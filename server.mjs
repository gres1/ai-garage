#!/usr/bin/env node
// Localhost Control — лёгкая панель управления локальными сервисами.
// Без зависимостей: только встроенные модули Node. Слушает 127.0.0.1:7777.
import http from "node:http";
import { exec, execFile, spawn } from "node:child_process";
import { readFile, writeFile, mkdir, unlink, stat, rename } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 7777;
const CFG_DIR = join(homedir(), ".config", "localhost-control");
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

async function keepAliveSet(svc, enable) {
  if (!svc.startCmd) return { ok: false, error: "у сервиса нет команды старта" };
  const label = kaLabel(svc.name), path = kaPlistPath(svc.name);
  if (enable) {
    const cwd = svc.cwd ? expandHome(svc.cwd) : homedir();
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xmlEsc(label)}</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>-lc</string><string>${xmlEsc(svc.startCmd)}</string></array>
  <key>WorkingDirectory</key><string>${xmlEsc(cwd)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>Crashed</key><true/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xmlEsc(homedir())}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>/tmp/${xmlEsc(label)}.log</string>
  <key>StandardErrorPath</key><string>/tmp/${xmlEsc(label)}.log</string>
</dict></plist>`;
    await mkdir(LA_DIR, { recursive: true });
    await writeFile(path, plist);
    return new Promise((r) => exec(`launchctl unload "${path}" 2>/dev/null; launchctl load -w "${path}"`, (e) =>
      r(e ? { ok: false, error: e.message.slice(0, 200) } : { ok: true, note: "держится включённым" })));
  } else {
    return new Promise(async (r) => {
      exec(`launchctl unload "${path}" 2>/dev/null`, async () => {
        try { await unlink(path); } catch {}
        r({ ok: true, note: "автозапуск выключен" });
      });
    });
  }
}

// ── Туннель-менеджер: публичная ссылка на localhost (cloudflared; задел под ngrok/ssh) ──
const tunnels = new Map(); // port -> { provider, child, url, error }
const TUNNEL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
function startTunnel(port, provider = "cloudflared") {
  const p = toPort(port);
  if (!p) return { ok: false, error: "некорректный порт" };
  if (tunnels.has(p)) return { ok: true, note: "туннель уже поднят" };
  let child;
  if (provider !== "cloudflared") return { ok: false, error: "провайдер пока не поддержан (есть cloudflared)" };
  try {
    child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${p}`, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch { return { ok: false, error: "не удалось запустить cloudflared" }; }
  const rec = { provider, child, url: null, error: null };
  tunnels.set(p, rec);
  const onData = (buf) => { const m = String(buf).match(TUNNEL_RE); if (m && !rec.url) rec.url = m[0]; };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (e) => { rec.error = e.code === "ENOENT" ? "cloudflared не установлен — brew install cloudflared" : e.message; });
  child.on("exit", () => { tunnels.delete(p); });
  return { ok: true, note: "туннель поднимается…" };
}
function stopTunnel(port) {
  const rec = tunnels.get(toPort(port));
  if (!rec) return { ok: true, note: "туннеля нет" };
  try { rec.child.kill("SIGTERM"); } catch {}
  tunnels.delete(toPort(port));
  return { ok: true, note: "туннель остановлен" };
}
const tunnelInfo = (port) => { const r = tunnels.get(toPort(port)); return r ? { url: r.url, provider: r.provider, error: r.error, managed: true } : null; };

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
  const out = { name: s.name.trim().slice(0, 100), type: s.type === "local" ? "local" : "link" };
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

  // Анти-DNS-rebinding: принимаем только loopback Host (все методы)
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  if (!["localhost", "127.0.0.1", "[::1]", ""].includes(host)) {
    res.writeHead(403); return res.end("bad host");
  }
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
    const rows = await Promise.all(services.map(async (s) => {
      const ti = tunnelInfo(s.port);
      return {
        name: s.name, type: s.type, port: s.port, url: s.url, note: s.note || "", host: s.host || "mac",
        up: !!s.port && listening.has(toPort(s.port)), tunnel: ti?.url || await tunnelUrl(s),
        tunnelManaged: !!ti, tunnelError: ti?.error || null,
        hasControls: !!(s.startCmd || s.stopCmd),
        keepAlive: await fileExists(kaPlistPath(s.name)),
      };
    }));
    const registeredPorts = new Set(services.map((s) => s.port).filter(Boolean));
    const discovered = all.filter((d) => !registeredPorts.has(d.port) && d.port !== PORT)
      .map((d) => { const ti = tunnelInfo(d.port); return { ...d, ...classifyProcess(d.command, d.port), tunnel: ti?.url || null, tunnelManaged: !!ti, tunnelError: ti?.error || null }; });
    return sendJson(res, 200, { services: rows, discovered, platform: process.platform, ts: Date.now(), authOn: !!cfg.token });
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
    return sendJson(res, 200, startTunnel(port, provider || "cloudflared"));
  }

  if (req.method === "POST" && url.pathname === "/api/tunnel-stop") {
    const { port } = await readBody(req);
    return sendJson(res, 200, stopTunnel(port));
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
      if (await fileExists(kaPlistPath(svc.name))) { try { await keepAliveSet(svc, false); } catch {} }
      await saveServices(list.filter((s) => s.name !== name));
      return { ok: true, note: "сервис удалён" };
    }));
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => console.log(`AI Garage → http://localhost:${PORT}`));
