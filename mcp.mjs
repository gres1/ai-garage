#!/usr/bin/env node
// AI Garage — MCP server. Даёт ИИ-агентам (Claude Code, Cursor, …) управлять localhost:
// посмотреть что запущено (включая то, что наспавнили агенты), освободить занятый порт,
// открыть/закрыть публичную ссылку — через локальный API запущенной панели AI Garage.
// Ноль зависимостей: сырой JSON-RPC по stdio (как и сам сервер панели).
import http from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.AIGARAGE_PORT) || 7777;
const CFG = join(homedir(), ".config", "localhost-control", "config.json");
async function token() { try { return JSON.parse(await readFile(CFG, "utf8")).token || ""; } catch { return ""; } }

function api(method, path, body) {
  return new Promise(async (resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path, method,
        headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${PORT}`, "x-control-token": await token(),
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve({ raw: b }); } }); });
    req.on("error", () => reject(new Error(`AI Garage panel is not running on http://127.0.0.1:${PORT} — start it (npx ai-garage)`)));
    if (data) req.write(data);
    req.end();
  });
}

const TOOLS = [
  { name: "list_services", description: "List everything running on this machine: saved services + auto-discovered listening ports (port, pid, command, category, and a 'safe' flag for system/database processes you should not kill). Use to see what is up — including processes that AI agents spawned and left behind.", inputSchema: { type: "object", properties: {} } },
  { name: "free_port", description: "Free a TCP port by stopping whatever listens on it (graceful SIGTERM, then SIGKILL after a moment). Refuses the panel's own port. Check the 'safe' flag from list_services first — killing a system/database port can lose data.", inputSchema: { type: "object", properties: { port: { type: "number", description: "TCP port to free" } }, required: ["port"] } },
  { name: "open_tunnel", description: "Create a public link (cloudflared) to a local port so it can be opened from a phone or shared. Returns the public https URL once it comes up.", inputSchema: { type: "object", properties: { port: { type: "number", description: "local port to expose" } }, required: ["port"] } },
  { name: "close_tunnel", description: "Close the public link for a port.", inputSchema: { type: "object", properties: { port: { type: "number" } }, required: ["port"] } },
];

async function call(name, args) {
  if (name === "list_services") {
    const s = await api("GET", "/api/status");
    return {
      services: (s.services || []).map((x) => ({ name: x.name, port: x.port, up: x.up, host: x.host, tunnel: x.tunnel || null })),
      discovered: (s.discovered || []).map((d) => ({ port: d.port, pid: d.pid, command: d.command, category: d.cat, safe: d.safe })),
    };
  }
  if (name === "free_port") return api("POST", "/api/kill-port", { port: args.port });
  if (name === "close_tunnel") return api("POST", "/api/tunnel-stop", { port: args.port });
  if (name === "open_tunnel") {
    await api("POST", "/api/tunnel-start", { port: args.port });
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const s = await api("GET", "/api/status");
      const hit = [...(s.services || []), ...(s.discovered || [])].find((x) => x.port === args.port && x.tunnel);
      if (hit) return { ok: true, url: hit.tunnel };
    }
    return { ok: true, note: "tunnel is coming up — call list_services again shortly to get the url" };
  }
  throw new Error("unknown tool: " + name);
}

// ── минимальный MCP: JSON-RPC 2.0, построчно по stdio ──
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
let buf = "";
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "ai-garage", version: "0.1.0" } } });
    } else if (m.method === "tools/list") {
      send({ jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } });
    } else if (m.method === "tools/call") {
      try { const out = await call(m.params.name, m.params.arguments || {}); send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] } }); }
      catch (e) { send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "error: " + e.message }], isError: true } }); }
    } else if (m.id !== undefined && m.method) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
    }
  }
});
process.stdin.resume();
