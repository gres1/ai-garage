// Собирает server.mjs в самодостаточный бинарь-sidecar (bun --compile) с именем,
// которое ждёт Tauri: binaries/ai-garage-server-<host-triple>. Node на машине пользователя не нужен.
// Кроссплатформенно: ищет rustc/bun сначала в PATH (CI), затем в домашней установке (локально).
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = join(__dirname, "..");
const home = process.env.HOME || process.env.USERPROFILE || "";

function resolveBin(name, homeRel) {
  const candidates = [name];
  if (home) candidates.push(join(home, homeRel));
  for (const c of candidates) {
    try { execSync(`"${c}" --version`, { stdio: "ignore" }); return c; } catch {}
  }
  return name; // последняя надежда — пусть PATH разрулит
}

const rustc = resolveBin("rustc", ".cargo/bin/rustc");
const bun = resolveBin("bun", ".bun/bin/bun");

const triple = execSync(`"${rustc}" --print host-tuple`).toString().trim();
const outDir = join(__dirname, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `ai-garage-server-${triple}`);

execSync(`"${bun}" build ${JSON.stringify(join(repo, "server.mjs"))} --compile --outfile ${JSON.stringify(out)}`, { stdio: "inherit" });
// bun на Windows добавляет .exe сам; снимаем флаг исполняемости где это применимо
for (const p of [out, out + ".exe"]) { if (existsSync(p)) { try { chmodSync(p, 0o755); } catch {} } }
console.log("sidecar →", out);
