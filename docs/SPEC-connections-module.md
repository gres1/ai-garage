# SPEC — модуль «Connections» (подключения/креды) для AI Garage

> Хендофф-спека для агента, ведущего AI Garage. Автор: Claude (сессия X-growth, 2026-07-04).
> Цель: превратить боль «сервис отвалился, ключ протух, статус хрен поймёшь» в панель со статусами и подключением в один клик.

## Зачем (проблема из реальной сессии)

Az постоянно теряет время на API-подключениях: Composio-ключ молча протух (401), CLI устарел и бьёт в мёртвый v1-эндпоинт, «подключено/не подключено» непонятно, реконнект — квест. Сегодня выяснилось только вручную: ключ валиден, но в проекте 0 connected accounts + CLI устарел. Это должно быть видно **с первого взгляда**, а реконнект — **в одну кнопку**.

AI Garage уже делает ровно это для **localhost-сервисов** (видит порты, статусы, старт/стоп в клик). Модуль «Connections» = тот же паттерн, но для **внешних API/интеграций** (ключи, OAuth, MCP, composio-коннекты).

## Как ложится на текущий стек (проверено по коду)

- `server.mjs` — vanilla Node, zero-deps, роуты `/api/*`. Добавляем группу `/api/conn/*` рядом с `/api/service-*`.
- Конфиг: новый файл **`connections.json`** рядом с `services.json` (тот же паттерн: массив объектов).
- Frontend: новая вкладка/секция «Connections» в `public/index.html` (рядом с сервисами; тот же дизайн-язык, оранжевая палитра).
- Уже есть прецедент реконнекта: `/api/claude-relogin` — переиспользовать паттерн.
- Health-check логика уже прототипирована: `~/.config/claude/check-keys.sh` (тестирует composio/linear/n8n/github/supabase/firecrawl/openrouter/gemini по HTTP-кодам). Портировать в Node.

## Модель данных — `connections.json`

```json
[
  {
    "id": "composio",
    "label": "Composio",
    "kind": "apikey",                    // apikey | oauth | mcp | bot
    "envKeys": ["COMPOSIO_API_KEY"],     // какие ключи в .env этому принадлежат
    "envFile": "~/.config/claude/.env",  // где живёт (может быть несколько — см. propagateTo)
    "propagateTo": [                      // куда ещё дублировать при обновлении
      "~/.claude.json",
      "~/.cursor/mcp.json"
    ],
    "health": {
      "method": "GET",
      "url": "https://backend.composio.dev/api/v3/toolkits?limit=1",
      "headers": { "x-api-key": "${COMPOSIO_API_KEY}" },
      "okCodes": [200],
      "warnCodes": [402],                // 402 = живой ключ, кончились кредиты (Firecrawl-кейс)
      "extractStatus": null              // опц. jsonpath для доп. статуса (напр. connected_accounts count)
    },
    "reconnect": {
      "type": "dashboard_url",           // dashboard_url | oauth_flow | cli_cmd | mcp_add
      "url": "https://dashboard.composio.dev/<org>/<project>/settings/api-keys",
      "hint": "Create API Key → скопировать → вставить сюда"
    },
    "lastChecked": null,
    "lastStatus": null                    // ok | warn | dead | unknown (кэш)
  }
]
```

Первичный список наполнить из `~/.config/claude/.env` (см. `check-keys.sh` — там уже перечислены все критичные: composio, linear, n8n, supabase, github, firecrawl, openrouter, gemini, + добавить typefully MCP, telegram-боты).

## Backend — новые эндпоинты (в `server.mjs`)

| Метод/путь | Что делает |
|---|---|
| `GET /api/conn/list` | вернуть все connections + кэш статуса |
| `GET /api/conn/check?id=X` | пингануть health одного (или `?all=1` — всех), обновить `lastStatus/lastChecked` |
| `POST /api/conn/set-key` | `{id, value}` → записать ключ в `envFile` + все `propagateTo` (см. ниже), перечекнуть |
| `POST /api/conn/reconnect` | `{id}` → по типу: открыть dashboard_url / запустить oauth_flow / выполнить cli_cmd / `claude mcp add` |
| `POST /api/conn/add` / `remove` | CRUD подключения (как `/api/service-add`) |

**Health-check ядро** (портировать из `check-keys.sh`): для каждого connection взять `health`, подставить `${ENV}` из envFile, сделать fetch, вернуть `ok|warn|dead` по кодам. Таймаут 5с. Параллелить.

**Пропагация ключа** (`set-key`) — ключевая фича «улетело везде где должно»:
1. Прочитать `envFile`, заменить/добавить строку `KEY=value`.
2. Для каждого `propagateTo`: если JSON (`.claude.json`, `mcp.json`) — найти узел с этим ключом (по имени сервера/env) и обновить; если `.env`-подобный — заменить строку.
3. Пересчитать health → показать зелёный.
4. Всё атомарно (бэкап файла перед записью). chmod 600 сохранить.

## Frontend — панель «Connections»

Вкладка рядом с сервисами. Каждый connection = карточка (как service-карточка):
- **Иконка + label** + тип (apikey/oauth/mcp).
- **Статус-точка**: 🟢 ok / 🟡 warn (кредиты/частично) / 🔴 dead / ⚪ unknown. + текст («работает» / «кончились кредиты» / «401 — протух» / «0 connected accounts»).
- **lastChecked** («2 мин назад»), кнопка ⟳ перечекнуть.
- Если 🔴/🟡 → кнопка **«Подключить»**: 
  - `dashboard_url` → открыть в браузере + модалка с полем «вставь новый ключ» → `set-key` → зелёный.
  - `oauth_flow` → запустить (для composio-коннектов Twitter/LinkedIn, MCP-add).
  - `cli_cmd` → выполнить (напр. `composio upgrade`) с выводом.
- Сверху — общий индикатор «N/M зелёных» (как ring «12 of 15» у сервисов).

Автопинг всех при открытии панели + опц. фон каждые N минут.

## Реконнект в один клик — сценарии

| Тип | Поток одной кнопки |
|---|---|
| **apikey** (composio, linear, firecrawl…) | открыть dashboard_url → юзер копирует ключ → вставляет в модалку → `set-key` пропагирует везде → зелёный |
| **mcp** (typefully…) | `claude mcp add --scope user --transport http <name> <url>` + проверить `claude mcp list` |
| **oauth** (composio→Twitter/LinkedIn) | запустить composio connect-флоу в браузере, дождаться callback |
| **bot** (telegram Hermes/OpenClaw) | пинг `/api/bot-ping` (уже есть паттерн), показать онлайн/оффлайн |

## Интеграция с Composio (важный кейс)

Composio сам по себе — «хаб подключений», но: (а) CLI v0.2.31 устарел (v1 API = 410), (б) `ak_` = project-key для SDK/env, `uak_` = user-key для CLI login — разные, отсюда путаница. Модуль должен:
- Тестировать composio-ключ через **v3 API** (`GET /api/v3/toolkits`), а не через CLI.
- Показывать **число connected_accounts** (сегодня было 0 — вот почему «ничего не работает»), тянуть `GET /api/v3/connected_accounts`.
- Кнопка «подключить сервис в composio» → composio connect-флоу.
- Не завязываться на CLI (он ломкий) — ходить в v3 REST напрямую.

## Фазы

- **MVP (Фаза 1):** `connections.json` + `/api/conn/list` + `/api/conn/check` + панель со статусами (read-only) + кнопка «открыть dashboard». Уже это решает 80% боли — видно что живо/мертво. Наполнить из `check-keys.sh`.
- **Фаза 2:** `set-key` с пропагацией во все конфиги + модалка вставки ключа.
- **Фаза 3:** oauth/mcp/cli реконнект-флоу в один клик + фоновый автопинг + уведомление (Telegram) когда что-то умерло.
- **Фаза 4:** «свой сервис подключений» — если не хотим зависеть от composio, AI Garage сам становится реестром кред для всех агентов (Mac + VPS через синк).

## Переиспользовать
- `~/.config/claude/check-keys.sh` — готовая матрица health-чеков (endpoint + okCode + regenerate-URL по каждому провайдеру). Это буквально сид для `connections.json`.
- Паттерн `services.json` + `/api/service-*` + карточки — копировать 1:1.
- `/api/claude-relogin` — прецедент реконнекта.

## Что НЕ делать
- Не хранить ключи в самом `connections.json` (только имена env-ключей + где лежат). Значения читать из `.env` в момент чека, не дублировать в конфиг модуля.
- Не логировать значения ключей.
- Не гонять health чаще чем раз в N минут (рейт-лимиты провайдеров).
