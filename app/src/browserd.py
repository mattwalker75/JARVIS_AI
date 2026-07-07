#!/usr/bin/env python3
"""JARVIS browser daemon — deterministic DOM-level browser control for the agent.

Runs ONE persistent headed Chromium on the workbench desktop (DISPLAY=:1, so the
user can watch it work), with the profile stored under /workspace/.browser_profile
so logins/cookies survive restarts and rebuilds. Driven over HTTP from the app
container (POST / {"op": ...}); started lazily by the browser_* tools.

stdlib + playwright only (both present in the workbench image).
"""
import json
from http.server import HTTPServer, BaseHTTPRequestHandler
from playwright.sync_api import sync_playwright

PORT = 9251
pw = ctx = page = None
refs = {}   # ref id -> element handle from the LAST snapshot (stale after navigation)

INTERACTIVE = ("a[href], button, input, textarea, select, [role='button'], "
               "[role='link'], [role='tab'], [role='menuitem'], [role='checkbox'], "
               "[onclick], [contenteditable='true']")


def ensure_page():
    global pw, ctx, page
    if page is not None:
        try:
            if not page.is_closed():
                return page
        except Exception:
            pass
    if pw is None:
        pw = sync_playwright().start()
    if ctx is None:
        ctx = pw.chromium.launch_persistent_context(
            "/workspace/.browser_profile",
            headless=False,
            args=["--no-sandbox", "--window-size=1010,700", "--window-position=8,8"],
            viewport={"width": 1000, "height": 640},
        )
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    return page


def state(p):
    try:
        return {"url": p.url, "title": p.title()}
    except Exception:
        return {"url": p.url, "title": ""}


def snapshot():
    global refs
    p = ensure_page()
    refs = {}
    out = []
    for el in p.query_selector_all(INTERACTIVE):
        if len(out) >= 120:
            break
        try:
            if not el.is_visible():
                continue
            tag = el.evaluate("e => e.tagName.toLowerCase()")
            item = {"ref": "e%d" % len(out), "tag": tag}
            text = (el.inner_text() or "").strip()[:80]
            if not text and tag in ("input", "textarea"):
                text = (el.get_attribute("placeholder") or "")[:80]
            if text:
                item["text"] = text
            for attr, key in (("type", "type"), ("name", "name"), ("aria-label", "label")):
                v = el.get_attribute(attr)
                if v:
                    item[key] = v[:60]
            if tag == "a":
                href = el.get_attribute("href")
                if href:
                    item["href"] = href[:120]
            if tag in ("input", "textarea", "select"):
                try:
                    v = el.input_value()
                    if v:
                        item["value"] = v[:60]
                except Exception:
                    pass
            refs[item["ref"]] = el
            out.append(item)
        except Exception:
            continue
    body = ""
    try:
        body = p.inner_text("body")[:1500]
    except Exception:
        pass
    return {**state(p), "elements": out, "text_preview": body,
            "hint": "click/fill by ref (e.g. 'e3') or any CSS selector; refs go stale after navigation — re-snapshot"}


def target(p, t):
    """Resolve a ref from the last snapshot or treat as a CSS selector."""
    if t in refs:
        return refs[t]
    loc = p.locator(t).first
    loc.wait_for(state="visible", timeout=8000)
    return loc


def settle(p):
    try:
        p.wait_for_load_state("domcontentloaded", timeout=6000)
    except Exception:
        pass


def handle(d):
    op = d.get("op")
    p = ensure_page()
    if op == "goto":
        p.goto(d["url"], wait_until="domcontentloaded", timeout=30000)
        return state(p)
    if op == "snapshot":
        return snapshot()
    if op == "click":
        target(p, d["target"]).click(timeout=8000)
        settle(p)
        return {"clicked": d["target"], **state(p)}
    if op == "fill":
        el = target(p, d["target"])
        el.fill(d.get("text", ""), timeout=8000)
        if d.get("press_enter"):
            p.keyboard.press("Enter")
            settle(p)
        return {"filled": d["target"], **state(p)}
    if op == "press":
        p.keyboard.press(d.get("key", "Enter"))
        settle(p)
        return {"pressed": d.get("key", "Enter"), **state(p)}
    if op == "extract":
        sel = d.get("selector") or "body"
        text = p.inner_text(sel, timeout=8000)
        total = len(text)
        off = max(0, int(d.get("offset") or 0))
        out = {"selector": sel, "total_chars": total, "text": text[off:off + 15000], **state(p)}
        if total > off + 15000:
            out["note"] = "truncated — re-call with offset:%d" % (off + 15000)
        return out
    if op == "back":
        p.go_back(wait_until="domcontentloaded", timeout=15000)
        return state(p)
    raise ValueError("unknown op: %r" % op)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        self._send({"ok": True})

    def do_POST(self):
        try:
            ln = int(self.headers.get("Content-Length") or 0)
            d = json.loads(self.rfile.read(ln) or b"{}")
            self._send(handle(d))
        except Exception as e:
            self._send({"error": str(e).split("\n")[0][:300]})


if __name__ == "__main__":
    # Single-threaded on purpose: serializes all browser ops through one Playwright page.
    HTTPServer(("0.0.0.0", PORT), H).serve_forever()
