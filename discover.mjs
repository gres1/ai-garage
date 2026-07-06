// discover.mjs — auto-discovery of a user's AI clients + the MCP servers/services each can reach.
// Builds the access-grantee graph (consumer -> service) from LIVE client configs. Zero-dep, read-only.
// SECURITY: never emits secret VALUES — only env-var NAMES. Identity is built ONLY from package/host
// shapes, never from raw arg/url strings (which can carry positional tokens). Every parse is try/caught
// and size-capped so a broken/foreign/huge config can never crash or hang the panel.
//
// CLI:  node discover.mjs snapshot  → prints {consumers, services, grants, blindSpots} as JSON

import { readFile, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const sha1 = (s) => createHash("sha1").update(String(s)).digest("hex").slice(0, 16);

const H = homedir();
const OS = platform(); // 'darwin' | 'win32' | 'linux'
const MAX_CFG = 4e6;   // skip configs larger than 4MB (real MCP configs are KBs)

const CLIENTS = [
  { id: "claude-code",    label: "Claude Code",    key: "mcpServers",      paths: [join(H, ".claude.json")] },
  { id: "cursor",         label: "Cursor",         key: "mcpServers",      paths: [join(H, ".cursor", "mcp.json")] },
  { id: "claude-desktop", label: "Claude Desktop", key: "mcpServers",      paths: [
      join(H, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
      join(H, "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
      join(H, ".config", "Claude", "claude_desktop_config.json") ] },
  { id: "antigravity",    label: "Antigravity",    key: "mcpServers",      paths: [
      join(H, ".gemini", "antigravity", "mcp_config.json"), join(H, ".antigravity", "mcp_config.json") ] },
  { id: "vscode",         label: "VS Code",        key: "servers",         paths: [
      join(H, "Library", "Application Support", "Code", "User", "mcp.json"),
      join(H, ".config", "Code", "User", "mcp.json"),
      join(H, "AppData", "Roaming", "Code", "User", "mcp.json") ] },
  { id: "windsurf",       label: "Windsurf",       key: "mcpServers",      paths: [join(H, ".codeium", "windsurf", "mcp_config.json")] },
  { id: "zed",            label: "Zed",            key: "context_servers", paths: [join(H, ".config", "zed", "settings.json")] },
  { id: "lmstudio",       label: "LM Studio",      key: "mcpServers",      paths: [join(H, ".lmstudio", "mcp.json")] },
];

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

// strip // line + /* block */ comments and trailing commas, RESPECTING string literals (a blanket
// regex would corrupt "//" inside a string value and silently drop that whole config).
function stripJsonc(s) {
  let out = "", inStr = false, esc = false, i = 0;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (inStr) { out += c; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++; i += 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}
function parseJsonc(txt) {
  try { return JSON.parse(txt); } catch {}
  try { return JSON.parse(stripJsonc(txt)); } catch { return null; }
}

// Zed nests { command:{path,args,env} }; everyone else is flat. args coerced to array (a string/object
// value would otherwise crash .find downstream).
function normalizeServer(raw) {
  const c = raw && typeof raw.command === "object" && raw.command ? raw.command : raw;
  return { command: (typeof c.command === "object" ? c.path : raw.command) ?? c.path,
    args: Array.isArray(c.args) ? c.args : [], env: (c.env && typeof c.env === "object") ? c.env : {},
    url: raw.url, type: raw.type };
}

// A value that is a package/host spec — NOT a token. Guarantees no secret arg reaches a client-visible id.
const PKG_SHAPE = /^(@?[\w.-]+\/)?[\w.-]+$/;
const TOKENISH = /^(sk|pk|ghp|gho|xox|ak_|uak_|Bearer|eyJ|AIza|hf_|glpat)/i;
const safePkg = (a) => { const v = String(a || ""); return !!v && !v.startsWith("-") && v.length <= 40 && PKG_SHAPE.test(v) && !TOKENISH.test(v) && !/[A-Za-z0-9]{24,}/.test(v); };
// host from a malformed url WITHOUT query/hash/userinfo/path (those carry inline secrets)
const safeHost = (u) => String(u).split(/[?#\s]/)[0].replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^/@]*@/, "").split("/")[0] || "invalid";

function identityOf(s) {
  if (s.url) { try { return "url:" + new URL(s.url).hostname; } catch { return "url:" + safeHost(s.url); } }
  const pkg = (s.args || []).find(safePkg) || "";
  return "cmd:" + (s.command || "") + " " + pkg;
}
function transportOf(s) { return s.type || (s.url ? "http" : "stdio"); }
function providerOf(name, s) {
  if (s.url) { try { return new URL(s.url).hostname.replace(/^mcp\./, "").replace(/\.(com|dev|app|ai|io|net)$/, ""); } catch { return name; } }
  const pkg = (s.args || []).find(safePkg) || (safePkg(s.command) ? s.command : name);
  return String(pkg).replace(/^@[^/]+\//, "").replace(/mcp[-_]?server[-_]?/gi, "").replace(/[-_]?mcp$/gi, "").replace(/@.*/, "") || name;
}
// env-var NAMES only (never values)
function keyNamesOf(s) {
  return Object.keys(s.env || {}).map((n) => ({ name: n, set: !!(s.env[n] && String(s.env[n]).length > 2) }));
}

async function scan() {
  const consumers = [];
  const svcMap = new Map();
  const blindSpots = [];

  for (const cl of CLIENTS) {
    let path = null;
    for (const p of cl.paths) { if (await exists(p)) { path = p; break; } }
    if (!path) continue;

    try { const st = await stat(path); if (st.size > MAX_CFG) { blindSpots.push(`${cl.label}: конфиг ${Math.round(st.size / 1e6)}MB — пропущен (слишком большой)`); continue; } } catch {}

    let raw = null;
    try { raw = parseJsonc(await readFile(path, "utf8")); } catch { blindSpots.push(`${cl.label}: файл нечитаем`); continue; }
    if (!raw || typeof raw !== "object") { blindSpots.push(`${cl.label}: конфиг не распарсился (JSONC/битый)`); continue; }

    const map = raw[cl.key] || raw.mcpServers || raw.servers || raw.context_servers || {};
    const names = (map && typeof map === "object") ? Object.keys(map) : [];
    consumers.push({ id: cl.id, label: cl.label, configPath: path.replace(H, "~"), configPathAbs: path, key: cl.key, os: OS, count: names.length });
    if (!names.length) { blindSpots.push(`${cl.label}: установлен, но MCP-серверы не настроены`); continue; }

    for (const name of names) {
      try {
        const s = normalizeServer(map[name] || {});
        const id = identityOf(s);
        let svc = svcMap.get(id);
        if (!svc) { svc = { id, label: name, transport: transportOf(s), identity: id, names: new Set(), grantedBy: [], keyNames: [], sources: [] }; svcMap.set(id, svc); }
        svc.names.add(name);
        svc.label = providerOf(name, s) || svc.label;
        if (!svc.grantedBy.includes(cl.id)) svc.grantedBy.push(cl.id);
        svc.sources.push({ client: cl.id, name, def: s });   // server-side only — не уходит в публичный ответ
        for (const k of keyNamesOf(s)) if (!svc.keyNames.some((x) => x.name === k.name)) svc.keyNames.push(k);
      } catch { continue; }
    }
  }

  blindSpots.push("Cursor/Zed: 'настроен' ≠ 'включён сейчас' (тумблер в UI не читается)");
  blindSpots.push("Один сервис с двумя аккаунтами (разные токены, тот же пакет/хост) — одна карточка (сервис, не аккаунт)");
  blindSpots.push("Cline/Roo/Continue: не парсим (globalStorage / YAML) — MVP");
  return { consumers, svcMap, blindSpots };
}

// Публичный ответ (для /api/conn/access): id хеширован, raw identity/def/абс.пути НЕ уходят наружу.
export async function discover() {
  const { consumers, svcMap, blindSpots } = await scan();
  const services = [...svcMap.values()]
    .map((s) => ({ id: "id:" + sha1(s.id), label: [...s.names][0] || s.label, transport: s.transport,
      grantedBy: s.grantedBy, keyNames: s.keyNames, aliases: [...s.names] }))
    .sort((a, b) => b.grantedBy.length - a.grantedBy.length);

  const grants = [];
  for (const s of services) for (const c of s.grantedBy) grants.push({ consumerId: c, serviceId: s.id });

  const pubConsumers = consumers.map(({ configPathAbs, key, ...c }) => c);
  return { ts: Date.now(), consumers: pubConsumers, services, grants, blindSpots,
    counts: { clients: pubConsumers.length, services: services.length, grants: grants.length } };
}

// Полная картина для СЕРВЕРНОЙ записи грантов (grant.mjs). Никогда не отдавать клиенту как есть.
export async function discoverFull() {
  const { consumers, svcMap } = await scan();
  const services = [...svcMap.values()].map((s) => ({
    id: "id:" + sha1(s.id), names: [...s.names], grantedBy: s.grantedBy, transport: s.transport, sources: s.sources,
  }));
  return { consumers, services };
}

if (process.argv[2] === "snapshot") {
  discover().then((r) => { process.stdout.write(JSON.stringify(r, null, 2)); process.exit(0); });
}
