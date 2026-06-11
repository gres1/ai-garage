# AGENTS.md — как ИИ-ассистенту управлять этой панелью

Этот файл для ИИ-ассистента (Claude Code, Cursor и т.п.), который помогает пользователю. Прочитай его, прежде чем что-то менять. Цель: пользователь говорит «добавь мой сервис / туннель в панель», и ты это делаешь — правильно и ничего не ломая.

## Что это
Локальная панель управления сервисами. Бэкенд — `server.mjs` (порт `127.0.0.1:7777`). Реестр сервисов — **простой JSON-файл**, его и редактируй.

## Реестр: `~/.config/localhost-control/services.json`
Массив объектов. Добавить сервис = добавить объект (или вызвать API, см. ниже).

| Поле | Обязательно | Что |
|---|---|---|
| `name` | да | уникальное имя карточки |
| `type` | да | `"local"` (с кнопками Старт/Стоп) или `"link"` (только статус+ссылка) |
| `port` | да | порт для проверки «работает/нет» |
| `url` | да | что открыть в браузере |
| `host` | нет | `"mac"` или `"vps"` — значок 💻/☁️ (по умолчанию mac) |
| `startCmd` | для local | команда запуска (выполняется в `cwd` через bash) |
| `stopCmd` | для local | команда остановки |
| `cwd` | для local | рабочая папка (можно `~`) |
| `tunnelLog` | нет | путь к логу туннеля для парса публичной ссылки |
| `tunnelRegex` | нет | regex ссылки (напр. `https://[a-z0-9-]+\\.trycloudflare\\.com`) |
| `note` | нет | подпись |

## Способы добавить (любой)
1. **Через API** (предпочтительно — не трогаешь файл руками):
   ```bash
   curl -s -X POST http://localhost:7777/api/service-add -H 'Content-Type: application/json' \
     -d '{"service":{"name":"My App","type":"local","port":3000,"url":"http://localhost:3000",
          "host":"mac","cwd":"~/projects/app","startCmd":"npm run dev",
          "stopCmd":"lsof -ti:3000 | xargs kill","note":"dev-сервер"}}'
   ```
   Если в `~/.config/localhost-control/config.json` задан `token` — добавь заголовок `-H 'x-control-token: <token>'`.
2. **Прямой правкой** `services.json` (валидный JSON, не дублируй `name`).

## Рецепты (частые случаи)
- **Vite/Next dev-сервер:** `type:"local"`, `startCmd:"npm run dev"`, `stopCmd:"lsof -ti:<port> | xargs kill"`, `cwd` = папка проекта.
- **cloudflared-туннель для телефона:** добавь в `startCmd` запуск `cloudflared tunnel --url http://localhost:<port> > /tmp/cf-<name>.log 2>&1 &`, и укажи `tunnelLog:"/tmp/cf-<name>.log"`, `tunnelRegex:"https://[a-z0-9-]+\\.trycloudflare\\.com"` — панель сама покажет публичную ссылку.
- **SSH-туннель до VPS** (`ssh -L локальный:127.0.0.1:удалённый user@vps`): `type:"link"` (или local с launchd load/unload), `host:"vps"`, `port` = локальный проброшенный порт.
- **Просто дашборд на VPS (через уже поднятый туннель):** `type:"link"`, `host:"vps"`, `port` = локальный порт туннеля, `url` = `http://localhost:<port>/...`.

## Прочие операции
- Освободить порт: `POST /api/kill-port {"port":3000}`.
- Удалить: `POST /api/service-remove {"name":"My App"}`.
- Статус всех: `GET /api/status`.

## Безопасность (не нарушай)
- Сервер слушает только `127.0.0.1`. **Не выставляй порт 7777 наружу.**
- Команды из `startCmd`/`stopCmd` выполняются как есть — добавляй только то, что пользователь понимает/подтвердил. Перед деструктивным (kill, rm) — спроси.
- Не записывай токены/пароли в `services.json` или в команды в открытом виде.
- После изменения проверь: `curl -s http://localhost:7777/api/status` — сервис появился и статус корректный.
