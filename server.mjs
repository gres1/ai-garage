#!/usr/bin/env node
// Localhost Control — лёгкая панель управления локальными сервисами.
// Без зависимостей: только встроенные модули Node. Слушает 127.0.0.1:7777.
import http from "node:http";
import https from "node:https";
import { exec, execFile, spawn } from "node:child_process";
import { readFile, writeFile, mkdir, unlink, stat, rename, readdir, chmod } from "node:fs/promises";
import { openSync, readFileSync, existsSync } from "node:fs";
import { createHash, timingSafeEqual, randomBytes, verify as cryptoVerify, createPublicKey } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir, hostname } from "node:os";
import { connList, connCheck, composioConnect, connStatus, connToolkits } from "./conn.mjs";
import { discover } from "./discover.mjs";
import { setGrant, connHistory } from "./grant.mjs";

// Connections-роуты раскрывают карту наличия/валидности кредов — за пределами loopback требуем токен (как мутации).
function connAuthOk(req, res, cfg) {
  // Гейтим по РЕАЛЬНОМУ хосту запроса: локальный браузер (loopback) — свободно, как /api/status;
  // запрос через туннель/LAN — требуем токен (conn-данные чувствительнее статуса сервисов).
  const host = (req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  if (["localhost", "127.0.0.1", "[::1]", ""].includes(host)) return true;
  if (!cfg.token) return true;
  const a = Buffer.from(String(req.headers["x-control-token"] || ""));
  const b = Buffer.from(String(cfg.token));
  if (a.length !== b.length || !timingSafeEqual(a, b)) { sendJson(res, 401, { ok: false, error: "нужен токен доступа" }); return false; }
  return true;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.AIGARAGE_PORT) || 7777;
const CFG_DIR = join(homedir(), ".config", "localhost-control");
// Имя этого устройства по ОС (дефолт для host, чтобы не было «Mac» у всех)
const DEVICE = process.platform === "darwin" ? "Mac" : process.platform === "win32" ? "PC" : process.platform === "linux" ? "Linux" : (hostname() || "Local");
const SERVICES_PATH = join(CFG_DIR, "services.json");
const CONFIG_PATH = join(CFG_DIR, "config.json");

// Доступ с телефона: фактический адрес привязки и кешированный Tailscale-IP (заполняются на старте)
let BIND_HOST = "127.0.0.1";
let TS_IP = null;

// Каталог public/: обычный node → рядом с server.mjs; bun-compiled sidecar → __dirname виртуальный (/$bunfs),
// поэтому: явный --assets/env (передаёт Tauri), иначе папка рядом с исполняемым файлом, иначе __dirname, иначе cwd.
function resolvePublicDir() {
  const ai = process.argv.indexOf("--assets");
  const cands = [
    ai >= 0 ? process.argv[ai + 1] : null,
    process.env.AIGARAGE_ASSETS || null,
    join(dirname(process.execPath), "public"),
    join(__dirname, "public"),
    join(process.cwd(), "public"),
  ].filter(Boolean);
  for (const d of cands) { try { if (existsSync(join(d, "index.html"))) return d; } catch {} }
  return join(__dirname, "public");
}
const PUBLIC_DIR = resolvePublicDir();

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
  await writeFile(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
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
const genToken = () => randomBytes(24).toString("base64url");
async function persistConfig(patch) {
  await mkdir(CFG_DIR, { recursive: true, mode: 0o700 });
  const next = { ...(await loadConfig()), ...patch };
  const tmp = CONFIG_PATH + ".tmp";
  await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });   // config.json хранит токен/лицензию/telegram-токен → только владелец
  await rename(tmp, CONFIG_PATH);                            // атомарно, как saveServices
  return next;
}
// ── Pro-лицензия (офлайн, без слежки) ────────────────────────────────────────
// Ключ = base64url(payload).base64url(signature). payload = JSON {email, plan, exp?, iat}.
// Подписан приватным ключом Az (Ed25519); панель проверяет ВСТРОЕННЫМ публичным ключом.
// Никаких обращений на сервер: приватно, работает офлайн, и никто не «выключит» купленную лицензию.
const LICENSE_PUBKEY_B64 = "MCowBQYDK2VwAyEAptlh+d6VjcqQsgVbgsOeYEa+7J1SUPBSiW6cW0KnpvU=";
const _licPubKey = (() => {
  try { return createPublicKey({ key: Buffer.from(LICENSE_PUBKEY_B64, "base64"), format: "der", type: "spki" }); }
  catch { return null; }
})();
const b64urlToBuf = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
// Возвращает {valid, plan, email, exp, reason}. Формат ошибок — человеку, не коду.
function verifyLicense(key) {
  if (!key || typeof key !== "string") return { valid: false, reason: "нет ключа" };
  if (!_licPubKey) return { valid: false, reason: "проверка недоступна" };
  const parts = key.trim().split(".");
  if (parts.length !== 2) return { valid: false, reason: "ключ повреждён" };
  try {
    const payloadBuf = b64urlToBuf(parts[0]);
    const sigBuf = b64urlToBuf(parts[1]);
    if (!cryptoVerify(null, payloadBuf, _licPubKey, sigBuf)) return { valid: false, reason: "подпись не совпадает" };
    const p = JSON.parse(payloadBuf.toString("utf8"));
    if (p.exp && Date.now() > p.exp) return { valid: false, reason: "срок истёк", plan: p.plan, email: p.email, exp: p.exp };
    return { valid: true, plan: p.plan || "pro", email: p.email || null, exp: p.exp || null };
  } catch { return { valid: false, reason: "ключ повреждён" }; }
}
// Текущий статус Pro — читаем из config.json. Кешируем, чтобы не парсить на каждый тик.
let _licCache = null;
async function licenseState() {
  const cfg = await loadConfig();
  const key = cfg.licenseKey || "";
  if (_licCache && _licCache.key === key) return _licCache.state;
  const v = verifyLicense(key);
  const state = { pro: v.valid, plan: v.valid ? v.plan : null, email: v.valid ? v.email : null, exp: v.valid ? v.exp : null, reason: v.valid ? null : (key ? v.reason : null) };
  _licCache = { key, state };
  return state;
}
const isPro = async () => (await licenseState()).pro;

// Tailscale IPv4 (100.x) для приватного bind. Встроенный CLI GUI-приложения тоже отвечает на `ip -4`.
async function tailscaleIp() {
  let bin = null;
  for (const b of ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"]) if (await fileExists(b)) { bin = b; break; }
  if (!bin) bin = await new Promise((r) => exec("command -v tailscale 2>/dev/null", (e, out) => r((out || "").trim() || null)));
  if (!bin) return null;
  return new Promise((r) => execFile(bin, ["ip", "-4"], (e, out) => {
    const line = (out || "").split("\n").map((s) => s.trim()).find((s) => /^100\./.test(s));
    r(line || null);
  }));
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

// CPU/RAM + рабочая папка процессов одним махом (по списку pid). Папка → человеческое имя сервиса.
function procInfo(pids) {
  return new Promise((resolve) => {
    if (process.platform === "win32") return resolve({});   // ps/lsof — только Unix; на Windows метрики не показываем
    const uniq = [...new Set(pids.filter((n) => Number.isInteger(n) && n > 0))];
    if (!uniq.length) return resolve({});
    const map = {};
    execFile("ps", ["-o", "pid=,%cpu=,%mem=,rss=", "-p", uniq.join(",")], (e, out) => {
      (out || "").trim().split("\n").forEach((line) => {
        const m = line.trim().split(/\s+/);
        if (m.length >= 4) map[+m[0]] = { cpu: +m[1], mem: +m[2], rss: +m[3] };   // rss в KB
      });
      // cwd всех pid одним lsof (-Fpn: строки p<pid> и n<path>) → имя папки проекта
      execFile("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", uniq.join(",")], (e2, o2) => {
        let cur = null;
        (o2 || "").split("\n").forEach((l) => {
          if (l[0] === "p") cur = +l.slice(1);
          else if (l[0] === "n" && cur) {
            const dir = l.slice(1), name = dir.split("/").filter(Boolean).pop();
            if (name && name !== cur + "") (map[cur] = map[cur] || {}).project = name;
          }
        });
        resolve(map);
      });
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

// ── Авто-запомненные команды запуска ──
// Панель, увидев ЖИВОЙ порт, тихо запоминает его команду+cwd (первый раз). Дальше кнопка Вкл работает
// сама и keep-alive поднимает сервис после ребута — без ручной настройки (для пользователя и клиента).
const CMDS_PATH = join(CFG_DIR, "commands.json");
async function loadCmds() { try { return JSON.parse(await readFile(CMDS_PATH, "utf8")); } catch { return {}; } }
async function saveCmds(m) { await mkdir(CFG_DIR, { recursive: true, mode: 0o700 }); const tmp = CMDS_PATH + ".tmp"; await writeFile(tmp, JSON.stringify(m, null, 2), { mode: 0o600 }); await rename(tmp, CMDS_PATH); }
// Из сырой команды процесса собрать фоновую start + stop (та же логика, что и в guessCmd).
function guessCmdFromRaw(raw, port) {
  let start = (raw || "").trim();
  let stop = `lsof -ti:${port} | xargs kill`;
  // Некоторые процессы переписывают своё имя в ps на человекочитаемый ТИТУЛ, а не команду:
  // Next.js → 'next-server (v16.2.10)', Postgres → 'postgres: writer process'. Это НЕ запускаемая
  // команда (скобки ломают bash). Не запоминаем такое — пусть кнопка «Вкл» честно попросит настроить.
  if (!start || /[()]/.test(start) || /^[\w.\-]+:\s/.test(start)) return { start: "", stop };
  const m = start.match(/\/([^/]+)\.app\/Contents\/MacOS\/(.+)$/);
  if (m && m[2].trim() === m[1]) {   // чистый GUI-запуск .app без аргументов → open/quit
    const app = m[1]; return { start: `open -a "${app}"`, stop: `osascript -e 'quit app "${app}"'` };
  }
  start = start.slice(0, 500);       // CLI-сервер → в фон, иначе панель убьёт по 25с-таймауту
  if (start && !/(^|\s)nohup\b/.test(start) && !/&\s*$/.test(start)) start = `nohup ${start} > /tmp/aig-${port}.log 2>&1 &`;
  return { start: start.slice(0, 800), stop };
}
// Снять команду+cwd с живого процесса по pid (для авто-запоминания).
function captureCmd(port, pid) {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "command=", "-p", String(pid)], (e, cmd) => {
      const raw = (cmd || "").trim(); if (!raw) return resolve(null);
      execFile("lsof", ["-a", "-d", "cwd", "-Fn", "-p", String(pid)], (e2, o2) => {
        const line = (o2 || "").split("\n").find((l) => l[0] === "n");
        const cwd = line ? line.slice(1) : null;
        const { start, stop } = guessCmdFromRaw(raw, port);
        resolve(start ? { start, stop, cwd, seenAt: Date.now() } : null);
      });
    });
  });
}
// Подставить сервису запомненную команду/cwd, если явных нет (мутирует копию svc).
async function resolveCmds(svc) {
  if ((!svc.startCmd || !svc.stopCmd || !svc.cwd) && svc.port) {
    const c = (await loadCmds())[String(svc.port)];
    if (c) { svc.startCmd = svc.startCmd || c.start; svc.stopCmd = svc.stopCmd || c.stop; if (!svc.cwd && c.cwd) svc.cwd = c.cwd; }
  }
  return svc;
}
async function removeKAPlist(name) {                          // снести старый (сломанный TCC) launchd-агент, если остался
  const path = kaPlistPath(name);
  if (await fileExists(path)) { await new Promise((r) => exec(`launchctl unload "${path}" 2>/dev/null; true`, () => r())); try { await unlink(path); } catch {} }
}
async function keepAliveSet(svc, enable) {
  if (svc.kind === "app") {             // приложению команда не нужна — поднимаем через `open -a`
    const ka = await loadKA();
    if (enable) { ka.add(svc.name); await saveKA(ka); appOpen(svc.appPath).catch(() => {}); return { ok: true, note: "держится включённым" }; }
    ka.delete(svc.name); await saveKA(ka); return { ok: true, note: "автозапуск выключен" };
  }
  if (enable) await resolveCmds(svc);   // авто-запомненной команды достаточно, чтобы держать включённым
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
      if (!ka.has(svc.name)) continue;
      if (svc.kind === "app") {                                // у приложения нет порта: смотрим процесс
        const st = await appState(svc);
        if (st.installed && !st.running) await appOpen(svc.appPath).catch(() => {});
        continue;
      }
      await resolveCmds(svc);                                  // поднять и по авто-запомненной команде (после ребута)
      if (!svc.startCmd) continue;
      const p = toPort(svc.port);
      if (p && !listening.has(p)) await startAndVerify(svc).catch(() => {});
    }
  } finally { _ensuringKA = false; }
}

// Фоновый монитор падений — работает даже при закрытой панели (тот же таймер, что keep-alive).
// Дёшево считает up по каждому сохранённому сервису и отдаёт detectDowns.
let _supervising = false;
async function superviseDowns() {
  if (_supervising) return; _supervising = true;
  try {
    const services = await loadServices();
    if (!services.length) return;
    const cfg = await loadConfig();
    const listening = new Set((await discoverPorts()).map((d) => d.port));
    const rows = [];
    for (const s of services) {
      let up;
      const localPortLive = !!s.port && listening.has(toPort(s.port));
      if (s.kind === "app") up = !!(await appState(s)).running;
      else up = localPortLive;
      // «нельзя проверить» = удалённое/VPS или бот без локального порта → это НЕ «упало», уведомление не шлём
      const cant = s.kind !== "app" && (/vps|впс|server|серв|cloud/i.test(s.host || "")
        || ((s.kind === "bot" || (Array.isArray(s.bots) && s.bots.length)) && !localPortLive));
      rows.push({ name: s.name, up, kind: s.kind || null, cant });
    }
    if (process.env.AIGARAGE_DEBUG) console.log("[superviseDowns]", JSON.stringify(rows));
    await detectDowns(rows, cfg);
  } catch (e) { if (process.env.AIGARAGE_DEBUG) console.log("[superviseDowns ERR]", e.message); } finally { _supervising = false; }
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

// Можно ли встроить сервис в iframe? Браузер из-за cross-origin не различает «загрузилось» и
// «заблокировано», поэтому проверяем заголовки сами (loopback-запрос к самому сервису).
function checkEmbeddable(port) {
  return new Promise((resolve) => {
    const r = http.get({ host: "127.0.0.1", port, path: "/", timeout: 2500 }, (resp) => {
      const xfo = String(resp.headers["x-frame-options"] || "").toLowerCase();
      const csp = String(resp.headers["content-security-policy"] || "").toLowerCase();
      resp.destroy();
      let embeddable = true, reason = "";
      if (xfo.includes("deny") || xfo.includes("sameorigin")) { embeddable = false; reason = "X-Frame-Options"; }
      const m = csp.match(/frame-ancestors([^;]*)/);
      if (m) { const v = m[1]; if (v.includes("'none'") || (!v.includes("*") && !/https?:/.test(v))) { embeddable = false; reason = "CSP frame-ancestors"; } }
      resolve({ ok: true, embeddable, reason });
    });
    r.on("error", () => resolve({ ok: true, embeddable: true, reason: "unchecked" }));   // не проверили — даём iframe попробовать
    r.on("timeout", () => { r.destroy(); resolve({ ok: true, embeddable: true, reason: "timeout" }); });
  });
}

// Угадать команды старта/стопа по живому процессу — чтобы не заставлять юзера писать их с нуля.
// Живой статус бота: читаем его /health (многие боты его отдают). null — если не отвечает (упал).
function botHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 1500 }, (r) => {
      let body = ""; r.on("data", (c) => (body += c));
      r.on("end", () => { try { const j = JSON.parse(body); resolve({ ok: true, uptime: j.uptime_sec ?? null, count: j.bots_count ?? null, names: j.bot_names || null, claude: j.claude || null }); } catch { resolve({ ok: r.statusCode < 400 }); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// ── Локальные приложения (.app) ──────────────────────────────────────────────
// У приложения НЕТ порта, поэтому «живо» = живой процесс, а не слушающий порт.
// Именно из-за этого keep-alive (он смотрит порты) раньше не мог поднимать упавшее приложение.
const APP_INFO_TTL = 60_000;
const _appInfoCache = new Map();
async function appInfo(appPath) {
  const p = expandHome(appPath || "");
  if (!p.endsWith(".app")) return null;
  const hit = _appInfoCache.get(p);
  if (hit && Date.now() - hit.ts < APP_INFO_TTL) return hit.v;
  const v = await new Promise((resolve) => {
    execFile("plutil", ["-convert", "json", "-o", "-", join(p, "Contents/Info.plist")], { timeout: 4000 }, (e, out) => {
      if (e) return resolve(null);
      try {
        const j = JSON.parse(out);
        const execName = j.CFBundleExecutable;
        if (!execName) return resolve(null);
        resolve({
          exec: execName,
          execPath: join(p, "Contents/MacOS", execName),
          bundleId: j.CFBundleIdentifier || null,
          version: j.CFBundleShortVersionString || j.CFBundleVersion || null,
          label: j.CFBundleDisplayName || j.CFBundleName || p.split("/").pop().replace(/\.app$/, ""),
          menuBarOnly: !!j.LSUIElement,       // живёт в строке меню, окна нет — «не вижу его» ≠ «упало»
        });
      } catch { resolve(null); }
    });
  });
  _appInfoCache.set(p, { ts: Date.now(), v });
  return v;
}
// Ищем ТОЧНЫЙ путь к исполняемому файлу, а не имя приложения: иначе «Prompt Copilot» совпало бы
// с любым окном/документом, где это имя встречается в командной строке.
function appPidOf(execPath) {
  return new Promise((resolve) => {
    execFile("pgrep", ["-f", `^${execPath}`], { timeout: 3000 }, (e, out) => {
      const pid = Number(String(out || "").trim().split("\n")[0]);
      resolve(Number.isInteger(pid) && pid > 0 ? pid : null);
    });
  });
}
async function appState(svc) {
  if (process.platform !== "darwin") return { supported: false };
  const info = await appInfo(svc.appPath);
  if (!info) return { installed: false, running: false };       // приложение удалили/переместили — честно скажем
  const pid = await appPidOf(info.execPath);
  return { installed: true, running: !!pid, pid, version: info.version, bundleId: info.bundleId, menuBarOnly: info.menuBarOnly };
}
function appOpen(appPath) {
  return new Promise((resolve) => {
    execFile("open", ["-a", expandHome(appPath)], { timeout: 8000 }, (e) =>
      resolve(e ? { ok: false, error: String(e.message || e).slice(0, 200) } : { ok: true }));
  });
}
async function appQuit(svc) {
  const info = await appInfo(svc.appPath);
  if (!info) return { ok: false, error: "приложение не найдено" };
  const pid = await appPidOf(info.execPath);
  if (!pid) return { ok: true, note: "уже не запущено" };
  // Сначала вежливо (приложение успеет сохраниться), и только упрямое — жёстко.
  await new Promise((r) => { try { process.kill(pid, "SIGTERM"); } catch {} setTimeout(r, 1500); });
  if (await appPidOf(info.execPath)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  return { ok: true, note: "остановлено" };
}
// Скан папок с приложениями. Фильтр задаёт пользователь (в продукте нельзя хардкодить чей-то
// личный префикс bundle-id) — без фильтра показываем всё найденное, пусть выбирает сам.
async function scanApps(filter) {
  if (process.platform !== "darwin") return [];
  const dirs = [join(homedir(), "Applications"), "/Applications"];
  const out = [];
  for (const dir of dirs) {
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".app")) continue;
      const p = join(dir, n);
      const info = await appInfo(p);
      if (!info) continue;
      if (filter) {
        const rx = new RegExp(String(filter).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"), "i");
        if (!rx.test(info.bundleId || "") && !rx.test(info.label || "")) continue;
      }
      out.push({ appPath: p, label: info.label, bundleId: info.bundleId, version: info.version, menuBarOnly: info.menuBarOnly });
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// macOS-уведомление когда у бота отвалилась авторизация Claude (переход false→true) — заметно даже при закрытой панели.
const _authFailNotified = new Map();
function notifyAuthFailIfNeeded(name, health) {
  if (process.platform !== "darwin") return;
  const failed = !!(health && health.claude && health.claude.auth_failed);
  const was = _authFailNotified.get(name) || false;
  if (failed && !was) {
    const msg = `${name}: Claude CLI разлогинен — нужен re-login`;
    exec(`osascript -e 'display notification ${JSON.stringify(msg)} with title "AI Garage" sound name "Basso"'`, () => {});
  }
  _authFailNotified.set(name, failed);
}

// ── Уведомления о падении ────────────────────────────────────────────────────
// Следим за переходом «работал → упал» для СОХРАНЁННЫХ сервисов/приложений/ботов
// (не для «Обнаружено» — там шум). macOS-уведомление бесплатно (локально); Telegram — Pro (дистанционно).
const _upState = new Map();        // name → был ли up на прошлом тике
let _upSeeded = false;             // первый тик только запоминает, не шлёт (иначе спам при старте)
// terminal-notifier (если установлен) → кликабельное уведомление с нашей иконкой и группировкой; иначе обычное системное.
function tnPath() { for (const p of ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"]) if (existsSync(p)) return p; return null; }
function notifyMac(title, msg) {
  if (process.platform !== "darwin") return;
  const tn = tnPath();
  if (tn) {
    // клик открывает панель на упавших (#downed); своя иконка; -group заменяет прошлое уведомление, а не копит стопку
    execFile(tn, ["-title", title, "-message", msg, "-open", `http://127.0.0.1:${PORT}/#downed`,
      "-appIcon", join(PUBLIC_DIR, "logo.png"), "-group", "aigarage-down", "-sound", "Basso"], () => {});
    return;
  }
  exec(`osascript -e 'display notification ${JSON.stringify(msg)} with title ${JSON.stringify(title)} sound name "Basso"'`, () => {});
}
async function notifyTelegram(cfg, text) {
  const nt = cfg.notify || {};
  if (!nt.telegramChatId) return;
  const token = nt.telegramTokenKey && nt.envPath ? await readEnvValue(nt.envPath, nt.telegramTokenKey) : nt.telegramToken;
  if (!token) return;
  await telegramSend(token, nt.telegramChatId, text).catch(() => {});
}
// rows — то, что уже посчитано в /api/status (name, up, kind). Вызывать оттуда, отдельный таймер не нужен.
async function detectDowns(rows, cfg) {
  const notify = cfg.notify || {};
  const pro = (await licenseState()).pro;
  const fresh = [];
  for (const r of rows) {
    const prev = _upState.get(r.name);
    _upState.set(r.name, r.up);
    // «упало» = только то, что реально проверяемо локально (не VPS/удалённое) — иначе ложный спам
    if (_upSeeded && prev === true && r.up === false && !r.cant) fresh.push(r);
  }
  if (!_upSeeded) { _upSeeded = true; return; }
  if (!fresh.length || notify.enabled === false) return;
  for (const r of fresh) console.log(`[notify] упало: ${r.name}`);
  // ОДНО уведомление на тик, даже если упало несколько сразу (иначе поток всплывашек)
  let msg;
  if (fresh.length === 1) {
    const r = fresh[0];
    const kind = r.kind === "app" ? "приложение" : r.kind === "bot" ? "бот" : "сервис";
    msg = `Упало ${kind}: ${r.name}`;
  } else {
    const names = fresh.map((r) => r.name);
    const shown = names.slice(0, 4).join(", ");
    msg = `Упало ${fresh.length}: ${shown}${names.length > 4 ? ` и ещё ${names.length - 4}` : ""}`;
  }
  notifyMac("AI Garage", msg);
  if (pro && notify.telegram !== false) await notifyTelegram(cfg, `🔴 AI Garage: ${msg}`);
}

// Прочитать одно значение KEY=... из .env-файла (для ping-теста бота). Без зависимостей.
async function readEnvValue(path, key) {
  try {
    const data = await readFile(expandHome(path), "utf8");
    const m = data.match(new RegExp("^" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*=\\s*(.+)$", "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch { return null; }
}

// Реальный тест «бот живой»: шлём ему сообщение через Telegram Bot API, ждём ответ 200/ok.
function telegramSend(token, chatId, text) {
  return new Promise((resolve) => {
    const body = new URLSearchParams({ chat_id: String(chatId), text: String(text) }).toString();
    const req = https.request({ host: "api.telegram.org", path: `/bot${token}/sendMessage`, method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }, timeout: 10000 },
      (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => { try { resolve({ ok: r.statusCode === 200 && JSON.parse(b).ok === true }); } catch { resolve({ ok: false, error: "bad response" }); } }); });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.end(body);
  });
}
const telegramPing = (token, chatId) => telegramSend(token, chatId, "ping test ✓ (AI Garage)");

function guessCmd(port) {
  return new Promise((resolve) => {
    execFile("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], (e, out) => {
      const pid = (out || "").trim().split("\n")[0];
      if (!pid) return resolve({ ok: true, start: "", stop: "" });
      execFile("ps", ["-o", "command=", "-p", pid], (e2, cmd) => {
        const { start, stop } = guessCmdFromRaw((cmd || "").trim(), port);
        resolve({ ok: true, start, stop });
      });
    });
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 1e6) { req.destroy(); return {}; } chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}
// Белый список полей сервиса (отбрасываем чужое, приводим типы)
function sanitizeService(s) {
  if (!s || typeof s.name !== "string" || !s.name.trim()) return null;
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : undefined);
  const out = { name: s.name.trim().replace(/["'<>`]/g, "").slice(0, 100) || "service", type: s.type === "local" ? "local" : "link" };
  if (s.kind === "app") {                                       // локальное приложение: путь к .app вместо порта
    out.kind = "app";
    out.appPath = str(s.appPath, 500);
    out.bundleId = str(s.bundleId, 200);
    if (!out.appPath) return null;
  }
  const port = toPort(s.port); if (port) out.port = port;
  out.url = str(s.url, 500); out.host = str(s.host, 40); out.note = str(s.note, 300);
  if (out.type === "local") { out.startCmd = str(s.startCmd, 2000); out.stopCmd = str(s.stopCmd, 2000); out.cwd = str(s.cwd, 500); }
  out.tunnelLog = str(s.tunnelLog, 500); out.tunnelRegex = str(s.tunnelRegex, 200);
  Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
  return out;
}

// ── Автозапуск при входе в систему (без терминала) ──
// Ставит launchd-агент, который поднимает панель при логине. Детектит и уже настроенный автозапуск
// (напр. ручной launchd-агент), чтобы не плодить дубли на одном порту.
const PANEL_PLIST = join(LA_DIR, "com.aigarage.panel.plist");
const SERVER_PATH = process.argv[1] || join(__dirname, "server.mjs");
async function autostartStatus() {
  if (process.platform !== "darwin") return { on: false, supported: false };
  if (await fileExists(PANEL_PLIST)) return { on: true, mine: true, supported: true };
  try {
    for (const f of await readdir(LA_DIR)) {                   // уже автозапускается другим агентом?
      if (!f.endsWith(".plist")) continue;
      try { const c = await readFile(join(LA_DIR, f), "utf8"); if (c.includes(SERVER_PATH)) return { on: true, mine: false, label: f.replace(/\.plist$/, ""), supported: true }; } catch {}
    }
  } catch {}
  return { on: false, supported: true };
}
async function autostartSet(enable) {
  if (process.platform !== "darwin") return { ok: false, error: "автозапуск при входе — пока только macOS" };
  const st = await autostartStatus(); const uid = process.getuid();
  if (enable) {
    if (st.on) return { ok: true, note: st.mine ? "уже включён" : "уже включён (другим агентом)" };
    const log = join(homedir(), "Library/Logs/ai-garage.log");
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.aigarage.panel</string>
  <key>ProgramArguments</key><array><string>${xmlEsc(process.execPath)}</string><string>${xmlEsc(SERVER_PATH)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${xmlEsc(log)}</string>
  <key>StandardOutPath</key><string>${xmlEsc(log)}</string>
</dict></plist>
`;
    await mkdir(LA_DIR, { recursive: true });
    await writeFile(PANEL_PLIST, plist);
    await new Promise((r) => exec(`launchctl bootstrap gui/${uid} ${JSON.stringify(PANEL_PLIST)} 2>/dev/null || launchctl load ${JSON.stringify(PANEL_PLIST)} 2>/dev/null; true`, () => r()));
    return { ok: true, note: "включён — панель будет стартовать при входе в систему" };
  }
  if (st.on && !st.mine) return { ok: false, error: "автозапуск настроен другим агентом (" + (st.label || "launchd") + ") — сними его вручную" };
  await new Promise((r) => exec(`launchctl bootout gui/${uid}/com.aigarage.panel 2>/dev/null || launchctl unload ${JSON.stringify(PANEL_PLIST)} 2>/dev/null; true`, () => r()));
  try { await unlink(PANEL_PLIST); } catch {}
  return { ok: true, note: "выключен" };
}

// ── Удалённые серверы по SSH (GUI-мастер, без терминала) ──
// Приватный ключ НЕ копируем — работаем ССЫЛКОЙ на файл в ~/.ssh (как обсуждали: безопасно + удобно).
async function sshKeys() {
  const dir = join(homedir(), ".ssh");
  try {
    const files = await readdir(dir);
    const pubs = new Set(files.filter((f) => f.endsWith(".pub")).map((f) => f.slice(0, -4)));
    const known = new Set(["id_ed25519", "id_rsa", "id_ecdsa", "id_dsa"]);
    const skip = new Set(["config", "known_hosts", "known_hosts.old", "authorized_keys"]);
    return files.filter((f) => !f.endsWith(".pub") && !skip.has(f) && (pubs.has(f) || known.has(f)))
      .map((f) => ({ name: f, path: "~/.ssh/" + f }));
  } catch { return []; }
}
const sshUserHost = (o) => `${String(o.user || "").replace(/[^\w.-]/g, "")}@${String(o.host || "").replace(/[^\w.:-]/g, "")}`;
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";   // безопасное shell-экранирование
function sshBaseArgs(o) {                                          // для execFile (без shell)
  const a = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new"];
  const p = toPort(o.sshPort || o.port); if (p) a.push("-p", String(p));
  if (o.keyPath) a.push("-i", expandHome(String(o.keyPath)));
  return a;
}
function sshCmdStr(o, remoteCmd) {                                 // строка для startCmd/stopCmd (исполняется через bash)
  let s = "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new";
  const p = toPort(o.sshPort || o.port); if (p) s += " -p " + p;
  if (o.keyPath) s += " -i " + shq(expandHome(String(o.keyPath)));
  s += " " + shq(sshUserHost(o));
  if (remoteCmd) s += " " + shq(String(remoteCmd));
  return s;
}
function sshTest(o) {
  return new Promise((resolve) => {
    if (!o.host || !o.user) return resolve({ ok: false, error: "нужны host и user" });
    execFile("ssh", [...sshBaseArgs(o), sshUserHost(o), "echo", "aig-ok"], { timeout: 15000 }, (e, out, err) => {
      if (String(out || "").includes("aig-ok")) return resolve({ ok: true });
      resolve({ ok: false, error: (String(err || "").split("\n").find((l) => l.trim()) || (e && e.message) || "не удалось подключиться").slice(0, 200) });
    });
  });
}

// Авто-детект ИИ-агентов (Claude Code, Cursor, …) для секции «Агенты» на главной — читает их конфиги
// через discover.mjs. Кешируем ~10с, чтобы не перечитывать файлы на каждый /api/agents.
let _agentsCache = null, _agentsAt = 0;
async function detectedAgents() {
  const now = Date.now();
  if (_agentsCache && now - _agentsAt < 10000) return _agentsCache;
  try {
    const d = await discover();
    _agentsCache = (d.consumers || []).map((c) => ({ id: c.id, label: c.label, count: c.count, configPath: c.configPath }));
    _agentsAt = now;
  } catch { _agentsCache = _agentsCache || []; }
  return _agentsCache;
}

// ── Сейф ключей (Keychain) ──
// ЗНАЧЕНИЯ секретов живут только в macOS Keychain (шифрует ОС). В приложении/файлах — лишь ИМЕНА
// и заметки (secrets.json, chmod 600). Значение отдаётся наружу только по явному действию (копировать/показать).
const SECRETS_PATH = join(CFG_DIR, "secrets.json");
const KC_SERVICE = "AI Garage";
const validSecretName = (n) => typeof n === "string" && /^[\w .:\-/@]{1,60}$/.test(n);
async function loadSecrets() { try { const a = JSON.parse(await readFile(SECRETS_PATH, "utf8")); return Array.isArray(a) ? a : []; } catch { return []; } }
async function saveSecrets(list) { await mkdir(CFG_DIR, { recursive: true }); const tmp = SECRETS_PATH + ".tmp"; await writeFile(tmp, JSON.stringify(list, null, 2), { mode: 0o600 }); await rename(tmp, SECRETS_PATH); }
function kcSet(name, value) { return new Promise((r) => execFile("security", ["add-generic-password", "-U", "-s", KC_SERVICE, "-a", name, "-w", String(value)], (e) => r(!e))); }
function kcGet(name) { return new Promise((r) => execFile("security", ["find-generic-password", "-s", KC_SERVICE, "-a", name, "-w"], (e, out) => r(e ? null : String(out || "").replace(/\n$/, "")))); }
function kcDel(name) { return new Promise((r) => execFile("security", ["delete-generic-password", "-s", KC_SERVICE, "-a", name], (e) => r(!e))); }

// Кеш проверки ключей: connCheck опрашивает все API + `claude mcp list` (~7с). Кешируем ~45с,
// чтобы вкладка «Ключи» открывалась мгновенно, а не выглядела пустой пока идут проверки.
let _connCheckCache = null, _connCheckAt = 0;
async function connCheckCached(force) {
  const now = Date.now();
  if (!force && _connCheckCache && now - _connCheckAt < 45000) return { ...(_connCheckCache), cached: true };
  const r = await connCheck();
  _connCheckCache = r; _connCheckAt = now;
  return r;
}

const handler = async (req, res) => {
 try {
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
  // Анти-CSRF: на мутациях hostname из Origin должен совпадать с уже провалидированным host
  // (hostOk выше допускает loopback/Tailscale/LAN/allowedHosts). Сравниваем только hostname (без порта).
  // Пустой Origin (curl/CLI) — ок.
  if (isMutation) {
    const o = req.headers.origin;
    if (o) {
      let oHost = ""; try { oHost = new URL(o).hostname.toLowerCase(); } catch {}
      if (oHost !== host && !["localhost", "127.0.0.1"].includes(oHost)) {
        return sendJson(res, 403, { ok: false, error: "запрещённый источник (CSRF)" });
      }
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
      const html = await readFile(join(PUBLIC_DIR, "index.html"), "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src http://localhost:* http://127.0.0.1:* https:; connect-src 'self'",
      });
      return res.end(html);
    } catch { res.writeHead(500); return res.end("index.html не найден"); }
  }

  // Статика из public/ (logo и пр.) — только GET, с защитой от path traversal
  if (req.method === "GET" && url.pathname !== "/" && !url.pathname.startsWith("/api/")) {
    const safe = url.pathname.replace(/\.\.+/g, "").replace(/^\/+/, "");
    const pub = PUBLIC_DIR;
    const fp = join(pub, safe);
    if (fp.startsWith(pub)) {
      try {
        const data = await readFile(fp);
        const ext = (safe.split(".").pop() || "").toLowerCase();
        const types = { html: "text/html; charset=utf-8", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", webp: "image/webp", ico: "image/x-icon", gif: "image/gif", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };
        const head = { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": ext === "html" ? "no-store" : "max-age=3600", "X-Content-Type-Options": "nosniff" };
        // Страницы панели (connections.html) панель встраивает в свою же вкладку — значит DENY нельзя,
        // но и чужому сайту врезать их в iframe тоже нельзя: внутри живёт токен управления (clickjacking).
        if (ext === "html") Object.assign(head, {
          "X-Frame-Options": "SAMEORIGIN",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'; connect-src 'self'",
        });
        res.writeHead(200, head);
        return res.end(data);
      } catch {}
    }
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const services = await loadServices();
    const all = await discoverPorts();                       // один lsof на весь запрос
    const listening = new Set(all.map((d) => d.port));
    const byPort = new Map(all.map((d) => [d.port, d]));
    const pinfo = await procInfo(all.map((d) => d.pid));     // CPU/RAM + имя папки по pid
    const tun = await loadTun();                             // супервизор туннелей — на таймере (не в каждом статусе), чтобы не молотить
    const tunAlive = await aliveTunnelPorts();
    const kaSet = await loadKA();
    // Авто-запоминание: увидели новый живой порт → тихо снимаем его команду+cwd (только для НОВЫХ портов, дёшево).
    const cmds = await loadCmds(); let cmdsChanged = false;
    for (const d of all) { const k = String(d.port);
      if (!cmds[k] && d.pid && d.port !== PORT) { const cap = await captureCmd(d.port, d.pid); if (cap) { cmds[k] = cap; cmdsChanged = true; } } }
    if (cmdsChanged) await saveCmds(cmds);
    const rows = await Promise.all(services.map(async (s) => {
      const ti = tunnelInfoFrom(tun, tunAlive, s.port);
      const health = (s.kind === "bot" && s.port && listening.has(toPort(s.port))) ? await botHealth(s.port) : null;
      notifyAuthFailIfNeeded(s.name, health);
      const app = s.kind === "app" ? await appState(s) : null;   // у приложения живость = процесс, не порт
      return {
        name: s.name, type: s.type, port: s.port, url: s.url, note: s.note || "", host: s.host || DEVICE,
        up: app ? !!app.running : (!!s.port && listening.has(toPort(s.port))), tunnel: ti?.url || await tunnelUrl(s),
        app, appPath: s.appPath || null,
        tunnelManaged: !!ti, tunnelError: ti?.error || null,
        hasControls: !!(s.startCmd || s.stopCmd || cmds[String(s.port)]),
        autoCmd: !s.startCmd && !!cmds[String(s.port)],   // команда запомнена автоматически (не задана вручную)
        keepAlive: kaSet.has(s.name),
        control: !!s.control,
        kind: s.kind || null,
        bots: Array.isArray(s.bots) ? s.bots : null,
        agent: s.agent || null, health, logPath: s.logPath || null,
        canPing: !!(s.pingEnv && s.pingChatId),
        ...(() => { const pi = pinfo[byPort.get(toPort(s.port))?.pid] || {}; return { cpu: pi.cpu ?? null, mem: pi.mem ?? null, rss: pi.rss ?? null }; })(),
      };
    }));
    const registeredPorts = new Set(services.map((s) => s.port).filter(Boolean));
    const catOverrides = await loadCatOverrides();
    const discovered = all.filter((d) => !registeredPorts.has(d.port) && d.port !== PORT)
      .map((d) => { const ti = tunnelInfoFrom(tun, tunAlive, d.port); const base = classifyProcess(d.command, d.port);
        const pi = pinfo[d.pid] || {};
        return { ...d, proj: pi.project || null, cpu: pi.cpu ?? null, mem: pi.mem ?? null, rss: pi.rss ?? null, ...applyCatOverride(d, base, catOverrides), tunnel: ti?.url || null, tunnelManaged: !!ti, tunnelError: ti?.error || null }; });
    return sendJson(res, 200, { services: rows, discovered, platform: process.platform, device: DEVICE, ts: Date.now(), authOn: !!cfg.token,
      selfTunnel: (tunnelInfoFrom(tun, tunAlive, PORT) || {}).url || null,
      sectionOrder: Array.isArray(cfg.sectionOrder) ? cfg.sectionOrder : null,
      wrapOrder: Array.isArray(cfg.wrapOrder) ? cfg.wrapOrder : null,
      pro: (await licenseState()).pro,
      access: cfg.access || "off", tsIp: TS_IP, lanUrl: BIND_HOST !== "127.0.0.1" ? `http://${BIND_HOST}:${PORT}` : null });
  }

  // --- Connections module (внешние ключи / composio / MCP / боты) ---
  if (req.method === "GET" && url.pathname === "/api/conn/list") {
    if (!connAuthOk(req, res, cfg)) return;
    return sendJson(res, 200, await connList());
  }
  if (req.method === "GET" && url.pathname === "/api/conn/check") {
    if (!connAuthOk(req, res, cfg)) return;
    return sendJson(res, 200, await connCheckCached(url.searchParams.get("force") === "1"));
  }
  if (req.method === "GET" && url.pathname === "/api/conn/access") {
    if (!connAuthOk(req, res, cfg)) return;
    return sendJson(res, 200, await discover());
  }
  if (req.method === "GET" && url.pathname === "/api/conn/status") {
    if (!connAuthOk(req, res, cfg)) return;
    return sendJson(res, 200, await connStatus(url.searchParams.get("id")));
  }
  if (req.method === "GET" && url.pathname === "/api/conn/composio-toolkits") {
    if (!connAuthOk(req, res, cfg)) return;
    return sendJson(res, 200, await connToolkits(url.searchParams.get("q")));
  }
  if (req.method === "GET" && url.pathname === "/api/conn/history") {
    if (!connAuthOk(req, res, cfg)) return;
    return sendJson(res, 200, await connHistory());
  }
  if (req.method === "POST" && url.pathname === "/api/conn/composio-connect") {
    if (!connAuthOk(req, res, cfg)) return;
    const { auth_config_id, slug } = await readBody(req);
    return sendJson(res, 200, await composioConnect(auth_config_id, slug));
  }
  if (req.method === "POST" && url.pathname === "/api/conn/grant") {
    if (!connAuthOk(req, res, cfg)) return;
    const { serviceId, clientId, enable } = await readBody(req);
    return sendJson(res, 200, await setGrant({ serviceId, clientId, enable }));
  }

  if (req.method === "GET" && url.pathname === "/api/can-embed") {
    const p = toPort(url.searchParams.get("port"));
    if (!p) return sendJson(res, 400, { ok: false, error: "некорректный порт" });
    return sendJson(res, 200, await checkEmbeddable(p));
  }

  // Обнаруженные ИИ-агенты (для секции «Агенты» на главной панели) — авто, без ручной настройки.
  if (req.method === "GET" && url.pathname === "/api/agents") {
    return sendJson(res, 200, { agents: await detectedAgents() });
  }

  // SSH-ключи из ~/.ssh — для выпадающего списка в мастере «удалённый сервер» (только имена, не содержимое).
  if (req.method === "GET" && url.pathname === "/api/ssh-keys") {
    return sendJson(res, 200, { keys: await sshKeys() });
  }

  // ── Сейф ключей ── список (ТОЛЬКО имена/заметки, без значений). За токеном при удалённом доступе.
  if (req.method === "GET" && url.pathname === "/api/secrets") {
    if (!connAuthOk(req, res, cfg)) return;
    const list = await loadSecrets();
    return sendJson(res, 200, { supported: process.platform === "darwin", items: list.map((s) => ({ name: s.name, note: s.note || "", updatedAt: s.updatedAt || null })) });
  }
  if (req.method === "POST" && url.pathname === "/api/secrets-set") {
    if (process.platform !== "darwin") return sendJson(res, 200, { ok: false, error: "сейф ключей — пока только macOS (Keychain)" });
    const { name, value, note } = await readBody(req);
    if (!validSecretName(name)) return sendJson(res, 400, { ok: false, error: "недопустимое имя" });
    if (typeof value !== "string" || !value) return sendJson(res, 400, { ok: false, error: "пустое значение" });
    if (!(await kcSet(name, value))) return sendJson(res, 200, { ok: false, error: "Keychain отказал" });
    await withLock(async () => { const list = await loadSecrets(); const e = list.find((s) => s.name === name) || (list.push({ name }), list[list.length - 1]); e.note = typeof note === "string" ? note.slice(0, 200) : (e.note || ""); e.updatedAt = Date.now(); await saveSecrets(list); });
    return sendJson(res, 200, { ok: true, note: "секрет сохранён в Keychain" });
  }
  if (req.method === "POST" && url.pathname === "/api/secrets-get") {   // отдаёт значение — только по явному действию (копировать/показать)
    if (process.platform !== "darwin") return sendJson(res, 200, { ok: false, error: "только macOS" });
    const { name } = await readBody(req);
    if (!validSecretName(name)) return sendJson(res, 400, { ok: false, error: "недопустимое имя" });
    const v = await kcGet(name);
    return sendJson(res, 200, v == null ? { ok: false, error: "не найдено в Keychain" } : { ok: true, value: v });
  }
  if (req.method === "POST" && url.pathname === "/api/secrets-del") {
    const { name } = await readBody(req);
    if (!validSecretName(name)) return sendJson(res, 400, { ok: false, error: "недопустимое имя" });
    await kcDel(name);
    await withLock(async () => { const list = (await loadSecrets()).filter((s) => s.name !== name); await saveSecrets(list); });
    return sendJson(res, 200, { ok: true, note: "секрет удалён" });
  }
  // Проверить SSH-подключение (зелёное/красное в мастере). Выполняется на машине пользователя.
  if (req.method === "POST" && url.pathname === "/api/ssh-test") {
    return sendJson(res, 200, await sshTest(await readBody(req)));
  }
  // Добавить удалённый сервер: строим ssh-обёрнутые команды старт/стоп и заводим карточку (host=VPS).
  if (req.method === "POST" && url.pathname === "/api/remote-add") {
    const b = await readBody(req);
    if (!b.name || !b.host || !b.user) return sendJson(res, 400, { ok: false, error: "нужны name, host, user" });
    const svc = sanitizeService({
      name: b.name, type: "local", host: "VPS", control: true,
      url: b.url || undefined, port: toPort(b.port) || undefined,
      startCmd: b.startCmd ? sshCmdStr(b, b.startCmd) : undefined,
      stopCmd: b.stopCmd ? sshCmdStr(b, b.stopCmd) : undefined,
      note: b.note || `SSH: ${sshUserHost(b)}`,
    });
    if (!svc || (!svc.startCmd && !svc.stopCmd)) return sendJson(res, 400, { ok: false, error: "задай хотя бы команду старта" });
    const done = await withLock(async () => {
      const list = await loadServices();
      if (list.some((s) => s.name === svc.name)) return { ok: false, error: "имя уже занято" };
      list.push(svc); await saveServices(list); return { ok: true };
    });
    return sendJson(res, 200, done.ok ? { ok: true, note: "удалённый сервер добавлен" } : done);
  }

  if (req.method === "GET" && url.pathname === "/api/guess-cmd") {
    const p = toPort(url.searchParams.get("port"));
    if (!p) return sendJson(res, 400, { ok: false });
    return sendJson(res, 200, await guessCmd(p));
  }

  // Последние строки лог-файла сервиса (для кнопки «Логи» — без терминала)
  if (req.method === "GET" && url.pathname === "/api/logs") {
    const name = url.searchParams.get("name");
    const services = await loadServices();
    const svc = services.find((s) => s.name === name);
    if (!svc || !svc.logPath) return sendJson(res, 404, { ok: false, error: "у сервиса нет лог-файла" });
    try {
      const data = await readFile(expandHome(svc.logPath), "utf8");
      const tail = data.split("\n").slice(-120).join("\n").slice(-20000);
      return sendJson(res, 200, { ok: true, log: tail || "(лог пуст)" });
    } catch (e) { return sendJson(res, 200, { ok: false, error: "лог недоступен: " + e.message }); }
  }

  // Ping-тест бота: реально шлём сообщение через Telegram Bot API и ждём ответ 200/ok.
  // Конфиг — в services.json: pingEnv (путь к .env), pingChatId, bots[].tokenKey. Без хардкода в продукте.
  if (req.method === "POST" && url.pathname === "/api/bot-ping") {
    const { name, bot } = await readBody(req);
    const services = await loadServices();
    const svc = services.find((s) => s.name === name);
    if (!svc || !svc.pingEnv || !svc.pingChatId) return sendJson(res, 200, { ok: false, error: "ping не настроен для этого бота" });
    const bots = Array.isArray(svc.bots) ? svc.bots : [];
    const targets = (bot != null && bots[bot]) ? [bots[bot]] : bots;
    const results = [];
    for (const b of targets) {
      if (!b || !b.tokenKey) { results.push({ user: b?.user || "?", ok: false, error: "нет tokenKey" }); continue; }
      const token = await readEnvValue(svc.pingEnv, b.tokenKey);
      if (!token) { results.push({ user: b.user, ok: false, error: "нет токена" }); continue; }
      const r = await telegramPing(token, svc.pingChatId);
      results.push({ user: b.user, ok: r.ok, error: r.error || null });
    }
    return sendJson(res, 200, { ok: results.length > 0 && results.every((r) => r.ok), results });
  }

  // Перелогин Claude CLI: открываем Terminal с командой `claude login` (фиксированная, не из ввода).
  if (req.method === "POST" && url.pathname === "/api/claude-relogin") {
    if (process.platform !== "darwin") return sendJson(res, 200, { ok: false, error: "только macOS" });
    exec(`osascript -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "claude login"'`, () => {});
    return sendJson(res, 200, { ok: true, note: "Терминал открыт — войди в Claude" });
  }

  // Регистрация сервиса агентом (через MCP): «я поднял X на порту P командой C в папке D».
  // Панель заводит карточку + запоминает команду → кнопка Вкл работает сразу, даже до первого запуска.
  if (req.method === "POST" && url.pathname === "/api/register") {
    const b = await readBody(req);
    const port = toPort(b.port);
    if (!port || !b.command) return sendJson(res, 400, { ok: false, error: "нужны port и command" });
    const cmds = await loadCmds();
    const { start, stop } = guessCmdFromRaw(String(b.command), port);
    cmds[String(port)] = { start, stop, cwd: b.cwd ? String(b.cwd).slice(0, 500) : null, seenAt: Date.now() };
    await saveCmds(cmds);
    await withLock(async () => {
      const list = await loadServices();
      if (!list.some((s) => toPort(s.port) === port)) {
        const svc = sanitizeService({ name: b.name || `service :${port}`, type: "local", port, url: b.url || `http://localhost:${port}` });
        if (svc) { list.push(svc); await saveServices(list); }
      }
    });
    return sendJson(res, 200, { ok: true, note: "сервис зарегистрирован — кнопка Вкл работает" });
  }

  if (req.method === "POST" && ["/api/start", "/api/stop", "/api/restart"].includes(url.pathname)) {
    const { name } = await readBody(req);
    const services = await loadServices();
    const svc = services.find((s) => s.name === name);
    if (!svc) return sendJson(res, 404, { ok: false, error: "сервис не найден" });
    await resolveCmds(svc);   // подставить авто-запомненную команду, если явной нет
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

  // Режим доступа с телефона: off | tailscale | public. Меняет config.json (мутация → уже под токеном, если он есть).
  // Автозапуск при входе: статус + вкл/выкл (ставит/снимает launchd-агент, без терминала).
  if (req.method === "GET" && url.pathname === "/api/autostart") return sendJson(res, 200, await autostartStatus());
  if (req.method === "POST" && url.pathname === "/api/autostart") {
    const { enable } = await readBody(req);
    return sendJson(res, 200, await autostartSet(!!enable));
  }

  if (req.method === "POST" && url.pathname === "/api/access") {
    const { mode } = await readBody(req);
    if (!["off", "tailscale", "public"].includes(mode)) return sendJson(res, 400, { ok: false, error: "неизвестный режим" });
    const patch = { access: mode };
    if ((mode === "tailscale" || mode === "public") && !cfg.token) patch.token = genToken();   // форс-токен за пределами loopback
    await persistConfig(patch);
    if (mode === "tailscale") TS_IP = await tailscaleIp().catch(() => null);                    // обновить кеш без рестарта
    if (mode === "public") await startTunnel(PORT);
    if (mode === "off") await stopTunnel(PORT);
    return sendJson(res, 200, {
      ok: true, mode, tsIp: TS_IP,
      token: patch.token || cfg.token || null,                  // отдаём токен вызывающему (включение — с доверенной панели)
      needRestart: mode === "tailscale",                        // rebind сокета требует перезапуска панели
      note: mode === "tailscale" ? "перезапусти панель, чтобы привязаться к Tailscale" : "применено",
    });
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

  // ── Уведомления о падении ──
  if (req.method === "GET" && url.pathname === "/api/notify") {
    const nt = cfg.notify || {};
    return sendJson(res, 200, {
      enabled: nt.enabled !== false, telegram: nt.telegram !== false,
      hasTelegram: !!(nt.telegramChatId && (nt.telegramToken || (nt.telegramTokenKey && nt.envPath))),
      telegramChatId: nt.telegramChatId || "", pro: (await licenseState()).pro,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/notify") {
    const b = await readBody(req);
    const cur = (await loadConfig()).notify || {};
    const nt = { ...cur };
    if (typeof b.enabled === "boolean") nt.enabled = b.enabled;
    if (typeof b.telegram === "boolean") nt.telegram = b.telegram;
    if (typeof b.telegramChatId === "string") nt.telegramChatId = b.telegramChatId.trim().slice(0, 64);
    if (typeof b.telegramToken === "string") nt.telegramToken = b.telegramToken.trim().slice(0, 100);   // хранится локально (config chmod 600)
    await persistConfig({ notify: nt });
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/notify-test") {
    notifyMac("AI Garage", "Тест уведомления — так ты узнаешь, если что-то упадёт");
    if ((await licenseState()).pro) { const j = await notifyTelegram(cfg, "🔔 AI Garage: тест уведомления"); }
    return sendJson(res, 200, { ok: true, note: "отправлено (проверь Центр уведомлений" + ((await licenseState()).pro ? " и Telegram)" : ")") });
  }

  // ── Pro-лицензия ──
  if (req.method === "GET" && url.pathname === "/api/license") {
    return sendJson(res, 200, await licenseState());
  }
  if (req.method === "POST" && url.pathname === "/api/license") {
    const { key } = await readBody(req);
    const raw = typeof key === "string" ? key.trim() : "";
    if (!raw) {                                                 // пустой ключ = снять лицензию (вернуться на free)
      await persistConfig({ licenseKey: "" }); _licCache = null;
      return sendJson(res, 200, { ok: true, ...(await licenseState()) });
    }
    const v = verifyLicense(raw);
    if (!v.valid) return sendJson(res, 400, { ok: false, error: v.reason || "ключ недействителен" });
    await persistConfig({ licenseKey: raw }); _licCache = null;
    return sendJson(res, 200, { ok: true, ...(await licenseState()) });
  }

  // ── Локальные приложения ──
  if (req.method === "GET" && url.pathname === "/api/apps-scan") {
    const cfg2 = await loadConfig();
    const filter = url.searchParams.get("filter") ?? cfg2.appFilter ?? "";
    const found = await scanApps(filter);
    const known = new Set((await loadServices()).filter((s) => s.kind === "app").map((s) => expandHome(s.appPath || "")));
    return sendJson(res, 200, {
      supported: process.platform === "darwin",
      items: found.map((a) => ({ ...a, added: known.has(a.appPath) })),
      filter,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/app-add") {
    const b = await readBody(req);
    const info = await appInfo(b.appPath);
    if (!info) return sendJson(res, 400, { ok: false, error: "это не приложение (.app не найден)" });
    const svc = sanitizeService({ name: b.name || info.label, kind: "app", type: "local", appPath: expandHome(b.appPath), bundleId: info.bundleId, note: b.note });
    if (!svc) return sendJson(res, 400, { ok: false, error: "не вышло добавить" });
    return sendJson(res, 200, await withLock(async () => {
      const list = await loadServices();
      if (list.some((s) => s.name === svc.name)) return { ok: false, error: "имя уже занято" };
      list.push(svc); await saveServices(list);
      return { ok: true, note: `«${svc.name}» добавлено` };
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/app-action") {
    const { name, action } = await readBody(req);
    const svc = (await loadServices()).find((s) => s.name === name && s.kind === "app");
    if (!svc) return sendJson(res, 404, { ok: false, error: "приложение не найдено" });
    if (action === "start") return sendJson(res, 200, await appOpen(svc.appPath));
    if (action === "stop") return sendJson(res, 200, await appQuit(svc));
    if (action === "restart") { await appQuit(svc); return sendJson(res, 200, await appOpen(svc.appPath)); }
    if (action === "reveal") { execFile("open", ["-R", expandHome(svc.appPath)], () => {}); return sendJson(res, 200, { ok: true }); }
    return sendJson(res, 400, { ok: false, error: "неизвестное действие" });
  }

  if (req.method === "POST" && url.pathname === "/api/apps-filter") {
    const { filter } = await readBody(req);
    await persistConfig({ appFilter: typeof filter === "string" ? filter.slice(0, 100) : "" });
    return sendJson(res, 200, { ok: true });
  }

  // Порядок секций панели (грид: local/vps/bots; блоки ниже: agents/secrets/disc) — в config.json,
  // чтобы был одинаковым в браузере, десктопе и Safari (localStorage у них разный).
  if (req.method === "POST" && url.pathname === "/api/sections-order") {
    const b = await readBody(req);
    const clean = (arr, allowed) => Array.isArray(arr) ? arr.filter((k) => allowed.includes(k)).slice(0, 10) : null;
    const patch = {};
    const sec = clean(b.sections, ["local", "apps", "vps", "bots"]);
    const wr = clean(b.wraps, ["agents", "secrets", "disc"]);
    if (sec && sec.length) patch.sectionOrder = sec;
    if (wr && wr.length) patch.wrapOrder = wr;
    if (!Object.keys(patch).length) return sendJson(res, 400, { ok: false, error: "нужен sections или wraps" });
    await persistConfig(patch);
    return sendJson(res, 200, { ok: true });
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

  // Настроить управление сервисом из панели (задать команды старта/стопа) — чтобы у «managed externally» появились кнопки
  if (req.method === "POST" && url.pathname === "/api/service-setcmd") {
    const { name, startCmd, stopCmd, cwd } = await readBody(req);
    const str = (v, n) => (typeof v === "string" ? v.slice(0, n).trim() : "");
    return sendJson(res, 200, await withLock(async () => {
      const list = await loadServices();
      const svc = list.find((s) => s.name === name);
      if (!svc) return { ok: false, error: "сервис не найден" };
      const sc = str(startCmd, 2000), st = str(stopCmd, 2000), cw = str(cwd, 500);
      if (sc) svc.startCmd = sc; else delete svc.startCmd;
      if (st) svc.stopCmd = st; else delete svc.stopCmd;
      if (cw) svc.cwd = cw; else delete svc.cwd;
      svc.type = (svc.startCmd || svc.stopCmd) ? "local" : "link";   // есть команды → панель управляет
      await saveServices(list);
      return { ok: true, note: "управление настроено" };
    }));
  }

  // Сменить ссылку карточки (напр. дописать путь /board к http://localhost:3000).
  if (req.method === "POST" && url.pathname === "/api/service-seturl") {
    const { name, url: newUrl } = await readBody(req);
    return sendJson(res, 200, await withLock(async () => {
      const list = await loadServices();
      const svc = list.find((s) => s.name === name);
      if (!svc) return { ok: false, error: "сервис не найден" };
      const u = typeof newUrl === "string" ? newUrl.slice(0, 500).trim() : "";
      if (u) svc.url = u; else delete svc.url;
      await saveServices(list);
      return { ok: true, note: "ссылка обновлена" };
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
 } catch (e) {
   if (process.env.AIGARAGE_DEBUG) console.log("[500]", (e && e.stack) || e);
   if (!res.headersSent) { try { sendJson(res, 500, { ok: false, error: "internal error" }); } catch {} }
   else { try { res.end(); } catch {} }
 }
};
const server = http.createServer(handler);

// Старт с учётом режима доступа (config.json → access): tailscale → доп. bind на 100.x (приватно, не в LAN)
// ДЛЯ ТЕЛЕФОНА, но loopback (127.0.0.1) слушаем ВСЕГДА — иначе десктоп-.app не достучится до панели.
// Выход за loopback ИЛИ public-режим требуют токена — генерируем и сохраняем, если его нет.
(async () => {
  const cfg = await loadConfig();
  for (const p of [CONFIG_PATH, CMDS_PATH, SERVICES_PATH]) { try { await chmod(p, 0o600); } catch {} }   // подтянуть права уже созданных файлов (токен/команды — только владелец)
  TS_IP = await tailscaleIp().catch(() => null);
  if (cfg.access === "tailscale") {
    if (TS_IP) BIND_HOST = TS_IP;
    else console.warn("AI Garage: Tailscale IP не найден — остаюсь на 127.0.0.1 (запущен ли Tailscale и залогинен?)");
  }
  if (BIND_HOST !== "127.0.0.1" || (cfg.access && cfg.access !== "off")) {
    if (!cfg.token) { await persistConfig({ token: genToken() }); console.log("AI Garage: сгенерирован токен доступа (открой панель или config.json, чтобы посмотреть)"); }
  }
  const shown = BIND_HOST === "127.0.0.1" ? "localhost" : BIND_HOST;
  server.on("error", (e) => {
    if (e && e.code === "EADDRINUSE") { console.error(`AI Garage: порт ${PORT} занят — задай другой: AIGARAGE_PORT=7788 npx ai-garage`); process.exit(1); }
    throw e;
  });
  server.listen(PORT, BIND_HOST, () => console.log(`AI Garage → http://${shown}:${PORT}`));
  // Второй слушатель на loopback, когда основной уехал на Tailscale-адрес: десктоп/локальный браузер
  // ходят на 127.0.0.1, телефон — на 100.x. LAN (0.0.0.0) намеренно НЕ открываем.
  if (BIND_HOST !== "127.0.0.1") {
    const loopback = http.createServer(handler);
    loopback.on("error", (e) => console.warn(`AI Garage: loopback :${PORT} недоступен (${e && e.code}) — десктоп может не достучаться`));
    loopback.listen(PORT, "127.0.0.1", () => console.log(`AI Garage → http://localhost:${PORT} (loopback для десктопа)`));
  }
  ensureTunnels(); ensureKeepAlive();                       // восстановить туннели и поднять keep-alive сервисы при старте
  setInterval(() => { ensureTunnels().catch(() => {}); ensureKeepAlive().catch(() => {}); superviseDowns().catch(() => {}); }, 12000);  // держать живыми + следить за падениями
})();
