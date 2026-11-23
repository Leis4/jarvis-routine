/* JARVIS v49.2 — Web Push client + owner diagnostics for the installed iPhone PWA.
 *
 * Chain: tap → Notification.requestPermission → PushManager.subscribe(VAPID)
 *        → POST /api/push/subscribe → D1 → POST /api/push/test → provider
 *        → service worker push event → showNotification → notificationclick.
 *
 * The client computes absolute local timestamps for the next 21 days and
 * resyncs on open/foreground/edit/complete/delete. It never claims device
 * delivery; diagnostics show provider acceptance only.
 */
(function (root) {
  'use strict';
  const CONFIG_KEY = 'jarvis_routine_ai_v3';
  const LAST_TEST_KEY = 'jarvis_push_last_test';
  const PROD_API = 'https://jarvis-routine-api.demo.workers.dev';
  let syncing = null, lastSync = 0, timer = 0, keyCache = null, keyPromise = null, lastApi = null, usedFallback = false;

  function cfg() { try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'); } catch (e) { return {}; } }
  async function api(path, options) {
    const c = cfg();
    if (!c.url || !c.token) throw new Error('no_server_config');
    let base = c.url;
    try {
      const u = new URL(base);
      // The AI settings sometimes point at the static frontend. Push must use
      // the API Worker, which is a separate origin (frontend /api/status = 404).
      if (u.hostname === 'jarvis-routine.demo.workers.dev') {
        base = PROD_API; usedFallback = true;
        // Correct the stored AI URL once: the static frontend has no /api routes.
        try { const o = cfg(); o.url = PROD_API; localStorage.setItem(CONFIG_KEY, JSON.stringify(o)); } catch (e) {}
      }
    } catch (e) {}
    const r = await fetch(String(base).replace(/\/$/, '') + path, {
      method: (options && options.method) || 'GET',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.token },
      body: options && options.body !== undefined ? JSON.stringify(options.body) : undefined,
      cache: 'no-store'
    });
    lastApi = { path, status: r.status, at: Date.now() };
    let data = null;
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) {
      const err = new Error((data && (data.error || data.detail)) || ('HTTP ' + r.status));
      err.status = r.status;
      err.code = data && (data.error || data.detail);
      throw err;
    }
    return data || {};
  }
  function installed() {
    try {
      return navigator.standalone === true ||
        matchMedia('(display-mode: standalone)').matches ||
        matchMedia('(display-mode: fullscreen)').matches;
    } catch (e) { return false; }
  }
  function supported() {
    return !!(root.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in root && 'Notification' in root);
  }
  function leadMinutes() {
    const n = Number(S && S.reminders && S.reminders.minutes);
    return Number.isFinite(n) && n >= 0 && n <= 60 ? n : 10;
  }
  function b64(bytes) {
    let bin = '';
    const a = new Uint8Array(bytes);
    for (let i = 0; i < a.length; i++) bin += String.fromCharCode(a[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function isStale(sub) {
    try {
      if (!sub || !keyCache) return false;
      const raw = sub.options && sub.options.applicationServerKey;
      if (!raw) return false;
      return b64(raw) !== keyCache.replace(/=+$/, '');
    } catch (e) { return false; }
  }
  async function loadKey(force) {
    if (keyCache && !force) return keyCache;
    if (!keyPromise || force) keyPromise = api('/api/push/key').then(r => { keyCache = r.publicKey || null; return keyCache; }).finally(() => { keyPromise = null; });
    return keyPromise;
  }
  async function currentSubscription() {
    try { const reg = await navigator.serviceWorker.ready; return await reg.pushManager.getSubscription(); } catch (e) { return null; }
  }
  async function swInfo() {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const keys = await caches.keys();
      return {
        scope: reg && reg.scope || null,
        active: !!(reg && reg.active),
        waiting: !!(reg && reg.waiting),
        installing: !!(reg && reg.installing),
        script: reg && reg.active && reg.active.scriptURL || null,
        caches: keys.filter(k => k.startsWith('jarvis-routine-')).slice(-3)
      };
    } catch (e) { return { error: String(e.message || e) }; }
  }
  async function serverStatus() {
    try {
      const s = await api('/api/push/status?device=' + encodeURIComponent(deviceId()));
      return { ok: true, ...s };
    } catch (e) {
      return { ok: false, status: e.status || null, code: e.code || e.message };
    }
  }
  async function status() {
    const sub = await currentSubscription();
    let server = { ok: false, code: 'not_checked' };
    let basic = null;
    try { basic = await api('/api/status'); server = { ok: true, configured: !!basic.pushConfigured }; } catch (e) { server = { ok: false, status: e.status || null, code: e.code || e.message }; }
    let push = null;
    if (server.ok) push = await serverStatus();
    let key = null;
    try { if (server.ok) key = await loadKey(); } catch (e) {}
    const sw = await swInfo();
    return {
      supported: supported(), installed: installed(),
      permission: ('Notification' in root) ? Notification.permission : 'unsupported',
      subscribed: !!sub, stale: isStale(sub), keyConfigured: !!key,
      server, push, sw, lead: leadMinutes(), lastApi, serverFallback: usedFallback
    };
  }
  async function enable() {
    if (!supported()) throw new Error('Web Push недоступен в этом браузере');
    if (!installed()) throw new Error('Открой JARVIS с иконки на экране «Домой»: Поделиться → На экран «Домой», затем запусти с иконки');
    if (Notification.permission === 'denied') throw new Error('Уведомления запрещены в iOS: Настройки → Уведомления → JARVIS');
    // On iOS the permission prompt is raised by pushManager.subscribe() itself,
    // directly in the tap. Do not call Notification.requestPermission() first.
    const keyStr = keyCache || await loadKey();
    if (!keyStr) throw new Error('Сервер не вернул публичный VAPID-ключ');
    const key = Uint8Array.from(atob(keyStr.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub && isStale(sub)) throw new Error('Ключ VAPID изменился. Нажми «Переподключить», чтобы обновить подписку без потери данных.');
    if (!sub) {
      try {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      } catch (e) {
        const name = e && e.name || '';
        if (name === 'NotAllowedError') throw new Error('iOS не выдал разрешение. Проверь Настройки → Уведомления → JARVIS и режим Focus.');
        throw new Error('Не удалось подписаться: ' + (e && e.message || name || 'unknown'));
      }
    }
    const saved = await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), device: deviceId() } });
    if (!saved || saved.ok !== true) throw new Error('Сервер не подтвердил сохранение подписки');
    const confirmed = await serverStatus();
    if (!confirmed.ok || confirmed.deviceSubscribed !== true) throw new Error('Подписка создана локально, но сервер её не подтвердил');
    if (S && S.reminders) { S.reminders.enabled = true; persist(); }
    await sync();
    return status();
  }
  async function reconnect() {
    const keyStr = keyCache || await loadKey(true);
    if (!keyStr) throw new Error('Сервер не вернул публичный VAPID-ключ');
    const key = Uint8Array.from(atob(keyStr.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) { try { await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); } catch (e) {} try { await sub.unsubscribe(); } catch (e) {} }
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const saved = await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), device: deviceId() } });
    if (!saved || saved.ok !== true) throw new Error('Сервер не подтвердил новую подписку');
    const confirmed = await serverStatus();
    if (!confirmed.ok || confirmed.deviceSubscribed !== true) throw new Error('Новая подписка не подтверждена сервером');
    await sync();
    return status();
  }
  async function disable() {
    const sub = await currentSubscription();
    if (sub) {
      try { await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); } catch (e) {}
      try { await sub.unsubscribe(); } catch (e) {}
    }
    if (S && S.reminders) { S.reminders.enabled = false; persist(); }
    return status();
  }
  function deviceId() {
    try {
      let id = localStorage.getItem('jarvis_push_device');
      if (!id) { id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('jarvis_push_device', id); }
      return id;
    } catch (e) { return 'dev_unknown'; }
  }
  function buildDay(date) {
    const lead = leadMinutes();
    const rows = (typeof itemList === 'function') ? itemList(date) : [];
    const done = (S && S.done && S.done[date]) || {};
    const out = [];
    for (const t of rows) {
      if (!t || t.status === 'Буфер' || t.cat === 'Буфер' || done[t.id]) continue;
      const at = Date.parse(date + 'T' + t.start + ':00');
      if (!Number.isFinite(at)) continue;
      const remindAt = at - lead * 60000;
      if (remindAt <= Date.now()) continue;
      out.push({ taskId: String(t.id), title: String(t.name).slice(0, 120), remindAt });
    }
    return out.slice(0, 30);
  }
  function horizon(days) {
    const n = Math.max(1, Math.min(30, Number(days) || 21));
    const out = [];
    const start = (typeof today === 'function') ? today() : new Date().toISOString().slice(0, 10);
    for (let i = 0; i < n; i++) {
      const d = (typeof shift === 'function') ? shift(start, i) : new Date(Date.now() + i * 86400000).toISOString().slice(0, 10);
      const items = buildDay(d);
      if (items.length) out.push({ day: d, items });
    }
    return out;
  }
  async function sync(days) {
    if (syncing) return syncing;
    syncing = (async () => {
      const sub = await currentSubscription();
      if (!sub) return { ok: false, reason: 'not_subscribed' };
      const groups = horizon(days);
      let scheduled = 0;
      for (const g of groups) {
        try { const r = await api('/api/reminders', { method: 'POST', body: g }); scheduled += Number(r.scheduled) || 0; } catch (e) {}
      }
      lastSync = Date.now();
      return { ok: true, days: groups.length, scheduled };
    })();
    try { return await syncing; } finally { syncing = null; }
  }
  function scheduleSync(days) {
    clearTimeout(timer);
    timer = setTimeout(() => { sync(days).catch(() => {}); }, 1500);
  }
  async function test() {
    const r = await api('/api/push/test', { method: 'POST', body: { device: deviceId(), immediate: true } });
    const record = {
      at: new Date().toISOString(), accepted: !!(r.accepted || r.sent),
      statuses: Array.isArray(r.providerStatuses) ? r.providerStatuses : [],
      correlationId: r.correlationId || null, note: r.note || ''
    };
    try { localStorage.setItem(LAST_TEST_KEY, JSON.stringify(record)); } catch (e) {}
    return r;
  }
  function lastTest() { try { return JSON.parse(localStorage.getItem(LAST_TEST_KEY) || 'null'); } catch (e) { return null; } }
  function lead(value) {
    const n = Math.max(0, Math.min(60, Number(value) || 0));
    S.reminders = S.reminders || { enabled: false, minutes: 10, last: {} };
    S.reminders.minutes = n;
    persist();
    scheduleSync();
    return n;
  }
  function safeDiagnostics(st) {
    const t = lastTest();
    return {
      at: new Date().toISOString(),
      version: 'v49.2',
      installed: st.installed, supported: st.supported, permission: st.permission,
      sw: st.sw, localSubscription: st.subscribed, vapidStale: st.stale,
      vapidConfigured: st.keyConfigured,
      serverConfigured: !!(st.server && st.server.configured),
      serverReachable: !!(st.push && st.push.ok),
      serverFallback: !!st.serverFallback,
      serverDeviceSubscribed: st.push ? !!st.push.deviceSubscribed : null,
      serverSubscriptions: st.push ? st.push.subscriptions : null,
      pendingReminders: st.push ? st.push.pending : null,
      nearestReminder: st.push && st.push.nearestReminder ? new Date(st.push.nearestReminder).toISOString() : null,
      lastTest: t ? { at: t.at, accepted: t.accepted, statuses: t.statuses, correlationId: t.correlationId } : null,
      lastApi: st.lastApi || null
    };
  }
  async function copyDiagnostics() {
    const st = await status();
    const text = JSON.stringify(safeDiagnostics(st), null, 2);
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); return true;
    } catch (e) { return false; }
  }

  // Rolling horizon and queue refresh.
  document.addEventListener('change', e => {
    if (e.target && e.target.matches && e.target.matches('input[data-id][data-date],#taskform input[type="time"],#taskform input[type="date"]')) scheduleSync();
  }, true);
  document.addEventListener('submit', e => {
    if (e.target && e.target.getAttribute && e.target.getAttribute('id') === 'taskform') scheduleSync();
  }, true);
  document.addEventListener('click', e => {
    if (e.target.closest && e.target.closest('[data-action="delete"],[data-action="nest"],[data-action="heroDone"],.task-check')) scheduleSync();
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastSync > 30 * 60000) scheduleSync();
  });
  root.addEventListener('pageshow', () => { if (Date.now() - lastSync > 30 * 60000) scheduleSync(); });
  setInterval(() => { if (!document.hidden) scheduleSync(); }, 6 * 60 * 60 * 1000);
  setTimeout(() => { if (!document.hidden) { loadKey().catch(() => {}); sync().catch(() => {}); } }, 4000);

  root.JarvisPush = { status, enable, disable, reconnect, sync, test, lead, horizon, buildDay, installed, supported, diagnostics: async () => safeDiagnostics(await status()), copyDiagnostics };

  /* Settings card + diagnostics (injected; survives the settingsView wrappers). */
  function ensureCard() {
    if (document.getElementById('pushCard')) return;
    const app = document.getElementById('app');
    if (!app) return;
    if (!app.querySelector('[data-action="wallpaper"]')) return;
    const holder = document.createElement('div');
    holder.innerHTML = `<div class="today-header"><div class="today-date">Настройки<small>Внешний вид, расписание, уведомления и данные</small></div></div><div class="subhead"><h2>Уведомления iPhone</h2></div><div class="card" id="pushCard"><p class="infotext" id="pushStatus">Проверяю поддержку Web Push…</p><div class="task-conflict-actions" id="pushActions" style="margin-top:6px"><button class="btn primary" data-push="enable">Включить уведомления</button><button class="btn" data-push="test">Отправить тест</button><button class="btn" data-push="reconnect" id="pushReconnect" hidden>Переподключить</button><button class="btn" data-push="off">Отключить</button></div><div class="eyebrow" style="margin-top:10px">Напомнить за</div><div class="task-conflict-actions" id="pushLead"><button class="btn tight" data-push-lead="0">0 мин</button><button class="btn tight" data-push-lead="5">5 мин</button><button class="btn tight" data-push-lead="10">10 мин</button><button class="btn tight" data-push-lead="15">15 мин</button></div><p class="tagline" id="pushHint">Push приходит на заблокированный iPhone только для PWA, добавленной на экран «Домой». Сервер отправляет по Cron; задержка до 5 минут.</p><details class="push-diag" id="pushDiagBox"><summary>Диагностика уведомлений</summary><pre id="pushDiag" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto;font-size:11px;line-height:1.5">Проверяю…</pre><button class="btn tight" type="button" data-push="copy" style="margin-top:8px">Скопировать диагностику</button></details></div>`;
    const firstCard = app.querySelector('.card');
    if (firstCard) app.insertBefore(holder, firstCard); else app.appendChild(holder);
  }
  let uiTimer = 0;
  function collapseSettings() {
    if (document.getElementById('settingsAdvanced')) return;
    const cards = [...document.querySelectorAll('#app > .card')].filter(c => {
      const t = (c.querySelector('.eyebrow')?.textContent || '').trim();
      return ['Бритьё', 'Хранилище', 'Прочее', 'Учебная неделя'].includes(t) && !c.closest('.settings-advanced');
    });
    if (cards.length < 1) return;
    const details = document.createElement('details');
    details.id = 'settingsAdvanced';
    details.className = 'settings-advanced';
    details.innerHTML = '<summary>Данные и обслуживание</summary>';
    const wrap = document.createElement('div');
    cards[0].parentNode.insertBefore(details, cards[0]);
    cards.forEach(c => wrap.appendChild(c));
    const density = document.createElement('button');
    density.type = 'button';
    density.className = 'btn tight';
    density.setAttribute('data-action', 'toggleDensity');
    density.textContent = (typeof ui !== 'undefined' && ui.density === 'compact') ? 'Вид списка: компактный' : 'Вид списка: подробный';
    wrap.appendChild(density);
    details.appendChild(wrap);
  }
  async function renderSettings() {
    ensureCard();
    collapseSettings();
    if (!document.getElementById('pushCard')) return;
    const out = document.getElementById('pushStatus');
    const hint = document.getElementById('pushHint');
    const diag = document.getElementById('pushDiag');
    const recon = document.getElementById('pushReconnect');
    if (!out) return;
    let s;
    try { s = await status(); } catch (e) { out.textContent = 'Не удалось проверить Push: ' + e.message; return; }
    const leadNow = leadMinutes();
    document.querySelectorAll('#pushLead [data-push-lead]').forEach(b => b.classList.toggle('primary', Number(b.dataset.pushLead) === leadNow));
    if (recon) recon.hidden = !s.stale;
    const serverOk = !!(s.server && s.server.ok && s.server.configured);
    const pushOk = !!(s.push && s.push.ok);
    if (!s.supported) out.textContent = 'Web Push недоступен в этом браузере. На iPhone нужна iOS 16.4+.';
    else if (!s.installed) out.textContent = 'Открыто не как PWA. На iPhone: Поделиться → На экран «Домой», затем открой JARVIS с иконки.';
    else if (s.permission === 'denied') out.textContent = 'Уведомления запрещены в iOS. Настройки → Уведомления → JARVIS → разрешить.';
    else if (s.stale) out.textContent = 'Ключ VAPID изменился: подписка устарела. Нажми «Переподключить» — данные не пострадают.';
    else if (s.subscribed && pushOk && s.push.deviceSubscribed) out.textContent = `Подписка активна и подтверждена сервером. Напоминания за ${leadNow} мин.`;
    else if (s.subscribed && !pushOk) out.textContent = 'Локальная подписка есть, но сервер не подтвердил её. Проверь подключение AI-сервера.';
    else if (s.subscribed && pushOk && !s.push.deviceSubscribed) out.textContent = 'Локальная подписка есть, но на сервере её нет. Нажми «Включить» ещё раз.';
    else if (s.serverFallback) out.textContent = 'URL AI указывает на frontend, поэтому Push использует API Worker. Нажми «Включить уведомления».';
    else if (!serverOk) out.textContent = 'Нет доступа к серверу Push. Проверь подключение сервера в AI → Настройки и токен.';
    else out.textContent = 'Push ещё не включён. Нажми «Включить уведомления» и разреши их в iOS.';
    if (hint) hint.textContent = s.subscribed ? 'Тест подтверждает только ответ push-провайдера. Появление баннера на заблокированном iPhone подтверждает владелец.' : 'Push работает только в установленной PWA; в обычной вкладке Safari уведомления не придут.';
    if (diag) {
      const t = lastTest();
      const sw = s.sw || {};
      const lines = [
        'Установлено на Домой: ' + (s.installed ? 'ДА' : 'НЕТ'),
        'Поддержка Push/SW: ' + (s.supported ? 'ДА' : 'НЕТ'),
        'Разрешение iOS: ' + ({ granted: 'разрешено', default: 'не запрашивалось', denied: 'запрещено', unsupported: 'нет' }[s.permission] || s.permission),
        'Service Worker: ' + (sw.active ? 'активен' : sw.installing ? 'устанавливается' : sw.waiting ? 'ожидает' : 'нет') + (sw.caches && sw.caches.length ? ' · ' + sw.caches.join(', ') : ''),
        'Локальная подписка: ' + (s.subscribed ? 'есть' : 'нет') + (s.stale ? ' · УСТАРЕВШИЙ VAPID' : ''),
        'Серверная подписка: ' + (pushOk ? (s.push.deviceSubscribed ? 'подтверждена' : 'отсутствует') : 'нет доступа (' + (s.push && s.push.status ? 'HTTP ' + s.push.status : (s.server && s.server.code) || 'ошибка') + ')'),
        ...(s.serverFallback ? ['URL AI указывает на frontend; Push использовал API Worker: ' + 'jarvis-routine-api'] : []),
        'Очередь: ' + (pushOk ? (s.push.pending || 0) + ' шт.' + (s.push.nearestReminder ? ', ближайшее ' + new Date(s.push.nearestReminder).toLocaleString('ru-RU') : '') : 'неизвестно'),
        'Последний тест: ' + (t ? new Date(t.at).toLocaleString('ru-RU') + ' · ' + (t.accepted ? 'провайдер принял' : 'не принят') + (t.statuses && t.statuses.length ? ' · HTTP ' + t.statuses.join(',') : '') + (t.correlationId ? ' · id ' + t.correlationId.slice(0, 8) : '') : 'не было'),
        'Доставка на экран: НЕИЗВЕСТНО до подтверждения владельца'
      ];
      diag.textContent = lines.join('\n');
    }
  }
  function scheduleRender() { clearTimeout(uiTimer); uiTimer = setTimeout(renderSettings, 350); }
  document.addEventListener('click', async e => {
    const b = e.target.closest && e.target.closest('[data-push]');
    if (b) {
      e.preventDefault();
      const out = document.getElementById('pushStatus');
      const act = b.dataset.push;
      try {
        if (act === 'enable') { if (out) out.textContent = 'Запрашиваю разрешение и подписку…'; await enable(); if (out) out.textContent = 'Подписка сохранена и подтверждена сервером.'; }
        else if (act === 'reconnect') { if (out) out.textContent = 'Переподключаю с новым ключом…'; await reconnect(); if (out) out.textContent = 'Подписка обновлена и подтверждена сервером.'; }
        else if (act === 'off') { await disable(); if (out) out.textContent = 'Push отключён на этом устройстве.'; }
        else if (act === 'test') {
          if (out) out.textContent = 'Отправляю тест через Worker…';
          const r = await test();
          const accepted = r.accepted || r.sent;
          const codes = Array.isArray(r.providerStatuses) && r.providerStatuses.length ? ' HTTP ' + r.providerStatuses.join(',') : '';
          if (out) out.textContent = accepted ? 'Push-провайдер принял тест.' + codes + ' Проверь баннер на iPhone.' : (r.note || 'Тест не принят: нет подписки или VAPID.') + codes;
        } else if (act === 'copy') {
          const ok = await copyDiagnostics();
          if (out) out.textContent = ok ? 'Диагностика скопирована (без токенов и endpoint).' : 'Не удалось скопировать; открой диагностику ниже.';
        }
      } catch (err) { if (out) out.textContent = 'Ошибка: ' + err.message; }
      scheduleRender();
      return;
    }
    const l = e.target.closest && e.target.closest('[data-push-lead]');
    if (l) {
      e.preventDefault();
      lead(l.dataset.pushLead);
      scheduleRender();
      return;
    }
  }, true);
  try {
    new MutationObserver(() => { if (document.getElementById('pushCard')) scheduleRender(); else ensureCard(); })
      .observe(document.body, { childList: true, subtree: true });
  } catch (e) {}
  setTimeout(renderSettings, 1400);
})(typeof globalThis !== 'undefined' ? globalThis : window);
