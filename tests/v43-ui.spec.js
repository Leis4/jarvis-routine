/* JARVIS Routine v43 — browser checks for the new modules on iPhone WebKit.
   Real user flows, not string-presence checks:
     - quick add: parse -> conflict/free slot -> persist -> undo
     - command palette
     - Study tab: lazy ts-fsrs load, introduce != review, real rating
     - activity heatmap in Progress
     - no uncaught errors and no horizontal overflow on any tab

   Note on overflow: on WebKit-on-Windows `window.innerWidth` is distorted by
   the host DPI scale (389 vs the real 430 CSS px). The honest measure is the
   document scroll width against the body's layout width.

   Run: npx playwright test --config=playwright.config.js tests/v43-ui.spec.js */
import { test, expect } from '@playwright/test';
import { seedScheduleTemplate } from './lib/seed-template.cjs';

async function boot(page) {
  await seedScheduleTemplate(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('#app', { timeout: 10000 });
  await page.waitForTimeout(400);
}

async function overflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.body.clientWidth);
}

test.describe('JARVIS v43 modules (iPhone WebKit)', () => {
  let errors;

  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await boot(page);
  });

  test('quick add parses Russian text, refuses a clash and can be undone', async ({ page }) => {
    // Ask the app itself for a genuinely free 30-minute window in the next two weeks.
    const free = await page.evaluate(() => {
      const C = window.jarvisTaskConflict;
      const base = new Date(today() + 'T12:00:00').getTime();
      for (let i = 1; i <= 13; i++) {
        const iso = new Date(base + i * 86400000).toISOString().slice(0, 10);
        for (let m = 7 * 60; m <= 21 * 60; m += 15) {
          const a = String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
          const b = String(Math.floor((m + 30) / 60)).padStart(2, '0') + ':' + String((m + 30) % 60).padStart(2, '0');
          if (!C.conflicts(iso, '', a, b).length) return { iso, dd: iso.slice(8, 10), mm: iso.slice(5, 7), start: a };
        }
      }
      return null;
    });
    expect(free, 'the seeded schedule must contain at least one free window').not.toBeNull();

    await page.click('#quickFab');
    await expect(page.locator('#quickPanel')).toBeVisible();

    await page.fill('#quickInput', `Проверка JARVIS ${free.dd}.${free.mm} в ${free.start} на 30 минут`);
    await expect(page.locator('#quickPreview')).toContainText('Проверка JARVIS');
    await expect(page.locator('#quickPreview')).toContainText(free.start);
    await expect(page.locator('#quickPreview')).not.toContainText('Пересечение');

    const before = await page.evaluate(() => S.extras.length);
    await page.click('#quickPanel button[type="submit"]');
    await page.waitForTimeout(250);

    expect(await page.evaluate(() => S.extras.length)).toBe(before + 1);
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis_routine_v1')).extras.length);
    expect(after).toBe(before + 1);
    const savedItem = await page.evaluate(() => S.extras[S.extras.length - 1]);
    expect(savedItem.name).toBe('Проверка JARVIS');
    expect(savedItem.fromDate).toBe(free.iso);

    // The confirmation offers a real undo.
    const undo = page.locator('.toast-action .toast-btn');
    await expect(undo).toBeVisible();
    await undo.click();
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => S.extras.length)).toBe(before);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis_routine_v1')).extras.length)).toBe(before);

    // A real clash is refused instead of silently double-booking the day.
    const busy = await page.evaluate(iso => {
      const t = itemList(iso).find(x => /^\d{2}:\d{2}$/.test(x.start) && /^\d{2}:\d{2}$/.test(x.end));
      return t ? t.start : null;
    }, free.iso);
    expect(busy).not.toBeNull();
    await page.click('#quickFab');
    await page.fill('#quickInput', `Конфликт ${free.dd}.${free.mm} в ${busy} на 30 минут`);
    await expect(page.locator('#quickPreview')).toContainText('Пересечение');
    await page.click('#quickPanel button[type="submit"]');
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => S.extras.length)).toBe(before);
    expect(errors).toEqual([]);
  });

  test('command palette opens on the first Ctrl+K, lists real commands and runs one', async ({ page }) => {
    await page.keyboard.press('Control+k');
    await expect(page.locator('#palette')).toBeVisible();
    expect(await page.locator('.palette-row').count()).toBeGreaterThan(3);

    await page.fill('#paletteInput', 'фокус 25');
    await page.waitForTimeout(150);
    await expect(page.locator('#paletteList')).toContainText('Добавить:');
    await page.keyboard.press('Escape');
    await expect(page.locator('#palette')).toBeHidden();

    // Reopen and run the focus command from the palette.
    await page.keyboard.press('Control+k');
    await expect(page.locator('#palette')).toBeVisible();
    await page.fill('#paletteInput', 'фокус');
    await page.waitForTimeout(150);
    await page.locator('.palette-row', { hasText: 'Начать фокус 25' }).first().click();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.JarvisFocus && window.JarvisFocus.session && window.JarvisFocus.session.plannedMin)).toBe(25);
    await expect(page.locator('#palette')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('Study tab loads ts-fsrs lazily and keeps introduction out of the success counter', async ({ page }) => {
    const requested = [];
    page.on('request', r => requested.push(r.url()));
    expect(requested.filter(u => u.includes('vendor/fsrs.min.js')).length).toBe(0);

    await page.evaluate(() => { window.ui.tab = 'more'; window.ui.moreTab = 'study'; render(); });
    await expect(page.locator('#app')).toContainText('К повторению');
    await expect.poll(() => requested.filter(u => u.includes('vendor/fsrs.min.js')).length, { timeout: 8000 }).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => typeof window.FSRS === 'object'), { timeout: 8000 }).toBe(true);

    await page.fill('#studyCardForm input[name="front"]', 'Теорема Байеса');
    await page.fill('#studyCardForm textarea[name="back"]', 'P(A|B)=P(B|A)P(A)/P(B)');
    await page.click('#studyCardForm button[type="submit"]');
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => S.study.cards.length)).toBe(1);
    expect(await page.evaluate(() => S.study.cards[0].reviews)).toBe(0);

    // Introduction is not a successful repetition.
    await page.click('[data-study="introduce"]');
    await page.waitForTimeout(200);
    await expect(page.locator('.study-back')).toContainText('P(A|B)');
    expect(await page.evaluate(() => S.study.cards[0].reviews)).toBe(0);
    expect(await page.evaluate(() => S.study.cards[0].introducedAt !== null)).toBe(true);

    // A real recall is counted and persisted.
    await page.click('[data-study="rate"][data-rating="good"]');
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => S.study.cards[0].reviews)).toBe(1);
    expect(await page.evaluate(() => S.study.cards[0].lapses)).toBe(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('jarvis_routine_v1')).study.cards.length)).toBe(1);
    expect(await overflow(page)).toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);
  });

  test('Progress tab shows the 12-week heatmap with real day data', async ({ page }) => {
    await page.evaluate(() => { window.ui.tab = 'more'; window.ui.moreTab = 'stats'; render(); });
    await expect(page.locator('.heatmap')).toBeVisible();
    expect(await page.locator('.heatmap .hm-cell').count()).toBe(12 * 7);
    expect(await page.locator('.hm-legend .hm-cell').count()).toBe(5);
    expect(await page.locator('.heatmap .hm-cell[data-today="1"]').count()).toBe(1);
    expect(await overflow(page)).toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);
  });

  test('every tab renders without horizontal overflow or uncaught errors', async ({ page }) => {
    const tabs = [['today', null], ['planner', null], ['ai', null], ['more', 'focus'], ['more', 'study'], ['more', 'stats'], ['more', 'more-habits'], ['more', 'settings']];
    for (const [tab, sub] of tabs) {
      await page.evaluate(([t, s]) => { window.ui.tab = t; if (s) window.ui.moreTab = s; render(); }, [tab, sub]);
      await page.waitForTimeout(220);
      expect(await overflow(page), `${tab}/${sub} must not overflow horizontally`).toBeLessThanOrEqual(2);
      expect(await page.locator('#app').innerText(), `${tab}/${sub} must render content`).not.toBe('');
    }
    expect(errors).toEqual([]);
  });
});
