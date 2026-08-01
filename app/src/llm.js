"use strict";
// OpenAI-compatible chat with a tool-calling loop. Works with OpenAI, Ollama,
// or any compatible /chat/completions endpoint (incl. a LiteLLM gateway).
// 'mock' replies offline.
const { config, modelFor } = require("./config");
const tools = require("./tools");
const log = require("./logger");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Follow-through guardrail: a weaker local model sometimes NARRATES an action it's about
// to take ("let me search that…", "I'll run the command…") but ends the turn WITHOUT
// emitting a tool call. This matches a first-person intent phrase followed (in the same
// clause) by a tool-ish verb — deliberately conservative so ordinary conversation
// ("it's going to be great", "let me know") does NOT trip it.
const ACTION_INTENT_RE = /\b(let me|i'?ll|i will|i'?m going to|i am going to|let me go|hang on,? let me|give me a (?:sec|moment)|one (?:sec|moment))\b[^.!?\n]*\b(search|look|check|run|fetch|grab|find|dig|browse|open|navigate|pull|query|execute|scrape|retrieve|do that|look that up|take care of|pull up|bring up)\b/i;

// Retryability is a property of each tool (see tools.isRetryable) — read-only tools
// retry on transient errors; mutating tools never auto-retry to avoid double execution.
const TRANSIENT = /(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|PROTOCOL_CONNECTION_LOST|ECONNREFUSED|\b(429|50\d)\b|service 5\d\d)/i;

// Some models (e.g. Qwen3 via Ollama) intermittently EMIT A TOOL CALL AS PLAIN TEXT —
// `<tool_call>run_shell <parameter=command>…</parameter></tool_call>` — instead of through
// the tool-calls API, because the model's XML-parameter dialect doesn't match the server's
// JSON tool-call parser. The call then never executes, yet the model believes it did and
// carries on reporting the work as done ("said it would, but nothing happened"). This parser
// recovers such calls so the harness can run them for real. Returns {markers, calls}.
function parseTextToolCalls(content, knownNames) {
  if (!content || content.indexOf("<tool_call>") === -1) return { markers: false, calls: [] };
  const calls = [];
  const blocks = content.split("<tool_call>").slice(1);
  for (const raw of blocks) {
    const block = raw.split("</tool_call>")[0];
    // (a) JSON dialect: <tool_call>{"name":"…","arguments":{…}}</tool_call>
    const jm = block.match(/\{[\s\S]*\}/);
    if (jm) {
      try { const o = JSON.parse(jm[0]); if (o && knownNames.has(o.name)) { calls.push({ name: o.name, args: o.arguments || o.parameters || {} }); continue; } } catch (_) {}
    }
    // (b) XML-parameter dialect: name on the first line, then <parameter=key>value</parameter>…
    const head = (block.split(/[\n<>]/)[0] || "").trim();          // token right after <tool_call>
    let name = knownNames.has(head) ? head : null;
    if (!name) for (const k of knownNames) { if (head.startsWith(k)) { name = k; break; } }  // "run_shellcommand" → "run_shell"
    if (!name) continue;
    const args = {}; let m;
    const re = /<parameter=(\w+)>\s*([\s\S]*?)\s*<\/parameter>/g;
    while ((m = re.exec(block))) args[m[1]] = m[2];
    if (Object.keys(args).length === 0) continue;                  // too garbled to run safely — leave for the nudge
    calls.push({ name, args });
  }
  return { markers: true, calls };
}

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

// Token-limit parameter compatibility. Most OpenAI-compatible endpoints (and Ollama/LiteLLM) take
// `max_tokens`, but newer OpenAI reasoning models (o1/o3/gpt-5 family) REJECT it and require
// `max_completion_tokens`. We default to max_tokens and, the first time a given model rejects it,
// remember that model and use max_completion_tokens for it from then on (until you switch models —
// the memory is keyed by model name, so a different model re-probes). See postChat().
const wantsMaxCompletion = new Set();
function tokenLimitParam(model, n) {
  return wantsMaxCompletion.has(model) ? { max_completion_tokens: n } : { max_tokens: n };
}
// Recognize ONLY the specific "use max_completion_tokens instead" 400 (not any 400 mentioning tokens).
function isMaxTokensUnsupported(status, text) {
  return status === 400 && /max_completion_tokens/i.test(text || "") &&
    /max_tokens|unsupported_parameter/i.test(text || "");
}
// POST a /chat/completions body, transparently retrying max_tokens -> max_completion_tokens on that
// one 400. `extra` merges into the body per call (e.g. {stream:true}). Returns the fetch Response;
// the caller still handles other errors. On fallback the offending model is remembered so subsequent
// turns build the right param up front (no repeated failed first attempt).
async function postChat(url, headers, body, signal, extra = {}) {
  const send = (b) => fetchWithRetry(url, { method: "POST", headers, body: JSON.stringify({ ...b, ...extra }), signal });
  let resp = await send(body);
  if (resp.status === 400 && "max_tokens" in body) {
    const t = await resp.clone().text();   // peek without consuming the body the caller may read
    if (isMaxTokensUnsupported(resp.status, t)) {
      wantsMaxCompletion.add(body.model);
      const { max_tokens, ...rest } = body;
      log.warn("llm", `model ${body.model} rejects max_tokens — retrying with max_completion_tokens (remembered for this model)`);
      resp = await send({ ...rest, max_completion_tokens: max_tokens });
    }
  }
  return resp;
}

async function chat({ messages, emit, tier, excludeTools, signal, watchdog, planMode, noTools }) {
  const llm = config.llm || {};
  if ((llm.provider || "").toLowerCase() === "mock") return mockChat(messages);
  return await openaiCompatibleChat(messages, emit, tier || "chat", excludeTools, signal, watchdog, planMode, noTools);
}

// Some chat templates (notably strict Qwen3 derivatives) raise
// "System message must be at the beginning" for ANY system message that is not
// the very first one — which breaks Ollama's tool-call parser generation the
// moment tools are attached. JARVIS legitimately injects system notes anywhere
// in the turn (current-time note, per-turn skill hint, repeat-tool warning), so
// before sending we collapse every system message into a single leading one.
// This is the standard, most-compatible message shape and is a no-op in effect
// for lenient templates.
function oneSystemAtFront(msgs) {
  const sys = [];
  const rest = [];
  for (const m of msgs) {
    if (m && m.role === "system") {
      sys.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    } else {
      rest.push(m);
    }
  }
  if (!sys.length) return msgs.slice();
  return [{ role: "system", content: sys.join("\n\n") }, ...rest];
}

async function openaiCompatibleChat(messages, emit, tier = "chat", excludeTools, signal, watchdog, planMode, noTools) {
  const excluded = new Set(excludeTools || []);
  const toolset = noTools ? [] : (excluded.size ? tools.toolDefs.filter((t) => !excluded.has(t.function && t.function.name)) : tools.toolDefs);
  const llm = config.llm || {};
  const base = (llm.base_url || "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = base + "/chat/completions";
  const headers = { "Content-Type": "application/json" };
  if (llm.api_key && !["ollama", "local"].includes((llm.provider || "").toLowerCase())) {
    headers["Authorization"] = "Bearer " + llm.api_key;
  }

  const convo = messages.slice();
  // Per-turn VOLATILE context — the current time (for scheduling), the shared-folder
  // paths, and an optional skill hint — is prepended to the LAST USER message, NOT
  // injected as a leading system note. This is a big performance win: the current time
  // changes every request, so putting it in the system block made the whole
  // system-prompt + tools prefix (~8k tokens) byte-different every turn, which defeats
  // Ollama/llama.cpp's KV-cache reuse and forces a full ~40s re-prefill on the first
  // model call of EVERY turn. Keeping the system block stable lets the cache hit, so
  // only the (already-changing) user tail is re-processed.
  const sh = config.shared || {};
  const lastUserIdx = convo.map((m) => m.role).lastIndexOf("user");
  if (lastUserIdx >= 0 && typeof convo[lastUserIdx].content === "string") {
    const notes = [`(Context — current date/time: ${new Date().toString()}. Shared folders: read-only = ${sh.read_only_dir || "/LLM_READ_ONLY_FILES"}, read-write = ${sh.read_write_dir || "/LLM_READ_WRITE_FILES"} — write files the user should receive into the read-write folder; a bare filename works.)`];
    // Auto-hint: nudge the model toward a relevant skill for THIS turn (on by default;
    // toggle with the skills_autohint config flag / the /hints UI command).
    if (config.skills_autohint !== false) {
      const h = require("./skills").hint(convo[lastUserIdx].content);
      if (h) { notes.push("(" + h + ")"); log.verbose("skill", "auto-hint", { hint: h }); }
    }
    // Active PLAN ledger: if a persistent plan is in flight, show it at the top of every turn
    // so the model always knows the objective + where it is and resumes from the first
    // incomplete step (survives stalls/restarts — it's on disk). This is the core fix for
    // "forgets what it was working on."
    try { const pn = require("./planner").contextNote(); if (pn) notes.push("[" + pn + "]"); } catch (_) {}
    // Planning mode: steer the model to clarify → plan → execute step by step. Injected as
    // part of the volatile user-message suffix (NOT the system block) so the cached prefix
    // stays byte-stable whether plan mode is on or off.
    if (planMode) {
      notes.push("(PLANNING MODE is ON. Before doing the work: (1) if ANYTHING about my request is ambiguous or underspecified, ASK your clarifying questions FIRST and stop for my answer — do not guess or start yet; (2) once it's clear, lay out a concise numbered HIGH-LEVEL PLAN of the steps; (3) then execute the plan step by step with your tools, briefly noting after each step what is done and what's next, and keep going until every step is genuinely complete.)");
    }
    convo[lastUserIdx] = { ...convo[lastUserIdx], content: notes.join("\n") + "\n\n" + convo[lastUserIdx].content };
  }
  // Idle watchdog: default from config, overridable per request (the UI switch). When OFF
  // the stream waits as long as the model needs (patient mode for long coding tasks); Stop
  // still interrupts. When ON, a >idle_timeout stall is treated as a dead stream.
  const watchdogOn = watchdog != null ? !!watchdog : ((config.llm || {}).idle_watchdog !== false);

  const maxIter = llm.max_tool_iterations || 8;
  const maxCompletionChecks = Number.isFinite(Number(llm.completion_checks)) ? Number(llm.completion_checks) : 2;
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const fingerprints = [];
  let intentNudges = 0;        // follow-through guardrail budget (see ACTION_INTENT_RE)
  let completionChecks = 0;    // "are you REALLY done?" budget
  let workedSinceCheck = false; // did the model call a tool since the last completion check?
  let leakedFixes = 0;         // budget for salvaging/correcting tool calls emitted as TEXT
  let lastModel = modelFor(tier);
  // context_tokens = the MOST RECENT single call's prompt size (not the per-turn sum) — that's
  // what actually reflects how full the context window is right now, for the UI meter.
  const addUsage = (u) => { if (u) { usage.prompt_tokens += u.prompt_tokens || 0; usage.completion_tokens += u.completion_tokens || 0; usage.total_tokens += u.total_tokens || 0; if (u.prompt_tokens) usage.context_tokens = u.prompt_tokens; } };
  const emitUsage = () => { if (emit && usage.total_tokens) emit({ type: "usage", model: lastModel, usage: { ...usage }, cost_usd: estimateCost(lastModel, usage) }); };

  for (let i = 0; i <= maxIter; i++) {
    if (signal && signal.aborted) return "⏹ Stopped.";
    // Vision routing happens inside the look-step (analyzeImage), not here — raw images
    // are never placed in `convo`, so the tier model always drives the tool loop.
    lastModel = modelFor(tier);
    const body = {
      model: lastModel,
      messages: oneSystemAtFront(convo),
      temperature: llm.temperature ?? 0.4,
      ...tokenLimitParam(lastModel, llm.max_tokens ?? 1200),   // max_tokens, or max_completion_tokens for models that require it
      ...(toolset.length ? { tools: toolset, tool_choice: "auto" } : {}),   // omit tools entirely when disabled
      stream_options: { include_usage: true },
    };
    log.info("llm", `turn iter=${i} tier=${tier} model=${lastModel} msgs=${convo.length} tools=${toolset.length}`);
    log.debug("llm", "request", { model: lastModel, tool_names: toolset.map((t) => t.function && t.function.name), messages: body.messages });
    let msg, turnUsage, finish;
    try {
      ({ message: msg, usage: turnUsage, finish } = await streamChatCompletion(url, headers, body, emit, signal, watchdogOn));
    } catch (e) {
      log.error("llm", `request failed: ${e.message}`, { model: lastModel });
      throw e;
    }
    log.info("llm", `response finish=${finish} tool_calls=${(msg.tool_calls || []).length} content_len=${(msg.content || "").length}`);
    log.debug("llm", "response", { content: msg.content, tool_calls: msg.tool_calls, reasoning_len: (msg.reasoning || "").length });
    addUsage(turnUsage);
    convo.push(msg);

    if (msg.tool_calls && msg.tool_calls.length) {
      workedSinceCheck = true;   // real work happened; a later "done" must be re-verified
      // Run independent tool calls concurrently (results pushed back in order).
      const settled = await Promise.allSettled(msg.tool_calls.map(async (tc) => {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
        if (emit) emit({ type: "tool", tool: tc.function.name, input: args });
        const started = Date.now();
        let result;
        try { result = await execWithRetry(tc.function.name, args, signal); }
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
        convo.push({ role: "user", content: "[system] You have now made the same tool call 3 times without progress. Stop repeating it — try a clearly different approach, or give your best final answer in plain text." });
      }
      continue; // let the model react to tool results
    }

    // ── Turn ended with NO tool call. Decide: accept the answer, or nudge & keep going. ──
    // NOTE: nudges are USER-role messages, NOT system. oneSystemAtFront() relocates system
    // messages to the front, which (a) defeats a nudge meant to follow the model's reply and
    // (b) can leave two assistant messages adjacent at the end → a 400 from strict backends.
    //
    // 0) Tool-call-as-text: the model wrote a `<tool_call>…</tool_call>` block in its reply
    //    instead of calling the tool for real (it never ran). Salvage the parseable ones and
    //    EXECUTE them so the work actually happens; then tell the model to use the real
    //    tool-call mechanism from now on. This is a top cause of "said it did it but didn't".
    if (msg.content && leakedFixes < 6) {
      const known = new Set(toolset.map((t) => t.function && t.function.name));
      const { markers, calls } = parseTextToolCalls(msg.content, known);
      if (markers) {
        leakedFixes++;
        if (calls.length) {
          log.warn("llm", `salvaged ${calls.length} tool call(s) the model wrote as TEXT — executing for real`, { names: calls.map((c) => c.name) });
          const results = [];
          for (const c of calls) {
            if (emit) emit({ type: "tool", tool: c.name, input: c.args });
            const started = Date.now();
            let result;
            try { result = await execWithRetry(c.name, c.args, signal); }
            catch (e) { result = { error: e.message }; }
            if (result && result.__image__) { const { __image__, ...rest } = result; result = { note: "screenshot captured", ...rest }; }
            if (emit) emit({ type: "tool_result", tool: c.name, output: clip(result, 4000), ms: Date.now() - started });
            results.push(`${c.name}(${JSON.stringify(c.args)}) →\n${clip(result, 4000)}`);
          }
          workedSinceCheck = true;
          convo.push({ role: "user", content: "[system] Your previous reply wrote the tool call(s) as TEXT inside <tool_call> tags — that does NOT execute them. I ran them for you this once; results below. From now on you MUST invoke tools through the real function-call mechanism, never by typing <tool_call> tags in your reply.\n\n" + results.join("\n\n") });
          continue;
        }
        // Markers present but nothing parseable → correct the model and let it retry.
        log.warn("llm", `model wrote a malformed tool call as text (unparseable) — correcting`, { content: (msg.content || "").slice(0, 200) });
        convo.push({ role: "user", content: "[system] Your last reply contained a tool call written as TEXT (<tool_call> tags), but it was malformed and did NOT execute — nothing ran. Do not type tool calls as text. Re-issue the action now as a real function/tool call." });
        continue;
      }
    }

    // 1) Follow-through: it narrated an action ("let me search…") but didn't take it.
    if (msg.content && intentNudges < 2 && ACTION_INTENT_RE.test(msg.content)) {
      intentNudges++;
      log.warn("llm", `follow-through nudge #${intentNudges}: promised an action but made no tool call`, { content: (msg.content || "").slice(0, 200) });
      convo.push({ role: "user", content: "[system] You described an action you were about to take but did not call any tool. If you intended to act (search the web, run a command, open the browser, fetch a page, read/write a file, etc.), CALL THE APPROPRIATE TOOL NOW. If you were only making conversation and no action is needed, briefly give your final answer." });
      continue;
    }

    // 2) Completion check: if the model DID real work this session and now thinks it's done,
    //    make it re-verify true completion before we accept. Keep nudging until it stops
    //    finding work (it re-affirms with no new tool call) or the budget is exhausted.
    if (msg.content && workedSinceCheck && completionChecks < maxCompletionChecks) {
      completionChecks++;
      workedSinceCheck = false;   // require NEW work to justify another completion nudge
      log.info("llm", `completion check #${completionChecks}: verifying the job is really done`);
      convo.push({ role: "user", content: "[system] Before you finish: re-read my ORIGINAL request and check that EVERY part is fully DONE and verified — not just described, planned, or partially done, and not something you only said you would do. If ANYTHING is incomplete or unverified, continue now using your tools. Only give your final answer if the job is genuinely 100% complete. Do NOT add work I did not ask for." });
      continue;
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
async function execWithRetry(name, args, signal) {
  const tries = tools.isRetryable(name) ? 3 : 1;
  let lastErr;
  for (let a = 0; a < tries; a++) {
    if (signal && signal.aborted) throw new Error("stopped");   // don't start/retry a tool after Stop
    try { return await tools.execTool(name, args, signal); }
    catch (e) {
      lastErr = e;
      if (signal && signal.aborted) throw e;                    // Stop pressed mid-tool — don't retry
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
async function streamChatCompletion(url, headers, body, emit, signal, watchdogOn = true) {
  const resp = await postChat(url, headers, body, signal, { stream: true });
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
  // When the watchdog is OFF (patient mode), we wait indefinitely — a slow cold-load/prefill
  // on a local model is NOT a dead stream, and there is no per-token cost locally. Stop still
  // interrupts because the underlying fetch is bound to `signal`.
  const IDLE_MS = (config.llm && config.llm.idle_timeout_ms) || 120000;
  async function readWithIdle() {
    if (!watchdogOn) return await reader.read();
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
  if (llm.api_key && !["ollama", "local"].includes((llm.provider || "").toLowerCase())) headers["Authorization"] = "Bearer " + llm.api_key;
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
    ...tokenLimitParam(modelFor("vision"), llm.max_tokens ?? 1200),   // same max_tokens/max_completion_tokens fallback
    stream: false,
    // NOTE: deliberately NO `tools` — vision models (qwen2.5vl) reject a tools payload.
  };
  const resp = await postChat(url, headers, body, signal);
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
