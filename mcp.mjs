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
  { name: "register_service", description: "Register a localhost service you just started so AI Garage shows it as a controllable card and its On/Off button + keep-alive work — even after a reboot. Call this right after you spawn a dev server or app, passing the exact command and working directory you used. This is how you make a service you started manageable without the user configuring anything.", inputSchema: { type: "object", properties: { name: { type: "string", description: "friendly name, e.g. 'insight-landing'" }, port: { type: "number", description: "TCP port it listens on" }, command: { type: "string", description: "the exact start command you ran, e.g. 'npm run dev' or 'node server.js' or 'pm2 start insight-landing'" }, cwd: { type: "string", description: "absolute working directory the command runs in" }, url: { type: "string", description: "optional, defaults to http://localhost:<port>" } }, required: ["port", "command"] } },
  { name: "connections_overview", description: "Access map: which AI clients (Claude Code, Cursor, Claude Desktop, Antigravity, VS Code, Windsurf, LM Studio…) have access to which MCP services on this machine. Auto-discovered from their live configs. Use before granting/revoking, or to answer 'у кого есть доступ к X'.", inputSchema: { type: "object", properties: {} } },
  { name: "connections_health", description: "Health of the user's external connections: API keys (works / expired / out of credits), composio hub (per-service: connected or not), MCP servers, bots. Use to answer 'работает ли ключ X' or before using a provider.", inputSchema: { type: "object", properties: {} } },
  { name: "grant_access", description: "Give or revoke an AI client's access to an MCP service (the вкл/выкл in the Connections tab). Config is backed up before every write; Claude Code goes through `claude mcp add/remove`. The client app must be restarted to pick the change up. service = name as shown in connections_overview (e.g. 'github', 'n8n').", inputSchema: { type: "object", properties: { service: { type: "string", description: "service name/alias from connections_overview" }, client: { type: "string", description: "one of: claude-code, cursor, claude-desktop, antigravity, vscode, windsurf, lmstudio" }, enable: { type: "boolean", description: "true = give access, false = revoke" } }, required: ["service", "client", "enable"] } },
  { name: "composio_connect", description: "Start connecting a service (github, notion, gmail, slack, telegram, x, linkedin, miro, youtube, googlesheets…) through the composio hub. Returns a redirect_url — SHOW IT TO THE USER: a human must open it and click Approve (OAuth consent). Then the connection becomes ACTIVE for all agents using composio.", inputSchema: { type: "object", properties: { service: { type: "string", description: "composio toolkit slug, e.g. 'github', 'notion', 'gmail'" } }, required: ["service"] } },
];

async function call(name, args) {
  if (name === "list_services") {
    const s = await api("GET", "/api/status");
    return {
      services: (s.services || []).map((x) => ({ name: x.name, port: x.port, up: x.up, host: x.host, tunnel: x.tunnel || null })),
      discovered: (s.discovered || []).map((d) => ({ port: d.port, pid: d.pid, command: d.command, category: d.cat, safe: d.safe })),
    };
  }
  if (name === "register_service") return api("POST", "/api/register", { name: args.name, port: args.port, command: args.command, cwd: args.cwd, url: args.url });
  if (name === "connections_overview") {
    const a = await api("GET", "/api/conn/access");
    return { clients: a.consumers, services: (a.services || []).map((s) => ({ name: s.label, aliases: s.aliases, transport: s.transport, grantedTo: s.grantedBy })), blindSpots: a.blindSpots };
  }
  if (name === "connections_health") {
    const h = await api("GET", "/api/conn/check");
    return { checkedAt: h.ts, tally: h.tally, items: (h.items || []).map((i) => ({ name: i.label, group: i.group, status: i.status, detail: i.detail, composio: i.extra?.configs || undefined })) };
  }
  if (name === "grant_access") {
    const a = await api("GET", "/api/conn/access");
    const q = String(args.service || "").toLowerCase();
    const svc = (a.services || []).find((s) => s.label.toLowerCase() === q || (s.aliases || []).some((x) => x.toLowerCase() === q));
    if (!svc) return { ok: false, error: `service '${args.service}' not found — call connections_overview for exact names` };
    return api("POST", "/api/conn/grant", { serviceId: svc.id, clientId: args.client, enable: !!args.enable });
  }
  if (name === "composio_connect") {
    const r = await api("POST", "/api/conn/composio-connect", { slug: args.service });
    if (r.redirect_url) return { ...r, note: "SHOW redirect_url to the user — a human must open it and approve. Poll connections_health to see it become ACTIVE." };
    return r;
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
