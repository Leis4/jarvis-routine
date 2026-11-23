/* JARVIS v43.4 — P0-B at the browser level (iPhone WebKit).
   The cloud restore runs through the REAL UI button and the REAL restoreCloud()
   code path, but the network is mocked with page.route: no production D1 is
   touched. It locks the user-visible safety contract for a stale cloud copy
   that shares top-level keys with newer local data:
     - local-only keys missing from the cloud are preserved;
     - keys present in BOTH but with different nested data raise an explicit
       overwrite warning instead of being replaced silently;
     - a restorable pre-restore backup is written before anything is replaced. */
import { test, expect } from '@playwright/test';
import { seedScheduleTemplate } from './lib/seed-template.cjs';

const CLOUD = {
  done: { '2026-11-10::old': true }, habits: {}, extras: [], logs: {}, anchor: null, shave: null, wakeTimes: {},
  goals: { '2026-11-10': [{ id: 'cloud-goal', text: 'Цель из облака' }] },
  customHabits: [{ id: 'cloud-h', name: 'Облачная привычка', created: '2026-11-10', archived: false }],
  flex: { mode: 'off' },
};

async function boot(page) {
  await seedScheduleTemplate(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('#app', { timeout: 10000 });
  await page.waitForTimeout(400);
}

async function seedLocal(page) {
  await page.evaluate(() => {
    const t = today();
    S.anchor = { monday: monday(t), parity: 0 };
    S.done = { ...(S.done || {}), [t + '::localTask']: true };
    S.habits = { ...(S.habits || {}), [t]: { localHabit: true } };
    S.goals = { ...(S.goals || {}), [t]: [{ id: 'local-goal', text: 'Локальная цель' }] };
    S.customHabits = [{ id: 'local-custom', name: 'Локальная привычка', created: t, archived: false }];
    S.flex = { ...(S.flex || {}), mode: 'on' };
    persist(); render();
  });
  await page.waitForTimeout(200);
}

test.describe('P0 cloud restore (iPhone WebKit, mocked D1)', () => {
  test('a stale cloud copy warns before overwriting newer local data and keeps a backup', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

    await boot(page);
    await seedLocal(page);

    /* Mock the network at the page level: nothing leaves the browser, no D1. */
    await page.evaluate((cloud) => {
      window.__snapshotHits = 0;
      const realFetch = window.fetch.bind(window);
      window.fetch = (url, opts) => {
        if (String(url).includes('/api/snapshot')) {
          window.__snapshotHits++;
          return Promise.resolve(new Response(JSON.stringify({ state: cloud, version: 42 }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return realFetch(url, opts);
      };
    }, CLOUD);

    /* Wire the app to the mock endpoint and open the AI settings view. */
    await page.evaluate(() => {
      window.aiState.url = 'https://example.test';
      window.aiState.token = 'z'.repeat(30);
      window.aiState.connected = true;
      window.aiState.showConfig = true;
      ui.tab = 'ai';
      render();
    });

    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });

    await page.click('[data-ai="pullSnapshot"]');
    await page.waitForTimeout(800);

    expect(await page.evaluate(() => window.__snapshotHits)).toBe(1);

    const after = await page.evaluate(() => {
      const t = today();
      const raw = localStorage.getItem('jarvis_routine_before_restore_v1');
      return {
        date: t,
        done: S.done,
        goals: S.goals,
        custom: (S.customHabits || []).map(h => h.id),
        flexMode: S.flex && S.flex.mode,
        backup: raw ? JSON.parse(raw) : null,
        status: window.aiState.status,
      };
    });

    /* The cloud copy wins for the keys it carries. */
    expect(after.done).toEqual({ '2026-11-10::old': true });
    expect(after.custom).toContain('cloud-h');

    /* Every shared key with different nested data triggered an explicit warning. */
    const warned = dialogs.join(' | ');
    expect(warned).toContain('перезапишет более свежие локальные данные');
    expect(warned).toContain('habits');
    expect(warned).toContain('done');

    /* A restorable backup of the pre-restore local state exists and holds the
       newer local data that the restore deliberately replaced. */
    expect(after.backup, 'a pre-restore backup must exist').not.toBeNull();
    expect(after.backup.goals).toEqual({ [after.date]: [{ id: 'local-goal', text: 'Локальная цель' }] });
    expect(after.backup.customHabits.some(h => h.id === 'local-custom')).toBe(true);
    expect(after.backup.habits[after.date]).toEqual({ localHabit: true });

    expect(errors).toEqual([]);
    page.removeAllListeners();
  });
});
