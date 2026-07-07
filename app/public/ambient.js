"use strict";
// Ambient voice mode: a full-screen glowing orb that IS JARVIS — breathes when idle,
// ripples to your voice when listening (real mic amplitude), churns while thinking, and
// pulses per spoken word while it talks (driven by SpeechSynthesis boundary events).
// A hands-free "just talk to it, don't watch the text" view. Enter/exit with a button.
//
// API (called from app.js):
//   JarvisAmbient.toggle() / enter() / exit()
//   JarvisAmbient.setState("idle"|"listening"|"thinking"|"speaking")
//   JarvisAmbient.pulse()        // bump the orb (per spoken word)
//   JarvisAmbient.active()
//   JarvisAmbient.onTap(fn)      // canvas tap → talk / barge-in
(function () {
  let overlay, canvas, ctx, raf, tapFn = null;
  let micStream = null, analyser = null, dataArr = null, audioCtx = null;
  let state = "idle", energy = 0, pulseE = 0, t = 0, active = false;

  const COLORS = {
    idle:      [96, 148, 190],
    listening: [54, 211, 255],
    thinking:  [176, 132, 255],
    speaking:  [72, 222, 176],
  };
  const CAPTION = { idle: "Tap to talk", listening: "Listening…", thinking: "Thinking…", speaking: "Speaking…" };

  function build() {
    overlay = document.createElement("div");
    overlay.id = "ambient";
    overlay.innerHTML =
      '<canvas id="ambient-canvas"></canvas>' +
      '<div class="ambient-caption" id="ambient-caption"></div>' +
      '<button class="ambient-exit" id="ambient-exit" title="Exit ambient mode">✕ Exit</button>';
    document.body.appendChild(overlay);
    canvas = overlay.querySelector("#ambient-canvas");
    ctx = canvas.getContext("2d");
    overlay.querySelector("#ambient-exit").addEventListener("click", (e) => { e.stopPropagation(); exit(); });
    canvas.addEventListener("click", () => { if (tapFn) tapFn(); });
    resize();
    window.addEventListener("resize", resize);
  }
  function resize() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function micLevel() {
    if (!analyser) return (Math.sin(t * 2) * 0.5 + 0.5) * 0.15;   // gentle fallback
    analyser.getByteFrequencyData(dataArr);
    let s = 0; for (let i = 0; i < dataArr.length; i++) s += dataArr[i];
    return Math.min(1, (s / dataArr.length) / 110);
  }

  function render() {
    t += 1 / 60;
    let target = 0.14, smooth = 0.16;                    // idle breathing baseline
    if (state === "listening") target = 0.18 + micLevel() * 0.85;
    else if (state === "thinking") target = 0.34 + Math.sin(t * 3.1) * 0.12 + Math.sin(t * 7) * 0.05;
    else if (state === "speaking") {
      // Continuous "talking" motion (the browser won't expose the synth voice's real
      // amplitude), layered with the per-word pulses — so it visibly reacts while it speaks.
      const talk = 0.13 * Math.abs(Math.sin(t * 10.5))
                 + 0.08 * Math.abs(Math.sin(t * 6.1 + 1.1))
                 + 0.05 * Math.abs(Math.sin(t * 15.7 + 0.5));
      target = 0.30 + talk + pulseE;
      smooth = 0.3;                                       // snappier so the motion pops
    }
    if (state === "idle") target += Math.sin(t * 1.1) * 0.05;     // slow breathe
    energy += (target - energy) * smooth;
    pulseE *= 0.88;

    const w = window.innerWidth, h = window.innerHeight, cx = w / 2, cy = h / 2;
    ctx.clearRect(0, 0, w, h);
    const base = Math.min(w, h) * 0.16;
    const r = base * (1 + energy * 0.55);
    const [cr, cg, cb] = COLORS[state] || COLORS.idle;

    // outer glow
    const g = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 2.6);
    g.addColorStop(0, `rgba(${cr},${cg},${cb},0.55)`);
    g.addColorStop(0.35, `rgba(${cr},${cg},${cb},0.22)`);
    g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r * 2.6, 0, Math.PI * 2); ctx.fill();

    // orb body with an organic wobble (extra fast ripple while speaking, so it looks
    // like it's actively talking)
    const spk = state === "speaking" ? 1 : 0;
    ctx.beginPath();
    for (let a = 0; a <= Math.PI * 2 + 0.001; a += 0.1) {
      const wob = 1
        + Math.sin(a * 3 + t * 2) * 0.03 * (1 + energy)
        + Math.sin(a * 5 - t * 1.6) * 0.022 * energy
        + Math.sin(a * 8 + t * 3) * (0.012 + spk * 0.02) * (energy + spk * 0.3)
        + spk * Math.sin(a * 6 - t * 9) * 0.022 * (0.4 + pulseE);
      const rr = r * wob;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      a === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    const body = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
    body.addColorStop(0, "rgba(255,255,255,0.95)");
    body.addColorStop(0.5, `rgba(${cr},${cg},${cb},0.95)`);
    body.addColorStop(1, `rgba(${(cr * 0.45) | 0},${(cg * 0.45) | 0},${(cb * 0.6) | 0},0.92)`);
    ctx.fillStyle = body; ctx.fill();

    raf = requestAnimationFrame(render);
  }

  async function startMic() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128; analyser.smoothingTimeConstant = 0.7;
      dataArr = new Uint8Array(analyser.frequencyBinCount);
      src.connect(analyser);
    } catch (_) { analyser = null; }   // graceful: fall back to a gentle animation
  }
  function stopMic() {
    if (micStream) { micStream.getTracks().forEach((tr) => tr.stop()); micStream = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
    analyser = null;
  }

  function setState(s) {
    if (!(s in COLORS)) s = "idle";
    state = s;
    const cap = overlay && overlay.querySelector("#ambient-caption");
    if (cap) cap.textContent = CAPTION[s] || "";
  }

  function enter() {
    if (active) return;
    if (!overlay) build();
    active = true;
    overlay.classList.add("on");
    document.body.classList.add("ambient-on");
    startMic();
    setState(state);
    render();
  }
  function exit() {
    if (!active) return;
    active = false;
    overlay.classList.remove("on");
    document.body.classList.remove("ambient-on");
    cancelAnimationFrame(raf);
    stopMic();
  }

  window.JarvisAmbient = {
    enter, exit, toggle: () => (active ? exit() : enter()),
    setState, pulse: () => { pulseE = Math.min(0.9, pulseE + 0.4); },
    active: () => active,
    onTap: (fn) => { tapFn = fn; },
  };
})();
