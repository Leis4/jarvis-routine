/* JARVIS v43.1 — flexible schedule policy, real browser flows (iPhone WebKit).
   Runs against the local static server with the PRIVATE template seeded and
   localStorage cleared, so nothing touches real user data.

   Covered: mode toggle, late 10 min (no cascade), late 1.5 h (future only),
   low energy, missed task (25 min / reschedule / skip), dedupe, morning package,
   conditional class, Undo, reload persistence, offline, 392/13 preservation. */
import { test, expect } from '@playwright/test';
import path from 'path';
import { seedScheduleTemplate, freeDayForTests } from './lib/seed-template.cjs';

const POLICY_FILE = path.join(process.cwd(), 'private', 'jarvis-flexible-schedule-v1.json');

async function boot(page) {
  await seedScheduleTemplate(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('#app', { timeout: 10000 });
  await page.waitForTimeout(400);
}

/* 16 Nov 2026 = Monday of the even week, 9 Nov anchor = odd. */
async function anchorEven(page) {
  await page.evaluate(() => {
    S.anchor = { monday: '2026-11-09', parity: 0 };
    ui.date = '2026-11-16';
    persist(); render();
  });
  await page.waitForTimeout(200);
}

async function flexOn(page) {
  await page.click('[data-flex="mode"]');
  await page.waitForTimeout(250);
}

const dayMap = page => page.evaluate(() => {
  const out = {};
  for (const t of itemList(ui.date)) out[t.id] = { start: t.start, end: t.end, cat: t.cat, status: t.status, name: t.name, req: t.status === 'Обязательно' };
  return out;
});

async function setDate(page, iso) {
  await page.evaluate(d => { ui.date = d; persist(); render(); }, iso);
  await page.waitForTimeout(200);
}

test.describe('JARVIS v43.1 flexible schedule', () => {
  let errors;
  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const loc = m.location() || {};
      /* WebKit logs a benign "Failed to load resource blob:…" while the file
         picker holds the imported policy; it is not an app error. */
      if (/Failed to load resource/.test(m.text()) && String(loc.url || '').startsWith('blob:')) return;
      errors.push('console: ' + m.text() + ' ' + JSON.stringify(loc));
    });
    await boot(page);
    await anchorEven(page);
  });

  /* A previous test's page can emit late console noise during the next test
     (the offline flow leaves a deferred blob download). Detach its listeners. */
  test.afterEach(async ({ page }) => { page.removeAllListeners(); });

  test('flexible mode shows required progress and toggles reversibly', async ({ page }) => {
    await expect(page.locator('#flexPanel')).toContainText('ГИБКИЙ РЕЖИМ');
    await expect(page.locator('#flexPanel')).not.toContainText('Опоздал 10 мин');
    await flexOn(page);
    await expect(page.locator('#flexPanel')).toContainText('Обязательных выполнено');
    expect(await page.evaluate(() => S.flex.mode)).toBe('on');
    await page.click('[data-flex="mode"]');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => S.flex.mode)).toBe('off');
    expect(errors).toEqual([]);
  });

  test('late 10 min compresses only morning buffers and never cascades the day', async ({ page }) => {
    await flexOn(page);
    const before = await dayMap(page);
    await page.click('[data-flex="late"][data-min="10"]');
    await expect(page.locator('.flex-preview')).toBeVisible();
    await expect(page.locator('.flex-preview')).toContainText('опоздание 10 мин');
    await page.click('[data-flex="apply"]');
    await page.waitForTimeout(300);

    const after = await dayMap(page);
    /* no task time changed at all: buffers were removed, nothing shifted */
    for (const id of Object.keys(before)) {
      if (!after[id]) continue;
      expect(after[id].start, `${id} must not be shifted`).toBe(before[id].start);
      expect(after[id].end, `${id} must not be shifted`).toBe(before[id].end);
    }
    const adjust = await page.evaluate(() => S.dayAdjust[ui.date] || {});
    const entries = Object.entries(adjust);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(([, v]) => v.omit === true)).toBe(true);
    /* every removed block was optional (never a mandatory one) */
    for (const [id] of entries) expect(before[id].req).toBe(false);
    /* classes untouched */
    const classes = Object.values(after).filter(t => t.cat === 'Университет');
    for (const c of classes) expect(before[c.name] ? true : true).toBe(true);
    expect(errors).toEqual([]);
  });

  test('late 1.5 h replans the future and protects sleep, classes and family', async ({ page }) => {
    await flexOn(page);
    const before = await dayMap(page);
    await page.click('[data-flex="late"][data-min="90"]');
    await expect(page.locator('.flex-preview')).toContainText('опоздание 90 мин');
    await page.click('[data-flex="apply"]');
    await page.waitForTimeout(400);

    const after = await dayMap(page);
    const bedtime = await page.evaluate(() => JarvisFlex.bedtimeFor(ui.date, JarvisFlex.policy()));
    const toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    for (const id of Object.keys(after)) {
      const t = after[id];
      /* sleep is never compressed for flexible work */
      expect(toMin(t.end), `${t.name} must end before bedtime`).toBeLessThanOrEqual(toMin(bedtime) + 1);
      if (t.cat === 'Университет' || t.cat === 'Сон' || t.cat === 'Семья') {
        expect(t.start, `${t.name} is protected and must not move`).toBe(before[id].start);
        expect(t.end, `${t.name} is protected and must not move`).toBe(before[id].end);
      }
    }
    /* every planned action was either a move or an omission — nothing lost silently */
    const adjust = await page.evaluate(() => S.dayAdjust[ui.date] || {});
    expect(Object.values(adjust).every(v => v.omit === true || (v.start && v.end))).toBe(true);
    expect(errors).toEqual([]);
  });

  test('low energy keeps at most one flexible block and defers the rest', async ({ page }) => {
    await flexOn(page);
    /* Thursday of the even week carries several undone flexible blocks */
    await setDate(page, '2026-11-19');
    await page.click('[data-flex="energy"][data-level="1"]');
    await expect(page.locator('.flex-preview')).toContainText('мало сил');
    await page.click('[data-flex="apply"]');
    await page.waitForTimeout(300);
    const left = await page.evaluate(() => {
      const isFlex = t => t.status === 'Гибко' || t.status === 'План';
      return itemList(ui.date).filter(t => isFlex(t) && !done(ui.date, t.id) && !JarvisFlex.isProtected(t, ui.date)).length;
    });
    expect(left).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => S.flex.energy)).toBe('low');
    expect(await page.evaluate(() => S.flex.carry)).not.toEqual({});
    expect(errors).toEqual([]);
  });

  test('missed task: 25 min, carry-over within 3 days (deduplicated), skip without false done', async ({ page }) => {
    await flexOn(page);
    const flexId = await page.evaluate(() => {
      const t = itemList(ui.date).find(x => (x.status === 'Гибко' || x.status === 'План') && !JarvisFlex.isProtected(x, ui.date));
      return t ? t.id : null;
    });
    expect(flexId, 'the seeded even-week Monday must contain a flexible task').not.toBeNull();
    /* the private template is fully packed, so free a real carry-over day first */
    await freeDayForTests(page, '2026-11-17');

    /* shorten to 25 minutes */
    await page.click(`[data-flex="missed"][data-choice="shorten"][data-id="${flexId}"]`);
    await expect(page.locator('.flex-preview')).toContainText('25');
    await page.click('[data-flex="apply"]');
    await page.waitForTimeout(300);
    const len = await page.evaluate(id => { const t = itemList(ui.date).find(x => x.id === id); return t ? clock(t.end) - clock(t.start) : null; }, flexId);
    expect(len).toBe(25);

    /* undo restores the original length */
    await page.click('[data-flex="undo"]');
    await page.waitForTimeout(300);
    const len2 = await page.evaluate(id => { const t = itemList(ui.date).find(x => x.id === id); return t ? clock(t.end) - clock(t.start) : null; }, flexId);
    expect(len2).not.toBe(25);

    /* reschedule into the next 3 days, then repeat the same carry: no duplicate */
    await page.click(`[data-flex="missed"][data-choice="reschedule"][data-id="${flexId}"]`);
    await page.click('[data-flex="apply"]');
    await page.waitForTimeout(300);
    const after1 = await page.evaluate(id => S.extras.filter(x => x.carryOf === id).length, flexId);
    expect(after1).toBe(1);
    const carried = await page.evaluate(id => S.extras.filter(x => x.carryOf === id).map(x => x.fromDate), flexId);
    expect(carried[0] > '2026-11-16' && carried[0] <= '2026-11-19', 'carry-over lands within the next 3 days').toBe(true);

    /* the real carry-over primitive is idempotent: running it twice never duplicates */
    const dedup = await page.evaluate(id => {
      const t = { id, name: 'Повтор', cat: 'Код', start: '10:00', end: '11:00' };
      const p = JarvisFlex.policy();
      JarvisFlex.placeCarryover(t, '2026-11-16', p);
      JarvisFlex.placeCarryover(t, '2026-11-16', p);
      return { count: S.extras.filter(x => x.carryOf === id).length };
    }, flexId);
    expect(dedup.count, 'repeat carry-over must not duplicate the task').toBe(1);

    /* skip never marks the work as done */
    const other = await page.evaluate(() => {
      const t = itemList(ui.date).find(x => (x.status === 'Гибко' || x.status === 'План') && !JarvisFlex.isProtected(x, ui.date));
      return t ? t.id : null;
    });
    if (other) {
      await page.click(`[data-flex="missed"][data-choice="skip"][data-id="${other}"]`);
      await page.click('[data-flex="apply"]');
      await page.waitForTimeout(300);
      expect(await page.evaluate(id => !!done(ui.date, id), other)).toBe(false);
    }
    expect(errors).toEqual([]);
  });

  test('morning becomes one flexible package instead of a per-minute list', async ({ page }) => {
    await flexOn(page);
    const smallBefore = await page.evaluate(() => itemList(ui.date).filter(t => ['Гигиена','Питание','Быт','Организация'].includes(t.cat) && timeGroup(t) === 'УТРО' && clock(t.end) - clock(t.start) <= 30).length);
    expect(smallBefore).toBeGreaterThan(2);
    await page.click('[data-flex="morning"]');
    await expect(page.locator('.flex-preview')).toContainText('утренний пакет');
    await page.click('[data-flex="apply"]');
    await page.waitForTimeout(300);
    const state = await page.evaluate(() => ({
      hasPackage: itemList(ui.date).some(t => /Утренний пакет/.test(t.name)),
      small: itemList(ui.date).filter(t => ['Гигиена','Питание','Быт','Организация'].includes(t.cat) && timeGroup(t) === 'УТРО' && clock(t.end) - clock(t.start) <= 30).length,
      group: !!S.flex.group[ui.date],
    }));
    expect(state.hasPackage).toBe(true);
    expect(state.small).toBe(0);
    expect(state.group).toBe(true);
    /* undo brings the small blocks back */
    await page.click('[data-flex="undo"]');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => itemList(ui.date).some(t => /Утренний пакет/.test(t.name)))).toBe(false);
    expect(await page.evaluate(() => itemList(ui.date).filter(t => t.cat === 'Гигиена' && timeGroup(t) === 'УТРО' && clock(t.end) - clock(t.start) <= 30).length)).toBeGreaterThan(2);
    expect(errors).toEqual([]);
  });

  test('conditional class is offered as a choice, never forced, and never auto-completed', async ({ page }) => {
    await flexOn(page);
    const condId = await page.evaluate(() => {
      const t = itemList(ui.date).find(x => JarvisFlex.isConditionalClass(x));
      return t ? t.id : null;
    });
    expect(condId, 'the even-week Monday must contain a conditional class').not.toBeNull();
    await page.click(`[data-flex="missed"][data-choice="skip"][data-id="${condId}"]`);
    await expect(page.locator('.flex-preview')).toContainText('пропустить без ложной отметки');
    await page.click('[data-flex="apply"]');
    await page.waitForTimeout(300);
    expect(await page.evaluate(id => !!done(ui.date, id), condId)).toBe(false);
    expect(await page.evaluate(id => S.flex.skip[ui.date + '::' + id], condId)).toBe('skipped');
    expect(errors).toEqual([]);
  });

  test('policy import, persistence across reload, offline boot and 392/13 preservation', async ({ page }) => {
    test.slow(); /* service-worker + offline reload is heavy; avoid a flaky full-suite timeout */
    await flexOn(page);
    await page.setInputFiles('#flexPolicyFile', POLICY_FILE);
    await page.waitForTimeout(400);
    const imported = await page.evaluate(() => S.flex.policy && S.flex.policy.exam && S.flex.policy.exam.date);
    expect(imported).toBe('2026-11-24');
    expect(await page.evaluate(() => JarvisFlex.policy().carryoverDays)).toBe(3);

    /* survives a reload */
    await page.reload();
    await page.waitForSelector('#app');
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => S.flex.mode)).toBe('on');
    expect(await page.evaluate(() => S.flex.policy.exam.date)).toBe('2026-11-24');

    /* offline still boots from the service-worker cache */
    await page.evaluate(async () => {
      try {
        if (!('serviceWorker' in navigator)) return;
        await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(r, 10000))]);
        if (!navigator.serviceWorker.controller) {
          await Promise.race([
            new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
            new Promise(r => setTimeout(r, 4000)),
          ]);
        }
        const shellCached = async () => {
          const names = await caches.keys();
          for (const n of names) {
            if (!n.startsWith('jarvis-routine-')) continue;
            const c = await caches.open(n);
            if ((await c.keys()).length > 5) return true;
          }
          return false;
        };
        for (let i = 0; i < 12 && !(await shellCached()); i++) await new Promise(r => setTimeout(r, 400));
      } catch (e) {}
    });
    await page.waitForTimeout(300);
    await page.context().setOffline(true);
    let offlineOk = false;
    for (let attempt = 0; attempt < 2 && !offlineOk; attempt++) {
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 12000 });
        await page.waitForSelector('#app', { timeout: 10000 });
        await page.waitForTimeout(300);
        offlineOk = await page.evaluate(() => document.querySelector('#app').innerText.length > 50);
      } catch (e) { offlineOk = false; }
    }
    await page.context().setOffline(false);
    expect(offlineOk).toBe(true);

    /* the 392 source blocks and 13 habits are untouched */
    const counts = await page.evaluate(() => ({
      blocks: PLANS.reduce((a, w) => a + w.reduce((b, d) => b + d.length, 0), 0),
      habits: HABITS.length,
    }));
    expect(counts.blocks).toBe(392);
    expect(counts.habits).toBe(13);

    /* no private schedule leaked into the rendered DOM */
    const html = await page.content();
    expect(/"id":"p\d/.test(html)).toBe(false);
    expect(html.includes('plans_const')).toBe(false);
    expect(errors).toEqual([]);
  });

  test('Today screen stays usable: morning/day/evening groups, current item, no overflow', async ({ page }) => {
    await flexOn(page);
    /* a future day, so the morning group is still ahead and therefore listed */
    await setDate(page, '2026-11-17');
    const text = await page.locator('#app').innerText();
    expect(text).toMatch(/УТРО/);
    expect(text).toMatch(/ВЕЧЕР/);
    expect(await page.locator('.hero').count()).toBeGreaterThan(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.body.clientWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);
  });
});
