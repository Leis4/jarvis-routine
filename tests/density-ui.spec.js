/* JARVIS v43.3 — compact / detailed schedule density (iPhone WebKit).
   The density is a saved UI preference only: it never touches schedule or marks. */
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

async function openToday(page) {
  await page.evaluate(() => { const t = today(); S.anchor = { monday: monday(t), parity: 0 }; ui.date = t; ui.tab = 'today'; persist(); render(); });
  await page.waitForTimeout(250);
}

test.describe('JARVIS v43.3 schedule density', () => {
  let errors;
  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await boot(page);
    await openToday(page);
  });
  test.afterEach(async ({ page }) => { page.removeAllListeners(); });

  test('toggles between detailed and compact rows, and the choice survives reload', async ({ page }) => {
    const rows = page.locator('#app .task-row');
    expect(await rows.count()).toBeGreaterThan(0);
    const first = rows.first();

    /* detailed (default): the category/note subline is visible, no condensed rows */
    await expect(page.locator('[data-action="toggleDensity"]')).toBeVisible();
    await expect(page.locator('[data-action="toggleDensity"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.task-row.condensed')).toHaveCount(0);
    await expect(first.locator('.task-name small')).toBeVisible();

    /* compact: rows gain .condensed and the subline is hidden */
    await page.click('[data-action="toggleDensity"]');
    await page.waitForTimeout(200);
    await expect(page.locator('[data-action="toggleDensity"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.locator('.task-row.condensed').count()).toBe(await rows.count());
    await expect(rows.first().locator('.task-name small')).toBeHidden();

    /* the preference is persisted, schedule data is untouched */
    await page.reload();
    await page.waitForSelector('#app');
    await page.waitForTimeout(400);
    await expect(page.locator('.task-row.condensed').first()).toBeVisible();
    await expect(page.locator('[data-action="toggleDensity"]')).toHaveAttribute('aria-pressed', 'true');

    /* toggling back restores the detailed view */
    await page.click('[data-action="toggleDensity"]');
    await page.waitForTimeout(200);
    await expect(page.locator('.task-row.condensed')).toHaveCount(0);
    await expect(page.locator('#app .task-row').first().locator('.task-name small')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('the density toggle itself never overflows on iPhone widths', async ({ page }) => {
    for (const mode of ['detailed', 'compact']) {
      await page.evaluate(m => { ui.density = m; render(); }, mode);
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.body.clientWidth);
      expect(overflow).toBeLessThanOrEqual(2);
    }
    expect(errors).toEqual([]);
  });
});
