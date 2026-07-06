---
title: Multi-Preview Stage — спека фичи
created: 2026-06-18
status: ready-to-implement
author: planning-session (Az + Claude)
target-file: public/multi.html (новая страница, копия public/index.html)
linear: KIT-XXX (см. localhost-control project)
---

# Multi-Preview Stage

## Контекст

В AI Garage (`localhost-control`) у каждого сервиса есть кнопка **Preview** — клик открывает iframe **внутри карточки** через `togglePreview(name)` → `buildPreviewContent(w, name)`. Это позволяет открыть несколько превью, но они появляются inline по одному, не дают общего обзора.

**Сценарий Az:** дал task в Linear по 4 проектам → ИИ переписал части интерфейсов → нужно увидеть результат **одновременно**, в общей сетке, чтобы сравнить.

## Решение — Multi-Preview Stage

Полноэкранный режим, в котором выбранные сервисы отображаются в адаптивной сетке iframe'ов.

### Поведение

1. На каждой карточке сервиса — **новая мини-кнопка** ⊞ (icon: grid) **рядом с Preview**. Toggle: добавить/убрать сервис из Multi-набора. Если в наборе — кнопка подсвечена (заливка accent).
2. В header — глобальная кнопка ▦ **Multi** со счётчиком `(N/total)`. Disabled если N=0.
3. Клик ▦ Multi → **fullscreen overlay** с сеткой:
   - Top-bar 40px: title «Multi-Stage», справа `[↻ refresh all] [⊟ remove all] [✕ close]`
   - Grid: auto-fit `minmax(420px, 1fr)` по умолчанию. При 2 элементах — 1×2 (или 2×1 если landscape узкий). 3-4 → 2×2. 5-6 → 3×2. 7+ → 3×3 + scroll.
   - Каждый tile: imp title (имя сервиса) сверху, iframe, footer `[↻ reload] [↗ open in tab]`
   - Iframe `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"` (как в текущем `buildPreviewContent`).
4. Hotkeys в Multi-Stage:
   - `Esc` — close
   - `R` — refresh all
   - `1..9` — focus tile N (рамка accent + iframe.focus())
5. Состояние persist'ится в `localStorage` ключом `garage:multi:names` (Set имён). Открывается через URL `?multi=1` либо при клике в header.
6. Drag-and-drop **необязательно** в v1, но желательно — переставить tile'ы.

### Не делаем в v1

- Не реализуем разделение экранов (panel resize)
- Не делаем shared scroll
- Не делаем синхронный refresh (по одному, не всех одновременно — но кнопка «refresh all» вызывает по очереди с задержкой 200ms)
- Не делаем capture screenshot

## Технически

### Файлы

- **Новая страница:** `public/multi.html` — копия `public/index.html` с изменениями
- **Сервер:** `server.mjs` **не трогаем**. Express/static уже отдаст `/multi.html` если он лежит в public/.
- **Альтернативно (если на сервере есть rewrite):** проверить как `index.html` отдается из `server.mjs` (grep по `index.html` или `sendFile`). Возможно нужно добавить routing `/multi` → `public/multi.html`.

### Структура multi.html (диф против index.html)

1. **Header**: добавить ▦ Multi кнопку. Селектор похожий на текущий язык/тему.
2. **Карточка сервиса**: рядом с Preview добавить ⊞. Использовать SVG icon из существующего `icon()` хелпера или вставить новый.
3. **Новый компонент `#multiStage`** — fullscreen overlay. CSS:
   ```css
   .multi-stage{position:fixed;inset:0;z-index:100;background:var(--bg);display:none;flex-direction:column}
   .multi-stage.open{display:flex}
   .multi-grid{flex:1;display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:12px;padding:12px;overflow:auto}
   .multi-tile{background:var(--card);border-radius:var(--r);box-shadow:var(--shadow);display:flex;flex-direction:column;min-height:340px}
   .multi-tile .head{padding:8px 12px;border-bottom:1px solid var(--line);font-weight:600}
   .multi-tile iframe{flex:1;border:0;background:#fff}
   .multi-tile .foot{padding:6px 8px;display:flex;gap:6px;justify-content:flex-end;border-top:1px solid var(--line)}
   ```
4. **JS-добавки** (после строки 938 в index.html — это место где `openPrevs.forEach(...)` восстанавливает превью):
   ```js
   // Multi-Stage
   const multiNames = new Set(JSON.parse(localStorage.getItem('garage:multi:names')||'[]'));
   const saveMulti = ()=>localStorage.setItem('garage:multi:names', JSON.stringify([...multiNames]));
   function toggleMulti(name){
     if(multiNames.has(name)) multiNames.delete(name); else multiNames.add(name);
     saveMulti(); render(); updateMultiBadge();
   }
   function openMultiStage(){
     const stage = document.getElementById('multiStage');
     const grid = stage.querySelector('.multi-grid');
     grid.innerHTML = '';
     [...multiNames].forEach((name,i)=>{
       const s = DATA.find(x=>x.name===name); if(!s) return;
       const u = safeUrl(s.url);
       const tile = document.createElement('div');
       tile.className = 'multi-tile'; tile.dataset.name = name;
       tile.innerHTML = `
         <div class="head">${esc(name)} · ${esc(s.url||'')}</div>
         <iframe src="${esc(u)}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
         <div class="foot">
           <button onclick="reloadMultiTile('${jsq(name)}')">${icon('restart')}</button>
           <button onclick="window.open('${esc(u)}','_blank')">${icon('external')}</button>
         </div>`;
       grid.appendChild(tile);
     });
     stage.classList.add('open');
     document.addEventListener('keydown', multiKeys);
   }
   function closeMultiStage(){
     document.getElementById('multiStage').classList.remove('open');
     document.removeEventListener('keydown', multiKeys);
   }
   function multiKeys(e){
     if(e.key==='Escape') closeMultiStage();
     else if(e.key==='r'||e.key==='R') refreshAllMulti();
     else if(/^[1-9]$/.test(e.key)){
       const tile = document.querySelectorAll('.multi-tile')[+e.key-1];
       if(tile){ tile.querySelector('iframe').focus(); }
     }
   }
   function reloadMultiTile(name){
     const tile = document.querySelector(`.multi-tile[data-name="${CSS.escape(name)}"]`);
     if(!tile) return;
     const iframe = tile.querySelector('iframe');
     iframe.src = iframe.src; // re-trigger load
   }
   function refreshAllMulti(){
     document.querySelectorAll('.multi-tile').forEach((tile,i)=>{
       setTimeout(()=>{ const f=tile.querySelector('iframe'); f.src=f.src; }, i*200);
     });
   }
   function updateMultiBadge(){
     const btn = document.getElementById('multiBtn');
     if(!btn) return;
     btn.textContent = `▦ Multi (${multiNames.size})`;
     btn.disabled = multiNames.size === 0;
   }
   updateMultiBadge();
   // Открыть Multi-Stage по URL ?multi=1
   if(new URLSearchParams(location.search).get('multi')==='1' && multiNames.size>0) openMultiStage();
   ```
5. **HTML overlay** — вставить перед `</body>`:
   ```html
   <div id="multiStage" class="multi-stage">
     <div class="multi-topbar" style="display:flex;align-items:center;padding:8px 12px;gap:8px;border-bottom:1px solid var(--line);background:var(--card)">
       <div style="font-weight:600;flex:1">Multi-Stage</div>
       <button onclick="refreshAllMulti()">↻ refresh all</button>
       <button onclick="multiNames.clear(); saveMulti(); openMultiStage(); updateMultiBadge(); closeMultiStage();">⊟ remove all</button>
       <button onclick="closeMultiStage()">✕</button>
     </div>
     <div class="multi-grid"></div>
   </div>
   ```
6. **Кнопка ⊞ на карточке** — найти где рендерятся карточки (строки 740-750 в index.html, кнопка Preview генерится как `<button class="btn btn-accent" onclick="togglePreview('${jsq(s.name)}')">${icon('eye')} ${t('preview')}</button>`). Добавить рядом:
   ```js
   `<button class="btn ${multiNames.has(s.name)?'btn-accent':''}" onclick="toggleMulti('${jsq(s.name)}')" title="Add to Multi">${icon('grid')||'⊞'}</button>`
   ```
7. **Кнопка ▦ Multi в header** — найти где header кнопки (язык/тема), добавить:
   ```html
   <button id="multiBtn" onclick="openMultiStage()">▦ Multi (0)</button>
   ```

### Иконки

В `icon()` функции добавить case `'grid'` и `'external'` (SVG inline). Если лень — использовать unicode `⊞` и `↗` как fallback.

## Acceptance Criteria

- [ ] `public/multi.html` существует, открывается по `http://localhost:7777/multi.html`
- [ ] На каждой карточке сервиса есть кнопка ⊞ рядом с Preview
- [ ] Клик ⊞ добавляет/убирает сервис из набора, кнопка подсвечивается
- [ ] В header есть `▦ Multi (N)` со счётчиком, disabled при N=0
- [ ] Клик `▦ Multi` открывает fullscreen overlay с сеткой iframe'ов
- [ ] Сетка auto-fit `minmax(420px, 1fr)`, gap 12px, scroll если не помещается
- [ ] Каждый tile: header с именем, iframe, footer с reload + external
- [ ] Esc закрывает overlay, R обновляет все, цифры 1-9 фокусируют tile
- [ ] LocalStorage сохраняет набор между обновлениями страницы
- [ ] URL `?multi=1` открывает overlay автоматически (если набор не пуст)
- [ ] Тест: открыть на 4 сервисах, проверить grid 2×2, тест на 6 → 3×2, тест на 1 → один tile во весь экран

## Как тестировать

1. Открыть `http://localhost:7777/multi.html`
2. Запустить 4-6 сервисов через основной AI Garage (`http://localhost:7777/`)
3. На multi.html нажать ⊞ на 4 сервисах → проверить что счётчик `▦ Multi (4)`
4. Нажать ▦ Multi → должна открыться сетка 2×2
5. ESC → закрыть. Перезагрузить страницу с `?multi=1` → сетка снова открыта.

## Если зайдёт — мердж

После одобрения Az'ом — портировать изменения обратно в `public/index.html` (не отдельной страницей, а как режим основной). Удалить `multi.html`.

## Не задача в этом тикете

- Drag-n-drop порядок tile'ов — отложить в v2
- Synced scroll, screenshot capture — отложить
- Темы Multi-Stage — наследует основную тему, не переопределяем
