/* JARVIS Routine v43 · StorageAdapter (phase 1 of the durable-storage plan).
   One small, honest interface between the UI and whatever actually persists data:

     get / put / remove / keys / query / transaction / migrate / export / import / healthCheck

   Source of truth is still localStorage — the browser sync API is atomic per key and
   every existing key keeps working. Two things are added on top:

   1. A real write contract. `put()` writes, reads the value back and reports
      {ok:true} or {ok:false, reason:'quota'|'verify'|'unavailable'}. Callers can now
      tell the user the truth instead of silently losing a day of edits.
   2. A Dexie/IndexedDB shadow copy (loaded lazily, after first paint). It is written
      only — never read as the source of truth — so a broken or blocked IndexedDB can
      never lose data. Phase 2 (making IndexedDB authoritative) is deliberately NOT
      enabled: see healthCheck().shadow.compare for the evidence that would be required.

   No third-party code is imported here; Dexie is a separate vendored classic script. */
(function (root, factory) {
  const api = factory(root);
  root.JarvisStore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const SCHEMA = 2;
  const META_KEY = 'jarvis_routine_meta_v1';
  const PREFIX = 'jarvis_';
  const DB_NAME = 'jarvis_routine_v3';
  const DEXIE_SRC = 'vendor/dexie.min.js';

  let shadowDb = null;
  let shadowPromise = null;
  let shadowWarned = false;
  let lastWrite = null;
  const listeners = [];

  function ls() {
    try {
      const b = root.localStorage;
      if (!b) return null;
      // Safari private mode exposes localStorage but throws on setItem.
      return b;
    } catch (e) { return null; }
  }

  function readRaw(key) {
    try { const b = ls(); const v = b ? b.getItem(key) : null; return v == null ? null : v; } catch (e) { return null; }
  }

  function get(key, fallback = null) {
    const raw = readRaw(key);
    if (raw == null) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  function emit(event) {
    for (const fn of listeners.slice()) { try { fn(event); } catch (e) { /* listener errors must not break writes */ } }
  }

  function put(key, value) {
    const b = ls();
    if (!b) return { ok: false, reason: 'unavailable' };
    let serialized;
    try { serialized = JSON.stringify(value); }
    catch (e) { return { ok: false, reason: 'serialize' }; }
    try { b.setItem(key, serialized); }
    catch (e) {
      const reason = /quota|exceed/i.test(String(e && e.name) + String(e && e.message)) ? 'quota' : 'io';
      lastWrite = { key, ok: false, reason, at: Date.now() };
      emit({ type: 'write-failed', key, reason });
      return { ok: false, reason };
    }
    if (readRaw(key) !== serialized) {
      lastWrite = { key, ok: false, reason: 'verify', at: Date.now() };
      emit({ type: 'write-failed', key, reason: 'verify' });
      return { ok: false, reason: 'verify' };
    }
    lastWrite = { key, ok: true, bytes: serialized.length, at: Date.now() };
    shadowPut(key, value);
    return { ok: true, bytes: serialized.length };
  }

  function remove(key) {
    const b = ls();
    if (!b) return { ok: false, reason: 'unavailable' };
    try { b.removeItem(key); } catch (e) { return { ok: false, reason: 'io' }; }
    shadowDelete(key);
    return { ok: true };
  }

  function keys(prefix = '') {
    const b = ls();
    if (!b) return [];
    const out = [];
    for (let i = 0; i < b.length; i++) {
      const k = b.key(i);
      if (k && k.startsWith(prefix)) out.push(k);
    }
    return out.sort();
  }

  function query(prefix = PREFIX) {
    return keys(prefix).map(k => ({ key: k, value: get(k) }));
  }

  /* Snapshot → run → roll back on throw. Not a real DB transaction, but it makes
     multi-key updates (import, replan commit) all-or-nothing at this layer. */
  function transaction(fn) {
    const snapshot = new Map();
    for (const k of keys()) snapshot.set(k, readRaw(k));
    try {
      return fn();
    } catch (e) {
      const b = ls();
      if (b) {
        for (const k of keys()) if (!snapshot.has(k)) { try { b.removeItem(k); } catch (err) {} }
        for (const [k, v] of snapshot) { try { b.setItem(k, v); } catch (err) {} }
      }
      emit({ type: 'transaction-rollback' });
      throw e;
    }
  }

  function getMeta() { return get(META_KEY, {}) || {}; }

  function setMeta(patch) {
    const next = { ...getMeta(), ...patch };
    return put(META_KEY, next);
  }

  /* steps: [{ version, up() }] — each runs at most once, version is recorded only
     after `up()` returns. Re-running after an interrupted upgrade is therefore safe. */
  function runMigrations(steps) {
    let version = Number(getMeta().schema) || 1;
    const applied = [];
    for (const step of (steps || []).slice().sort((a, b) => a.version - b.version)) {
      if (step.version <= version) continue;
      step.up();
      setMeta({ schema: step.version, migratedAt: Date.now() });
      version = step.version;
      applied.push(step.version);
    }
    if (!applied.length && !getMeta().schema) setMeta({ schema: SCHEMA, migratedAt: Date.now() });
    return applied;
  }

  function exportAll() {
    const data = {};
    for (const k of keys(PREFIX)) data[k] = get(k);
    return { format: 'jarvis-store', version: SCHEMA, exportedAt: new Date().toISOString(), data };
  }

  /* Import is validated by the caller's own schema check before it gets here;
     this layer guarantees atomicity and a rollback point. */
  function importAll(dump) {
    if (!dump || dump.format !== 'jarvis-store' || typeof dump.data !== 'object' || !dump.data) {
      return { ok: false, reason: 'format' };
    }
    return transaction(() => {
      for (const [k, v] of Object.entries(dump.data)) {
        if (!k.startsWith(PREFIX)) continue;
        const r = put(k, v);
        if (!r.ok) throw new Error('import write failed: ' + r.reason);
      }
      return { ok: true, keys: Object.keys(dump.data).length };
    });
  }

  /* ── Dexie shadow (write-only, phase 1) ───────────────────────────── */

  function shadowSupported() {
    return !!(root.indexedDB && root.document && root.document.createElement);
  }

  function loadDexie() {
    if (shadowPromise) return shadowPromise;
    shadowPromise = new Promise(resolve => {
      if (!shadowSupported()) return resolve(null);
      if (root.Dexie) return resolve(openDb());
      const s = root.document.createElement('script');
      s.src = DEXIE_SRC;
      s.async = true;
      s.onload = () => resolve(openDb());
      s.onerror = () => resolve(null);
      (root.document.head || root.document.body || root.document.documentElement).appendChild(s);
    });
    return shadowPromise;
  }

  function openDb() {
    try {
      const db = new root.Dexie(DB_NAME);
      db.version(1).stores({
        documents: 'key',
        events: 'eid,date,type',
        queue: '++id,createdAt',
        meta: 'key',
      });
      shadowDb = db;
      return db;
    } catch (e) { return null; }
  }

  /* Called by the app after first paint so cold start is not blocked. */
  function initShadow() { return loadDexie(); }

  function shadowPut(key, value) {
    if (!shadowDb) return;
    try {
      const t = shadowDb.transaction('rw', shadowDb.documents, shadowDb.meta, () => {
        shadowDb.documents.put({ key, value, bytes: JSON.stringify(value).length, at: Date.now() });
        shadowDb.meta.put({ key: 'lastShadowWrite', value: Date.now() });
      });
      t.catch(() => {});
    } catch (e) { /* shadow must never break the primary write path */ }
  }

  function shadowDelete(key) {
    if (!shadowDb) return;
    try { shadowDb.documents.delete(key).catch(() => {}); } catch (e) {}
  }

  function shadowPutMany(entries) {
    if (!shadowDb) return Promise.resolve(0);
    try {
      return shadowDb.transaction('rw', shadowDb.documents, () => {
        for (const [key, value] of entries) shadowDb.documents.put({ key, value, bytes: JSON.stringify(value).length, at: Date.now() });
      }).then(() => entries.length);
    } catch (e) { return Promise.resolve(0); }
  }

  async function shadowEvents(events) {
    const db = await loadDexie();
    if (!db || !Array.isArray(events)) return 0;
    try {
      await db.transaction('rw', db.events, () => { for (const e of events) if (e && e.eid) db.events.put(e); });
      return events.length;
    } catch (e) { return 0; }
  }

  async function healthCheck() {
    const b = ls();
    const storeKeys = keys(PREFIX);
    let bytes = 0;
    for (const k of storeKeys) bytes += (readRaw(k) || '').length;
    const db = await loadDexie();
    const report = {
      schema: Number(getMeta().schema) || 1,
      backend: b ? 'localStorage' : 'none',
      keys: storeKeys.length,
      bytes,
      lastWrite,
      shadow: { supported: shadowSupported(), open: !!db, compare: null },
    };
    if (db) {
      try {
        const shadowKeys = await db.documents.toCollection().primaryKeys();
        const missing = storeKeys.filter(k => !shadowKeys.includes(k));
        const extra = shadowKeys.filter(k => !storeKeys.includes(k));
        report.shadow.compare = { localKeys: storeKeys.length, shadowKeys: shadowKeys.length, missing, extra, inSync: missing.length === 0 && extra.length === 0 };
      } catch (e) {
        report.shadow.compare = { error: String(e && e.message || e) };
      }
    }
    return report;
  }

  /* Mirror every existing key once, then keep writing live. Safe to call repeatedly. */
  async function syncShadowNow() {
    const entries = keys(PREFIX).map(k => [k, get(k)]);
    return shadowPutMany(entries);
  }

  function onEvent(fn) { if (typeof fn === 'function') listeners.push(fn); }

  return {
    SCHEMA, META_KEY, PREFIX,
    get, put, remove, keys, query, transaction,
    getMeta, setMeta, runMigrations, exportAll, importAll,
    initShadow, syncShadowNow, shadowEvents, healthCheck, onEvent,
    get lastWrite() { return lastWrite; },
  };
});
