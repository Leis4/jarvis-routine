/* JARVIS Routine v46.0 — durable chat storage (Dexie/IndexedDB).
 *
 * The synchronous localStorage chats remain the working copy for compatibility,
 * but this module keeps the FULL message history in IndexedDB (localStorage
 * truncates to the last 35 per chat). It is a durable mirror + recovery source,
 * not a second independent history: every save mirrors the active chat, and the
 * legacy localStorage data is migrated once, idempotently.
 *
 * PRIVACY: local only. No network. */
(function (root, factory) {
  const api = factory(root);
  root.JarvisChatStore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const DB_NAME = 'jarvis_chats_db';
  const VERSION = 1;
  let db = null, opening = null;

  function init() {
    if (db) return Promise.resolve(db);
    if (opening) return opening;
    opening = (async () => {
      try { if (root.JarvisStore && root.JarvisStore.initShadow) await root.JarvisStore.initShadow(); } catch (e) {}
      if (!root.Dexie) return null;
      try {
        const d = new root.Dexie(DB_NAME);
        d.version(VERSION).stores({ chats: 'id, updatedAt', messages: 'id, chatId, createdAt' });
        await d.open();
        db = d;
        return db;
      } catch (e) { return null; }
    })();
    return opening;
  }

  function chatMeta(c) {
    return { id: c.id, title: c.title || '', createdAt: c.createdAt || Date.now(), updatedAt: c.updatedAt || Date.now(), archived: !!c.archived, pinned: !!c.pinned };
  }
  function msgRows(chat) {
    const list = Array.isArray(chat.messages) ? chat.messages : [];
    return list.map((m, i) => ({ id: chat.id + '__' + i, chatId: chat.id, index: i, role: m.role, model: m.model || '', content: String(m.content || ''), createdAt: m.createdAt || chat.createdAt || Date.now() }));
  }

  async function mirrorChat(chat) {
    const d = await init(); if (!d || !chat || !chat.id) return false;
    try {
      await d.transaction('rw', d.chats, d.messages, async () => {
        await d.chats.put(chatMeta(chat));
        const rows = msgRows(chat);
        if (rows.length) await d.messages.bulkPut(rows);
      });
      return true;
    } catch (e) { return false; }
  }
  async function mirrorAll(chats) {
    const d = await init(); if (!d || !Array.isArray(chats)) return false;
    for (const c of chats) await mirrorChat(c);
    return true;
  }
  async function replaceChat(chat) {
    const d = await init(); if (!d || !chat || !chat.id) return false;
    try {
      await d.transaction('rw', d.chats, d.messages, async () => {
        await d.chats.put(chatMeta(chat));
        await d.messages.where('chatId').equals(chat.id).delete();
        const rows = msgRows(chat);
        if (rows.length) await d.messages.bulkPut(rows);
      });
      return true;
    } catch (e) { return false; }
  }
  async function replaceAll(chats) {
    const d = await init(); if (!d || !Array.isArray(chats)) return false;
    try {
      await d.transaction('rw', d.chats, d.messages, async () => {
        await d.messages.clear(); await d.chats.clear();
        for (const c of chats) {
          await d.chats.put(chatMeta(c));
          const rows = msgRows(c);
          if (rows.length) await d.messages.bulkPut(rows);
        }
      });
      return true;
    } catch (e) { return false; }
  }
  async function deleteChat(id) {
    const d = await init(); if (!d || !id) return false;
    try {
      await d.transaction('rw', d.chats, d.messages, async () => {
        await d.chats.delete(id);
        await d.messages.where('chatId').equals(id).delete();
      });
      return true;
    } catch (e) { return false; }
  }
  async function loadChat(id) {
    const d = await init(); if (!d || !id) return null;
    try {
      const msgs = await d.messages.where('chatId').equals(id).sortBy('index');
      return msgs.map(m => ({ role: m.role, model: m.model, content: m.content }));
    } catch (e) { return null; }
  }
  async function loadAll() {
    const d = await init(); if (!d) return null;
    try {
      const chats = await d.chats.toArray();
      const out = [];
      for (const c of chats) {
        const msgs = await d.messages.where('chatId').equals(c.id).sortBy('index');
        out.push({ ...c, messages: msgs.map(m => ({ role: m.role, model: m.model, content: m.content })) });
      }
      return out;
    } catch (e) { return null; }
  }
  async function search(q) {
    const d = await init(); if (!d) return [];
    const s = String(q || '').toLowerCase().trim(); if (!s) return [];
    try {
      const all = await d.messages.toArray();
      return all.filter(m => String(m.content || '').toLowerCase().includes(s)).slice(0, 40)
        .map(m => ({ chatId: m.chatId, snippet: String(m.content || '').slice(0, 160) }));
    } catch (e) { return []; }
  }
  async function count() {
    const d = await init(); if (!d) return { chats: 0, messages: 0 };
    try { return { chats: await d.chats.count(), messages: await d.messages.count() }; } catch (e) { return { chats: 0, messages: 0 }; }
  }
  /* One-time, idempotent legacy migration. Never deletes the source. */
  async function migrateLegacy(localChats) {
    const d = await init(); if (!d) return false;
    const n = await count();
    if (n.chats > 0) return false; // already has data; do not duplicate
    if (!Array.isArray(localChats) || !localChats.length) return false;
    return mirrorAll(localChats);
  }

  return { init, mirrorChat, mirrorAll, replaceChat, replaceAll, deleteChat, loadChat, loadAll, search, count, migrateLegacy, DB_NAME };
});

/* Self-seed Dexie from the legacy localStorage chats once, independently of the
   AI module. Idempotent: migrateLegacy skips when Dexie already has chats. */
try {
  if (typeof localStorage !== 'undefined' && typeof document !== 'undefined') {
    const raw = JSON.parse(localStorage.getItem('jarvis_qwen_chats_v1') || 'null');
    if (raw && Array.isArray(raw.list) && raw.list.length) {
      const seed = () => { try { const api = window.JarvisChatStore; if (!api) return; api.init().then(db => { if (db) api.migrateLegacy(raw.list); }); } catch (e) {} };
      seed();
      if (document.readyState !== 'complete') window.addEventListener('load', seed);
    }
  }
} catch (e) {}
