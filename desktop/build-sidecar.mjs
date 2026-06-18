// Собирает server.mjs в самодостаточный бинарь-sidecar (bun --compile) с именем,
// которое ждёт Tauri: binaries/ai-garage-server-<host-triple>. Node на машине пользователя не нужен.
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = join(__dirname, "..");
const home = process.env.HOME;
const rustc = `${home}/.cargo/bin/rustc`;
const bun = `${home}/.bun/bin/bun`;

const triple = execSync(`${rustc} --print host-tuple`).toString().trim();
const outDir = join(__dirname, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `ai-garage-server-${triple}`);

execSync(`${bun} build ${JSON.stringify(join(repo, "server.mjs"))} --compile --outfile ${JSON.stringify(out)}`, { stdio: "inherit" });
execSync(`chmod +x ${JSON.stringify(out)}`);
console.log("sidecar →", out);
