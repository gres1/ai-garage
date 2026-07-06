// grant.mjs — give/revoke a client's access to an MCP service (the вкл/выкл button).
// Safety contract:
//  - ALWAYS backs the target config up to ~/.config/localhost-control/backups/ before writing.
//  - Atomic write (tmp + rename). Strict JSON only — a JSONC/commented config is never rewritten
//    (would lose comments), we return a guide instead.
//  - Claude Code goes through `claude mcp add/remove` (execFile, no shell) — its ~/.claude.json is
//    a big stateful file we do not touch directly.
//  - Response never echoes env VALUES; backup path is ~-stripped.

import { readFile, writeFile, mkdir, copyFile, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { discoverFull } from "./discover.mjs";

const H = homedir();
const CFG_DIR = join(H, ".config", "localhost-control");
const BAK_DIR = join(CFG_DIR, "backups");

// how each client is written: cli = via its own CLI, json = flat JSON map edit, guide = hands off
const WRITE_CLASS = {
  "claude-code": "cli",
  "cursor": "json", "claude-desktop": "json", "antigravity": "json",
  "windsurf": "json", "lmstudio": "json", "vscode": "json",
  "zed": "guide",
};

async function backup(path) {
  await mkdir(BAK_DIR, { recursive: true });
  const dst = join(BAK_DIR, `${Date.now()}-${basename(path)}`);
  await copyFile(path, dst);
  return dst.replace(H, "~");
}

const defToRaw = (d) => d.url
  ? { url: d.url, ...(d.type ? { type: d.type } : {}) }
  : { command: d.command, args: d.args || [], ...(Object.keys(d.env || {}).length ? { env: d.env } : {}) };

function claudeCli(args) {
  return new Promise((r) => execFile("claude", args, { timeout: 30000 }, (e, so = "", se = "") =>
    r({ ok: !e, out: String(so || se).slice(0, 300) })));
}

export async function setGrant({ serviceId, clientId, enable }) {
  if (typeof serviceId !== "string" || !/^id:[a-f0-9]{16}$/.test(serviceId)) return { ok: false, error: "некорректный serviceId" };
  if (typeof clientId !== "string" || !WRITE_CLASS[clientId]) return { ok: false, error: "неизвестный клиент" };
  enable = !!enable;

  const full = await discoverFull();
  const svc = full.services.find((s) => s.id === serviceId);
  if (!svc) return { ok: false, error: "сервис не найден" };
  const target = full.consumers.find((c) => c.id === clientId);
  const granted = svc.grantedBy.includes(clientId);
  if (enable && granted) return { ok: true, note: "доступ уже есть" };
  if (!enable && !granted) return { ok: true, note: "доступа и так нет" };

  const src = svc.sources[0];                       // определение сервера берём у клиента, у которого он уже есть
  const name = src?.name || svc.names[0];
  const def = src?.def;
  if (enable && !def) return { ok: false, error: "нет определения сервера — не с кого скопировать" };

  const wc = WRITE_CLASS[clientId];

  if (wc === "guide") {
    return { ok: false, guide: `${clientId}: конфиг в особом формате — безопаснее добавить руками. Открой настройки клиента и ${enable ? "добавь" : "убери"} сервер «${name}».` };
  }

  if (wc === "cli") {                               // Claude Code — через собственный CLI (валидация на его стороне)
    if (!enable) {
      const r = await claudeCli(["mcp", "remove", name]);
      return r.ok ? { ok: true, note: `убран из Claude Code · перезапусти сессии, чтобы подхватили` } : { ok: false, error: r.out || "claude mcp remove не сработал" };
    }
    const args = ["mcp", "add", "--scope", "user"];
    for (const [k, v] of Object.entries(def.env || {})) args.push("-e", `${k}=${v}`);
    if (def.url) args.push("--transport", def.type === "sse" ? "sse" : "http", name, def.url);
    else args.push(name, "--", def.command, ...(def.args || []));
    const r = await claudeCli(args);
    return r.ok ? { ok: true, note: `добавлен в Claude Code · новые сессии увидят сразу` } : { ok: false, error: r.out || "claude mcp add не сработал" };
  }

  // json-клиенты: правим карту серверов напрямую — только строгий JSON, с бэкапом, атомарно
  if (!target || !target.configPathAbs) {
    return { ok: false, error: `${clientId} не найден на этой машине (конфига нет)` };
  }
  const path = target.configPathAbs;
  let txt;
  try { txt = await readFile(path, "utf8"); } catch { return { ok: false, error: "конфиг не читается" }; }
  let obj;
  try { obj = JSON.parse(txt); } catch {
    return { ok: false, guide: `Конфиг ${target.label} содержит комментарии (JSONC) — автоправка стёрла бы их. ${enable ? "Добавь" : "Убери"} сервер «${name}» руками: ${target.configPath}` };
  }

  const key = target.key || "mcpServers";
  if (typeof obj[key] !== "object" || obj[key] === null) obj[key] = {};

  if (enable) {
    obj[key][name] = defToRaw(def);
  } else {
    let removed = false;
    for (const n of svc.names) if (obj[key][n]) { delete obj[key][n]; removed = true; }
    if (!removed) return { ok: false, error: "сервер не найден в конфиге клиента" };
  }

  const bak = await backup(path);
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(obj, null, 2));
  await rename(tmp, path);
  return { ok: true, note: `${enable ? "доступ выдан" : "доступ отключён"} · бэкап: ${bak} · перезапусти ${target.label}, чтобы подхватил`, backup: bak };
}
