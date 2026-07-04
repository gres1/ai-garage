# AI Garage — HANDOFF для новой сессии

> **Обновлено: 2026-06-28.** ЭТО единственный актуальный HANDOFF — файл `~/Documents/App/localhost-control/docs/HANDOFF.md`.
> Старый `Vault/Obsidian/Projects/localhost-control/HANDOFF — передать новой сессии.md` УСТАРЕЛ (первая сессия) — не использовать.
> Новой сессии говорить дословно: «прочитай `~/Documents/App/localhost-control/docs/HANDOFF.md` и продолжи».

Передача контекста: что сделано, что осталось, нюансы. Проект: `~/Documents/App/localhost-control` (npm `ai-garage`, GitHub `gres1/ai-garage`).

## ПРАВИЛО №1 (критично)
**НЕ добавлять `Co-Authored-By: Claude` в git-коммиты.** Автор — только пользователь (gres1/Az/Tito). Память: `~/.claude/.../memory/feedback_git_no_coauthor.md`.

## Текущее состояние (на момент передачи)
- Вся работа на ветке **`feat/desktop-tauri-phone-access`** (НЕ запушена). История уже **очищена от claude** (0 упоминаний). Последние коммиты: `b5df58b`, `b6a94b1`.
- `origin` = `https://github.com/gres1/ai-garage.git` (пользователь думал, что переименовал в AzDev, но `gh api user` = `gres1` — rename НЕ вступил; remote вернул на gres1).
- **Осталось запушить** (workflow-scope уже выдан пользователем через `gh auth refresh -s workflow`): пользователь сам выполняет
  ```
  cd ~/Documents/App/localhost-control && git push --force origin feat/desktop-tauri-phone-access:main
  ```
  (force-push и git filter-branch ЗАБЛОКИРОВАНЫ песочницей агента — это делает пользователь сам.)
- Десктоп `.app` стоит в `/Applications/AI Garage.app`; пересобирается из `desktop/`.

## ✋ TODO пользователя (Az делает сам — завести в Linear, когда MCP вернётся)
1. **Apple Developer аккаунт** ($99/год, developer.apple.com) — чтобы подписать десктоп: иначе при установке Mac пугает «приложение от неизвестного разработчика». После оплаты — прислать, агент пропишет подпись.
2. **Запушить код в GitHub** (одна команда, агента песочница не пускает): открыть Терминал →
   `cd ~/Documents/App/localhost-control && git push origin HEAD:main` (на 2026-06-30 это fast-forward, force НЕ нужен; история уже чиста от Claude — см. Сделано 2026-06-30).
3. **npm publish** новой версии — когда добьём UX: `cd ~/Documents/App/localhost-control && npm publish` (сначала агент поднимет version).
4. **composio login** (для Higgsfield-видео на лендинг): `composio upgrade && composio login`.
5. **VPS always-online** (опц.) — решить, нужна ли копия панели на VPS 24/7; потребует дать агенту SSH-доступ (отдельно объяснить по шагам).

## Сделано (2026-07-05)
- **Авто-запоминание команд (ключевая фича, generic для клиентов):** панель, увидев живой порт, тихо снимает его команду+cwd в `~/.config/localhost-control/commands.json` (`captureCmd` в /api/status, только для НОВЫХ портов). Дальше кнопка Вкл и keep-alive работают БЕЗ ручной настройки. `hasControls` учитывает запомненное; `resolveCmds(svc)` подставляет команду в start/stop/restart и в `ensureKeepAlive`/`keepAliveSet`. `guessCmd` отрефакторен на общую `guessCmdFromRaw`. Протестировано end-to-end (изолированный HOME). Коммит `fed3c3f`.
- **MCP `register_service` + POST `/api/register`:** агент, спавня сервер, регистрирует его (name/port/command/cwd) → панель заводит карточку + пишет команду в commands.json → кнопка Вкл работает сразу, даже до первого запуска. Пояс+подтяжки к авто-запоминанию. Коммит `b78ba10`. Протестировано.
- **Убрана всегда-висящая карточка «Claude CLI»** (по решению Az — было непонятно/«unknown»). Оставлены доработки ВНУТРИ карточки бота: красный при auth_failed, «Пинг-тест», live-логи. Коммит `62d11d6`.
- **Версия → 0.2.0** (`e15f03f`). Раскатка: `git push origin HEAD:main` (GitHub+кэш claude) · `npm publish` · `git tag v0.2.0 && git push origin v0.2.0` (CI-сборки десктопа).
- **:3030 = insight-landing** (другой агент завёл через pm2, production, `pm2 save`). Для ребута нужен `pm2 startup` (boot-хук). В панели — только показывать, keep-alive НЕ включать (иначе pm2 и панель дерутся).

## Сделано (2026-06-30)
- **Карточка бота — полировка (Mac, #6,7,8,11,12):** красная карточка при `claude.auth_failed` (даже при HTTP 200); кнопка **«Пинг-тест»** (реальный sendMessage через Telegram Bot API, config-driven: `pingEnv`/`pingChatId` + `bots[].tokenKey` в services.json — БЕЗ хардкода в продукте); **live-логи** (попап авто-обновляется 1.5с); **macOS-уведомление** при переходе auth ok→fail (`notifyAuthFailIfNeeded`); закреплённая сверху **«Claude CLI»** карточка (`claudeStatusCard()`). Проверено playwright на статик-сервере. Коммит `789b474`. VPS-сторона (#9 re-deploy, #12 VPS-статус) — отложена (нужен SSH + фича «Подключения»).
- **Личный конфиг:** в `~/.config/localhost-control/services.json` у Mac-бота прописаны `pingEnv=~/.mcp-servers/azz-bot/.env`, `pingChatId=5843091959` (из state-файлов бота; агентский 110110069 был неверный), `tokenKey` CHAT_BOT_TOKEN/VAULT_BOT_TOKEN.
- **CI пофикшен** (`73d1c72`): причина exit 127 — в `desktop/` не ставились npm-зависимости; добавлен `npm install` + node 22. Windows может ещё потребовать правки имени sidecar `.exe` по логам нового прогона.
- **guessCmd** (`ebbedae`): не выдаёт `open -a` для CLI-серверов на dev-портах (грабли ATLAS), реальную команду оборачивает в `nohup … &`.
- **GitHub / Claude — ВЫЯСНЕНО:** поле «автор» и тела коммитов на ветке уже чисты (трейлеры `Co-Authored-By: Claude` были только в бэкап-рефах `refs/original/`). Реальный remote через API: контрибьютор только `gres1`. «claude» в боковой панели = устаревший кэш виджета GitHub. **Действие:** просто `git push origin HEAD:main` (fast-forward, force НЕ нужен) → кэш пересчитается.
- **Higgsfield:** composio залогинен, но tool-API даёт 401 → нужен одноразовый `composio login` (пользователь). Демо-видео пользователь пишет через Recordy; Higgsfield — под лого-заставку/hero-фон (промпты в чате + заметке запуска).
- **Obsidian:** план запуска сохранён — `Projects/localhost-control/Запуск и продвижение — AI Garage.md` (шот-лист GIF, демо-промпт, каналы Show HN/PH/Reddit/MCP-реестры), ссылка добавлена в `00 — ЧИТАТЬ`.
- **Чтобы УВИДЕТЬ новую карточку:** `:7777` сейчас отдаёт старый бандл из `.app` (sidecar). Быстрый превью: выйти из AI Garage → `cd ~/Documents/App/localhost-control && node server.mjs` → открыть localhost:7777 (отдаёт живой public/index.html). Для постоянного — пересобрать десктоп (см. «Нюансы»).

## Сделано (последняя сессия, 2026-06-28)
- **Бот-карточка = пульт агента (Mac, «Фаза 1»):** `azz-bot (Mac)` теперь type=local — кнопки **Вкл/Выкл/Рестарт** (launchctl bootstrap/bootout/kickstart), **«Логи»** (попап, `GET /api/logs?name=` тейлит `logPath`), **«Перелогинить Claude»** (`POST /api/claude-relogin` → `osascript` открывает Terminal с `claude login`; показывается когда Claude разлогинен). Живой статус из бота `/health` (uptime) + статус Claude.
- **Доработан сам бот** `~/.mcp-servers/azz-bot` (Python, БЕЗ git — правки локальные): `claude_cli.py` → `LAST_STATUS`+`_mark_claude` (ловит 401/authentication_failed), `health.py` отдаёт `claude:{ok,auth_failed,error,checked_at}` и `status:degraded`. Перезапуск: `launchctl kickstart -k gui/$(id -u)/com.azz.bot`.
- **Фикс «On»:** проверял `s.startCmd` (его сервер в браузер НЕ шлёт) → теперь `s.hasControls`. Сервисы с сохранённой командой стартуют по On (раньше падали в подсказку, а Keep alive работал — отсюда путаница пользователя).
- **Фикс ATLAS:** авто-захват записал неверную команду `open -a "Python"` (для .app-процессов `guess-cmd` отдаёт `open -a Name` — для CLI-серверов это НЕВЕРНО, не поднимает порт). Исправлено в services.json на `nohup python3 server.py --port 8788 > /tmp/atlas-8788.log 2>&1 &`, cwd `~/Documents/App/atlas-prototype`. **TODO:** в `guessCmd` (server.mjs) не выдавать `open -a` для процессов на dev-портах — отдавать реальную CLI-команду или пусто.
- **Keep alive** убран из видимых кнопок карточки → в меню ⋮ (On и так включает keep-alive). **Метрики CPU/RAM** перенесены мелким к `:port` (RAM всегда, CPU только ≥1%, без «0.0%»); кросс-платформенно безопасно (Windows — пропуск).
- **Логотип/лендинг** — см. ниже. Все коммиты на ветке `feat/desktop-tauri-phone-access`, БЕЗ Co-Authored-By (правило №1). Пользователь пушит сам: `git push origin feat/desktop-tauri-phone-access:main`.

## Сделано (2026-06-26)
- **Метрики CPU/RAM на карточках** (#1) — `procInfo()` (один `ps` + один `lsof`); проверено сравнением с системным `ps` (панель 97.9% = ps 98.4%, RAM байт-в-байт). RAM всегда, CPU только ≥1% (без шумных нулей). На Windows пропускается (нет ps/lsof) — кросс-платформенно безопасно.
- **Человеческие имена обнаруженных** (#2) — по cwd процесса (`node :8787` → `vault-brain`).
- **Тултип «cantStart»** — был улетающий toast, стал popover (`hintAt`) прямо под кнопкой, держится 8с.
- **Логотип приложения** заменён на `MagicEraser_260617…PNG` (сжатый logo.png/favicon).
- **Лендинг**: `~/Documents/App/ai-garage-landing` (Next.js, dev :4444) — Hero (большой лого справа + обтекание), тёмная grid-секция, Real-UI showcase, Free/Pro (Pro=waitlist), плейсхолдеры `/hero.mp4` `/demo.mp4` под Higgsfield-видео.
- Дизайн-инструменты записаны: `Vault/Obsidian/Resources/Дизайн — инструменты и ресурсы.md`.
- **Новое направление в обсуждении** (не начато): визуализация/управление Telegram-агентами в панели — отдельная вкладка «Агенты». Mac-агент `com.azz.bot` (LaunchAgent, KeepAlive, логи `~/.mcp-servers/azz-bot/logs/`) — управляем локально (статус/логи/рестарт через launchctl). VPS-агенты (Hermes/OpenClaw) — нужен репортёр на VPS или SSH.

## Сделано
- **Фаза 1 — доступ с телефона** (`server.mjs` + `public/index.html`): режимы `off/tailscale/public` в `~/.config/localhost-control/config.json`; bind на Tailscale-IP; форс-токен за пределами loopback; расширенный CSRF; `/api/access`; QR (вендорный `public/qrcode.min.js`, MIT); токен через `#fragment`. Кнопка «Телефон» помечена **PRO**, скрыта при удалённом заходе.
- **Фаза 2 — десктоп (Tauri 2)** в `desktop/`: обычное окно + Dock + видимая монохромная иконка в трее с бейджем `X/Y` + меню (открыть/автозапуск/выход). Сервер вшит как **sidecar** (`bun build --compile`, Node не нужен) — `desktop/build-sidecar.mjs`. Ассеты резолвятся через `--assets` (Tauri resource) / execDir / `__dirname` (`resolvePublicDir()` в server.mjs). Внешние ссылки из webview открываются в системном браузере (мостик `/__open`, см. `lib.rs` + `LINK_SCRIPT`). DMG: `npx tauri build --bundles dmg`. Подпись ad-hoc; Developer ID — позже.
- **Live view** — режим «стена живых iframe» (переключатель «Список ⇄ Live view» в шапке, один порт). Детект блокировки строго по `/api/can-embed` (не по таймауту). Перетаскивание плиток за шапку, инкрементальное добавление/удаление, скрыт на телефоне. Спека: `docs/SPEC-live-view.md`.
- **UX-редизайн карточки (частично)**: единый набор — одна **Вкл/Выкл** (`togglePower`: умное вкл/выкл, авто-подхват команды пока сервис жив, по умолчанию ставит keep-alive), **«Держать включённым»**, Preview; Restart/туннель/освободить-порт/«Настроить запуск» — в меню ⋮. **Страшная форма больше не выскакивает** — при неизвестной команде мягкая подсказка (`cantStart`), ручная настройка только через ⋮.
- **prompt/confirm → мини-модалки** (`uiPrompt`/`uiConfirm` в index.html) — нативные в Tauri не работают (ломались rename, «Other», удаление, токен). Починено.
- Локальные проекты пользователя прописаны в `~/.config/localhost-control/services.json` с **фоновыми** командами (важно: команда должна быть фоновой `nohup ... &`, иначе панель убьёт по 25с-таймауту `runCmd`): vault-brain (`./start.sh`), ATLAS (`nohup python3 server.py --port 8788 ... &`, cwd `~/Documents/App/atlas-prototype`), лендинг node:4444 (`nohup npm run dev -- --port 4444 ... &`, cwd `~/Documents/App/ai-garage-landing`). Сейчас ATLAS+лендинг запущены.

## Осталось (задачи)
**Свежие (от пользователя, 2026-06-28) — двигать дальше:**
1. **Фаза 2 — пульт ботов на VPS** (то же, что Mac-Фаза1, но через SSH). **Доступ ЕСТЬ:** `ssh agent@178.105.196.251` (пользователь подтвердил, можно пользоваться). Сделать: карточку `azz-bot (VPS)` → type=local: startCmd `ssh agent@178.105.196.251 'systemctl --user start azz-bot'`, stopCmd `... stop`, restart `... restart`; VPS-Claude статус через туннель `http://127.0.0.1:8766/health` (поднять cloudflared/ssh-туннель к VPS-боту :8766); «Логи VPS» = `ssh ... 'tail -100 ~/.mcp-servers/azz-bot/logs/bot.err.log'`; «Перелогинить Claude VPS» = `ssh -t agent@178.105.196.251 'claude /login'`. На VPS бот тоже доработать как Mac (отдавать `claude` в /health).
2. **Реестр SSH/подключений в приложении** (идея пользователя — обсудить, потом согласовать): хранить SSH-строки/туннели/команды приватно в `~/.config/localhost-control` (НЕ в git, chmod 600), чтобы не искать по заметкам — для пользователя и его клиентов. Возможно отдельная секция «Подключения». Безопасность: ключи держать ССЫЛКОЙ на файл, не сам приватный ключ.
3. **Боты: одна карточка vs раздельно** — решить. Сейчас `azz-bot` = одна карточка на 2 бота (служба). Рекомендация: оставить карточку службы, но показывать живой статус КАЖДОГО бота (chat/vault) отдельно — для этого бот в `/health` должен отдавать per-bot статус (сейчас отдаёт только общий). Молния ⚡ на чипе = «продвинутый» (голос/реалтайм), кружок = вкл/выкл.
4. **Лендинг** `~/Documents/App/ai-garage-landing` (Next.js, :4444) — готов; ждёт GIF/видео в `public/demo.mp4`+`hero.mp4` (Higgsfield-промпты — в чате) и деплой на Vercel.

**Из прошлого:**
1. **Метрики CPU/RAM на карточке** (задача #15, не сделано): сервер — один `ps -o pid=,%cpu=,%mem=,rss= -p <pids>` по pid из `discoverPorts`, отдать в `/api/status`; UI — показать на карточке.
2. **Лучшие имена «обнаруженных» сервисов** (запрос пользователя): вместо «node :4444» выводить имя проекта — на сервере по pid взять cwd процесса (`lsof -p <pid> -d cwd` или `ps`)→ имя папки. Сейчас имена generic.
3. **Прописать команды ещё двум проектам пользователя**: **orchestrator/LLM Panel (:8790)** — папка `~/Documents/App/orchestrator` (нет package.json — узнать как стартует, м.б. python/pm2); **проект на :4321** (пользователь: «тоже лендинг»). Прописать фоновые startCmd+cwd в services.json, как ATLAS.
4. **Developer ID подпись + нотаризация** (#13): когда у пользователя будет Apple Developer аккаунт ($99/год). Прописать `bundle.macOS.signingIdentity` + notarytool; пароль вводит пользователь, агент — не вводит.
5. **VPS «всегда онлайн»** (#6, опц.): копия сервера на VPS `178.105.196.251` под pm2 + Tailscale. SSH по ключу id_ed25519 НЕ пускает (нужен доступ от пользователя). Команды — в истории чата.
6. **npm publish новой версии** — когда добьём UX (новый функционал не опубликован; `npx ai-garage` ставит старую версию). Поднять version в package.json, `npm publish`.
7. **GitHub Actions** (`.github/workflows/build-desktop.yml`) — кросс-сборка Win/Linux/Mac; нужен `workflow` scope (выдан). Win/Linux серверной части — «macOS-first», keep-alive (launchd) только macOS.

## Нюансы / как делать
- **Пересборка десктопа без убийства запущенной копии пользователя:** `cd desktop && PATH="$HOME/.cargo/bin:$PATH" npx tauri build --debug --bundles app`, затем `ditto "src-tauri/target/debug/bundle/macos/AI Garage.app" "/Applications/AI Garage.app"`. НЕ делать `pkill`/`open` по его копии — раньше это давало диалог «приложение больше не открыто» и злило. Пользователь сам перезапускает (трей → Выйти → открыть).
- **Тест UI без его копии:** временный статик-сервер `cd public && python3 -m http.server 8899`, playwright на `127.0.0.1:8899`, `card({...mock})` / eval. Порт 7777 занят его инстансом (sidecar отдаёт старый бандл из `.app`).
- **server.mjs PORT=7777 хардкод.** Панель сейчас в режиме `access:public` + токен в config.json → мутации требуют токен (UI хранит его в localStorage; curl/MCP — нужен заголовок `x-control-token`). Прямая правка services.json токен обходит (панель читает файл на лету).
- **Синтаксис JS перед сборкой:** извлечь основной `<script>` из index.html и `node --check`.
- **Поведение Az (см. `~/.claude/CLAUDE.md`):** объяснения по-русски простыми словами без жаргона; терсно; делать ЗА него (CLI/код), не инструктировать без нужды; визуальная проверка UI (playwright); при фрустрации — быстрый фикс, меньше слов. Не плодить Linear/файлы без явной просьбы.

## Принцип для клиентов (важный вопрос пользователя)
UX-механика **универсальна и едет в приложении** (одна Вкл/Выкл, нет страшной формы, «запусти раз — запомню», monitor-only ссылки для VPS/внешнего). А **конкретные команды** (ATLAS/лендинг с путями) — это локальный конфиг ЭТОГО пользователя в его `~/.config/...`, в продукт не зашиты. У клиента панель так же: его сервисы получают команды на ЕГО машине (захват при запуске / ручная настройка), монитор-ссылки просто показывают статус.
