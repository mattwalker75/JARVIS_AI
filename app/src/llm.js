"use strict";
// OpenAI-compatible chat with a tool-calling loop. Works with OpenAI, Ollama,
// or any compatible /chat/completions endpoint (incl. a LiteLLM gateway).
// 'mock' replies offline.
const { config, modelFor } = require("./config");
const tools = require("./tools");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tools that are safe to retry on a transient (connection-level) error because
// they are read-only / idempotent. Mutating tools (run_shell, sql, write_file,
// set_secret, computer-use) are never auto-retried to avoid double-execution.
const RETRYABLE_TOOLS = new Set(["fetch_url", "web_search", "search_memory", "list_memories", "screenshot"]);
const TRANSIENT = /(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|PROTOCOL_CONNECTION_LOST|ECONNREFUSED|\b(429|50\d)\b|service 5\d\d)/i;

// Rough USD per 1K tokens [prompt, completion]; used only for a cost estimate in the UI.
const PRICES = {
  "gpt-4o-mini": [0.00015, 0.0006], "gpt-4o": [0.0025, 0.01],
  "gpt-4.1-mini": [0.0004, 0.0016], "gpt-4.1": [0.002, 0.008], "gpt-4.1-nano": [0.0001, 0.0004],
  "o4-mini": [0.0011, 0.0044], "claude": [0.003, 0.015], "gemini": [0.0005, 0.0015],
};
function estimateCost(model, u) {
  const key = Object.keys(PRICES).find((k) => (model || "").includes(k));
  const [pi, po] = key ? PRICES[key] : [0, 0];
  return +(((u.prompt_tokens || 0) / 1000) * pi + ((u.completion_tokens || 0) / 1000) * po).toFixed(6);
}

async function chat({ messages, emit, tier, excludeTools, signal }) {
  const llm = config.llm || {};
  if ((llm.provider || "").toLowerCase() === "mock") return mockChat(messages);
  return await openaiCompatibleChat(messages, emit, tier || "chat", excludeTools, signal);
}

async function openaiCompatibleChat(messages, emit, tier = "chat", excludeTools, signal) {
  const excluded = new Set(excludeTools || []);
  const toolset = excluded.size ? tools.toolDefs.filter((t) => !excluded.has(t.function && t.function.name)) : tools.toolDefs;
  const llm = config.llm || {};
  const base = (llm.base_url || "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = base + "/chat/completions";
  const headers = { "Content-Type": "application/json" };
  if (llm.api_key && (llm.provider || "").toLowerCase() !== "ollama") {
    headers["Authorization"] = "Bearer " + llm.api_key;
  }

  const convo = messages.slice();
  // Give the model the current time (for scheduling) and the shared-folder paths.
  const sh = config.shared || {};
  const nowNote = { role: "system", content: `Current date/time: ${new Date().toString()} (epoch ms ${Date.now()}). Shared folders: read-only = ${sh.read_only_dir || "/READ_ONLY_FILES"}, read-write = ${sh.read_write_dir || "/READ_WRITE_FILES"} (write files the user should receive into the read-write folder; a bare filename works).` };
  if (convo.length && convo[0].role === "system") convo.splice(1, 0, nowNote);
  else convo.unshift(nowNote);

  const maxIter = llm.max_tool_iterations || 8;
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const fingerprints = [];
  let lastModel = modelFor(tier);
  const addUsage = (u) => { if (u) { usage.prompt_tokens += u.prompt_tokens || 0; usage.completion_tokens += u.completion_tokens || 0; usage.total_tokens += u.total_tokens || 0; } };
  const emitUsage = () => { if (emit && usage.total_tokens) emit({ type: "usage", model: lastModel, usage: { ...usage }, cost_usd: estimateCost(lastModel, usage) }); };

  for (let i = 0; i <= maxIter; i++) {
    if (signal && signal.aborted) return "⏹ Stopped.";
    // Vision routing happens inside the look-step (analyzeImage), not here — raw images
    // are never placed in `convo`, so the tier model always drives the tool loop.
    lastModel = modelFor(tier);
    const body = {
      model: lastModel,
      messages: convo,
      temperature: llm.temperature ?? 0.4,
      max_tokens: llm.max_tokens ?? 1200,
      tools: toolset,
      tool_choice: "auto",
      stream_options: { include_usage: true },
    };
    const { message: msg, usage: turnUsage, finish } = await streamChatCompletion(url, headers, body, emit, signal);
    addUsage(turnUsage);
    convo.push(msg);

    if (msg.tool_calls && msg.tool_calls.length) {
      // Run independent tool calls concurrently (results pushed back in order).
      const settled = await Promise.allSettled(msg.tool_calls.map(async (tc) => {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
        if (emit) emit({ type: "tool", tool: tc.function.name, input: args });
        const started = Date.now();
        let result;
        try { result = await execWithRetry(tc.function.name, args); }
        catch (e) { result = { error: e.message }; }
        let summarized = result;
        if (result && result.__image__) {
          // Vision "look" step: hand the screenshot to the vision model IN ISOLATION and
          // fold its TEXT analysis back into the tool result. We do NOT inject the raw image
          // into this conversation — the tool-driving model is text-only, and vision models
          // reject a `tools` payload, so the two can't be mixed in one call.
          const { __image__, ...rest } = result;
          if (emit) emit({ type: "tool", tool: "vision:look", input: { model: modelFor("vision"), question: args.question || "(general)" } });
          let visual_analysis;
          try { visual_analysis = await analyzeImage(__image__, args.question, signal); }
          catch (e) { visual_analysis = `(vision analysis failed: ${e.message})`; }
          summarized = { note: "screenshot captured; analyzed by the vision model", ...rest, visual_analysis };
          if (emit) emit({ type: "tool_result", tool: "vision:look", output: clip(visual_analysis, 4000), ms: Date.now() - started });
        }
        if (emit) emit({ type: "tool_result", tool: tc.function.name, output: clip(summarized, 4000), ms: Date.now() - started });
        return { tc, summarized };
      }));

      // Push exactly one tool result per tool_call, ALWAYS keyed to the real tool_call_id
      // (order is preserved by allSettled) — an unmatched/placeholder id makes many
      // backends 400 the next turn.
      msg.tool_calls.forEach((tc, i) => {
        const s = settled[i];
        const summarized = (s && s.status === "fulfilled" && s.value)
          ? s.value.summarized
          : { error: s && s.reason ? String(s.reason) : "tool execution failed" };
        convo.push({ role: "tool", tool_call_id: tc.id, content: clip(summarized, 12000) });
      });

      // No-progress guard: if the model repeats the same tool calls, nudge it.
      const fp = msg.tool_calls.map((tc) => tc.function.name + ":" + (tc.function.arguments || "")).sort().join("|");
      fingerprints.push(fp);
      if (fingerprints.filter((f) => f === fp).length >= 3) {
        convo.push({ role: "system", content: "You have now made the same tool call 3 times without progress. Stop repeating it — try a clearly different approach, or give your best final answer in plain text." });
      }
      continue; // let the model react to tool results
    }

    emitUsage();
    // Never leave the user hanging with a blank reply. If the turn produced no answer
    // and no tool call, always say SOMETHING — and if it was cut off by the token cap,
    // say that specifically.
    if (!msg.content) {
      if (finish === "length") {
        return `⚠️ Ran out of tokens trying to process the request (max_tokens = ${llm.max_tokens ?? 1200}). The model spent its whole budget thinking before it could finish. Please try again, or raise "llm.max_tokens" in JARVIS_CONFIG.json.`;
      }
      return "⚠️ I wasn't able to produce a response to that. Please try again, or rephrase the request.";
    }
    return msg.content;
  }
  emitUsage();
  return "(Stopped after the maximum number of tool steps.)";
}

// Execute a tool, retrying read-only/idempotent ones on transient errors.
async function execWithRetry(name, args) {
  const tries = RETRYABLE_TOOLS.has(name) ? 3 : 1;
  let lastErr;
  for (let a = 0; a < tries; a++) {
    try { return await tools.execTool(name, args); }
    catch (e) {
      lastErr = e;
      if (a === tries - 1 || !TRANSIENT.test(e.message || "")) throw e;
      await sleep(Math.min(8000, 400 * 2 ** a) + Math.random() * 300);
    }
  }
  throw lastErr;
}

// fetch with retry + backoff on transient HTTP (429/5xx) and network errors.
async function fetchWithRetry(url, options, tries = 4) {
  let lastErr;
  for (let a = 0; a < tries; a++) {
    try {
      const resp = await fetch(url, options);
      if ((resp.status === 429 || resp.status >= 500) && a < tries - 1) {
        const ra = parseInt(resp.headers.get("retry-after") || "", 10);
        await sleep(ra ? ra * 1000 : Math.min(30000, 1000 * 2 ** a) + Math.random() * 1000);
        continue;
      }
      return resp;
    } catch (e) {
      lastErr = e;
      // A user-initiated abort is final — do not retry it.
      if (e.name === "AbortError" || (options.signal && options.signal.aborted)) throw e;
      if (a === tries - 1) throw e;
      await sleep(Math.min(30000, 1000 * 2 ** a) + Math.random() * 1000);
    }
  }
  throw lastErr || new Error("fetch failed");
}

// One streamed /chat/completions call. Emits {type:"token"} per content delta,
// assembles streamed tool-call deltas, captures usage. Returns {message, usage}.
async function streamChatCompletion(url, headers, body, emit, signal) {
  const resp = await fetchWithRetry(url, { method: "POST", headers, body: JSON.stringify({ ...body, stream: true }), signal });
  if (!resp.ok || !resp.body) {
    const t = resp.body ? await resp.text() : "";
    throw new Error(`LLM ${resp.status} (model ${body.model}): ${t.slice(0, 400)}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", content = "", reasoning = "", usage = null, finish = null;
  const toolCalls = [];
  let done = false;
  // Idle watchdog: if the model sends NO data for this long, treat the stream as stalled
  // and abort (a healthy stream — even a slow reasoning model — sends tokens continuously).
  const IDLE_MS = (config.llm && config.llm.idle_timeout_ms) || 120000;
  async function readWithIdle() {
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`stream idle >${Math.round(IDLE_MS / 1000)}s — the model stopped sending data`)), IDLE_MS); });
    try { return await Promise.race([reader.read(), timeout]); } finally { clearTimeout(timer); }
  }
  while (!done) {
    let r;
    try { r = await readWithIdle(); }
    catch (e) { try { await reader.cancel(); } catch (_) {} throw e; }
    if (r.done) break;
    buf += decoder.decode(r.value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { done = true; break; }
      let json; try { json = JSON.parse(payload); } catch { continue; }
      if (json.usage) usage = json.usage;
      const choice = json.choices && json.choices[0];
      if (choice && choice.finish_reason) finish = choice.finish_reason;
      const delta = choice && choice.delta;
      if (!delta) continue;
      // Reasoning models (e.g. qwen3-next) stream their chain-of-thought in a separate
      // `reasoning`/`reasoning_content` field. Surface it so the UI can show live thinking.
      const rz = delta.reasoning || delta.reasoning_content;
      if (rz) { reasoning += rz; if (emit) emit({ type: "reasoning", text: rz }); }
      if (delta.content) { content += delta.content; if (emit) emit({ type: "token", text: delta.content }); }
      if (delta.tool_calls) {
        for (const d of delta.tool_calls) {
          const i = d.index || 0;
          if (!toolCalls[i]) toolCalls[i] = { id: "", type: "function", function: { name: "", arguments: "" } };
          if (d.id) toolCalls[i].id = d.id;
          if (d.function && d.function.name) toolCalls[i].function.name += d.function.name;
          if (d.function && d.function.arguments) toolCalls[i].function.arguments += d.function.arguments;
        }
      }
    }
  }
  const tc = toolCalls.filter(Boolean);
  return { message: { role: "assistant", content: content || null, tool_calls: tc.length ? tc : undefined }, usage, finish, reasoning };
}

// The "look" step for computer-use: send a screenshot to the vision model on its own
// (image + question, NO tools) and return its text description + element coordinates.
// This is how a text-only tool-driver model (e.g. qwen3-next) "sees" — and it avoids the
// "<vision model> does not support tools" 400, since we never attach tools to this call.
async function analyzeImage(dataUrl, question, signal) {
  const llm = config.llm || {};
  const base = (llm.base_url || "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = base + "/chat/completions";
  const headers = { "Content-Type": "application/json" };
  if (llm.api_key && (llm.provider || "").toLowerCase() !== "ollama") headers["Authorization"] = "Bearer " + llm.api_key;
  const q = question && String(question).trim();
  const prompt = "You are the eyes of a desktop automation agent. Look at this screenshot of a " +
    "1024x768 screen and report exactly what is visible. List the interactive elements (buttons, links, " +
    "text fields, icons, tabs, menu items) with their visible label and their approximate CENTER pixel " +
    "coordinate as (x, y) measured from the top-left corner. Note which window is focused, the address/URL " +
    "bar contents if a browser is open, and the overall state. Be concise but complete and accurate about positions." +
    (q ? ` The agent specifically needs to know: ${q}` : "");
  const body = {
    model: modelFor("vision"),
    messages: [{ role: "user", content: [
      { type: "text", text: prompt },
      { type: "image_url", image_url: { url: dataUrl } },
    ] }],
    temperature: 0,
    max_tokens: llm.max_tokens ?? 1200,
    stream: false,
    // NOTE: deliberately NO `tools` — vision models (qwen2.5vl) reject a tools payload.
  };
  const resp = await fetchWithRetry(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!resp.ok) throw new Error(`vision ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const d = await resp.json();
  const m = d.choices && d.choices[0] && d.choices[0].message;
  return (m && (m.content || m.reasoning)) || "(vision model returned no description)";
}

function clip(value, n) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > n ? s.slice(0, n) + " …[truncated]" : s;
}

function mockChat(messages) {
  const last = [...messages].reverse().find((m) => m.role === "user");
  const q = last ? last.content : "";
  return (
    `**[MOCK JARVIS]** You said: "${q}".\n\n` +
    `I'm running in mock mode so this reply is canned, but my tools are live — ` +
    `the memory database, the root workbench shell, and the shared folders all work. ` +
    `Run the System self-test to see them, or set llm.provider to "openai" (with an api_key) ` +
    `or "ollama" in JARVIS_CONFIG.json for real, tool-using responses.`
  );
}

module.exports = { chat };
