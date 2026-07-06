"use strict";
// Context-window probe: a "needle in a haystack" test that measures how large a
// prompt the CURRENT model can actually use — i.e., the biggest context where it
// still recalls a fact placed at the very start. Reports the effective window (which
// is what matters: with Ollama's /v1 auto-sizing, this reflects the model's real max
// or any server cap). Run:  ./JARVIS.sh --probe-context
const { config } = require("./src/config");

const llm = config.llm || {};
const base = (llm.base_url || "https://api.openai.com/v1").replace(/\/+$/, "");
const url = base + "/chat/completions";
const headers = { "Content-Type": "application/json" };
if (llm.api_key && (llm.provider || "").toLowerCase() !== "ollama") headers["Authorization"] = "Bearer " + llm.api_key;
const model = llm.model;

const NEEDLE = "The secret passphrase is ZEBRA-ONederful-42.";
const SENT = "The weather in the quiet valley was calm and unremarkable that long afternoon. ";

function buildPrompt(approxTokens) {
  // SENT ~= 14 tokens; pad to roughly the target size, needle pinned at the very top.
  const reps = Math.max(1, Math.round((approxTokens - 60) / 14));
  return "Near the very top of this document is a secret you must remember: " + NEEDLE +
    "\n\n" + SENT.repeat(reps) +
    "\n\nQUESTION: what is the secret passphrase? Reply with ONLY the passphrase.";
}

async function probe(approxTokens) {
  const body = {
    model, messages: [{ role: "user", content: buildPrompt(approxTokens) }],
    // Reasoning models (e.g. qwen3-next) spend tokens "thinking" before the answer, so
    // give a generous budget or content comes back empty and looks like a miss.
    stream: false, temperature: 0, max_tokens: 2048,
  };
  // Ask Ollama for enough KV cache to hold the prompt; cloud APIs reject unknown fields, so skip it.
  if ((llm.provider || "").toLowerCase() === "ollama") body.options = { num_ctx: approxTokens + 4096 };
  // Big prompts take longer to prefill on a local model — scale the timeout with size (cap 10 min).
  const timeoutMs = Math.min(600000, 90000 + approxTokens * 4);
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) return { error: `HTTP ${r.status}: ${(await r.text()).slice(0, 120)}` };
  const d = await r.json();
  const m = (d.choices && d.choices[0] && d.choices[0].message) || {};
  // The needle may land in content OR in a separate reasoning/thinking field.
  const c = [m.content, m.reasoning, m.reasoning_content].filter(Boolean).join(" ");
  return { prompt_tokens: d.usage && d.usage.prompt_tokens, recalled: /ZEBRA-ONederful-42/i.test(c) };
}

(async () => {
  console.log(`Context-window probe — model: ${model}  (provider: ${llm.provider || "?"})\n`);
  const ladder = [2000, 4000, 8000, 16000, 32000, 64000, 128000, 200000];
  let lastGood = 0, ceiling = null, stopReason = null;
  for (const t of ladder) {
    process.stdout.write(`  target ~${t.toLocaleString()} tok ... `);
    let res;
    try { res = await probe(t); } catch (e) { res = { error: e.message }; }
    if (res.error) { console.log(`stopped (${res.error})`); ceiling = t; stopReason = "error"; break; }
    const pt = res.prompt_tokens || t;
    console.log(`sent ${String(pt).padStart(7)} tok → needle ${res.recalled ? "RECALLED ✓" : "LOST ✗"}`);
    if (res.recalled) lastGood = pt; else { ceiling = pt; stopReason = "lost"; break; }
  }
  console.log("\n=== RESULT ===");
  console.log(`  Confirmed usable context: ~${lastGood.toLocaleString()} tokens (needle recalled).`);
  if (stopReason === "lost")
    console.log(`  The model started missing the fact by ~${Number(ceiling).toLocaleString()} tokens — treat ~${lastGood.toLocaleString()} as the practical ceiling.`);
  else if (stopReason === "error")
    console.log(`  Probing stopped at ~${Number(ceiling).toLocaleString()} tokens (timeout/error, NOT a recall failure) — the real window is at least ~${lastGood.toLocaleString()} and likely higher.`);
  else
    console.log(`  Still solid at the top of the ladder — the window is at least ~${lastGood.toLocaleString()} tokens, likely larger.`);
  console.log(`  JARVIS sessions rarely exceed ~20-30k tokens, so anything above that is comfortable headroom.`);
  process.exit(0);
})().catch((e) => { console.log("ERR", e.message); process.exit(1); });
