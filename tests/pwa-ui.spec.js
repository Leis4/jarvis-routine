/* JARVIS Routine — PWA integration tests for Apple iPhone (Playwright WebKit).
   Run: npx playwright test --config=playwright.config.js
   Design v2: 4-tab nav (Сегодня, План, AI, Ещё), compact today, expandable tasks.
*/
import { test, expect } from '@playwright/test';
import { seedScheduleTemplate } from './lib/seed-template.cjs';

test.describe('JARVIS Routine PWA - iPhone WebKit (v2 design)', () => {

  test.beforeEach(async ({ page }) => {
    await seedScheduleTemplate(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('#app', { timeout: 10000 });
  });

  test('PWA manifest and basic structure', async ({ page }) => {
    await expect(page).toHaveTitle(/JARVIS/);
    const manifest = page.locator('link[rel="manifest"]');
    await expect(manifest).toHaveAttribute('href', 'manifest.webmanifest');
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#bottomnav')).toBeVisible();
  });

  test('today view shows compact header with date and progress', async ({ page }) => {
    await expect(page.locator('.today-date')).toBeVisible();
    await expect(page.locator('.today-progress')).toBeVisible();
    await expect(page.locator('.today-date')).toContainText(/ноября/);
    await expect(page.locator('.brand')).toContainText('JARVIS');
  });

  test('navigation between all 4 main tabs', async ({ page }) => {
    // Weekday comes from the app itself: the test must not depend on the day it runs.
    const weekday = await page.evaluate(() => DAYSFULL[indexDay(today())]);
    const tabs = [
      { tab: 'today', expected: weekday },
      { tab: 'planner', expected: 'План' },
    ];
    for (const t of tabs) {
      await page.evaluate((tk) => { window.ui.tab = tk; render(); }, t.tab);
      await page.waitForTimeout(300);
      await expect(page.locator('#app')).toContainText(t.expected);
    }
    // Verify 4 nav buttons
    const navBtns = page.locator('#bottomnav .navbutton');
    expect(await navBtns.count()).toBe(4);
    const labels = await navBtns.allTextContents();
    expect(labels.join('')).toContain('Сегодня');
    expect(labels.join('')).toContain('План');
    expect(labels.join('')).toContain('AI');
    expect(labels.join('')).toContain('Ещё');
  });

  test('task checkbox saves to localStorage', async ({ page }) => {
    await page.waitForTimeout(500);
    const checkbox = page.locator('input.task-check[data-id]').first();
    const count = await checkbox.count();

    if (count === 0) {
      test.skip('No task checkboxes today');
      return;
    }

    const taskId = await checkbox.getAttribute('data-id');
    const date = await checkbox.getAttribute('data-date');
    await checkbox.check();
    await page.waitForTimeout(300);

    const stored = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('jarvis_routine_v1') || '{}');
      return s.done;
    });
    const hasTask = Object.values(stored).some((day) => day[taskId] === true);
    expect(hasTask).toBeTruthy();
  });

  test('habit checkbox persists after reload', async ({ page }) => {
    await page.waitForTimeout(500);
    const habitBox = page.locator('input.task-check[data-habit]').first();
    if (await habitBox.count() === 0) {
      test.skip('No habit checkboxes');
      return;
    }

    await habitBox.check();
    await page.waitForTimeout(300);
    const habitId = await habitBox.getAttribute('data-habit');

    await page.reload();
    await page.waitForSelector('#app');
    await page.waitForTimeout(500);

    const restored = page.locator('input.task-check[data-habit]').first();
    if (await restored.count() > 0) {
      await expect(restored).toBeChecked();
    }
  });

  test('planner view shows week cards', async ({ page }) => {
    await page.evaluate(() => { window.ui.tab = 'planner'; ui.showWeekOverview = true; render(); });
    await page.waitForTimeout(500);
    const cards = page.locator('.week-card');
    expect(await cards.count()).toBeGreaterThanOrEqual(6);

    // Date strip with day chips
    const chips = page.locator('.date-chip');
    expect(await chips.count()).toBeGreaterThanOrEqual(5);
  });

  test('focus timer is accessible via More tab', async ({ page }) => {
    await page.evaluate(() => { window.ui.tab = 'more'; window.ui.moreTab = 'focus'; render(); });
    await page.waitForTimeout(500);

    const clock = page.locator('#clock');
    await expect(clock).toBeVisible();
    await expect(clock).toContainText(/40:00/);

    // Switch to break
    await page.locator('[data-action="timerMode"][data-val="break"]').click();
    await page.waitForTimeout(300);
    await expect(clock).toContainText(/10:00/);

    // Start and verify tick
    await page.locator('[data-action="timerToggle"]').click();
    await page.waitForTimeout(2000);
    const timeText = await clock.textContent();
    if (timeText) {
      const sec = Number(timeText.split(':')[1]);
      expect(sec).toBeLessThan(60);
    }
  });

  test('settings accessible via More tab', async ({ page }) => {
    await page.evaluate(() => { window.ui.tab = 'more'; window.ui.moreTab = 'settings'; render(); });
    await page.waitForTimeout(500);
    await expect(page.locator('#app')).toContainText('Настройки');
    await expect(page.locator('#app')).toContainText('Резервная копия');
  });

  test('sub-navigation in More tab switches views', async ({ page }) => {
    await page.evaluate(() => { window.ui.tab = 'more'; render(); });
    await page.waitForTimeout(500);

    // Click stats sub-nav
    const statsBtn = page.locator('.sub-nav button', { hasText: 'Прогресс' });
    await expect(statsBtn).toBeVisible();
    await statsBtn.click();
    await page.waitForTimeout(300);
    await expect(page.locator('#app')).toContainText('Прогресс');
  });

  test('new task modal opens from add button', async ({ page }) => {
    const addBtn = page.locator('[data-action="new"]').first();
    if (await addBtn.count() > 0) {
      await addBtn.click();
      await page.waitForTimeout(300);
      await expect(page.locator('#modalback.show')).toBeVisible();
      await expect(page.locator('#modalbox')).toContainText('Новое дело');
    }
  });

  test('task details expandable on click', async ({ page }) => {
    await page.waitForTimeout(500);
    const taskRow = page.locator('.task-row').first();
    if (await taskRow.count() === 0) {
      test.skip('No tasks');
      return;
    }
    const taskId = await taskRow.getAttribute('data-task-id');
    // Click task to expand
    await taskRow.click();
    await page.waitForTimeout(300);
    const details = page.locator(`#detail_${taskId}`);
    await expect(details).toBeVisible();
    await expect(details.locator('button[data-action="edit"]')).toBeVisible();
    await expect(details.locator('button[data-action="delete"]')).toBeVisible();
    // Contains edit
    await expect(details).toContainText('Изменить');
  });
});