/* JARVIS v43.2 — habits management flows (iPhone WebKit).
   Create, edit, complete, archive, restore — with history preserved and honest
   streaks/percentages computed only over scheduled days. */
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

async function openHabits(page) {
  await page.evaluate(() => { const t = today(); S.anchor = { monday: t, parity: 0 }; ui.date = t; ui.tab = 'more'; ui.moreTab = 'more-habits'; persist(); render(); });
  await page.waitForTimeout(250);
}

const habits = page => page.evaluate(() => (S.customHabits || []).map(h => ({ id: h.id, name: h.name, archived: !!h.archived })));

test.describe('JARVIS v43.2 habits', () => {
  let errors;
  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await boot(page);
    await openHabits(page);
  });
  test.afterEach(async ({ page }) => { page.removeAllListeners(); });

  test('create, edit, complete, archive and restore a habit without losing history', async ({ page }) => {
    /* create */
    await page.click('[data-action="addHabit"]');
    await page.fill('#habitForm [name="name"]', 'Полить цветы');
    await page.fill('#habitForm [name="sub"]', 'утром');
    await page.click('#habitForm button[type="submit"]');
    await page.waitForTimeout(250);
    let list = await habits(page);
    expect(list.length).toBe(1);
    const id = list[0].id;
    expect(list[0].name).toBe('Полить цветы');
    await expect(page.locator(`.habrow [data-action="editHabit"][data-id="${id}"]`)).toBeVisible();

    /* edit: rename and switch to weekly, keeping today scheduled */
    await page.click(`[data-action="editHabit"][data-id="${id}"]`);
    await expect(page.locator('#habitForm [name="habitId"]')).toHaveValue(id);
    await page.fill('#habitForm [name="name"]', 'Полить цветы и травы');
    await page.selectOption('#habitForm [name="mode"]', 'weekly');
    const todayIdx = await page.evaluate(() => indexDay(today()));
    await page.check(`#habitForm [name="day${todayIdx}"]`);
    await page.click('#habitForm button[type="submit"]');
    await page.waitForTimeout(250);
    list = await habits(page);
    expect(list.length).toBe(1);
    expect(list[0].name).toBe('Полить цветы и травы');
    expect(await page.evaluate(i => S.customHabits.find(h => h.id === i).mode, id)).toBe('weekly');

    /* complete today -> honest streak of 1 */
    await page.check(`.habrow input.taskcheck[data-habit="${id}"]`);
    await page.waitForTimeout(250);
    expect(await page.evaluate(i => !!S.habits[ui.date][i], id)).toBe(true);
    await expect(page.locator('.habit-hist', { hasText: 'Полить цветы и травы' })).toContainText('🔥 1');

    /* archive: leaves the active list, keeps the completion mark */
    await page.click(`[data-action="archiveHabit"][data-id="${id}"]`);
    await page.waitForTimeout(250);
    expect((await habits(page))[0].archived).toBe(true);
    expect(await page.evaluate(i => !!S.habits[ui.date][i], id)).toBe(true);
    await expect(page.locator('.habrow.archived')).toContainText('в архиве');

    /* restore */
    await page.click(`[data-action="restoreHabit"][data-id="${id}"]`);
    await page.waitForTimeout(250);
    expect((await habits(page))[0].archived).toBe(false);
    expect(await page.evaluate(i => !!S.habits[ui.date][i], id)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('a new habit is not shown as a failure before it exists', async ({ page }) => {
    await page.click('[data-action="addHabit"]');
    await page.fill('#habitForm [name="name"]', 'Новая привычка');
    await page.selectOption('#habitForm [name="mode"]', 'weekly');
    /* schedule it on a weekday that is not today, so the last 7 days contain no
       planned day (all earlier days are before the habit existed) */
    const todayIdx = await page.evaluate(() => indexDay(today()));
    const other = (todayIdx + 1) % 7;
    await page.uncheck(`#habitForm [name="day${todayIdx}"]`);
    await page.check(`#habitForm [name="day${other}"]`);
    await page.click('#habitForm button[type="submit"]');
    await page.waitForTimeout(250);
    /* DOM evidence: the history row shows "—" percent, no 🔥 streak and seven
       "off" (not-planned) day dots */
    const row = page.locator('.habit-hist', { hasText: 'Новая привычка' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('—');
    await expect(row).not.toContainText('🔥');
    expect(await row.locator('.hdot.off').count()).toBe(7);
    expect(await row.locator('.hdot.on').count()).toBe(0);
    expect(errors).toEqual([]);
  });

  test('the habits screen has no horizontal overflow on iPhone widths', async ({ page }) => {
    await page.click('[data-action="addHabit"]');
    await page.fill('#habitForm [name="name"]', 'Очень длинная привычка с длинным названием для проверки переполнения');
    await page.click('#habitForm button[type="submit"]');
    await page.waitForTimeout(250);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.body.clientWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);
  });
});
