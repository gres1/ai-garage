#!/usr/bin/env node
// Localhost Control — лёгкая панель управления локальными сервисами.
// Без зависимостей: только встроенные модули Node. Слушает 127.0.0.1:7777.
import http from "node:http";
import { exec, execFile, spawn } from "node:child_process";
import { readFile, writeFile, mkdir, unlink, stat, rename, readdir } from "node:fs/promises";
import { openSync, readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 7777;
const CFG_DIR = join(homedir(), ".config", "localhost-control");
// Имя этого устройства по ОС (дефолт для host, чтобы не было «Mac» у всех)
const DEVICE = process.platform === "darwin" ? "Mac" : process.platform === "win32" ? "PC" : process.platform === "linux" ? "Linux" : (hostname() || "Local");
const SERVICES_PATH = join(CFG_DIR, "services.json");
const CONFIG_PATH = join(CFG_DIR, "config.json");

const expandHome = (p) => (p && p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
// Безопасность: порт — только целое 1..65535 (иначе null)
const toPort = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null; };
// XML-escape для plist (анти-инъекция)
const xmlEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

async function loadServices() {
  try { return JSON.parse(await readFile(SERVICES_PATH, "utf8")); } catch { return []; }
}
async function saveServices(list) {
  await mkdir(CFG_DIR, { recursive: true });
  // Атомарно: пишем во временный файл и переименовываем (+ .bak), чтобы обрыв не потерял сервисы
  try { await rename(SERVICES_PATH, SERVICES_PATH + ".bak"); } catch {}
  const tmp = SERVICES_PATH + ".tmp";
  await writeFile(tmp, JSON.stringify(list, null, 2));
  await rename(tmp, SERVICES_PATH);
}
// Сериализация мутаций реестра (анти-гонка add/remove)
let saveLock = Promise.resolve();
function withLock(fn) {
  const run = saveLock.then(fn, fn);
  saveLock = run.catch(() => {});
  return run;
}
async function loadConfig() {
  try { return JSON.parse(await readFile(CONFIG_PATH, "utf8")); } catch { return {}; }
}

// Пользовательские правки категорий для обнаруженных процессов (если авто-классификация ошиблась).
// Ключ — команда:порт; переживает смену pid. Системные/БД порты остаются защищёнными даже после правки.
const ALLOWED_CATS = new Set(["system", "db", "app", "dev", "agent", "unknown", "web", "api", "worker", "docker", "monitoring", "tunnel"]);
const CAT_PATH = join(CFG_DIR, "catoverrides.json");
const catKey = (command, port) => `${String(command).slice(0, 60)}:${port}`;
async function loadCatOverrides() { try { return JSON.parse(await readFile(CAT_PATH, "utf8")); } catch { return {}; } }
async function saveCatOverrides(ov) { await mkdir(CFG_DIR, { recursive: true }); await writeFile(CAT_PATH, JSON.stringify(ov, null, 2)); }
function applyCatOverride(d, base, overrides) {
  const ov = overrides[catKey(d.command, d.port)];
  if (!ov || !ALLOWED_CATS.has(ov)) return base;
  // правка меняет ЯРЛЫК, но защиту от kill НЕ снимает: если процесс изначально опознан как
  // небезопасный (system по имени, БД, низкий порт) — он остаётся guarded, какой бы ярлык ни выбрали.
  const newlyUnsafe = ov === "system" || ov === "db" || d.port < 1024 || DB_PORTS.has(d.port);
  const safe = base.safe === false ? false : !newlyUnsafe;
  return { cat: ov, label: base.label, safe, catOverridden: true };
}

function portUp(port) {
  return new Promise((resolve) => {
    const p = toPort(port);
    if (!p) return resolve(false);
    execFile("lsof", ["-ti", `tcp:${p}`, "-sTCP:LISTEN"], (e, out) => resolve(!!(out || "").trim()));
  });
}
async function tunnelUrl(svc) {
  if (!svc.tunnelLog || !svc.tunnelRegex) return null;
  try {
    const log = await readFile(expandHome(svc.tunnelLog), "utf8");
    const m = log.match(new RegExp(svc.tunnelRegex, "g"));
    return m ? m[m.length - 1] : null;
  } catch { return null; }
}
function runCmd(svc, which) {
  const cmd = which === "start" ? svc.startCmd : svc.stopCmd;
  if (!cmd) return Promise.resolve({ ok: false, error: "команда не задана" });
  const cwd = svc.cwd ? expandHome(svc.cwd) : homedir();
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: 25000, shell: "/bin/bash" }, (err, out, errout) => {
      if (err && err.killed) return resolve({ ok: true, note: "запущено (фоновый процесс)" });
      if (err) return resolve({ ok: false, error: (errout || err.message).slice(0, 400) });
      resolve({ ok: true, out: (out || "").slice(-400) });
    });
  });
}
// Старт + честная проверка: реально ли порт поднялся (а не ложный ✅)
async function startAndVerify(svc) {
  const r = await runCmd(svc, "start");
  if (!r.ok || !toPort(svc.port)) return r;
  for (let i = 0; i < 4; i++) {
    await new Promise((res) => setTimeout(res, 800));
    if (await portUp(svc.port)) return { ok: true, note: "запущено, порт отвечает" };
  }
  return { ok: true, note: "команда выполнена, но порт пока не отвечает — проверь статус" };
}

// Авто-обнаружение: все слушающие порты (даже не внесённые)
function discoverPorts() {
  return new Promise((resolve) => {
    exec(`lsof -nP -iTCP -sTCP:LISTEN`, (e, out) => {
      const map = new Map();
      (out || "").split("\n").slice(1).forEach((line) => {
        const p = line.trim().split(/\s+/);
        if (p.length < 9) return;
        const command = p[0], pid = +p[1];
        let port = null;
        for (const tok of p) { const m = tok.match(/:(\d+)$/); if (m) port = +m[1]; }
        if (!port) return;
        if (!map.has(port)) map.set(port, { port, pid, command });
      });
      resolve([...map.values()].sort((a, b) => a.port - b.port));
    });
  });
}

// Распознавание процессов: чтобы юзер понимал что это и не убил нужное
const KNOWN = {
  system: ["controlce", "rapportd", "mdnsrespo", "launchd", "sharingd", "spotlight", "syspolicy", "nsurlsess", "apsd", "cfprefsd", "secd", "trustd", "remoted", "coreaudio", "bluetoothd"],
  app: ["obsidian", "linear", "orbstack", "google", "chrome", "figma", "recordly", "antigravi", "spotify", "slack", "docker", "postman", "zoom", "telegram", "syncthing", "notion"],
  agent: ["claude", "cursor", "copilot", "ollama", "lmstudio"],
  dev: ["node", "python", "ruby", "java", "php", "deno", "bun", "vite", "webpack", "nginx", "caddy", "cli-proxy", "cliproxy", "stable"],
};
const DB_PORTS = new Set([5432, 5433, 3306, 27017, 6379, 5984, 9200, 1433, 11211]);
function classifyProcess(command, port) {
  const c = String(command || "").toLowerCase();
  if (DB_PORTS.has(port)) return { cat: "db", label: "база данных — осторожно", safe: false };
  for (const k of KNOWN.system) if (c.includes(k)) return { cat: "system", label: "системное — не трогать", safe: false };
  if (port < 1024) return { cat: "system", label: "системный порт — осторожно", safe: false };
  for (const k of KNOWN.agent) if (c.includes(k)) return { cat: "agent", label: "ИИ-агент", safe: true };
  for (const k of KNOWN.app) if (c.includes(k)) return { cat: "app", label: "приложение", safe: true };
  for (const k of KNOWN.dev) if (c.includes(k)) return { cat: "dev", label: "dev-инструмент", safe: true };
  return { cat: "unknown", label: "неизвестно", safe: true };
}

function killPort(port) {
  return new Promise((resolve) => {
    const p = toPort(port);
    if (!p) return resolve({ ok: false, error: "некорректный порт" });
    if (p === PORT) return resolve({ ok: false, error: "это порт самой панели — не трогаем" });
    execFile("lsof", ["-ti", `tcp:${p}`], (e, out) => {
      const pids = (out || "").trim().split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 1);
      if (!pids.length) return resolve({ ok: true, note: "порт уже свободен" });
      // Мягко (SIGTERM — даёт БД/процессу шанс сохраниться), через 1.2с добиваем выживших
      for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
      setTimeout(() => {
        execFile("lsof", ["-ti", `tcp:${p}`], (e2, out2) => {
          const left = (out2 || "").trim().split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 1);
          for (const pid of left) { try { process.kill(pid, "SIGKILL"); } catch {} }
          resolve({ ok: true, note: "порт освобождён" });
        });
      }, 1200);
    });
  });
}

// Keep-alive через launchd: держать сервис включённым без терминала
const LA_DIR = join(homedir(), "Library", "LaunchAgents");
const kaLabel = (name) => "com.aigarage." +
  (name.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "svc") +
  "-" + createHash("md5").update(String(name)).digest("hex").slice(0, 6);
const kaPlistPath = (name) => join(LA_DIR, kaLabel(name) + ".plist");
async function fileExists(p) { try { await stat(p); return true; } catch { return false; } }

// Keep-alive теперь СУПЕРВИЗИТ САМА ПАНЕЛЬ (а не отдельный launchd-агент): у панели есть
// доступ к ~/Documents, а у отдельного агента — нет (macOS TCC → «Operation not permitted»).
// Список «держать живым» — в keepalive.json; супервизор перезапускает упавшее по таймеру.
const KA_STATE = join(CFG_DIR, "keepalive.json");
async function loadKA() { try { return new Set(JSON.parse(await readFile(KA_STATE, "utf8"))); } catch { return new Set(); } }
async function saveKA(set) { await mkdir(CFG_DIR, { recursive: true }); await writeFile(KA_STATE, JSON.stringify([...set], null, 2)); }
async function removeKAPlist(name) {                          // снести старый (сломанный TCC) launchd-агент, если остался
  const path = kaPlistPath(name);
  if (await fileExists(path)) { await new Promise((r) => exec(`launchctl unload "${path}" 2>/dev/null; true`, () => r())); try { await unlink(path); } catch {} }
}
async function keepAliveSet(svc, enable) {
  if (enable && !svc.startCmd) return { ok: false, error: "у сервиса нет команды старта" };
  const ka = await loadKA();
  await removeKAPlist(svc.name);                              // миграция со старого механизма
  if (enable) { ka.add(svc.name); await saveKA(ka); startAndVerify(svc).catch(() => {}); return { ok: true, note: "держится включённым" }; }
  ka.delete(svc.name); await saveKA(ka); return { ok: true, note: "автозапуск выключен" };
}
let _ensuringKA = false;
async function ensureKeepAlive() {
  if (_ensuringKA) return; _ensuringKA = true;
  try {
    const ka = await loadKA(); if (!ka.size) return;
    const services = await loadServices();
    const listening = new Set((await discoverPorts()).map((d) => d.port));
    for (const svc of services) {
      if (!ka.has(svc.name) || !svc.startCmd) continue;
      const p = toPort(svc.port);
      if (p && !listening.has(p)) await startAndVerify(svc).catch(() => {});
    }
  } finally { _ensuringKA = false; }
}

// ── Туннель-менеджер: публичная ссылка (cloudflared) фоновым процессом ──
// Состояние = СПИСОК ЖЕЛАЕМЫХ портов (tunnels.json). Живость определяем по самому процессу
// (pgrep), а не по pid — поэтому дублей не бывает и переживает рестарт. БЕЗ launchd-агента
// → без диалога macOS «фоновый объект». Супервизор переподнимает желаемые после
// перезагрузки Мака / обрыва (адрес меняется, но руками пересоздавать не нужно).
const TUN_STATE = join(CFG_DIR, "tunnels.json");
const tunLog = (p) => `/tmp/aigarage-tunnel-${p}.log`;
async function loadTun() { try { return JSON.parse(await readFile(TUN_STATE, "utf8")); } catch { return {}; } }
async function saveTun(st) { await mkdir(CFG_DIR, { recursive: true }); await writeFile(TUN_STATE, JSON.stringify(st, null, 2)); }
const readTunUrl = (log) => { try { const m = readFileSync(log, "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g); return m ? m[m.length - 1] : null; } catch { return null; } };
async function cfPath() {
  for (const p of ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "/usr/bin/cloudflared"]) if (await fileExists(p)) return p;
  return new Promise((r) => exec("command -v cloudflared 2>/dev/null", (e, out) => r((out || "").trim() || null)));   // фолбэк по PATH (Linux/нестандартная установка)
}
// какие порты сейчас реально протуннелированы (один pgrep на все)
function aliveTunnelPorts() {
  return new Promise((r) => exec(`pgrep -fl "cloudflared tunnel --url" || true`, (e, out) => {
    const s = new Set(); if (out) for (const m of String(out).matchAll(/--url http:\/\/localhost:(\d+)/g)) s.add(Number(m[1])); r(s);
  }));
}
const killTunnelProc = (p) => new Promise((r) => exec(`pkill -f "cloudflared tunnel --url http://localhost:${p} " 2>/dev/null; true`, () => r()));
async function spawnTunnel(p) {
  const cf = await cfPath(); if (!cf) return false;
  await killTunnelProc(p);                                  // гарантируем один процесс на порт
  let fd; try { fd = openSync(tunLog(p), "w"); } catch { return false; }
  try {
    const child = spawn(cf, ["tunnel", "--url", `http://localhost:${p}`, "--http-host-header", `localhost:${p}`, "--no-autoupdate"], { stdio: ["ignore", fd, fd], detached: true });
    child.on("error", () => {}); child.unref(); return true;
  } catch { return false; }
}
async function startTunnel(port) {
  const p = toPort(port);
  if (!p) return { ok: false, error: "некорректный порт" };
  if (!(await cfPath())) return { ok: false, error: "cloudflared не найден — установи: brew install cloudflared" };
  const st = await loadTun(); st[p] = { provider: "cloudflared", log: tunLog(p) }; await saveTun(st);  // запомнить как желаемый
  if ((await aliveTunnelPorts()).has(p)) return { ok: true, note: "ссылка уже создана" };
  await spawnTunnel(p);
  return { ok: true, note: "ссылка создаётся…" };
}
async function stopTunnel(port) {
  const p = toPort(port);
  if (!p) return { ok: false, error: "некорректный порт" };
  await killTunnelProc(p);
  const st = await loadTun(); delete st[p]; await saveTun(st);
  try { await unlink(tunLog(p)); } catch {}
  return { ok: true, note: "ссылка убрана" };
}
// info по заранее загруженным: wanted (tunnels.json) + alive (pgrep-набор)
const tunnelInfoFrom = (wanted, alive, port) => { const p = toPort(port); return wanted[p] ? { url: alive.has(p) ? readTunUrl(tunLog(p)) : null, provider: "cloudflared", managed: true } : null; };
// супервизор: переподнимает желаемые туннели, которых нет среди живых.
// С экспоненциальным backoff — если адрес не поднимается (напр. cloudflare 429 Too Many
// Requests), повторяет всё реже (1→2→4→…→30 мин), а не долбит лимит каждые 12с.
let _ensuring = false;
const _tunFail = {};   // порт -> { at: время последней попытки (мс), n: подряд неудач }
async function ensureTunnels() {
  if (_ensuring) return; _ensuring = true;
  try {
    const st = await loadTun(); const alive = await aliveTunnelPorts(); const now = Date.now();
    for (const k of Object.keys(st)) {
      const p = Number(k);
      if (alive.has(p)) { delete _tunFail[p]; continue; }            // живёт — сброс счётчика
      const f = _tunFail[p] || { at: 0, n: 0 };
      const backoff = Math.min(20000 * 2 ** f.n, 480000);            // 20с,40с,…,8 мин (макс) — быстрее восстанавливается
      if (now - f.at < backoff) continue;                            // ещё рано — не трогаем лимит
      _tunFail[p] = { at: now, n: Math.min(f.n + 1, 6) };
      await spawnTunnel(p);
    }
  } finally { _ensuring = false; }
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}
// Белый список полей сервиса (отбрасываем чужое, приводим типы)
function sanitizeService(s) {
  if (!s || typeof s.name !== "string" || !s.name.trim()) return null;
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : undefined);
  const out = { name: s.name.trim().replace(/["'<>`]/g, "").slice(0, 100) || "service", type: s.type === "local" ? "local" : "link" };
  const port = toPort(s.port); if (port) out.port = port;
  out.url = str(s.url, 500); out.host = str(s.host, 40); out.note = str(s.note, 300);
  if (out.type === "local") { out.startCmd = str(s.startCmd, 2000); out.stopCmd = str(s.stopCmd, 2000); out.cwd = str(s.cwd, 500); }
  out.tunnelLog = str(s.tunnelLog, 500); out.tunnelRegex = str(s.tunnelRegex, 200);
  Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const cfg = await loadConfig();

  // Анти-DNS-rebinding: loopback всегда; плюс Tailscale (*.ts.net, 100.64/10), локальная
  // сеть (10/192.168/172.16-31) и явный cfg.allowedHosts. Публичные домены (rebinding) — блок.
  const host = (req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  const hostOk = ["localhost", "127.0.0.1", "[::1]", ""].includes(host)
    || host.endsWith(".ts.net")
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
    || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
    || (Array.isArray(cfg.allowedHosts) && cfg.allowedHosts.map((h) => String(h).toLowerCase()).includes(host));
  if (!hostOk) { res.writeHead(403); return res.end("bad host"); }
  const isMutation = req.method === "POST";
  // Анти-CSRF: на мутациях Origin должен быть наш (пустой — для curl/CLI)
  if (isMutation) {
    const o = req.headers.origin;
    if (o && o !== `http://localhost:${PORT}` && o !== `http://127.0.0.1:${PORT}`) {
      return sendJson(res, 403, { ok: false, error: "запрещённый источник (CSRF)" });
    }
  }
  // Опциональный токен: если задан в config.json — мутации требуют заголовок (constant-time сравнение).
  if (isMutation && cfg.token) {
    const a = Buffer.from(String(req.headers["x-control-token"] || ""));
    const b = Buffer.from(String(cfg.token));
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return sendJson(res, 401, { ok: false, error: "нужен токен доступа" });
    }
  }

  if (req.method === "GET" && url.pathname === "/") {
    try {
      const html = await readFile(join(__dirname, "public", "index.html"), "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src http://localhost:* http://127.0.0.1:* https:; connect-src 'self'",
      });
      return res.end(html);
    } catch { res.writeHead(500); return res.end("index.html не найден"); }
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const services = await loadServices();
    const all = await discoverPorts();                       // один lsof на весь запрос
    const listening = new Set(all.map((d) => d.port));
    const tun = await loadTun();                             // супервизор туннелей — на таймере (не в каждом статусе), чтобы не молотить
    const tunAlive = await aliveTunnelPorts();
    const kaSet = await loadKA();
    const rows = await Promise.all(services.map(async (s) => {
      const ti = tunnelInfoFrom(tun, tunAlive, s.port);
      return {
        name: s.name, type: s.type, port: s.port, url: s.url, note: s.note || "", host: s.host || DEVICE,
        up: !!s.port && listening.has(toPort(s.port)), tunnel: ti?.url || await tunnelUrl(s),
        tunnelManaged: !!ti, tunnelError: ti?.error || null,
        hasControls: !!(s.startCmd || s.stopCmd),
        keepAlive: kaSet.has(s.name),
        control: !!s.control,
        kind: s.kind || null,
        bots: Array.isArray(s.bots) ? s.bots : null,
        agent: s.agent || null,
      };
    }));
    const registeredPorts = new Set(services.map((s) => s.port).filter(Boolean));
    const catOverrides = await loadCatOverrides();
    const discovered = all.filter((d) => !registeredPorts.has(d.port) && d.port !== PORT)
      .map((d) => { const ti = tunnelInfoFrom(tun, tunAlive, d.port); const base = classifyProcess(d.command, d.port);
        return { ...d, ...applyCatOverride(d, base, catOverrides), tunnel: ti?.url || null, tunnelManaged: !!ti, tunnelError: ti?.error || null }; });
    return sendJson(res, 200, { services: rows, discovered, platform: process.platform, device: DEVICE, ts: Date.now(), authOn: !!cfg.token, selfTunnel: (tunnelInfoFrom(tun, tunAlive, PORT) || {}).url || null });
  }

  if (req.method === "POST" && ["/api/start", "/api/stop", "/api/restart"].includes(url.pathname)) {
    const { name } = await readBody(req);
    const services = await loadServices();
    const svc = services.find((s) => s.name === name);
    if (!svc) return sendJson(res, 404, { ok: false, error: "сервис не найден" });
    if (url.pathname === "/api/start") return sendJson(res, 200, await startAndVerify(svc));
    if (url.pathname === "/api/stop") return sendJson(res, 200, await runCmd(svc, "stop"));
    await runCmd(svc, "stop");
    await new Promise((r) => setTimeout(r, 1500));
    return sendJson(res, 200, await startAndVerify(svc));
  }

  if (req.method === "POST" && url.pathname === "/api/kill-port") {
    const { port } = await readBody(req);
    return sendJson(res, 200, await killPort(port));
  }

  if (req.method === "POST" && url.pathname === "/api/tunnel-start") {
    const { port, provider } = await readBody(req);
    return sendJson(res, 200, await startTunnel(port, provider || "cloudflared"));
  }

  if (req.method === "POST" && url.pathname === "/api/tunnel-stop") {
    const { port } = await readBody(req);
    return sendJson(res, 200, await stopTunnel(port));
  }

  if (req.method === "POST" && url.pathname === "/api/keepalive") {
    const { name, enable } = await readBody(req);
    const services = await loadServices();
    const svc = services.find((s) => s.name === name);
    if (!svc) return sendJson(res, 404, { ok: false, error: "сервис не найден" });
    return sendJson(res, 200, await keepAliveSet(svc, !!enable));
  }

  if (req.method === "POST" && url.pathname === "/api/service-add") {
    const { service } = await readBody(req);
    const clean = sanitizeService(service);
    if (!clean) return sendJson(res, 400, { ok: false, error: "нужно корректное имя" });
    return sendJson(res, 200, await withLock(async () => {
      const list = await loadServices();
      if (list.some((s) => s.name === clean.name)) return { ok: false, error: "имя занято" };
      list.push(clean); await saveServices(list);
      return { ok: true, note: "сервис добавлен" };
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/service-remove") {
    const { name } = await readBody(req);
    return sendJson(res, 200, await withLock(async () => {
      const list = await loadServices();
      const svc = list.find((s) => s.name === name);
      if (!svc) return { ok: false, error: "сервис не найден" };
      try { await keepAliveSet(svc, false); } catch {}
      await saveServices(list.filter((s) => s.name !== name));
      return { ok: true, note: "сервис удалён" };
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/service-rename") {
    const { name, newName } = await readBody(req);
    const nn = typeof newName === "string" ? newName.trim().slice(0, 80) : "";
    if (!nn) return sendJson(res, 400, { ok: false, error: "нужно новое имя" });
    return sendJson(res, 200, await withLock(async () => {
      const list = await loadServices();
      const svc = list.find((s) => s.name === name);
      if (!svc) return { ok: false, error: "сервис не найден" };
      if (list.some((s) => s.name === nn)) return { ok: false, error: "имя занято" };
      const wasKA = (await loadKA()).has(svc.name);
      if (wasKA) { try { await keepAliveSet(svc, false); } catch {} }
      svc.name = nn;
      await saveServices(list);
      if (wasKA) { try { await keepAliveSet(svc, true); } catch {} }
      return { ok: true, note: "переименовано" };
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/save-all-discovered") {
    return sendJson(res, 200, await withLock(async () => {
      const list = await loadServices();
      const have = new Set(list.map((s) => toPort(s.port)).filter(Boolean));
      const all = await discoverPorts();
      let n = 0;
      for (const d of all) {
        if (d.port === PORT || have.has(d.port)) continue;
        if (classifyProcess(d.command, d.port).safe === false) continue;   // не тащить системные/БД-процессы в список
        list.push({ name: `${d.command} :${d.port}`, type: "link", port: d.port, url: `http://localhost:${d.port}`, host: DEVICE, note: "обнаружено" });
        have.add(d.port); n++;
      }
      if (n) await saveServices(list);
      return { ok: true, note: `добавлено: ${n}` };
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/service-reorder") {
    const { order } = await readBody(req);
    if (!Array.isArray(order)) return sendJson(res, 400, { ok: false, error: "нужен массив порядка" });
    return sendJson(res, 200, await withLock(async () => {
      const list = await loadServices();
      const idx = new Map(order.map((nm, i) => [nm, i]));
      list.sort((a, b) => (idx.has(a.name) ? idx.get(a.name) : 1e6) - (idx.has(b.name) ? idx.get(b.name) : 1e6));
      await saveServices(list);
      return { ok: true };
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/service-sethost") {
    const { name, host } = await readBody(req);
    const h = typeof host === "string" ? host.trim().slice(0, 40) : "";
    if (!h) return sendJson(res, 400, { ok: false, error: "нужно устройство" });
    return sendJson(res, 200, await withLock(async () => {
      const list = await loadServices();
      const svc = list.find((s) => s.name === name);
      if (!svc) return { ok: false, error: "сервис не найден" };
      svc.host = h;
      await saveServices(list);
      return { ok: true, note: "устройство изменено" };
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/service-setagent") {
    const { name, agent } = await readBody(req);
    const a = typeof agent === "string" ? agent.trim().slice(0, 40) : "";
    return sendJson(res, 200, await withLock(async () => {
      const list = await loadServices();
      const svc = list.find((s) => s.name === name);
      if (!svc) return { ok: false, error: "сервис не найден" };
      if (a) svc.agent = a; else delete svc.agent;
      await saveServices(list);
      return { ok: true, note: "агент обновлён" };
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/cat-override") {
    const { command, port, cat } = await readBody(req);
    const p = toPort(port);
    if (!command || !p) return sendJson(res, 400, { ok: false, error: "некорректные параметры" });
    const c = typeof cat === "string" ? cat.trim() : "";
    const ov = await loadCatOverrides();
    const key = catKey(command, p);
    if (c === "auto") delete ov[key];                         // вернуть авто-классификацию
    else if (ALLOWED_CATS.has(c)) ov[key] = c;
    else return sendJson(res, 400, { ok: false, error: "неизвестная категория" });
    await saveCatOverrides(ov);
    return sendJson(res, 200, { ok: true, note: "категория обновлена" });
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => console.log(`AI Garage → http://localhost:${PORT}`));
ensureTunnels(); ensureKeepAlive();                         // восстановить туннели и поднять keep-alive сервисы при старте
setInterval(() => { ensureTunnels().catch(() => {}); ensureKeepAlive().catch(() => {}); }, 12000);  // и держать их живыми
