// conn.mjs — Connections health engine for AI Garage.
// Data-driven from connections.json. Read-only: pings provider APIs, never writes secrets.
// Reuses the health matrix from ~/.config/claude/check-keys.sh, plus composio accounts,
// `claude mcp list`, and bot /health. Node 18+ (global fetch).
//
// CLI:  node conn.mjs snapshot   → prints checkAll() result as JSON (for baking a preview file)

import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import http from "node:http";
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(homedir(), ".config", "claude", ".env");
const CONN_PATH = join(HERE, "connections.json");
const CFG_DIR = join(homedir(), ".config", "localhost-control");
const CFG_PATH = join(CFG_DIR, "config.json");
const COMPOSIO = "https://backend.composio.dev/api/v3.1";  // v3.1: v3 initiate retired 2026-07-03

// Stable per-install composio user_id — never "default" (that leaks tokens across a shared project + phantom dupes).
async function getComposioUserId() {
  try { const c = JSON.parse(await readFile(CFG_PATH, "utf8")); if (c.composioUserId) return c.composioUserId; } catch {}
  const id = "aigarage-" + randomUUID();
  try {
    await mkdir(CFG_DIR, { recursive: true });
    let c = {}; try { c = JSON.parse(await readFile(CFG_PATH, "utf8")); } catch {}
    c.composioUserId = id;
    await writeFile(CFG_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
  } catch {}
  return id;
}

// --- env (values stay in memory only; never returned to the client) ---
function readEnv() {
  let txt = "";
  try { txt = readFileSync(ENV_PATH, "utf8"); } catch { return {}; }
  const m = {};
  for (const line of txt.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    m[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return m;
}
const subst = (s, env) => String(s).replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => env[k] ?? "");
const hasAll = (keys, env) => (keys || []).every((k) => env[k] && env[k].length > 3);

// --- one HTTP health probe → status code (0 = timeout, -1 = network error) ---
async function probe(h, env) {
  const url = subst(h.url, env);
  const headers = {};
  for (const [k, v] of Object.entries(h.headers || {})) headers[k] = subst(v, env);
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), h.timeout || 6000);
  try {
    const res = await fetch(url, {
      method: h.method || "GET",
      headers,
      body: h.body ? JSON.stringify(h.body) : undefined,
      signal: ctrl.signal,
      redirect: "manual",
    });
    return res.status;
  } catch (e) {
    return e.name === "AbortError" ? 0 : -1;
  } finally {
    clearTimeout(to);
  }
}

function classify(code, h) {
  const ok = h.okCodes || [200];
  const warn = h.warnCodes || [];
  if (ok.includes(code)) return { status: "ok", detail: `работает · ${code}` };
  if (warn.includes(code)) return { status: "warn", detail: `ключ жив, но ${code}` };
  if (code === 0) return { status: "dead", detail: "не отвечает · timeout" };
  if (code === -1) return { status: "dead", detail: "сеть недоступна" };
  if (code === 401 || code === 403) return { status: "dead", detail: `ключ протух · ${code}` };
  return { status: "dead", detail: `ошибка · ${code}` };
}

// --- composio v3.1 REST ---
async function composioRaw(path, env, method = "GET", body) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${COMPOSIO}${path}`, {
      method,
      headers: { "x-api-key": env.COMPOSIO_API_KEY, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const j = await res.json().catch(() => ({}));
    return { code: res.status, ok: res.ok, json: j };
  } catch (e) {
    return { code: e.name === "AbortError" ? 0 : -1, ok: false, json: {}, error: e.message };
  } finally { clearTimeout(to); }
}
const listItems = (j) => { const a = j && (j.items || j.data); return Array.isArray(a) ? a : (Array.isArray(j) ? j : []); };

// composio 7 raw statuses → UI verb
const CX_STATE = {
  ACTIVE: "ok", INITIALIZING: "warn", INITIATED: "warn",
  EXPIRED: "warn", INACTIVE: "warn", FAILED: "dead", REVOKED: "dead",
};

async function checkComposio(env) {
  if (!env.COMPOSIO_API_KEY) return { status: "unknown", detail: "нет COMPOSIO_API_KEY" };
  if (String(env.COMPOSIO_API_KEY).startsWith("uak_")) return { status: "warn", detail: "ключ uak_ (CLI) — для REST нужен ak_ (project key)" };
  const tkr = await composioRaw("/toolkits?limit=1", env);
  if (tkr.code !== 200) return classify(tkr.code, { okCodes: [200] }); // ключ мёртв — дальше не идём

  const [acc, cfg] = await Promise.all([composioRaw("/connected_accounts?limit=100", env), composioRaw("/auth_configs?limit=100", env)]);
  const accounts = listItems(acc.json);
  const total = accounts.length;
  const active = accounts.filter((a) => (a.status || "").toUpperCase() === "ACTIVE").length;

  // подключаемые сервисы = auth_configs, с числом реальных подключений по каждому
  const configs = listItems(cfg.json).map((c) => {
    const slug = c.toolkit?.slug || c.toolkit_slug || c.app_name || c.name || "service";
    const conns = accounts.filter((a) => (a.toolkit?.slug || a.toolkit_slug) === slug);
    const act = conns.filter((a) => (a.status || "").toUpperCase() === "ACTIVE").length;
    return {
      slug, id: c.id || c.nano_id || null,
      managed: c.is_composio_managed !== false,
      connections: conns.length, active: act,
      status: act > 0 ? "ok" : conns.length > 0 ? "warn" : "dead",
    };
  });

  // дедуп настроенных сервисов по slug (miro бывает в 2 auth_config → одна строка)
  const bySlug = new Map();
  for (const c of configs) {
    const e = bySlug.get(c.slug) || { slug: c.slug, id: c.id, managed: c.managed, connections: 0, active: 0 };
    e.connections += c.connections; e.active += c.active; e.id = e.id || c.id;
    e.status = e.active > 0 ? "ok" : e.connections > 0 ? "warn" : "dead";
    bySlug.set(c.slug, e);
  }
  const uniqConfigs = [...bySlug.values()];
  const cli = await composioCli();

  const detail = total === 0
    ? `ключ валиден, но ни один сервис не подключён (${uniqConfigs.length} настроено)`
    : `${active} из ${total} подключений активны`;
  const status = active > 0 ? "ok" : "warn";
  return { status, detail, extra: { total, active, configs: uniqConfigs, cli } };
}

// composio CLI login state (uak_) — separate from the ak_ REST key. Best-effort; not everyone has the CLI.
function composioCli() {
  return new Promise((resolve) => {
    exec("composio whoami", { timeout: 5000 }, (err, out = "") => {
      if (err) return resolve({ installed: false });
      try { const j = JSON.parse(out); resolve({ installed: true, loggedIn: !!j.email }); }
      catch { resolve({ installed: true, loggedIn: false }); }
    });
  });
}

// --- MCP servers: parse `claude mcp list` ---
function checkMcp() {
  return new Promise((resolve) => {
    exec("claude mcp list", { timeout: 20000 }, (err, stdout = "") => {
      const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.includes(" - "));
      const servers = lines.map((l) => {
        const name = l.split(":")[0].trim();
        const connected = /Connected/i.test(l);
        const needsAuth = /Needs authentication/i.test(l);
        return { name, status: connected ? "ok" : needsAuth ? "warn" : "dead" };
      }).filter((s) => s.name);
      if (!servers.length) return resolve({ status: "unknown", detail: "claude mcp list пуст/недоступен", extra: { servers: [] } });
      const bad = servers.filter((s) => s.status === "dead");
      const warn = servers.filter((s) => s.status === "warn");
      const ok = servers.filter((s) => s.status === "ok").length;
      const status = bad.length ? "dead" : warn.length ? "warn" : "ok";
      const detail = bad.length ? `${bad.length} упали: ${bad.map((s) => s.name).join(", ")}`
        : warn.length ? `${ok} connected · ${warn.length} нужна авторизация`
        : `${ok} connected`;
      resolve({ status, detail, extra: { servers } });
    });
  });
}

// --- bot /health on a host:port ---
function checkBot(host, port) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/health", timeout: 2500 }, (r) => {
      r.resume();
      resolve(r.statusCode === 200
        ? { status: "ok", detail: `онлайн · ${host}:${port}` }
        : { status: "warn", detail: `отвечает ${r.statusCode} · ${host}:${port}` });
    });
    req.on("error", () => resolve({ status: "unknown", detail: `не достучались · ${host}:${port}` }));
    req.on("timeout", () => { req.destroy(); resolve({ status: "unknown", detail: `таймаут · ${host}:${port}` }); });
  });
}

export async function loadConn() {
  // user-scoped override survives updates; repo file is only a seed/template
  for (const p of [join(CFG_DIR, "connections.json"), CONN_PATH, join(HERE, "connections.example.json")]) {
    try { return JSON.parse(await readFile(p, "utf8")); } catch {}
  }
  return { version: 1, items: [] };
}

// list without values — for /api/conn/list
export async function connList() {
  const cfg = await loadConn();
  const env = readEnv();
  return cfg.items.map((it) => ({
    id: it.id, label: it.label, group: it.group,
    hasKey: it.env ? hasAll(it.env, env) : true,
    dashboard: it.dashboard || null, reconnect: it.reconnect || null,
  }));
}

// run all health checks in parallel — for /api/conn/check
export async function connCheck() {
  const cfg = await loadConn();
  const env = readEnv();
  const results = await Promise.all(cfg.items.map(async (it) => {
    const base = { id: it.id, label: it.label, group: it.group, dashboard: it.dashboard || null, reconnect: it.reconnect || null };
    try {
      if (it.special === "composio") return { ...base, ...(await checkComposio(env)) };
      if (it.special === "mcp") return { ...base, ...(await checkMcp()) };
      if (it.special === "bot") return { ...base, ...(await checkBot(it.host || "127.0.0.1", it.port)) };
      if (it.health) {
        if (it.env && !hasAll(it.env, env)) return { ...base, status: "unknown", detail: "нет ключа в .env" };
        const code = await probe(it.health, env);
        return { ...base, ...classify(code, it.health) };
      }
      return { ...base, status: "unknown", detail: "нет health-чека" };
    } catch (e) {
      return { ...base, status: "dead", detail: `ошибка чека: ${e.message}` };
    }
  }));
  const tally = results.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
  return { ts: Date.now(), tally, items: results };
}

// initiate a composio OAuth connection → returns redirect_url + connected_account_id to complete consent
export async function composioConnect(authConfigId, slug) {
  const env = readEnv();
  if (!env.COMPOSIO_API_KEY) return { error: "нет COMPOSIO_API_KEY" };
  if (String(env.COMPOSIO_API_KEY).startsWith("uak_")) return { error: "ключ uak_ (CLI); для REST нужен ak_ (project key)" };
  if (slug != null && !/^[a-z0-9_-]{2,40}$/i.test(String(slug))) return { error: "недопустимый slug" };
  if (authConfigId != null && !/^[a-zA-Z0-9_-]{2,60}$/.test(String(authConfigId))) return { error: "недопустимый auth_config_id" };
  const userId = await getComposioUserId();

  let acId = authConfigId;
  if (!acId && slug) {                                       // резолвим auth_config по slug
    const r = await composioRaw(`/auth_configs?toolkit_slug=${encodeURIComponent(slug)}`, env);
    acId = listItems(r.json)[0]?.id || listItems(r.json)[0]?.nano_id || null;
    if (!acId) {                                             // нет — создаём composio-managed (свой client_id не нужен)
      const c = await composioRaw("/auth_configs", env, "POST", { toolkit: { slug }, auth_config: { type: "use_composio_managed_auth" } });
      acId = c.json?.id || c.json?.auth_config?.id || c.json?.nano_id || null;
      if (!acId) return { error: `не создался auth_config для ${slug} · ${c.code}`, detail: c.json?.message || null };
    }
  }
  if (!acId) return { error: "нет auth_config_id и slug" };

  // v3.1 link: пробуем плоскую форму, при 400/422 — вложенную (совместимость форматов)
  let r = await composioRaw("/connected_accounts/link", env, "POST", { auth_config_id: acId, user_id: userId });
  if (!r.ok && (r.code === 400 || r.code === 422)) {
    r = await composioRaw("/connected_accounts/link", env, "POST", { auth_config_id: acId, connection: { user_id: userId } });
  }
  if (!r.ok) return { error: `composio ${r.code}`, detail: r.json?.message || r.json?.error || null };
  const j = r.json;
  return {
    redirect_url: j.redirect_url || j.redirectUrl || j.connectionData?.redirectUrl || j.redirect_uri || null,
    connected_account_id: j.id || j.nano_id || j.connected_account_id || j.connectedAccountId || null,
    status: (j.status || "INITIATED").toUpperCase(),
  };
}

// poll one composio connection's status → mapped UI verb (for the connect flow)
export async function connStatus(id) {
  const env = readEnv();
  if (!env.COMPOSIO_API_KEY || !id) return { error: "нет ключа или id" };
  const r = await composioRaw(`/connected_accounts/${encodeURIComponent(id)}`, env);
  if (r.code !== 200) return { error: `composio ${r.code}` };
  const raw = (r.json.status || "").toUpperCase();
  return { raw, ui: CX_STATE[raw] || "warn", terminal: ["ACTIVE", "FAILED", "REVOKED", "EXPIRED", "INACTIVE"].includes(raw) };
}

// весь каталог composio-сервисов (для «+ подключить любой»), с опц. поиском
export async function connToolkits(q) {
  const env = readEnv();
  if (!env.COMPOSIO_API_KEY) return { items: [], error: "нет COMPOSIO_API_KEY" };
  const r = await composioRaw("/toolkits?limit=500", env);
  if (r.code !== 200) return { items: [], error: `composio ${r.code}` };
  const items = listItems(r.json).map((t) => ({
    slug: t.slug || t.toolkit_slug || t.name || "",
    name: t.name || t.meta?.name || t.slug || "",
    categories: t.meta?.categories || t.categories || [],
  })).filter((t) => t.slug);
  const query = String(q || "").trim().toLowerCase();
  const list = query ? items.filter((t) => (t.slug + " " + t.name).toLowerCase().includes(query)) : items;
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { total: items.length, items: list };
}

// CLI: node conn.mjs snapshot
if (process.argv[2] === "snapshot") {
  connCheck().then((r) => { process.stdout.write(JSON.stringify(r, null, 2)); process.exit(0); });
}
