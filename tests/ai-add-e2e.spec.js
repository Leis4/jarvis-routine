/* JARVIS Routine — AI-add bug E2E data path trace
   Data path: inject proposal → confirm → localStorage → DOM → reload → persist
   AI state exposed via window.aiState; ui via window.ui.
   Default filter is 'all' — AI tasks with status 'План' are visible.
   'main' filter still shows only 'Обязательно' tasks.
   v2 design: tasks use .task-row class instead of .task
*/
import { test, expect } from '@playwright/test';
import { seedScheduleTemplate, freeDayForTests } from './lib/seed-template.cjs';

test.describe('AI-Add Task - Data Path Verification', () => {

  test.beforeEach(async ({ page }) => {
    await seedScheduleTemplate(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector('#app', { timeout: 10000 });
    // The private template day is fully packed: free it so AI-add has a valid slot.
    // Trust the app's own day boundary (calendar-nav owns `today`), not a local guess:
    // between 00:00 and 04:00 the calendar day and the logical schedule day differ.
    const day = await page.evaluate(() => today());
    await freeDayForTests(page, day);
  });

  async function injectProposal(page, title, start, durationMin, cat, reason) {
    const today = await page.evaluate(() => window.today());
    await page.evaluate(({ date, title, start, durationMin, cat, reason }) => {
      window.ui.tab = 'ai';
      (typeof render === 'function' ? render : window.ui.render)();
      window.aiState.proposals.push({
        action: 'add', title, date, start, durationMin, cat, reason
      });
      window.aiState.status = '';
      render();
    }, { date: today, title, start, durationMin, cat, reason });
    await page.waitForTimeout(300);
    return today;
  }

  async function switchToTodayView(page, filter) {
    await page.evaluate((f) => {
      window.ui.tab = 'today';
      window.ui.filter = f;
      // Task times here are fixed clock values; keep past rows visible regardless of run time.
      window.ui.showPast = true;
      render();
    }, filter || 'all');
    await page.waitForTimeout(500);
  }

  test('T1: Inject proposal → confirm → task appears in localStorage', async ({ page }) => {
    await injectProposal(page, 'Убрать стол', '18:00', 15, 'Быт', 'Уборка');
    await expect(page.locator('#app')).toContainText('Убрать стол');
    await expect(page.locator('[data-ai="apply"]')).toBeVisible();

    await page.locator('[data-ai="apply"]').click();
    await page.waitForTimeout(300);

    const stored = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('jarvis_routine_v1') || '{}');
      return (s.extras || []).filter(t => t.name === 'Убрать стол');
    });
    expect(stored.length).toBe(1);
    expect(stored[0]).toMatchObject({
      name: 'Убрать стол',
      start: '18:00',
      end: '18:15',
      cat: 'Быт',
    });
    expect(stored[0].id).toMatch(/^x_ai_/);
    expect(stored[0].fromDate).toBeTruthy();
    expect(stored[0].status).toBe('План');
  });

  test('T2: AI task appears with default "all" filter', async ({ page }) => {
    await injectProposal(page, 'Убрать стол', '18:00', 15, 'Быт', 'Уборка');
    await page.locator('[data-ai="apply"]').click();
    await page.waitForTimeout(300);

    await switchToTodayView(page, 'all');
    const taskEl = page.locator('.task-row', { hasText: 'Убрать стол' });
    await expect(taskEl.first()).toBeVisible();
    await expect(taskEl.first()).toContainText('18:00');
    await expect(taskEl.first()).toContainText('18:15');
  });

  test('T3: AI task is NOT visible with "main" filter (only Обязательно)', async ({ page }) => {
    await injectProposal(page, 'Убрать стол', '18:00', 15, 'Быт', 'Уборка');
    await page.locator('[data-ai="apply"]').click();
    await page.waitForTimeout(300);

    await switchToTodayView(page, 'main');
    const taskEl = page.locator('.task-row', { hasText: 'Убрать стол' });
    await expect(taskEl).toHaveCount(0);

    const inData = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('jarvis_routine_v1') || '{}');
      return (s.extras || []).some(t => t.name === 'Убрать стол');
    });
    expect(inData).toBe(true);
  });

  test('T4: AI task with status "План" is shown in "other" filter', async ({ page }) => {
    await injectProposal(page, 'Убрать стол', '18:00', 15, 'Быт', 'Уборка');
    await page.locator('[data-ai="apply"]').click();
    await page.waitForTimeout(300);

    await switchToTodayView(page, 'other');
    const taskEl = page.locator('.task-row', { hasText: 'Убрать стол' });
    await expect(taskEl.first()).toBeVisible();
  });

  test('T5: AI task persists after page reload', async ({ page }) => {
    await injectProposal(page, 'Убрать стол', '18:00', 15, 'Быт', 'Уборка');
    await page.locator('[data-ai="apply"]').click();
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForSelector('#app');
    await page.waitForTimeout(500);

    const stored = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('jarvis_routine_v1') || '{}');
      return (s.extras || []).filter(t => t.name === 'Убрать стол');
    });
    expect(stored.length).toBe(1);

    await switchToTodayView(page, 'all');
    await expect(page.locator('.task-row', { hasText: 'Убрать стол' }).first()).toBeVisible();
  });

  test('T6: AI task has correct time slot (start + duration = end)', async ({ page }) => {
    await injectProposal(page, 'Важный созвон', '14:30', 45, 'Организация', 'Встреча');
    await page.locator('[data-ai="apply"]').click();
    await page.waitForTimeout(300);

    await switchToTodayView(page, 'all');
    const taskEl = page.locator('.task-row', { hasText: 'Важный созвон' }).first();
    await expect(taskEl).toContainText('14:30');
    await expect(taskEl).toContainText('15:15');
  });

  test('T7: Rejected proposal does NOT save anything', async ({ page }) => {
    await injectProposal(page, 'Ненужная задача', '12:00', 20, 'Быт', 'Тест');
    await page.locator('[data-ai="reject"]').first().click();
    await page.waitForTimeout(300);

    const stored = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('jarvis_routine_v1') || '{}');
      return (s.extras || []).filter(t => t.name === 'Ненужная задача');
    });
    expect(stored.length).toBe(0);

    await switchToTodayView(page, 'all');
    await expect(page.locator('.task-row', { hasText: 'Ненужная задача' })).toHaveCount(0);
  });

  test('T8: crypto.randomUUID() availability', async ({ page }) => {
    const result = await page.evaluate(() => {
      try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
          return 'ok:' + crypto.randomUUID();
        return 'unavailable';
      } catch (e) { return 'error:' + e.message; }
    });
    console.log(`  🔐 crypto.randomUUID: ${result}`);
    expect(result.startsWith('ok:')).toBe(true);
  });

  test('T9: Multiple AI-add tasks on same day all appear', async ({ page }) => {
    await page.evaluate(() => {
      window.ui.tab = 'ai'; render();
      const date = today();
      window.aiState.proposals.push(
        { action:'add', title:'Дело А', date, start:'10:00', durationMin:30, cat:'Организация', reason:'Тест' },
        { action:'add', title:'Дело Б', date, start:'11:00', durationMin:20, cat:'Код', reason:'Тест' }
      );
      render();
    });
    await page.waitForTimeout(300);
    const btns = page.locator('[data-ai="apply"]');
    expect(await btns.count()).toBe(2);

    await btns.nth(0).click();
    await page.waitForTimeout(200);
    await btns.nth(0).click();
    await page.waitForTimeout(200);

    const stored = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('jarvis_routine_v1') || '{}');
      return (s.extras || []).map(t => t.name).sort();
    });
    expect(stored).toContain('Дело А');
    expect(stored).toContain('Дело Б');

    await switchToTodayView(page, 'all');
    await expect(page.locator('.task-row', { hasText: 'Дело А' }).first()).toBeVisible();
    await expect(page.locator('.task-row', { hasText: 'Дело Б' }).first()).toBeVisible();
  });

  test('T10: Explicitly required AI task appears in "main" filter', async ({ page }) => {
    const today = await page.evaluate(() => window.today());
    await page.evaluate((date) => {
      const s = JSON.parse(localStorage.getItem('jarvis_routine_v1') || '{}');
      s.extras = s.extras || [];
      s.extras.push({
        id: 'x_test_required',
        name: 'Обязательное AI-дело',
        start: '16:00',
        end: '16:30',
        cat: 'Код',
        status: 'Обязательно',
        note: 'AI: срочно',
        fromDate: date,
        repeat: 'once'
      });
      localStorage.setItem('jarvis_routine_v1', JSON.stringify(s));
      window.ui.date = date;
    }, today);
    await page.reload();
    await page.waitForSelector('#app');
    await page.waitForTimeout(500);

    await switchToTodayView(page, 'main');
    await expect(page.locator('.task-row', { hasText: 'Обязательное AI-дело' }).first()).toBeVisible();
  });
});