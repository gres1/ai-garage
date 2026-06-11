#!/usr/bin/env node
// Localhost Control — лёгкая панель управления локальными сервисами.
// Без зависимостей: только встроенные модули Node. Слушает 127.0.0.1:7777.
import http from "node:http";
import { exec } from "node:child_process";
import { readFile, writeFile, mkdir, unlink, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 7777;
const CFG_DIR = join(homedir(), ".config", "localhost-control");
const SERVICES_PATH = join(CFG_DIR, "services.json");
const CONFIG_PATH = join(CFG_DIR, "config.json");

const expandHome = (p) => (p && p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

async function loadServices() {
  try { return JSON.parse(await readFile(SERVICES_PATH, "utf8")); } catch { return []; }
}
async function saveServices(list) {
  await mkdir(CFG_DIR, { recursive: true });
  await writeFile(SERVICES_PATH, JSON.stringify(list, null, 2));
}
async function loadConfig() {
  try { return JSON.parse(await readFile(CONFIG_PATH, "utf8")); } catch { return {}; }
}

function portUp(port) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    exec(`lsof -ti tcp:${port} -sTCP:LISTEN`, (e, out) => resolve(!!out.trim()));
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

function killPort(port) {
  return new Promise((resolve) => {
    if (!port) return resolve({ ok: false, error: "порт не задан" });
    exec(`lsof -ti tcp:${port} | xargs kill -9`, (err) =>
      resolve(err && err.code === 1 ? { ok: true, note: "порт уже свободен" } : { ok: true, note: "порт освобождён" }));
  });
}

// Keep-alive через launchd: держать сервис включённым без терминала
const LA_DIR = join(homedir(), "Library", "LaunchAgents");
const kaLabel = (name) => "com.localhostcontrol." + name.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40);
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
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>-lc</string><string>${svc.startCmd.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string></array>
  <key>WorkingDirectory</key><string>${cwd}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>Crashed</key><true/><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${homedir()}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>/tmp/${label}.log</string>
  <key>StandardErrorPath</key><string>/tmp/${label}.log</string>
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

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const cfg = await loadConfig();

  // Опциональная защита: если в config.json задан token — мутации требуют заголовок.
  const isMutation = req.method === "POST";
  if (isMutation && cfg.token && req.headers["x-control-token"] !== cfg.token) {
    return sendJson(res, 401, { ok: false, error: "нужен токен доступа" });
  }

  if (req.method === "GET" && url.pathname === "/") {
    try {
      const html = await readFile(join(__dirname, "public", "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch { res.writeHead(500); return res.end("index.html не найден"); }
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const services = await loadServices();
    const rows = await Promise.all(services.map(async (s) => ({
      name: s.name, type: s.type, port: s.port, url: s.url, note: s.note || "", host: s.host || "mac",
      up: await portUp(s.port), tunnel: await tunnelUrl(s),
      hasControls: !!(s.startCmd || s.stopCmd),
      keepAlive: await fileExists(kaPlistPath(s.name)),
    })));
    const registeredPorts = new Set(services.map((s) => s.port).filter(Boolean));
    const discovered = (await discoverPorts()).filter((d) => !registeredPorts.has(d.port) && d.port !== PORT);
    return sendJson(res, 200, { services: rows, discovered, ts: Date.now(), authOn: !!cfg.token });
  }

  if (req.method === "POST" && ["/api/start", "/api/stop", "/api/restart"].includes(url.pathname)) {
    const { name } = await readBody(req);
    const services = await loadServices();
    const svc = services.find((s) => s.name === name);
    if (!svc) return sendJson(res, 404, { ok: false, error: "сервис не найден" });
    if (url.pathname === "/api/start") return sendJson(res, 200, await runCmd(svc, "start"));
    if (url.pathname === "/api/stop") return sendJson(res, 200, await runCmd(svc, "stop"));
    await runCmd(svc, "stop");
    await new Promise((r) => setTimeout(r, 1500));
    return sendJson(res, 200, await runCmd(svc, "start"));
  }

  if (req.method === "POST" && url.pathname === "/api/kill-port") {
    const { port } = await readBody(req);
    return sendJson(res, 200, await killPort(port));
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
    if (!service || !service.name) return sendJson(res, 400, { ok: false, error: "нужно имя" });
    const list = await loadServices();
    if (list.some((s) => s.name === service.name)) return sendJson(res, 400, { ok: false, error: "имя занято" });
    list.push(service); await saveServices(list);
    return sendJson(res, 200, { ok: true, note: "сервис добавлен" });
  }

  if (req.method === "POST" && url.pathname === "/api/service-remove") {
    const { name } = await readBody(req);
    const list = await loadServices();
    const next = list.filter((s) => s.name !== name);
    await saveServices(next);
    return sendJson(res, 200, { ok: true, note: "сервис удалён" });
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => console.log(`Localhost Control → http://localhost:${PORT}`));
