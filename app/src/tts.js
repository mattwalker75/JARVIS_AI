"use strict";
// Proxy to the jarvis-piper container (offline neural TTS). The browser talks only to
// the app (same origin); the app forwards to Piper over the internal Docker network.
// This keeps CORS out of the picture and lets the app own the piper endpoint config.
const { config } = require("./config");

function piperBase() {
  const v = config.voice || {};
  return (process.env.PIPER_URL || v.piper_url || "http://jarvis-piper:5000").replace(/\/+$/, "");
}

// List the voices baked into the piper image (id + human label + language).
async function voices() {
  const r = await fetch(piperBase() + "/voices", { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error("piper /voices " + r.status);
  return await r.json();
}

// Synthesize one chunk of text -> WAV bytes (Buffer). `rate` 0.5..2 (1 = normal).
async function synth(text, voice, rate) {
  const body = JSON.stringify({ text: String(text || ""), voice: voice || "", rate: Number(rate) || 1.0 });
  const r = await fetch(piperBase() + "/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    let m = "";
    try { m = (await r.json()).error; } catch (_) {}
    throw new Error("piper /tts " + r.status + (m ? ": " + m : ""));
  }
  return Buffer.from(await r.arrayBuffer());
}

module.exports = { voices, synth, piperBase };
