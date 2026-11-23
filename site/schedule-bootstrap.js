/* JARVIS Routine 4.0 — private schedule bootstrap.
 *
 * The personal weekly schedule (392 blocks) and personal habits are NOT shipped in
 * any public asset any more. They are resolved at runtime, in this order:
 *
 *   1. local cache written by this module on the device  → full offline work;
 *   2. authenticated GET /api/schedule-template from the existing Worker + D1;
 *   3. explicit import of the owner's private JSON backup file.
 *
 * Hard rules enforced here:
 *   - an empty, malformed or unreachable template never replaces a good one;
 *   - an older template never overwrites a newer cached one;
 *   - user state (`jarvis_routine_v1`: marks, overrides, extras, logs, history) is
 *     never read for writing, never rewritten and never cleared by this module;
 *   - a rejected network request leaves the app fully usable offline.
 */
(() => {
'use strict';

const TEMPLATE_KEY = 'jarvis_schedule_template_v1';
const TEMPLATE_PREV_KEY = 'jarvis_schedule_template_prev_v1';
const CONFIG_KEY = 'jarvis_routine_ai_v3';
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIMEOUT_MS = 20000;

const st = typeof SCHEDULE_STATE !== 'undefined' ? SCHEDULE_STATE : null;

function setStatus(status, message) {
  if (!st) return;
  st.status = status;
  st.message = message || '';
}

function toastSafe(msg) {
  try { if (typeof toast === 'function') toast(msg); } catch {}
}

/* ── validation: identical rules to the Worker, plus "never empty" ── */
function validate(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'payload должен быть объектом';
  const plans = payload.plans;
  if (!Array.isArray(plans) || plans.length < 1 || plans.length > 4) return 'plans должен содержать 1–4 недели';
  const ids = new Set();
  let total = 0;
  for (const week of plans) {
    if (!Array.isArray(week) || week.length < 1 || week.length > 7) return 'неделя должна содержать 1–7 дней';
    for (const day of week) {
      if (!Array.isArray(day) || day.length > 64) return 'день содержит слишком много блоков';
      for (const item of day) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return 'блок должен быть объектом';
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (!id) return 'у блока должен быть идентификатор';
        if (ids.has(id)) return 'идентификаторы блоков должны быть уникальны';
        ids.add(id);
        if (!TIME_RE.test(String(item.start || '')) || !TIME_RE.test(String(item.end || ''))) return 'некорректное время блока';
        if (typeof item.name !== 'string' || !item.name.trim()) return 'у блока должно быть название';
        if (++total > 1200) return 'слишком много блоков';
      }
    }
  }
  if (!total) return 'шаблон пустой: пустой шаблон не должен заменять реальное расписание';
  if (payload.habits !== undefined) {
    if (!Array.isArray(payload.habits) || payload.habits.length > 64) return 'habits должен быть массивом';
    for (const h of payload.habits) {
      if (!h || typeof h !== 'object') return 'некорректная привычка';
      if (typeof h.id !== 'string' || !h.id.trim()) return 'у привычки должен быть id';
      if (typeof h.name !== 'string' || !h.name.trim()) return 'у привычки должно быть название';
      if (!Array.isArray(h.days)) return 'у привычки должен быть список дней';
    }
  }
  return null;
}

function blockCount(payload) {
  return (payload.plans || []).reduce((n, w) => n + w.reduce((m, d) => m + d.length, 0), 0);
}

/* ── cache (offline source of truth on this device) ── */
function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.payload) return null;
    if (validate(data.payload)) return null;
    return { version: Number(data.version) || 1, payload: data.payload, savedAt: data.savedAt || null };
  } catch { return null; }
}

function writeCache(version, payload) {
  try {
    const current = localStorage.getItem(TEMPLATE_KEY);
    // Keep one previous copy so a bad import/refresh remains reversible.
    if (current) localStorage.setItem(TEMPLATE_PREV_KEY, current);
    localStorage.setItem(TEMPLATE_KEY, JSON.stringify({ version, savedAt: new Date().toISOString(), payload }));
    return true;
  } catch { return false; }
}

/* ── apply: user state (S) is intentionally untouched ── */
function applyPayload(payload, version, options) {
  const opts = options || {};
  const invalid = validate(payload);
  if (invalid) return invalid;
  PLANS = payload.plans;
  HABITS = Array.isArray(payload.habits) ? payload.habits : [];
  if (!opts.fromCache) {
    const saved = writeCache(version, { plans: payload.plans, habits: HABITS });
    if (!saved) toastSafe('Не удалось сохранить копию расписания на устройстве');
  }
  setStatus('ready', '');
  try { if (typeof render === 'function') render(); } catch {}
  return null;
}

/* ── server config reuses the existing AI connection settings ── */
function readConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
    return { url: typeof c.url === 'string' ? c.url : '', token: typeof c.token === 'string' ? c.token : '' };
  } catch { return { url: '', token: '' }; }
}

function apiOrigin(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost') throw Error('Сервер должен использовать HTTPS');
  return u.origin;
}

async function fetchRemote() {
  const cfg = readConfig();
  if (!cfg.url || !cfg.token || cfg.token.length < 24) {
    throw Error('Сначала подключи сервер в разделе AI (URL и токен доступа)');
  }
  const origin = apiOrigin(cfg.url);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : 0;
  let response;
  try {
    response = await fetch(origin + '/api/schedule-template', {
      headers: { Authorization: 'Bearer ' + cfg.token },
      cache: 'no-store',
      signal: controller ? controller.signal : undefined,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!response.ok) throw Error('Сервер ответил ' + response.status);
  const data = await response.json();
  if (!data || typeof data !== 'object' || !data.payload) throw Error('Сервер не вернул шаблон расписания');
  const invalid = validate(data.payload);
  if (invalid) throw Error(invalid);
  const remoteVersion = Number(data.version) || 1;
  const cached = readCache(TEMPLATE_KEY);
  if (scheduleReady() && cached && cached.version > remoteVersion) {
    // Never downgrade a newer private template already on this device.
    return false;
  }
  if (scheduleReady() && cached && cached.version === remoteVersion) return false;
  const applied = applyPayload(data.payload, remoteVersion);
  if (applied) throw Error(applied);
  return true;
}

/* ── explicit local import / export of the private template ── */
function importFile() {
  let input;
  try {
    input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
  } catch { return; }
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    file.text().then((text) => {
      let parsed;
      try { parsed = JSON.parse(text); } catch { toastSafe('Неверный файл расписания'); return; }
      const payload = parsed && parsed.payload ? parsed.payload
        : parsed && parsed.plans ? parsed
        : parsed && Array.isArray(parsed.plans) ? parsed : null;
      if (!payload) { toastSafe('Неверный файл расписания'); return; }
      const invalid = validate(payload);
      if (invalid) { toastSafe(invalid); return; }
      if (!confirm('Загрузить расписание из файла? Текущая копия сохранится как резервная.')) return;
      const applied = applyPayload(payload, Number(parsed.version) || 1);
      if (applied) toastSafe(applied);
      else toastSafe('Расписание загружено из файла');
    }).catch(() => toastSafe('Не удалось прочитать файл'));
  });
  input.click();
}

function exportCopy() {
  if (!scheduleReady()) { toastSafe('Сначала загрузи расписание'); return; }
  try {
    const payload = { schema: 'jarvis-schedule-template', version: 1, count: blockCount({ plans: PLANS, habits: HABITS }), plans: PLANS, habits: HABITS };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'jarvis-schedule-private-' + new Date().toISOString().slice(0, 10) + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch { toastSafe('Экспорт недоступен в этом браузере'); }
}

async function manualFetch() {
  const hadSchedule = scheduleReady();
  setStatus('loading', 'Запрашиваю приватное расписание…');
  try { if (typeof render === 'function') render(); } catch {}
  try {
    const changed = await fetchRemote();
    setStatus('ready', '');
    try { if (typeof render === 'function') render(); } catch {}
    toastSafe(changed ? 'Расписание загружено с сервера' : hadSchedule ? 'Расписание уже актуально' : 'Расписание загружено');
  } catch (error) {
    const message = error && error.name === 'AbortError' ? 'Истекло время ожидания сервера' : (error && error.message) || 'Сервер недоступен';
    // A failed request must never destroy an already working offline copy.
    setStatus(hadSchedule ? 'ready' : 'error', hadSchedule ? '' : 'Не удалось получить расписание: ' + message);
    try { if (typeof render === 'function') render(); } catch {}
    if (!hadSchedule) toastSafe('Расписание недоступно: ' + message);
  }
}

/* ── boot ── */
function boot() {
  const cached = readCache(TEMPLATE_KEY) || readCache(TEMPLATE_PREV_KEY);
  if (cached) {
    const applied = applyPayload(cached.payload, cached.version, { fromCache: true });
    if (applied) setStatus('missing', '');
    else if (!readCache(TEMPLATE_KEY)) writeCache(cached.version, cached.payload); // repair a damaged primary copy
  } else {
    setStatus('loading', '');
  }
  try { if (typeof render === 'function') render(); } catch {}
  if (cached) {
    // Silent refresh: only replaces the cached template when the server is newer.
    const cfg = readConfig();
    if (cfg.url && cfg.token && cfg.token.length >= 24) {
      fetchRemote().catch(() => { /* offline is a normal, supported state */ });
    }
    return;
  }
  const cfg = readConfig();
  if (cfg.url && cfg.token && cfg.token.length >= 24) {
    fetchRemote()
      .then(() => setStatus('ready', ''))
      .catch((error) => {
        setStatus('missing', 'Сервер недоступен: ' + ((error && error.message) || 'нет сети'));
        try { if (typeof render === 'function') render(); } catch {}
      });
  } else {
    setStatus('missing', '');
  }
}

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('click', (event) => {
    const target = event && event.target;
    if (!target || typeof target.closest !== 'function') return;
    const button = target.closest('[data-sched-action]');
    if (!button) return;
    const action = button.getAttribute ? button.getAttribute('data-sched-action') : button.dataset && button.dataset.schedAction;
    if (action === 'fetch') manualFetch();
    else if (action === 'import') importFile();
    else if (action === 'export') exportCopy();
  });
}

try { boot(); } catch (error) {
  setStatus('missing', 'Не удалось инициализировать расписание: ' + ((error && error.message) || 'ошибка'));
}

// Test / integration hook (no personal data is exposed by the getters to the network).
try {
  if (typeof window !== 'undefined' && window) {
    window.jarvisSchedule = {
      ready: () => scheduleReady(),
      refresh: manualFetch,
      importFile,
      exportCopy,
      blockCount: () => blockCount({ plans: PLANS, habits: HABITS }),
      validate,
    };
  }
} catch {}
})();