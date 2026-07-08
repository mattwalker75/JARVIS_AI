# Voice

Hands-free voice conversation. **Speech-to-text** is browser-native (Web Speech API —
best in **Chrome**, also Safari). **Text-to-speech** has two selectable engines:

- **Browser** — the OS/Chrome built-in voices (Web Speech API). Zero setup, but the
  available voices depend on the machine (macOS ships good premium neural voices).
- **Piper** — an **offline neural** voice from the `jarvis-piper` container. Free, fully
  local, and **machine-independent**: the same voice travels with JARVIS to any host
  (Mac, Linux, Windows) because the engine + models are baked into the image. See
  [Neural voice (Piper)](#neural-voice-piper) below.

Implementation: `app/public/voice.js` (engine) + wiring in `app/public/app.js`;
server proxy in `app/src/tts.js`; the TTS service in `piper/`.

## The controls

Open the UI at `http://localhost:8110` (a **secure context** — localhost or HTTPS is
required for the mic). Two independent things: whether JARVIS **speaks** its replies,
and how it **listens**.

| Control | Behavior |
| --- | --- |
| **🔊 Voice** | Toggles **spoken replies** (text-to-speech) on/off. Persists. |
| **🎤 Talk** | Push-to-talk — tap, speak one utterance, it's sent. **Enabled only when the mic is Off** (Wake/Open already listen, so it's disabled there). |
| Mic mode: **Off** | Mic disabled (use push-to-talk). |
| Mic mode: **Wake** | Continuous; say the wake word to start; sleeps after silence. A **follow-up window** then lets you reply without the wake word (see below). |
| Mic mode: **Open** | Continuous; every utterance is sent — full hands-free. |

**Hands-free like ChatGPT:** set mic mode to **Open** (or **Wake**) and turn **🔊 Voice**
on — now you talk and it talks back. In any continuous mode, saying
**"<wake word> stop listening"** turns the mic off.

To interrupt while it's speaking (barge-in): **tap the mic**, press **Esc**, or click
**Stop**.

## The wake word

In **Wake** mode you start a turn by saying the wake word. It's **configurable** via
`voice.wake_word` in `JARVIS_CONFIG.json` (and the matching `voice.stop_phrase`); it
defaults to the `assistant_name` ("Jarvis"). The current wake word is shown in the mic
status ("say Jarvis") and updates if you change it.

### Follow-up window (natural conversation)

By default Wake mode would make you say the name *every* turn. The **follow-up window**
fixes that: after JARVIS finishes speaking, it stays awake for a few seconds so you can
just reply — no wake word needed. Say the name again only once the window lapses.

- Configured by `voice.followup_seconds` in `JARVIS_CONFIG.json` (e.g. `5`). `0` disables
  it (classic behavior — wake word every turn).
- The timer starts **when it stops talking**, not when you last spoke — so the AI taking
  a while to think or give a long answer never eats into your reply window.
- It's the time to **start** replying, not to finish: the moment you begin speaking the
  countdown stops, so a longer sentence (with normal pauses) won't cut you off.
- It re-opens after every response, so a back-and-forth keeps going as long as you start
  answering within the window. During the window the mic status shows **listening**; after
  it lapses it returns to **asleep** ("say Jarvis").
- Applies to Wake mode with spoken replies on (it's anchored to end-of-speech). The
  separate `voice.silence_timeout_seconds` still governs how long you have to *start*
  talking right after saying the wake word.

## Ambient (hands-free) mode

Click **🌌 Ambient** in the header for a full-screen, hands-free view: the UI disappears
and JARVIS becomes a large glowing avatar that animates with its state — so you can lean
back and just talk, without watching text. **✕ Exit** returns to the normal UI.

Two avatar styles, switchable live with the button in the **top-left** of ambient mode
(persists to `voice.ambient_style`):

- **Face** (default) — an expressive glowing face that **blinks**, lets its **gaze wander
  while thinking**, and **lip-syncs its mouth to the voice** as it speaks.
- **Orb** — a single glowing orb that pulses/wobbles with its state.

Both share the same state colors + motion cues:

| State | Look |
| --- | --- |
| **Idle** | Soft blue, calm — "tap to talk". |
| **Listening** | Cyan; reacts to your **real voice amplitude** (via the mic). Face: eyes widen. |
| **Thinking** | Purple, churning while the model reasons. Face: eyes look around. |
| **Speaking** | Green, **animates as it talks** — with the Piper engine driven by the AI's **real voice amplitude** (the face's mouth lip-syncs to it); with the browser engine, a synthesized envelope + a pulse per word. |

- **Tap the avatar** to talk (push-to-talk) — which also interrupts it if it's speaking (barge-in).
- If a continuous mic mode (Wake/Open) is on, just talk — no tap needed.
- Entering ambient turns spoken replies on so it can talk back.

The listening reaction is real microphone amplitude (Web Audio). For **speaking**, the
engine matters: with **Piper**, JARVIS plays its own audio through Web Audio, so the avatar
reacts to the *actual waveform* of its voice — the face's mouth truly lip-syncs. With the
**browser** engine the synthesized waveform isn't readable, so "speaking" is word-synced
(a `boundary`-event pulse over a talking envelope) — still alive, just not amplitude-exact.
So switching to Piper both upgrades the voice **and** makes the avatar more lifelike.

## Choosing the voice

Click the **🎚️** button (next to 🔊 Voice) for the voice-settings popover:

- **Engine** — **Browser** (built-in) or **Piper** (neural · local). Switching resets the
  Voice dropdown, since each engine has its own voice list.
- **Voice** — for **Browser**, the speech voices your OS/Chrome provides; for **Piper**,
  the neural voices baked into the `jarvis-piper` image. Changing it plays a short sample.
  ("Auto" picks a sensible default.)
- **Speed** slider (both engines). **Pitch** slider (browser engine only — Piper has no
  pitch control, so it's dimmed there).
- **▶ Test voice** — hear the current settings any time (works even if Voice is muted).

Everything persists to `JARVIS_CONFIG.json` (`voice.tts_engine`, `voice.tts_voice`,
`voice.tts_rate`, `voice.tts_pitch`), so your choice survives refreshes, restarts, and
rebuilds.

**Browser voices** come from your Mac/Chrome — macOS ships several (Samantha, Alex,
Daniel, Karen…), and you can install better ones under **System Settings → Accessibility
→ Spoken Content → System Voice → Manage Voices** (the "Premium/Enhanced" ones are
excellent); they appear after a browser refresh. Chrome also adds its own "Google …"
voices. The catch: these live on *this machine* — move JARVIS to another host and they're
gone. That's what Piper solves.

## Neural voice (Piper)

**Piper** is an offline neural text-to-speech engine ([rhasspy/piper](https://github.com/rhasspy/piper),
MIT-licensed). JARVIS runs it in its own container, `jarvis-piper`, exposed only on the
internal Docker network:

- **Free** — no API, no key, no per-use cost.
- **Fully local** — the engine and voice models are baked into the image at build time;
  at runtime nothing leaves your machine (only the one-time image build needs internet).
- **Machine-independent** — the arch is auto-detected, so the same setup builds and runs
  on Apple Silicon (arm64) and x86_64 alike. The voice travels with JARVIS.
- **Fast** — ~45× faster than real-time on CPU (a sentence synthesizes in well under a
  second), so streamed replies still play sentence-by-sentence with no noticeable lag.

**How it flows:** the browser POSTs each sentence to the app (`/api/tts`), which proxies
to `jarvis-piper` (`app/src/tts.js`); the returned WAV is decoded and played through the
Web Audio API — queued and prefetched one sentence ahead so playback is gapless. Because
the audio goes through Web Audio, the ambient orb can read its real amplitude (see above).

**Voices** are `.onnx` models under `/opt/voices` in the image. The default set is a
spread of US/GB, female/male medium-quality voices (Amy, Lessac, Kristin, Ryan, HFC-male,
Jenny, Alan). To add or swap voices, edit `piper/download-voices.sh` (browse the catalog
at [huggingface.co/rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices)) and
rebuild:

```
docker compose build jarvis-piper && docker compose up -d jarvis-piper
```

**Quality note:** Piper is very natural — a big jump over the default browser voices, and
roughly on par with macOS's premium voices, with the advantage of being portable. For an
even more human voice you'd need a cloud engine (OpenAI TTS, ElevenLabs) — at the cost of
a key + internet, which Piper deliberately avoids.

## How speech output works (ChatGPT-style)

- **Streaming** — replies are spoken **sentence by sentence as they're generated**,
  not after the whole answer finishes. (With a local reasoning model you'll still hear
  nothing during the "thinking" phase, then speech begins as the answer streams.)
- **Queued** — sentences play in order and long replies never hit the browser's
  single-utterance length limit.
- **Cleaned** — code blocks, inline code, URLs, and importance markers are skipped, so
  it speaks the prose, not the punctuation and syntax.
- **Barge-in** — a new message, the Stop button, Esc, or tapping the mic instantly
  silences speech and resumes listening.

While JARVIS is speaking, the mic is **paused** (browser Web Speech has no echo
cancellation for continuous recognition, so otherwise it would hear itself). That
means you can't interrupt *by voice* mid-speech — use the mic tap / Esc / Stop.

## Configuration

In `JARVIS_CONFIG.json` under `voice` (see [Configuration](configuration.md#voice)):
`enabled`, `tts`, `stt`, `mic_mode`, `silence_timeout_seconds`, `followup_seconds`,
optional `wake_word` / `stop_phrase`, and the TTS settings `tts_engine` (`browser` | `piper`),
`tts_voice`, `tts_rate`, `tts_pitch`. The engine, voice, mic mode, and TTS toggle are
all settable from the UI and persist.

## Snappier voice

The main latency is the model "thinking" before it speaks. For a more responsive feel,
point the **chat** tier at a smaller/faster model with the header model switcher (or
`/model`), e.g. `qwen3:8b` — trivial now that everything routes through the gateway.

## Troubleshooting

- **No mic / permission denied** — allow the microphone for `localhost` in the browser,
  and check macOS System Settings → Privacy & Security → Microphone for your browser.
- **"needs a secure context"** — open `http://localhost:8110` (not a LAN IP), or use HTTPS.
- **No speech output** — check the 🔊 toggle and your system output. Browser voices come
  from the OS; for **Piper**, make sure `jarvis-piper` is running (`docker ps`) — if the
  Voice dropdown shows "(Piper unavailable)" the container is down or still starting.
- **Piper picked but silent** — the first audio needs a user gesture to unlock the browser's
  audio context; click **▶ Test voice** or the 🔊 Voice button once, then it plays freely.
