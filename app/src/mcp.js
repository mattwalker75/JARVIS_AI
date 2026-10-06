"use strict";
// Minimal MCP client (Model Context Protocol, Streamable HTTP transport) so external
// tool servers can be plugged into JARVIS without writing integration code. Configure:
//   "mcp": { "servers": [ { "name": "github", "url": "http://host:port/mcp",
//                           "headers": {"Authorization": "Bearer ..."} } ] }
// Each server's tools are registered as mcp_<server>_<tool> at startup; saving the config
// (or POST /api/tools/reload) re-handshakes the server list, so no restart is needed. An
// expired session is re-initialized automatically. HTTP transport only — stdio servers are
// out of scope.
const { config } = require("./config");

const ext = [];          // [{server, tool, def}]
const sessions = {};     // server name -> Mcp-Session-Id
let rpcId = 1;

async function rpc(server, method, params, retried) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    ...(server.headers || {}),
  };
  if (sessions[server.name]) headers["Mcp-Session-Id"] = sessions[server.name];
  const r = await fetch(server.url, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params: params || {} }),
    signal: AbortSignal.timeout(30000),
  });
  const sid = r.headers.get("mcp-session-id");
  if (sid) sessions[server.name] = sid;
  // 404 with a session id = the server forgot our session (it restarted, or the session
  // expired). Per the MCP spec: start a new session and send the request once more.
  if (r.status === 404 && headers["Mcp-Session-Id"] && !retried && method !== "initialize") {
    try { await r.body?.cancel(); } catch (_) {}
    delete sessions[server.name];
    await handshake(server);
    return await rpc(server, method, params, true);
  }
  const ct = r.headers.get("content-type") || "";
  let msg;
  if (ct.includes("text/event-stream")) {
    // The response may arrive as SSE — take the last JSON-RPC message with our shape.
    const text = await r.text();
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try { const j = JSON.parse(line.slice(5).trim()); if (j.jsonrpc) msg = j; } catch (_) {}
    }
    if (!msg) throw new Error("no JSON-RPC message in SSE response");
  } else {
    if (!r.ok) throw new Error(`MCP HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    msg = await r.json();
  }
  if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error).slice(0, 200));
  return msg.result;
}

async function notify(server, method) {
  const headers = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", ...(server.headers || {}) };
  if (sessions[server.name]) headers["Mcp-Session-Id"] = sessions[server.name];
  await fetch(server.url, {
    method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => {});
}

async function handshake(s) {
  await rpc(s, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "jarvis", version: "1.0" },
  });
  await notify(s, "notifications/initialized");
}

// Connect to each configured server and collect its tools. Failures are logged and
// skipped — a dead MCP server must never block JARVIS from starting.
// Each init/reload is a numbered generation: the startup handshake and a reload (config
// save) can overlap, and only the NEWEST one may publish its tools — an older one returns
// null instead of adding a second copy of every tool.
let generation = 0;
async function init() {
  const gen = ++generation;
  const servers = (config.mcp && config.mcp.servers) || [];
  const found = [];
  for (const s of servers) {
    if (!s || !s.name || !s.url) continue;
    try {
      await handshake(s);
      const res = await rpc(s, "tools/list");
      for (const t of (res && res.tools) || []) {
        const name = `mcp_${s.name}_${t.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
        if (found.some((x) => x.def.function.name === name)) { console.log(`MCP: skipped '${s.name}' tool '${t.name}' — the name ${name} is already taken`); continue; }
        found.push({ server: s, tool: t.name, def: { type: "function", function: {
          name,
          description: `[external: ${s.name}] ${(t.description || t.name).slice(0, 900)}`,
          parameters: t.inputSchema || { type: "object", properties: {} },
        } } });
      }
      console.log(`MCP: connected '${s.name}' (${((res && res.tools) || []).length} tools)`);
    } catch (e) {
      console.log(`MCP: server '${s.name}' unavailable: ${e.message}`);
    }
    if (gen !== generation) return null;   // a newer reload started — let it publish
  }
  if (gen !== generation) return null;
  ext.length = 0;
  ext.push(...found);
  return ext.map((t) => t.def);
}

// Re-handshake every configured server (config may have changed since startup) and
// rebuild the tool list. Used by the hot-reload path — a config save no longer needs an
// app restart to pick up added/removed MCP servers.
async function reload() {
  for (const k of Object.keys(sessions)) delete sessions[k];
  return await init();
}

function has(name) { return ext.some((t) => t.def.function.name === name); }

async function call(name, args) {
  const t = ext.find((x) => x.def.function.name === name);
  if (!t) throw new Error("unknown MCP tool: " + name);
  const res = await rpc(t.server, "tools/call", { name: t.tool, arguments: args || {} });
  const content = res && res.content;
  if (Array.isArray(content)) {
    const text = content.map((c) => (c && c.text) || JSON.stringify(c)).join("\n");
    return { result: text.slice(0, 15000), is_error: res.isError || undefined };
  }
  return res;
}

module.exports = { init, reload, has, call };
