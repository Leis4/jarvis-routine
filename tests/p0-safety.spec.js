/* JARVIS v43.3 — P0 safety on iPhone WebKit.
   1. a hostile habit name is escaped in the UI (never executed);
   2. a backup export -> import round-trips added data;
   3. the app boots and renders in another timezone. */
import { test, expect } from '@playwright/test';
import { seedScheduleTemplate } from './lib/seed-template.cjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

async function boot(page) {
  await seedScheduleTemplate(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('#app', { timeout: 10000 });
  await page.waitForTimeout(400);
}

async function openHabits(page) {
  await page.evaluate(() => { const t = today(); S.anchor = { monday: monday(t), parity: 0 }; ui.date = t; ui.tab = 'more'; ui.moreTab = 'more-habits'; persist(); render(); });
  await page.waitForTimeout(250);
}

async function openToday(page) {
  await page.evaluate(() => { const t = today(); S.anchor = { monday: monday(t), parity: 0 }; ui.date = t; ui.tab = 'today'; persist(); render(); });
  await page.waitForTimeout(250);
}

test.describe('P0 safety (iPhone WebKit)', () => {
  let errors;
  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await boot(page);
  });
  test.afterEach(async ({ page }) => { page.removeAllListeners(); });

  test('a hostile habit name is rendered as text, never executed', async ({ page }) => {
    await openHabits(page);
    const payload = '<img src=x onerror="window.__habitXss=1"><script>window.__habitXss2=1</script>';
    await page.click('[data-action="addHabit"]');
    await page.fill('#habitForm [name="name"]', payload);
    await page.click('#habitForm button[type="submit"]');
    await page.waitForTimeout(300);

    expect(await page.evaluate(() => window.__habitXss)).toBeUndefined();
    expect(await page.evaluate(() => window.__habitXss2)).toBeUndefined();
    const label = page.locator('.habrow label', { hasText: '<img src=x' });
    await expect(label).toHaveCount(1);
    await expect(label).toContainText('<img src=x');
    expect(await label.locator('img').count()).toBe(0);
    expect(errors).toEqual([]);
  });

  test('a backup export restores added data after the state is wiped', async ({ page }) => {
    /* create a habit and mark it done */
    await openHabits(page);
    await page.click('[data-action="addHabit"]');
    await page.fill('#habitForm [name="name"]', 'Резервная привычка');
    await page.click('#habitForm button[type="submit"]');
    await page.waitForTimeout(250);
    const id = await page.evaluate(() => S.customHabits[0].id);
    const date = await page.evaluate(() => ui.date);
    await page.check(`.habrow input.taskcheck[data-habit="${id}"]`);
    await page.waitForTimeout(200);

    /* export the real backup file */
    await page.evaluate(() => { ui.tab = 'more'; ui.moreTab = 'settings'; render(); });
    await page.waitForTimeout(200);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('[data-action="export"]'),
    ]);
    const file = path.join(os.tmpdir(), 'jarvis-p0-backup-' + Date.now() + '.json');
    await download.saveAs(file);
    const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(dump.customHabits.some(h => h.id === id)).toBe(true);
    expect(dump.habits[date][id]).toBe(true);

    /* wipe local state so restore has something to bring back */
    await page.evaluate(() => { S.customHabits = []; S.habits = {}; persist(); render(); });
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => (S.customHabits || []).length)).toBe(0);

    /* restore through the real UI */
    page.once('dialog', d => d.accept());
    await page.setInputFiles('#importFile', file);
    await page.waitForTimeout(700);
    expect(await page.evaluate(i => (S.customHabits || []).some(h => h.id === i), id)).toBe(true);
    expect(await page.evaluate(({ d, i }) => !!(S.habits[d] && S.habits[d][i]), { d: date, i: id })).toBe(true);
    expect(errors).toEqual([]);
    fs.unlinkSync(file);
  });
});

test.describe('P0 other timezone', () => {
  test.use({ timezoneId: 'America/New_York' });
  test('boots and renders the day without errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await boot(page);
    await openToday(page);
    await expect(page.locator('#app .task-row').first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.body.clientWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);
    page.removeAllListeners();
  });
});
