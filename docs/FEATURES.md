# AI Garage — Features

> Capabilities document for landing / PRD / pitch. Keep it in sync with the product.

---

## Кратко (RU)

**AI Garage** — пульт управления всем, что запущено на твоём Маке, без терминала. Видишь каждый сервис, порт и процесс — включая те, что наплодили ИИ-агенты (Claude Code, Cursor и др.), — и одним кликом гасишь зависший порт, запускаешь/останавливаешь сервис, держишь его живым или открываешь публичную ссылку на телефон.

Три вещи, которых нет у других похожих утилит:
- **Видит процессы ИИ-агентов** — не только твои сервисы, но и всё, что агент запустил и забыл.
- **Единая карта доступов** — какой ИИ-клиент к какому MCP/ключу подключён, живой ли ключ, где протух.
- **Приватность по умолчанию** — слушает только `127.0.0.1`, значения секретов в Keychain, ничего в облако, ничего личного в публичном репозитории.

---

## One-line pitch

**Mission control for your localhost — see & control everything running on your machine, including what AI agents spawned, with no terminal.**

**Hook:** You run a dozen local servers. Your AI coding agents spawn even more — and forget to clean them up. Soon a port is *"already in use"* and you don't know by what. AI Garage is the single pane of glass for all of it.

---

## Core services control

- **Live status of everything running** — saved services *and* every listening port, auto-discovered, refreshing every 3 seconds. Green/red at a glance.
- **Start / Stop / Restart** any service in one click — no terminal, no remembering the command.
- **Free a stuck port in one click** — kills whatever holds the classic *"port already in use"*, with a graceful `SIGTERM` first and `SIGKILL` only after 1.2s, so databases (Postgres/MySQL) get to flush. A guard warns before touching system/DB ports, and the panel refuses to kill itself.
- **Keep-alive** — the panel supervises a service and restarts it *only when its port is actually down*, so it never thrashes your scripts.
- **Auto-discovery, de-noised** — every process you didn't add is classified (system / database / app / dev / AI-agent). System and background app ports are collapsed into one "System & background" group so you only see the dev servers that matter.
- **Live preview** of a service right inside its card.
- **Auto-remembered commands** — when the panel sees a live port, it remembers the command + working directory, so Start and Keep-alive work without manual setup.
- **Edit the link** on any card — set a custom URL or path (e.g. `localhost:3000/board`) without recreating the service.
- **Sections & organization** — group services into *This Mac / VPS / Bots*, drag to reorder, rename, change device.
- **Autostart at login** — a toggle installs a launch-at-login agent without touching the terminal; it detects if it's already set up so it never duplicates.
- **19 UI languages** (EN/RU + 17 more), switchable in the header. Clean glass UI with a live cursor highlight.

## AI-agent features

- **Agents view** — auto-detects your AI clients (Claude Code, Cursor, Claude Desktop, Antigravity, LM Studio, …) with the number of MCP servers each has, and a one-click jump to its access map.
- **Sees what agents left running** — the discovery layer tags AI-agent processes specifically, so the ports your coding agent spawned and forgot are visible and killable — not mystery entries.
- **Bots & agents view** — group Telegram bots/agents by the backend they run on, with a one-click "open in Telegram".
- **Honest bot health** — a "Ping-test" sends a real Telegram message to prove the bot actually answers (not just "process is up"); cards go red on auth failure, show live logs, and fire a macOS notification when a bot logs out. When the panel genuinely can't tell, it says *"unknown"* — never a false "off".

## Connections & keys

*One map of every API access on your machine.* Your AI stack sprawls: API keys in `.env`, OAuth accounts inside hubs like Composio, and MCP servers wired into **each** client separately. Any single agent only sees its own config. The Connections tab reads the live configs of **all** your AI clients at once.

- **Access map — who can reach what.** Which AI clients have access to which MCP service, de-duplicated across clients, auto-discovered from real config files. Flip it: pick a client, see everything it can reach.
- **One-click grant / revoke** a client's access to a service from a card. Every config is backed up before any write, edits are atomic, and Claude Code goes through its own `claude mcp add/remove`.
- **Live key health** — every API key checked live and reported in plain words: *works / expired / out of credits*. Keys never leave your Mac.
- **Composio, honestly** — per-service connection status (connected / needs reconnect), one-click OAuth connect, a catalog of 500+ popular apps to add (12 popular ones in one click), and it flags a half-finished CLI login that would make agents throw 401.
- **Friendly names** — raw slugs become human labels (`pinecone-mcp-server` → Pinecone, `figma-dev-mode-mcp-server` → Figma, `xcodebuildmcp` → Xcode).
- **Honest about blind spots** — it tells you what it *can't* see (a client's UI-only toggle, a cloud-only hub) instead of faking a green check.

## Remote servers over SSH

- **Add a remote service over SSH** — "+ Service" → "remote over SSH" → host / user / port / key (picked from `~/.ssh`) / start & stop commands.
- **Test the connection** before saving, and a "let the agent fill it in" helper that hands a ready prompt to your AI agent.
- **Key by reference, not copy** — the SSH key is referenced by its file path; the key material is never copied into the app's config.
- **Direct SSH** to your own box — no cloud middleman between you and your VPS.

## Secrets vault

- **A safe for API keys & tokens** — "+ Add" → name + value + note; each card offers Copy / Show (auto-hides after 15s) / Delete.
- **Values live in macOS Keychain** — the app's files and UI store only the *names* and notes, never the secret values.
- **macOS-native** — backed by the system `security` layer under the "AI Garage" Keychain service.

## Sharing & phone

- **Public link in one click** — expose a local port via `cloudflared` and open it on your phone (ngrok stable URLs & custom domains on the roadmap).
- **Optional token for sharing** — when you share, every action can require a token you set; the read-only status view stays open.

---

## Security & privacy

- **Loopback-only bind** — the server listens on `127.0.0.1` only; it's not reachable from your network by default.
- **Anti-CSRF / anti-DNS-rebinding** — every mutating request is checked for same-origin `Origin` and an allowed `Host`. "localhost-only" isn't enough on its own (any open browser tab can POST to localhost) — most localhost tools ignore this; AI Garage doesn't.
- **Secret values in the macOS Keychain** — never written to config files or shown in the UI beyond a 15-second reveal.
- **SSH keys by reference, not copied** — remote servers point at a key file in `~/.ssh`; the key material never enters the app's storage.
- **Direct SSH, no cloud middleman** — remote control goes straight from your machine to your server.
- **Nothing leaves your machine** — no cloud, no telemetry, nothing collected; keys are checked locally. Nothing to leak.
- **No personal data in the public repo/npm** — the published package and tracked files are clean; personal state (registry, config, secrets, tunnels) lives outside git in `~/.config/localhost-control/`.
- **Safe by design** — port-freeing is graceful with a DB/system-port guard, the panel won't kill itself, the service registry is written atomically with a backup, and **zero dependencies** means no npm supply-chain surface.

---

## For AI agents (MCP)

AI Garage ships a zero-dependency **MCP server** so coding agents drive it directly — `list_services`, `free_port`, `open_tunnel`, `close_tunnel`, `register_service`, `register_remote`, plus the Connections tools `connections_overview`, `connections_health`, `grant_access`, `composio_connect` — instead of guessing with `lsof` and `kill -9`.

---

Обновляй этот файл при добавлении каждой новой фичи.
