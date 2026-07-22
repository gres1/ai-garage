# Orbit 3D — спека полного функционала (для витрины)

> `public/orbit.html` — 3D-пространство (Three.js, вложен в `public/vendor/`). Цель: ВЕСЬ функционал панели, но в spatial-дизайне. Составлено разведкой 8 агентов 2026-07-22 (769K токенов). Полный дамп: workflow `wf_6fa94d32-660` journal.jsonl.

## Фундамент (первым — без него ничего не работает)
- Портировать из `index.html` ВЕРБАТИМ: `token()` (L855), `api()` (L856-860, шлёт `x-control-token`, на 401 → `uiPrompt` → сохраняет в localStorage → ретрай), `uiPrompt/uiConfirm/toast` (L852,862-872 — нативные prompt/confirm мертвы в Tauri webview!), `safeUrl()`, `jsq()`, `esc()`, `#token=`-hash-capture IIFE (L876).
- **orbit на том же origin (localhost:7777) → localStorage общий → auth переиспользуется, свой флоу не нужен.**
- **На loopback мутации БЕСПЛАТНЫ** (токен нужен только для tunnel/LAN/public). CSRF Origin-check проходит сам для same-origin POST.
- После каждого успешного `api()` — refetch `/api/status` + перерисовать открытую деталь-панель.

## Порядок реализации (по ценности)
1. Фундамент (auth/api/helpers/refetch) + kebab-builder по флагам `{s.port,s.control,isBot,isApp,s.startCmd}`.
2. **Services** — богатейшая карточка, даёт ~80% переиспользования.
3. **Bots** — Telegram, ежедневно.
4. **Apps** — маленькая (appAct + keepalive + reveal).
5. **VPS** — это Services с 2 вариантами (control:true SSH прячет urls+сжимает kebab; либо host-matched = обычный сервис).
6. **Secrets** — изолировано, security-модель.
7. **Agents + Connections** — НЕ переписывать: встроить `/connections.html?embed=1` в iframe-оверлей (как `toggleConn` в панели).

## Общие хелперы (написать один раз)
- `togglePower(name)` — On/Off это ВЕТКА, не endpoint: down→On = POST /api/start (или guess-cmd→service-setcmd→start) + авто keepalive enable:true; up→Off = keepalive off → /api/stop или /api/kill-port. Services+Bots+VPS (НЕ apps).
- `appAct(name,action)` — apps: start|stop|restart|reveal → POST /api/app-action; stop СНАЧАЛА keepalive enable:false.
- `toggleKeepAlive` → /api/keepalive {name,enable}; `act(name,'restart')` → /api/restart; `renameService` → /api/service-rename; `delService` → /api/service-remove (confirm); `setHost` → /api/service-sethost; `tunnelStart/Stop` → /api/tunnel-start|stop; `killPort` → /api/kill-port (confirm, для <1024/DB — усиленный killDanger); `editUrl` → /api/service-seturl; `openManage/saveManage` → /api/service-setcmd (+guess-cmd).
- Connections grant: `toggleGrant` → /api/conn/grant (или пропустить через iframe).

## Ключевые риски (легко забыть при портировании)
- On/Off не один endpoint (ветка + fallback + авто keepalive).
- App off при keepalive = 2 запроса ПО ПОРЯДКУ (keepalive off → app-action stop), иначе супервизор поднимет за 3с.
- **honest-status: unknown ≠ off.** VPS/portless-боты = нейтральный (не красный). Три состояния: up / down / unknown. Счётчик header: down = total−up−unknown.
- kebab-гейтинг по флагам: portless сервис = только Edit/Rename/Remove; control:true SSH так же; у ботов нет keepalive/edit-link/preview.
- urls-блок (port/url/метрики/tunnel) СКРЫТ при `s.control||bot||app`.
- Боты: per-@username чипы (bots[] = объекты {user,name,tier,tokenKey} ИЛИ строки; tier='advanced' → ⚡; цвет точки botChipSt; чипы = t.me ссылки; status:'off' переопределяет health).
- Preview IS_LOCAL-gated + GET /api/can-embed?port (X-Frame-Options).
- metricsStr: только rss (МБ) + cpu (если ≥1%), только когда up; mem НЕ показывать.
- Secrets: значение НИКОГДА в list GET, только POST /api/secrets-get по Copy/Show; Show авто-скрытие ровно 15с (toggle); имя /^[\w .:\-/@]{1,60}$/; вся категория скрыта если /api/secrets supported:false (не-macOS); delete-confirm говорит «из Keychain».
- Agents: НЕТ health-пробы — всегда зелёный «detected»; одна кнопка Access; не выдумывать Start/Stop.
- Санитайзеры: safeUrl() на каждый href, jsq() на inline onclick-строки — иначе XSS через note/url или сломанный onclick с кавычками.
- Composio (если переписывать): async OAuth (open redirect_url → poll /api/conn/status 2.5с до 180с), не один вызов. → лучше iframe.
- tooltips несут смысл (unkTip/kaTip/claudeAuthTip/menuBarTip/killDanger) — сохранить.

## Реалистичные формы (пункт Az №2) — процедурные эмблемы вместо голых многогранников
Серверная стойка (Сервисы) · планета+атмосфера (VPS) · голова-ИИ с визором (Агенты) · робот (Боты) · сейф с замком (Секреты) · хаб-узел со спицами (Подключения) · стопка окон (Приложения). Из примитивов Three.js, PBR-материалы. Фотореал → .glb модели от Az.
