// conn-demo.mjs — STANDALONE preview server for the Connections module.
// Runs independently of AI Garage (own port) so you can look at the tab live without touching the main app.
//   node conn-demo.mjs           → http://127.0.0.1:7788/
//   DEMO_PORT=9001 node conn-demo.mjs
// Read-only over your machine; localhost-bind only. When it looks good, the same routes are already
// wired into server.mjs — the in-app version is one restart away.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connCheck, composioConnect, connStatus } from "./conn.mjs";
import { discover } from "./discover.mjs";
import { setGrant } from "./grant.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");
const PORT = Number(process.env.DEMO_PORT) || 7788;

const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
const TYPES = { html: "text/html; charset=utf-8", png: "image/png", js: "text/javascript", css: "text/css", ico: "image/x-icon", svg: "image/svg+xml" };

function readBody(req) {
  return new Promise((resolve) => {
    let b = "", done = false;
    const fin = (v) => { if (done) return; done = true; try { resolve(JSON.parse(v || "{}")); } catch { resolve({}); } };
    req.on("data", (c) => { b += c; if (Buffer.byteLength(b) > 1e6) { req.destroy(); fin(""); } });
    req.on("end", () => fin(b));
    req.on("close", () => fin(""));   // destroy() emits 'close', not 'end' — settle so the handler never hangs
    req.on("error", () => fin(""));
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    const p = url.pathname;

    // anti-DNS-rebinding: loopback bind only serves loopback Host; mutations require loopback Origin
    const host = (req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
    if (!["localhost", "127.0.0.1", "[::1]", "::1", ""].includes(host)) { res.writeHead(403); return res.end("bad host"); }
    if (req.method === "POST") {
      const o = req.headers.origin;
      if (o) { let oh = ""; try { oh = new URL(o).hostname.toLowerCase(); } catch {} if (!["localhost", "127.0.0.1", "[::1]"].includes(oh)) { res.writeHead(403); return res.end("bad origin"); } }
    }

    if (req.method === "GET" && p === "/api/conn/check") return json(res, 200, await connCheck());
    if (req.method === "GET" && p === "/api/conn/access") return json(res, 200, await discover());
    if (req.method === "GET" && p === "/api/conn/status") return json(res, 200, await connStatus(url.searchParams.get("id")));
    if (req.method === "POST" && p === "/api/conn/composio-connect") {
      const { auth_config_id, slug } = await readBody(req);
      return json(res, 200, await composioConnect(auth_config_id, slug));
    }
    if (req.method === "POST" && p === "/api/conn/grant") {
      const { serviceId, clientId, enable } = await readBody(req);
      return json(res, 200, await setGrant({ serviceId, clientId, enable }));
    }

    // static
    const file = p === "/" ? "connections.html" : p.replace(/^\/+/, "").replace(/\.\.+/g, "");
    const fp = join(PUBLIC, file);
    if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end("bad path"); }
    try {
      const data = await readFile(fp);
      const ext = (file.split(".").pop() || "").toLowerCase();
      res.writeHead(200, { "Content-Type": TYPES[ext] || "application/octet-stream" });
      return res.end(data);
    } catch { res.writeHead(404); return res.end("not found"); }
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

server.on("error", (e) => { if (e.code === "EADDRINUSE") { console.error(`порт ${PORT} занят → DEMO_PORT=7799 node conn-demo.mjs`); process.exit(1); } throw e; });
server.listen(PORT, "127.0.0.1", () => console.log(`Connections demo → http://127.0.0.1:${PORT}/`));
