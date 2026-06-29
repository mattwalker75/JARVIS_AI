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

async function chat({ messages, emit, tier }) {
  const llm = config.llm || {};
  if ((llm.provider || "").toLowerCase() === "mock") return mockChat(messages);
  return await openaiCompatibleChat(messages, emit, tier || "chat");
}

async function openaiCompatibleChat(messages, emit, tier = "chat") {
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
    // Per-task routing: a vision model when the context contains images, else the tier's model.
    const hasImages = convo.some((m) => Array.isArray(m.content) && m.content.some((c) => c && c.type === "image_url"));
    lastModel = hasImages ? modelFor("vision") : modelFor(tier);
    const body = {
      model: lastModel,
      messages: convo,
      temperature: llm.temperature ?? 0.4,
      max_tokens: llm.max_tokens ?? 1200,
      tools: tools.toolDefs,
      tool_choice: "auto",
      stream_options: { include_usage: true },
    };
    const { message: msg, usage: turnUsage } = await streamChatCompletion(url, headers, body, emit);
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
        let image = null, summarized = result;
        if (result && result.__image__) {
          const { __image__, ...rest } = result;
          summarized = { note: "screenshot captured", ...rest };
          image = __image__;
        }
        if (emit) emit({ type: "tool_result", tool: tc.function.name, output: clip(summarized, 4000), ms: Date.now() - started });
        return { tc, summarized, image };
      }));

      const pendingImages = [];
      for (const s of settled) {
        const v = s.status === "fulfilled" ? s.value : { tc: { id: "unknown" }, summarized: { error: String(s.reason) } };
        convo.push({ role: "tool", tool_call_id: v.tc.id, content: clip(v.summarized, 12000) });
        if (v.image) pendingImages.push(v.image);
      }
      for (const img of pendingImages) {
        convo.push({ role: "user", content: [
          { type: "text", text: "Current screenshot of the desktop:" },
          { type: "image_url", image_url: { url: img } },
        ] });
      }

      // No-progress guard: if the model repeats the same tool calls, nudge it.
      const fp = msg.tool_calls.map((tc) => tc.function.name + ":" + (tc.function.arguments || "")).sort().join("|");
      fingerprints.push(fp);
      if (fingerprints.filter((f) => f === fp).length >= 3) {
        convo.push({ role: "system", content: "You have now made the same tool call 3 times without progress. Stop repeating it — try a clearly different approach, or give your best final answer in plain text." });
      }
      continue; // let the model react to tool results
    }

    emitUsage();
    return msg.content || "";
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
      if (a === tries - 1) throw e;
      await sleep(Math.min(30000, 1000 * 2 ** a) + Math.random() * 1000);
    }
  }
  throw lastErr || new Error("fetch failed");
}

// One streamed /chat/completions call. Emits {type:"token"} per content delta,
// assembles streamed tool-call deltas, captures usage. Returns {message, usage}.
async function streamChatCompletion(url, headers, body, emit) {
  const resp = await fetchWithRetry(url, { method: "POST", headers, body: JSON.stringify({ ...body, stream: true }) });
  if (!resp.ok || !resp.body) {
    const t = resp.body ? await resp.text() : "";
    throw new Error(`LLM ${resp.status}: ${t.slice(0, 400)}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", content = "", usage = null;
  const toolCalls = [];
  let done = false;
  while (!done) {
    const r = await reader.read();
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
      const delta = choice && choice.delta;
      if (!delta) continue;
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
  return { message: { role: "assistant", content: content || null, tool_calls: tc.length ? tc : undefined }, usage };
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
