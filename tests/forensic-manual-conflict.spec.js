import { test, expect } from '@playwright/test';
import { seedScheduleTemplate } from './lib/seed-template.cjs';

// Regression for DOM clobbering: taskform contains <input name="id">, which
// shadows form.id. The submit guard must use getAttribute('id'), not form.id.
test('Manual conflicting task is rejected before any local persistence', async ({page}) => {
  await seedScheduleTemplate(page);
  await page.goto('/');
  await page.evaluate(() => {
    ui.date = '2026-11-15';
    ui.week = monday(ui.date);
    ui.tab = 'planner';
    render();
  });
  await page.locator('[data-action="new"]').first().click();
  const form = page.locator('#taskform');
  await form.locator('input[name="name"]').fill('FORENSIC_TEST_CONFLICT');
  await form.locator('input[name="start"]').fill('19:00');
  await form.locator('input[name="end"]').fill('19:30');
  await form.locator('button[type="submit"]').first().click();
  await expect(form.locator('#taskConflictWarning')).toContainText('Время уже занято');
  expect(await page.evaluate(() => S.extras.some(t => t.name === 'FORENSIC_TEST_CONFLICT'))).toBe(false);
});
