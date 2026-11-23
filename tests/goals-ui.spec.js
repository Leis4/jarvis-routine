/* JARVIS v43.2 — "Мои 2–3 цели дня" real browser flows (iPhone WebKit).
   Runs against the local static server with the PRIVATE template seeded and
   localStorage cleared, so nothing touches real user data. */
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

async function anchorEven(page) {
  await page.evaluate(() => { S.anchor = { monday: '2026-11-09', parity: 0 }; ui.date = '2026-11-16'; persist(); render(); });
  await page.waitForTimeout(200);
}

const goals = page => page.evaluate(() => (S.goals && S.goals[ui.date]) || []);

test.describe('JARVIS v43.2 goals of the day', () => {
  let errors;
  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await boot(page);
    await anchorEven(page);
  });
  test.afterEach(async ({ page }) => { page.removeAllListeners(); });

  test('the goals card is on Today and starts empty', async ({ page }) => {
    await expect(page.locator('#goalsCard')).toBeVisible();
    await expect(page.locator('#goalsCard')).toContainText('МОИ ЦЕЛИ ДНЯ');
    await expect(page.locator('#goalsCard')).toContainText('Выбери 2–3 главных дела');
    expect(await goals(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('pick from the schedule, reorder, remove and cap at three', async ({ page }) => {
    const chips = page.locator('#goalsCard .goal-chip');
    expect(await chips.count()).toBeGreaterThan(2);
    await chips.nth(0).click();
    await chips.nth(0).click();   // the list re-renders, first chip is now the next task
    await chips.nth(0).click();
    await page.waitForTimeout(200);
    let g = await goals(page);
    expect(g.length).toBe(3);
    await expect(page.locator('#goalsCard')).toContainText('Три цели — достаточно');

    /* priority reorder: move the second goal up */
    const second = g[1].id;
    await page.click(`#goalsCard [data-goal="up"][data-id="${second}"]`);
    await page.waitForTimeout(150);
    g = await goals(page);
    expect(g[0].id).toBe(second);

    /* remove the first goal */
    await page.click(`#goalsCard [data-goal="remove"][data-id="${g[0].id}"]`);
    await page.waitForTimeout(150);
    expect((await goals(page)).length).toBe(2);
    expect(errors).toEqual([]);
  });

  test('a custom goal is added, completed, survives reload and is escaped', async ({ page }) => {
    await page.click('#goalsCard [data-goal="custom"]');
    await page.fill('#goalCustomInput', '<img src=x onerror="window.__xss=1">');
    await page.click('#goalsCard [data-goal="save"]');
    await page.waitForTimeout(200);
    let g = await goals(page);
    expect(g.length).toBe(1);
    expect(g[0].taskId).toBe(null);
    /* XSS must be inert: rendered as text, no injected element, no handler ran */
    expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    await expect(page.locator('#goalsCard .goal-text')).toContainText('<img src=x');

    /* completing a custom goal writes the canonical S.done map */
    const id = g[0].id;
    await page.check(`#goalsCard input.task-check[data-id="${id}"]`);
    await page.waitForTimeout(200);
    expect(await page.evaluate(i => !!S.done[ui.date][i], id)).toBe(true);

    /* survives a reload. ui.date resets to the real today() on boot, so re-open
       the fixed test date before reading the goal back. */
    await page.reload();
    await page.waitForSelector('#app');
    await page.waitForTimeout(300);
    await page.evaluate(() => { ui.date = '2026-11-16'; render(); });
    await page.waitForTimeout(200);
    g = await goals(page);
    expect(g.length).toBe(1);
    expect(await page.evaluate(i => !!S.done[ui.date][i], id)).toBe(true);
    expect(await page.locator(`#goalsCard input.task-check[data-id="${id}"]`).isChecked()).toBe(true);
    expect(errors).toEqual([]);
  });

  test('a goal linked to a schedule task shares its completion mark', async ({ page }) => {
    /* show past rows so the linked schedule row is definitely rendered for the check */
    await page.evaluate(() => { ui.showPast = true; persist(); render(); });
    await page.waitForTimeout(150);
    /* pick the first candidate: it is a real task of the day */
    const taskId = await page.evaluate(() => {
      const chip = document.querySelector('#goalsCard .goal-chip');
      return chip ? chip.dataset.id : null;
    });
    expect(taskId).not.toBeNull();
    await page.click(`#goalsCard .goal-chip[data-id="${taskId}"]`);
    await page.waitForTimeout(150);
    const rowSel = `.task-row input.task-check[data-id="${taskId}"]`;
    await expect(page.locator(rowSel)).toHaveCount(1);
    /* mark the goal done -> the same S.done entry the schedule row uses */
    await page.check(`#goalsCard input.task-check[data-id="${taskId}"]`);
    await page.waitForTimeout(200);
    expect(await page.evaluate(id => !!S.done[ui.date][id], taskId)).toBe(true);
    /* unchecking the schedule row clears the goal too */
    await page.uncheck(rowSel);
    await page.waitForTimeout(200);
    expect(await page.evaluate(id => !!S.done[ui.date][id], taskId)).toBe(false);
    expect(await page.locator(`#goalsCard input.task-check[data-id="${taskId}"]`).isChecked()).toBe(false);
    expect(errors).toEqual([]);
  });

  test('goals are per-day and the card never overflows on iPhone widths', async ({ page }) => {
    await page.click('#goalsCard .goal-chip');
    await page.waitForTimeout(150);
    const todayGoals = (await goals(page)).length;
    expect(todayGoals).toBe(1);
    await page.evaluate(() => { ui.date = '2026-11-17'; persist(); render(); });
    await page.waitForTimeout(200);
    expect((await goals(page)).length).toBe(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.body.clientWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);
  });
});
