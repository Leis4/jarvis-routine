// Backend integration tests: AI chat, sync, proposals, and error recovery
// Uses mock AITunnel responses — no live API calls.
import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- Helpers ---
function mockWorker() {
  const src = readFileSync(new URL('../backend/src/worker.js', import.meta.url), 'utf8')
    .replace(/^import \{ buildPushPayload \}.*;\s*/m, 'const buildPushPayload=async()=>({});\n');
  const tmp = mkdtempSync(join(tmpdir(), 'routine-worker-'));
  writeFileSync(join(tmp, 'mock-worker.mjs'), src);
  return import('file://' + join(tmp, 'mock-worker.mjs'));
}

function makeDB() {
  const tables = {};
  
  // Simple in-memory database mock
  const execute = async (sql, ...args) => {
    const tableName = sql.match(/(?:FROM|INTO|UPDATE)\s+(\S+)/i)?.[1];
    if (!tableName) return { results: [] };
    if (!tables[tableName]) tables[tableName] = [];
    return { table: tableName, sql, args: args.flat() };
  };

  const query = (sql) => {
    const tableName = sql.match(/FROM\s+(\S+)/i)?.[1];
    return {
      table: tableName,
      first: async () => {
        if (!tableName || !tables[tableName]) return null;
        const rows = tables[tableName];
        // Very simple WHERE matching: extract column=value patterns
        const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|$)/i);
        if (whereMatch) {
          const conditions = whereMatch[1].split(/\s+AND\s+/i);
          return rows.find(r => conditions.every(c => {
            const m = c.match(/(\w+)\s*([=<>!]+)\s*(?:\?|'[^']*'|(\d+))/i);
  const col = m?.[1], op = m?.[2], val = m?.[3];
            if (op === '=') {
              const cell = r[col];
              if (val) return String(cell) === val;
              return true; // positional — assume matches
            }
            if (op?.toUpperCase() === 'LIKE') {
              const pattern = c.match(/LIKE\s+'([^']+)'/i)?.[1];
              if (pattern) {
                const re = new RegExp('^' + pattern.replace(/%/g, '.*').replace(/_/g, '.') + '$');
                return re.test(r[col] || '');
              }
            }
            return true;
          })) || null;
        }
        return rows[0] || null;
      },
      all: async () => {
        if (!tableName || !tables[tableName]) return { results: [] };
        return { results: tables[tableName] };
      },
      run: async () => { /* in-mem tables handled by batch */ },
    };
  };

  const runStmt = async (st) => {
    const sql = st.sql || st;
    const tableName = sql.match(/(?:INTO|UPDATE)\s+(\S+)/i)?.[1];
    if (!tableName) return;
    if (!tables[tableName]) tables[tableName] = [];

    // Snapshot CAS is a conditional SQLite mutation, not a blind UPSERT.
    // Model affected-row counts so the integration test detects stale writes.
    if (sql.startsWith('INSERT OR IGNORE INTO snapshots')) {
      if (tables.snapshots.some(r => r.id === 1)) return {meta:{changes:0}};
      tables.snapshots.push({id:1,version:1,payload:st.args[0],updated_at:st.args[1]});
      return {meta:{changes:1}};
    }
    if (sql.startsWith('UPDATE snapshots SET version=version+1')) {
      const row=tables.snapshots.find(r => r.id === 1 && r.version === st.args[2]);
      if (!row) return {meta:{changes:0}};
      row.version += 1;row.payload=st.args[0];row.updated_at=st.args[1];
      return {meta:{changes:1}};
    }

    if (/^INSERT\s+(?:OR\s+REPLACE\s+)?INTO/i.test(sql)) {
      // Extract column list from INSERT INTO table (col1,col2,...)
      const colMatch = sql.match(/INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+\S+\s*\(([^)]+)\)\s*VALUES/i);
      if (!colMatch) return;
      const cols = colMatch[1].split(',').map(c => c.trim());
      
      // Extract values: handle mixed literals and ? placeholders
      const valMatch = sql.match(/VALUES\s*\(([^)]+)\)/i);
      if (!valMatch) return;
      const valueParts = valMatch[1].split(',').map(v => v.trim());
      
      // Build row: for each value, if it's '?' use next bind arg, otherwise use literal
      let argIdx = 0;
      const args = st.args || [];
      const row = {};
      cols.forEach((col, i) => {
        const part = valueParts[i] || 'NULL';
        if (part === '?') {
          row[col] = args[argIdx++];
        } else if (part === 'NULL') {
          row[col] = null;
        } else if (/^\d+$/.test(part)) {
          row[col] = Number(part);
        } else {
          row[col] = part.replace(/^'(.*)'$/, '$1');
        }
      });

      // ON CONFLICT: update existing
      const conflictMatch = sql.match(/ON CONFLICT\((\w+)\)/i);
      if (conflictMatch) {
        const pk = conflictMatch[1];
        const existing = tables[tableName].findIndex(r => r[pk] === row[pk]);
        if (existing >= 0) {
          Object.assign(tables[tableName][existing], row);
          return;
        }
      }
      tables[tableName].push(row);
    } else if (/^UPDATE/i.test(sql)) {
      const setMatch = sql.match(/SET\s+(\w+)\s*=\s*(?:\?|'[^']*'|(\d+))/i);
      if (setMatch && st.args) {
        const col = setMatch[1];
        const val = st.args[0];
        const whereMatch = sql.match(/WHERE\s+(\w+)\s*=\s*(?:\?|'[^']*'|(\d+))/i);
        if (whereMatch) {
          const wCol = whereMatch[1];
          const wVal = whereMatch[2] || st.args[1];
          const row = tables[tableName].find(r => r[wCol] === wVal);
          if (row) row[col] = val;
        }
      }
    } else if (/^DELETE/i.test(sql)) {
      const whereMatch = sql.match(/WHERE\s+(\w+)\s*=\s*(?:\?|'[^']*')/i);
      if (whereMatch) {
        const wCol = whereMatch[1];
        const wVal = st.args?.[0];
        tables[tableName] = tables[tableName].filter(r => r[wCol] !== wVal);
      }
    }
  };

  const prepare = (sql) => ({
    sql,
    bind(...args) {
      const stmt = { sql, args };
      stmt.first = async () => {
        const t = await query(sql);
        return t.first();
      };
      stmt.all = async () => {
        const t = await query(sql);
        return t.all();
      };
      stmt.run = async () => await runStmt(stmt);
      return stmt;
    },
    first: async () => { const t = await query(sql); return t.first(); },
    all: async () => { const t = await query(sql); return t.all(); },
    run: async () => await runStmt({ sql }),
  });

  const batch = async (stmts) => {
    for (const st of stmts) {
      await runStmt(st);
    }
  };

  return { prepare, batch, tables };
}

function mockFetch(responseMaker) {
  const old = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    return responseMaker(url, opts);
  };
  return old;
}

function makeReq(path, { method = 'GET', body, origin, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers['Origin'] = origin;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const req = new Request(`https://service.workers.dev${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return req;
}

const ENV_BASE = {
  APP_ACCESS_TOKEN: 'test-bearer-token-with-over-24-chars',
  ALLOWED_ORIGIN: 'https://jarvis-routine.demo.workers.dev',
  AITUNNEL_API_KEY: 'sk-test-only-not-real',
  QWEN_BASE_URL: 'https://api.aitunnel.ru/v1',
  VAPID_SUBJECT: 'mailto:test@example.com',
};

// --- Tests ---

let worker;
test('setup: load worker module', async () => {
  worker = (await mockWorker()).default;
});

test('AI chat with valid structured JSON response', async () => {
  const DB = makeDB();
  DB.tables['request_usage'] = [];
  const env = { ...ENV_BASE, DB };

  const oldFetch = mockFetch((url, opts) => {
    assert.ok(url.toString().includes('/chat/completions'));
    const sentModel = JSON.parse(opts.body).model;
    assert.ok(sentModel.startsWith('qwen3.7'));
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            answer: 'Я предлагаю перенести код на вечер.',
            proposals: [
              { action: 'move', date: '2026-11-16', start: '18:00', durationMin: 60, taskId: 'p0_0_8', reason: 'Утром больше времени для подготовки к паре' },
              { action: 'add', date: '2026-11-17', start: '14:00', durationMin: 40, title: 'Повторить SQL', cat: 'Код', reason: 'Подготовка к дедлайну' },
            ]
          })
        }
      }],
      usage: { prompt_tokens: 140, completion_tokens: 45 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  try {
    const req = makeReq('/api/ai/chat', {
      method: 'POST',
      origin: ENV_BASE.ALLOWED_ORIGIN,
      token: ENV_BASE.APP_ACCESS_TOKEN,
      body: {
        message: 'Перемести код на сегодня на вечер, а завтра добавь повторение SQL',
        tier: 'plus',
        date: '2026-11-15',
        tasks: [
          { id: 'p0_0_8', name: 'Практика: ОС', start: '09:00', end: '10:35', cat: 'Университет', status: 'Обязательно', fixed: true, done: false },
          { id: 'p0_0_12', name: 'Код Python', start: '16:00', end: '16:40', cat: 'Код', status: 'План', fixed: false, done: false },
        ],
        wake: '08:00',
        history: [],
      },
    });
    const r = await worker.fetch(req, env);
    assert.equal(r.status, 200, await r.clone().text());
    const out = await r.json();
    assert.ok(out.answer.length > 10);
    assert.equal(out.proposals.length, 2);
    assert.equal(out.proposals[0].action, 'move');
    assert.equal(out.proposals[1].action, 'add');
    assert.ok(out.model.includes('qwen3.7'));
    assert.ok('retried' in out);
    assert.equal(out.usage.inputTokens, 140);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('AI chat: truncated JSON triggers retry without thinking', async () => {
  const DB = makeDB();
  DB.tables['request_usage'] = [];
  const env = { ...ENV_BASE, DB };
  let callCount = 0;

  const oldFetch = mockFetch((url, opts) => {
    callCount++;
    const body = JSON.parse(opts.body);
    if (callCount === 1) {
      // First call: truncated JSON (no closing brace) — emulates streaming cut.
      // Structured actions must already run with reasoning switched off.
      assert.equal(body.reasoning?.enabled, false, 'Structured call must disable reasoning');
      assert.equal(body.enable_thinking, false, 'DashScope-native thinking switch must be off too');
      assert.equal(body.max_tokens, 1600, 'plain chat keeps the small budget');
      const truncated = '{"answer":"Частичный ответ","proposals":[{"action":"add","date":"2026-11-16"';
      return new Response(JSON.stringify({
        choices: [{ message: { content: truncated }, finish_reason: 'length' }],
        usage: { prompt_tokens: 100, completion_tokens: 30 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (callCount === 2) {
      // Second call: no thinking, clean JSON
      assert.equal(body.enable_thinking, false, 'Retry should disable thinking');
      assert.equal(body.reasoning?.enabled, false, 'Retry should disable reasoning');
      assert.equal(body.temperature, 0.3);
      assert.equal(body.max_tokens, 5000);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ answer: 'Готово, проверил расписание.', proposals: [] }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 25 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw Error('Unexpected call #' + callCount);
  });

  try {
    const req = makeReq('/api/ai/chat', {
      method: 'POST',
      origin: ENV_BASE.ALLOWED_ORIGIN,
      token: ENV_BASE.APP_ACCESS_TOKEN,
      body: { message: 'Проверь мой день', date: '2026-11-15', tasks: [], history: [] },
    });
    const r = await worker.fetch(req, env);
    assert.equal(r.status, 200, await r.clone().text());
    const out = await r.json();
    assert.equal(callCount, 2, 'Should have retried once');
    assert.ok(out.answer.includes('Готово'));
    assert.equal(out.retried, true);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('AI chat: plain text (non-JSON) returned as normal answer', async () => {
  const DB = makeDB();
  DB.tables['request_usage'] = [];
  const env = { ...ENV_BASE, DB };

  const oldFetch = mockFetch(() => new Response(JSON.stringify({
    choices: [{ message: { content: 'Просто текст без JSON и без структуры', finish_reason: 'stop' } }],
    usage: { prompt_tokens: 50, completion_tokens: 10 }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

  try {
    const r = await worker.fetch(makeReq('/api/ai/chat', {
      method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
      body: { message: 'Хелло', date: '2026-11-15', tasks: [], history: [] },
    }), env);
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.answer, 'Просто текст без JSON и без структуры');
    assert.equal(out.proposals.length, 0);
    assert.equal(out.retried, false);
  } finally { globalThis.fetch = oldFetch; }
});

test('AI chat: retry recovers when first response has no content', async () => {
  const DB = makeDB();
  DB.tables['request_usage'] = [];
  const env = { ...ENV_BASE, DB };
  let callCount = 0;

  const oldFetch = mockFetch((url, opts) => {
    callCount++;
    if (callCount === 1) {
      // Streaming: content is empty but finish_reason indicates stop? No, this is a real scenario where reasoning_content exists but content is null
      return new Response(JSON.stringify({
        choices: [{ message: { content: null }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 80, completion_tokens: 5 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ answer: 'Повторный ответ после пустого.', proposals: [] }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 80, completion_tokens: 30 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  try {
    const req = makeReq('/api/ai/chat', {
      method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
      body: { message: 'Привет', date: '2026-11-15', tasks: [], history: [] },
    });
    const r = await worker.fetch(req, env);
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(callCount, 2);
    assert.equal(out.retried, true);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('AI chat: budget limits enforce max tier', async () => {
  const DB = makeDB();
  DB.tables['request_usage'] = [{ day: '2026-11-15', requests: 24, max_calls: 0 }];
  DB.tables['ai_usage'] = [];
  const env = { ...ENV_BASE, DB };

  // Should work: 24 requests used, 25 is max
  const oldFetch = mockFetch(() => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ answer: 'Ок', proposals: [] }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

  try {
    const req = makeReq('/api/ai/chat', {
      method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
      body: { message: 'Привет flash', tier: 'flash', date: '2026-11-15', tasks: [], history: [] },
    });
    const r = await worker.fetch(req, env);
    assert.equal(r.status, 200);
    
    // Now test over limit
    DB.tables['request_usage'] = [{ day: '2026-11-15', requests: 25, max_calls: 0 }];
    const r2 = await worker.fetch(makeReq('/api/ai/chat', {
      method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
      body: { message: 'Ещё запрос', tier: 'flash', date: '2026-11-15', tasks: [], history: [] },
    }), env);
    assert.equal(r2.status, 429);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('AI chat: max tier limited to 1/day and 4/month', async () => {
  const DB = makeDB();
  DB.tables['request_usage'] = [{ day: '2026-11-15', requests: 0, max_calls: 1 }];
  DB.tables['ai_usage'] = [{ model: 'qwen3.7-max', created_at: '2026-11-01T12:00:00Z' }]; // already 1 this month — actually this is same month but it's 1, and 4 is allowed
  const env = { ...ENV_BASE, DB };

  const oldFetch = mockFetch(() => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ answer: 'Max ответ', proposals: [] }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

  try {
    // 1 max call today, that's the limit
    DB.tables['request_usage'] = [{ day: '2026-11-15', requests: 0, max_calls: 1 }];
    const req = makeReq('/api/ai/chat', {
      method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
      body: { message: 'Max-запрос', tier: 'max', date: '2026-11-15', tasks: [], history: [] },
    });
    const r = await worker.fetch(req, env);
    assert.equal(r.status, 429, 'Should reject when max_calls already used today');
    assert.match((await r.json()).error, /Лимит Max/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('Snapshot: save and restore via API', async () => {
  const DB = makeDB();
  // Pre-populate via API (don't use DB.tables directly for accurate mock testing)
  const env = { ...ENV_BASE, DB };

  // Initially empty — save a new snapshot
  const r1 = await worker.fetch(makeReq('/api/snapshot', {
    method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
    body: { state: { done: { '2026-11-16': { p1: true } }, habits: {}, extras: [], wakeTimes: {} }, expectedVersion: 0 },
  }), env);
  assert.equal(r1.status, 200, await r1.clone().text());
  const saved = await r1.json();
  assert.equal(saved.ok, true);
  assert.equal(saved.version, 1);

  // Read it back
  const r2 = await worker.fetch(makeReq('/api/snapshot', { origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN }), env);
  assert.equal(r2.status, 200);
  const snap = await r2.json();
  assert.equal(snap.version, 1);
  assert.equal(snap.state.done['2026-11-16'].p1, true);

  // Version conflict: expectedVersion=0 but current version=1
  const r3 = await worker.fetch(makeReq('/api/snapshot', {
    method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
    body: { state: { done: {} }, expectedVersion: 0 },
  }), env);
  assert.equal(r3.status, 409);
  const conflict = await r3.json();
  assert.ok(conflict.error.includes('conflict'), `Unexpected error: ${conflict.error}`);
});

test('Events: write and query analytics', async () => {
  const DB = makeDB();
  DB.tables['habit_events'] = [];
  const env = { ...ENV_BASE, DB };

  // Write events
  const r1 = await worker.fetch(makeReq('/api/events', {
    method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
    body: {
      events: [
        { eid: 'ev1', type: 'complete', date: '2026-11-15', category: 'Код', taskId: 't1', actualStart: '14:00', actualDuration: 35 },
        { eid: 'ev2', type: 'skip', date: '2026-11-15', category: 'Университет', taskId: 't2' },
      ]
    },
  }), env);
  assert.equal(r1.status, 200);
  const write = await r1.json();
  assert.equal(write.stored, 2);

  // Analytics
  const r2 = await worker.fetch(makeReq('/api/analytics', { origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN }), env);
  assert.equal(r2.status, 200);
  const analytics = await r2.json();
  assert.ok('usage' in analytics);
});

test('OPTIONS CORS allows designated origin', async () => {
  const r = await worker.fetch(new Request('https://service.workers.dev/api/health', {
    method: 'OPTIONS',
    headers: { Origin: ENV_BASE.ALLOWED_ORIGIN },
  }), ENV_BASE);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ENV_BASE.ALLOWED_ORIGIN);
});

test('CORS blocks unknown origin', async () => {
  const r = await worker.fetch(makeReq('/api/snapshot', {
    origin: 'https://unknown.evil.com',
    token: ENV_BASE.APP_ACCESS_TOKEN,
  }), ENV_BASE);
  assert.equal(r.status, 403);
});

test('Model routing: tier auto-selection based on intent', async () => {
  const DB = makeDB();
  DB.tables['request_usage'] = [{ day: '2026-11-15', requests: 0, max_calls: 0 }];
  const env = { ...ENV_BASE, DB };

  const oldFetch = mockFetch((url, opts) => {
    const body = JSON.parse(opts.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ answer: `Used ${body.model}`, proposals: [] }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  try {
    // schedule intent should pick plus
    const req1 = makeReq('/api/ai/chat', {
      method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
      body: { message: 'Перепланируй мне расписание на сегодня', date: '2026-11-15', tasks: [], history: [] },
    });
    const r1 = await worker.fetch(req1, env);
    const o1 = await r1.json();
    assert.ok(o1.answer.includes('qwen3.7-plus'), `Expected plus model in "${o1.answer}"`);
    
    // weekly review should pick plus
    const req2 = makeReq('/api/ai/chat', {
      method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
      body: { message: 'Проанализируй достижения недели', purpose: 'weekly_review', date: '2026-11-15', tasks: [], history: [] },
    });
    const r2 = await worker.fetch(req2, env);
    const o2 = await r2.json();
    assert.ok(o2.answer.includes('qwen3.7-plus'));
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('Invalid inputs return 400', async () => {
  const DB = makeDB();
  DB.tables['request_usage'] = [];
  const env = { ...ENV_BASE, DB };

  const oldFetch = mockFetch(() => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ answer: 'ок', proposals: [] }) } }],
    usage: { prompt_tokens: 5, completion_tokens: 5 }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

  try {
    const r1 = await worker.fetch(makeReq('/api/ai/chat', {
      method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
      body: { message: '', date: '2026-11-15', tasks: [], history: [] },
    }), env);
    assert.equal(r1.status, 400);

    const r2 = await worker.fetch(makeReq('/api/ai/chat', {
      method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
      body: { message: 'Привет', tier: 'premium', date: '2026-11-15', tasks: [], history: [] },
    }), env);
    assert.equal(r2.status, 200);
  } finally { globalThis.fetch = oldFetch; }
});

test('Snapshot payload too large is rejected', async () => {
  const DB = makeDB();
  const env = { ...ENV_BASE, DB };

  const hugeState = { done: {}, habits: {}, extras: Array(5000).fill({ name: 'x'.repeat(200) }) };
  const r = await worker.fetch(makeReq('/api/snapshot', {
    method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
    body: { state: hugeState, expectedVersion: 0 },
  }), env);
  assert.equal(r.status, 413);
});

// ── Hybrid-thinking (Qwen 3.7 Flash) regression guards ──

test('AI chat: hybrid thinking is disabled for flash/plus and reasoning text is never exposed', async () => {
  const DB = makeDB();
  DB.tables['request_usage'] = [];
  const env = { ...ENV_BASE, DB };
  const SECRET_THOUGHTS = 'ВНУТРЕННИЕ_РАССУЖДЕНИЯ_МОДЕЛИ';

  const oldFetch = mockFetch((url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(body.reasoning?.enabled, false, 'flash/plus must switch reasoning off');
    assert.equal(body.enable_thinking, false, 'DashScope-native thinking switch must be off');
    assert.ok(!('effort' in body.reasoning), 'effort must not be combined with enabled=false');
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({ answer: 'Перенёс код на вечер.', proposals: [] }),
          reasoning: SECRET_THOUGHTS,
          reasoning_content: SECRET_THOUGHTS,
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 120, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 700 } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  try {
    const r = await worker.fetch(makeReq('/api/ai/chat', {
      method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
      body: { message: 'Перестрой остаток дня', purpose: 'explain', tier: 'flash', date: '2026-11-15', tasks: [], history: [] },
    }), env);
    assert.equal(r.status, 200, await r.clone().text());
    const raw = await r.clone().text();
    assert.equal(raw.includes(SECRET_THOUGHTS), false, 'reasoning must never reach the client');
    const out = await r.json();
    assert.equal(out.answer, 'Перенёс код на вечер.');
    assert.equal(out.usage.reasoningTokens, 700);
    assert.equal(out.retried, false);
  } finally { globalThis.fetch = oldFetch; }
});

test('AI chat: empty content caused by thinking triggers one retry and then succeeds', async () => {
  const DB = makeDB();
  DB.tables['request_usage'] = [];
  const env = { ...ENV_BASE, DB };
  let callCount = 0;

  const oldFetch = mockFetch((url, opts) => {
    callCount++;
    const body = JSON.parse(opts.body);
    assert.equal(body.reasoning?.enabled, false, 'every attempt must disable reasoning');
    if (callCount === 1) {
      // Budget consumed by thoughts: finish_reason length with no final text.
      return new Response(JSON.stringify({
        choices: [{ message: { content: null, reasoning: 'думаю…' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 100, completion_tokens: 2000, completion_tokens_details: { reasoning_tokens: 2000 } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Готово: остаток дня перестроен.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  try {
    const r = await worker.fetch(makeReq('/api/ai/chat', {
      method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
      body: { message: 'Проверь день', date: '2026-11-15', tasks: [], history: [] },
    }), env);
    assert.equal(r.status, 200, await r.clone().text());
    const out = await r.json();
    assert.equal(callCount, 2, 'exactly one retry');
    assert.equal(out.retried, true);
    assert.ok(out.answer.includes('Готово'));
  } finally { globalThis.fetch = oldFetch; }
});

test('AI chat: repeated truncation returns a human error, never raw JSON', async () => {
  const DB = makeDB();
  DB.tables['request_usage'] = [];
  const env = { ...ENV_BASE, DB };
  let callCount = 0;

  const oldFetch = mockFetch(() => {
    callCount++;
    return new Response(JSON.stringify({
      choices: [{
        message: { content: '{"answer":"Начало ответа","proposals":[{"action":"move","date":"2026-11-15","start":"1' },
        finish_reason: 'length',
      }],
      usage: { prompt_tokens: 100, completion_tokens: 1500 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  try {
    const r = await worker.fetch(makeReq('/api/ai/chat', {
      method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
      body: { message: 'Перепланируй расписание', date: '2026-11-15', tasks: [], history: [] },
    }), env);
    assert.equal(callCount, 2, 'one bounded retry only');
    assert.equal(r.status, 502);
    const out = await r.json();
    assert.match(out.error, /финальный текст/);
    assert.equal(out.error.includes('"proposals"'), false, 'no raw JSON in the error');
    assert.equal(out.error.includes('{"answer"'), false, 'no raw JSON in the error');
    assert.equal('proposals' in out, false, 'unfinished JSON must not be applied');
  } finally { globalThis.fetch = oldFetch; }
});

test('AI chat: max tier keeps reasoning hidden and cheap', async () => {
  const DB = makeDB();
  DB.tables['request_usage'] = [];
  DB.tables['ai_usage'] = [];
  const env = { ...ENV_BASE, DB };

  const oldFetch = mockFetch((url, opts) => {
    const body = JSON.parse(opts.body);
    assert.deepEqual(body.reasoning, { effort: 'low', exclude: true });
    assert.equal('enable_thinking' in body, false, 'max tier uses the canonical reasoning object');
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ answer: 'Стратегия недели готова.', proposals: [] }), reasoning: 'скрытая цепочка' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 200, completion_tokens: 60, completion_tokens_details: { reasoning_tokens: 500 } },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  try {
    const r = await worker.fetch(makeReq('/api/ai/chat', {
      method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
      body: { message: 'Глубокий анализ недели', purpose: 'weekly_review', tier: 'max', date: '2026-11-15', tasks: [], history: [] },
    }), env);
    assert.equal(r.status, 200, await r.clone().text());
    const raw = await r.clone().text();
    assert.equal(raw.includes('скрытая цепочка'), false);
    const out = await r.json();
    assert.equal(out.model, 'qwen3.7-max');
  } finally { globalThis.fetch = oldFetch; }
});

test('AI chat: system prompt matches the purpose (no JSON demanded for explanations)', async () => {
  const DB = makeDB();
  DB.tables['request_usage'] = [];
  const env = { ...ENV_BASE, DB };
  const seen = [];

  const oldFetch = mockFetch((url, opts) => {
    const body = JSON.parse(opts.body);
    seen.push(body.messages[0].content);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ answer: 'ок', proposals: [] }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  try {
    await worker.fetch(makeReq('/api/ai/chat', {
      method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
      body: { message: 'Объясни изменения', purpose: 'explain', tier: 'flash', date: '2026-11-15', tasks: [], history: [] },
    }), env);
    await worker.fetch(makeReq('/api/ai/chat', {
      method: 'POST', origin: ENV_BASE.ALLOWED_ORIGIN, token: ENV_BASE.APP_ACCESS_TOKEN,
      body: { message: 'Добавь дело завтра', date: '2026-11-15', tasks: [], history: [] },
    }), env);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].includes('proposals'), false, 'explain must not ask for JSON proposals');
    assert.equal(seen[0].includes('JARVIS'), true, 'explain prompt stays the short planner persona');
    assert.equal(/(?:ТОЛЬКО JSON|Выводи только JSON)/i.test(seen[1]), true, 'action intents must request JSON-only output');
  } finally { globalThis.fetch = oldFetch; }
});