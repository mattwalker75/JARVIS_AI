"use strict";
// Minimal MCP client (Model Context Protocol, Streamable HTTP transport) so external
// tool servers can be plugged into JARVIS without writing integration code. Configure:
//   "mcp": { "servers": [ { "name": "github", "url": "http://host:port/mcp",
//                           "headers": {"Authorization": "Bearer ..."} } ] }
// Each server's tools are registered as mcp_<server>_<tool> at startup (restart to
// pick up config changes). HTTP transport only — stdio servers are out of scope.
const { config } = require("./config");

const ext = [];          // [{server, tool, def}]
const sessions = {};     // server name -> Mcp-Session-Id
let rpcId = 1;

async function rpc(server, method, params) {
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

// Connect to each configured server and collect its tools. Failures are logged and
// skipped — a dead MCP server must never block JARVIS from starting.
async function init() {
  const servers = (config.mcp && config.mcp.servers) || [];
  for (const s of servers) {
    if (!s || !s.name || !s.url) continue;
    try {
      await rpc(s, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "jarvis", version: "1.0" },
      });
      await notify(s, "notifications/initialized");
      const res = await rpc(s, "tools/list");
      for (const t of (res && res.tools) || []) {
        const name = `mcp_${s.name}_${t.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
        ext.push({ server: s, tool: t.name, def: { type: "function", function: {
          name,
          description: `[external: ${s.name}] ${(t.description || t.name).slice(0, 900)}`,
          parameters: t.inputSchema || { type: "object", properties: {} },
        } } });
      }
      console.log(`MCP: connected '${s.name}' (${((res && res.tools) || []).length} tools)`);
    } catch (e) {
      console.log(`MCP: server '${s.name}' unavailable: ${e.message}`);
    }
  }
  return ext.map((t) => t.def);
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

module.exports = { init, has, call };
