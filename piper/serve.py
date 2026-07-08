#!/usr/bin/env python3
"""jarvis-piper: a tiny HTTP wrapper around Piper (offline neural text-to-speech).

The app (jarvis-app) is the only client and reaches this over the internal Docker
network. Fully local: voice models are baked into the image at build time, so nothing
here touches the network at runtime.

Endpoints:
  GET  /healthz   -> "ok"
  GET  /voices    -> {"voices": [{"id","label","lang"}...], "default": "<id>"}
  POST /tts       -> audio/wav   ; JSON body {"text": "...", "voice": "<id>", "rate": 1.0}

A "voice" is an <id>.onnx file (+ matching <id>.onnx.json) under VOICES_DIR. Add more
voices by dropping the pair in and rebuilding — they show up in /voices automatically.
"""
import glob
import json
import os
import re
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PIPER_BIN = os.environ.get("PIPER_BIN", "/opt/piper/piper")
ESPEAK_DATA = os.environ.get("ESPEAK_DATA", "/opt/piper/espeak-ng-data")
VOICES_DIR = os.environ.get("VOICES_DIR", "/opt/voices")
DEFAULT = os.environ.get("DEFAULT_VOICE", "en_US-amy-medium")
PORT = int(os.environ.get("PORT", "5000"))
MAX_CHARS = int(os.environ.get("TTS_MAX_CHARS", "2000"))


def prettify(vid):
    # "en_US-amy-medium" -> "Amy · en_US · medium"
    parts = vid.split("-")
    lang = parts[0] if parts else vid
    name = parts[1].replace("_", " ").title() if len(parts) > 1 else vid
    qual = parts[2] if len(parts) > 2 else ""
    bits = [name, lang] + ([qual] if qual else [])
    return " · ".join(bits)


def discover():
    out = {}
    for onnx in sorted(glob.glob(os.path.join(VOICES_DIR, "*.onnx"))):
        vid = os.path.basename(onnx)[:-5]  # strip ".onnx"
        lang = ""
        try:
            with open(onnx + ".json") as f:
                meta = json.load(f)
            lang = (meta.get("language") or {}).get("code") or ""
        except Exception:
            pass
        if not lang:
            m = re.match(r"([a-z]{2}_[A-Z]{2})", vid)
            lang = m.group(1) if m else ""
        out[vid] = {"id": vid, "path": onnx, "lang": lang, "label": prettify(vid)}
    return out


VOICES = discover()


def synth(model_path, text, length_scale):
    """Run piper on `text`, return WAV bytes (or None on failure)."""
    out = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            out = tf.name
        cmd = [
            PIPER_BIN,
            "--model", model_path,
            "--espeak_data", ESPEAK_DATA,
            "--length_scale", str(length_scale),
            "--sentence_silence", "0.25",
            "--output_file", out,
        ]
        p = subprocess.run(
            cmd, input=text.encode("utf-8"),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60,
        )
        if p.returncode != 0:
            return None
        with open(out, "rb") as f:
            return f.read()
    except Exception:
        return None
    finally:
        if out:
            try:
                os.unlink(out)
            except Exception:
                pass


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet; the app logs its own traffic
        pass

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def do_GET(self):
        if self.path.startswith("/healthz"):
            return self._send(200, "ok", "text/plain")
        if self.path.startswith("/voices"):
            vs = [{"id": v["id"], "label": v["label"], "lang": v["lang"]} for v in VOICES.values()]
            dv = DEFAULT if DEFAULT in VOICES else next(iter(VOICES), "")
            return self._send(200, {"voices": vs, "default": dv})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/tts"):
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send(400, {"error": "invalid JSON"})
        text = (req.get("text") or "").strip()[:MAX_CHARS]
        if not text:
            return self._send(400, {"error": "text required"})
        vid = req.get("voice") or DEFAULT
        v = VOICES.get(vid) or VOICES.get(DEFAULT) or next(iter(VOICES.values()), None)
        if not v:
            return self._send(503, {"error": "no voices installed"})
        try:
            rate = float(req.get("rate") or 1.0)
        except Exception:
            rate = 1.0
        rate = min(2.0, max(0.5, rate))
        length_scale = 1.0 / rate  # piper: larger length_scale => slower speech
        wav = synth(v["path"], text, length_scale)
        if wav is None:
            return self._send(500, {"error": "synthesis failed"})
        return self._send(200, wav, "audio/wav")


if __name__ == "__main__":
    ids = ", ".join(VOICES) or "(none)"
    print(f"jarvis-piper: {len(VOICES)} voice(s) [{ids}], default={DEFAULT}, listening on :{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
