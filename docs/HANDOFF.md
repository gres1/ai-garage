# AI Garage — HANDOFF для новой сессии

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

## Сделано
- **Фаза 1 — доступ с телефона** (`server.mjs` + `public/index.html`): режимы `off/tailscale/public` в `~/.config/localhost-control/config.json`; bind на Tailscale-IP; форс-токен за пределами loopback; расширенный CSRF; `/api/access`; QR (вендорный `public/qrcode.min.js`, MIT); токен через `#fragment`. Кнопка «Телефон» помечена **PRO**, скрыта при удалённом заходе.
- **Фаза 2 — десктоп (Tauri 2)** в `desktop/`: обычное окно + Dock + видимая монохромная иконка в трее с бейджем `X/Y` + меню (открыть/автозапуск/выход). Сервер вшит как **sidecar** (`bun build --compile`, Node не нужен) — `desktop/build-sidecar.mjs`. Ассеты резолвятся через `--assets` (Tauri resource) / execDir / `__dirname` (`resolvePublicDir()` в server.mjs). Внешние ссылки из webview открываются в системном браузере (мостик `/__open`, см. `lib.rs` + `LINK_SCRIPT`). DMG: `npx tauri build --bundles dmg`. Подпись ad-hoc; Developer ID — позже.
- **Live view** — режим «стена живых iframe» (переключатель «Список ⇄ Live view» в шапке, один порт). Детект блокировки строго по `/api/can-embed` (не по таймауту). Перетаскивание плиток за шапку, инкрементальное добавление/удаление, скрыт на телефоне. Спека: `docs/SPEC-live-view.md`.
- **UX-редизайн карточки (частично)**: единый набор — одна **Вкл/Выкл** (`togglePower`: умное вкл/выкл, авто-подхват команды пока сервис жив, по умолчанию ставит keep-alive), **«Держать включённым»**, Preview; Restart/туннель/освободить-порт/«Настроить запуск» — в меню ⋮. **Страшная форма больше не выскакивает** — при неизвестной команде мягкая подсказка (`cantStart`), ручная настройка только через ⋮.
- **prompt/confirm → мини-модалки** (`uiPrompt`/`uiConfirm` в index.html) — нативные в Tauri не работают (ломались rename, «Other», удаление, токен). Починено.
- Локальные проекты пользователя прописаны в `~/.config/localhost-control/services.json` с **фоновыми** командами (важно: команда должна быть фоновой `nohup ... &`, иначе панель убьёт по 25с-таймауту `runCmd`): vault-brain (`./start.sh`), ATLAS (`nohup python3 server.py --port 8788 ... &`, cwd `~/Documents/App/atlas-prototype`), лендинг node:4444 (`nohup npm run dev -- --port 4444 ... &`, cwd `~/Documents/App/ai-garage-landing`). Сейчас ATLAS+лендинг запущены.

## Осталось (задачи)
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
