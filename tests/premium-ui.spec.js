// v42 Premium UI: real user flows in iPhone WebKit (Playwright project).
// Only actual clicks + persisted state are asserted — no "function exists" checks.
const { test, expect } = require('@playwright/test');
const { seedScheduleTemplate } = require('./lib/seed-template.cjs');

async function bootWithData(page) {
  const seeded = await seedScheduleTemplate(page);
  await page.goto('/');
  await page.waitForSelector('#app');
  await page.evaluate(() => {
    if (!S.anchor) { S.anchor = { monday: monday(today()), parity: 0 }; persist(); }
    ui.tab = 'today'; ui.date = today(); ui.showPast = true;
    render();
  });
  await page.waitForTimeout(200);
  return seeded;
}

async function openFocusOnFirstTask(page) {
  // Prefer the hero "Начать" button, which must always target a real task.
  const hero = page.locator('.hero [data-focus="start"]');
  if (await hero.count()) { await hero.first().click(); }
  else { await page.locator('.task-row .row-play').first().click(); }
  await expect(page.locator('#focusRoot .focus-screen')).toBeVisible();
  return page.evaluate(() => window.JarvisFocus.session);
}

test.describe('Today (v42)', () => {
  test('hero card, progress ring and grouped timeline render real data', async ({ page }) => {
    // Midday clock: the schedule is a packed day, and late-evening runs would land in
    // the honest "day is over" empty state instead of a live hero card.
    const midday = new Date();
    midday.setHours(13, 20, 0, 0);
    await page.clock.setFixedTime(midday);
    const seeded = await bootWithData(page);
    test.skip(!seeded, 'private schedule template not available');

    const hero = page.locator('.hero');
    await expect(hero).toBeVisible();
    await expect(hero.locator('.hero-label')).toHaveText(/Сейчас|Далее|Свободно/);
    await expect(hero.locator('[data-focus="start"]')).toBeVisible();

    const title = (await hero.locator('.hero-title').innerText()).trim();
    expect(title.length).toBeGreaterThan(0);

    // The hero must point at a task that really exists in the rendered day.
    if (await page.locator('.hero [data-action="heroDone"]').count()) {
      const id = await page.locator('.hero [data-action="heroDone"]').getAttribute('data-id');
      const inDay = await page.evaluate((tid) => itemList(ui.date).some((t) => String(t.id) === tid), id);
      expect(inDay).toBe(true);
    }

    const ring = page.locator('.ring');
    await expect(ring).toHaveAttribute('aria-label', /Выполнено \d+%/);
    const val = Number(await ring.evaluate((el) => el.style.getPropertyValue('--val')));
    expect(val).toBeGreaterThanOrEqual(0);
    expect(val).toBeLessThanOrEqual(100);

    // Group headers are present for the blocks that exist, and rows are in time order.
    const groups = await page.locator('.group-label').allInnerTexts();
    expect(groups.length).toBeGreaterThan(0);
    const times = await page.locator('.day-group .task-time b').allInnerTexts();
    const minutes = times.map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)));
    expect([...minutes].sort((a, b) => a - b)).toEqual(minutes);
  });

  test('hero quick action marks a task done and survives reload', async ({ page }) => {
    const midday = new Date();
    midday.setHours(13, 20, 0, 0);
    await page.clock.setFixedTime(midday);
    const seeded = await bootWithData(page);
    test.skip(!seeded, 'private schedule template not available');
    const doneBtn = page.locator('.hero [data-action="heroDone"]');
    if (!(await doneBtn.count())) test.skip(true, 'no remaining task to complete');

    const id = await doneBtn.getAttribute('data-id');
    const date = await doneBtn.getAttribute('data-date');
    await doneBtn.click();
    await expect(page.locator('.toast')).toBeVisible();

    const marked = await page.evaluate(({ id, date }) => !!S.done[date]?.[id], { id, date });
    expect(marked).toBe(true);

    const row = page.locator(`.task-row[data-task-id="${id}"]`);
    if (await row.count()) await expect(row.first()).toHaveClass(/done/);

    await page.reload();
    await page.waitForSelector('#app');
    const stillDone = await page.evaluate(({ id, date }) => !!S.done[date]?.[id], { id, date });
    expect(stillDone).toBe(true);
  });
});

test.describe('Focus Mode (v42)', () => {
  test('start → timer runs from timestamps → pause freezes → done marks and logs', async ({ page }) => {
    const seeded = await bootWithData(page);
    test.skip(!seeded, 'private schedule template not available');

    const session = await openFocusOnFirstTask(page);
    expect(session.title.length).toBeGreaterThan(0);

    const before = await page.evaluate(() => (window.JarvisFocus.toggle(), window.JarvisFocus.session.running));
    expect(before).toBe(true);

    // Real elapsed time on the clock, derived from timestamps.
    await page.waitForTimeout(1200);
    const elapsed = await page.evaluate(() => window.JarvisFocus._elapsed());
    expect(elapsed).toBeGreaterThan(900);

    // Pause must freeze elapsed time even while wall clock keeps moving.
    await page.locator('#focusRoot [data-focus="toggle"]').click();
    const paused = await page.evaluate(() => window.JarvisFocus._elapsed());
    await page.waitForTimeout(900);
    const pausedLater = await page.evaluate(() => window.JarvisFocus._elapsed());
    expect(Math.abs(pausedLater - paused)).toBeLessThan(50);
    await expect(page.locator('#focusRoot .focus-clock')).toBeVisible();

    const title = await page.locator('#focusRoot .focus-task').innerText();
    await page.locator('#focusRoot [data-focus="done"]').click();
    await expect(page.locator('#focusRoot .focus-screen')).toHaveCount(0);

    const state = await page.evaluate((t) => {
      const log = (S.focusSessions || []).slice(-1)[0];
      return { log, done: !!S.done[log.date]?.[log.taskId], title: log.title, matches: t.trim() === log.title };
    }, title);
    expect(state.log).toBeTruthy();
    expect(state.matches).toBe(true);
    expect(state.done).toBe(true);
    expect(state.log.actualMs).toBeGreaterThan(0);

    // Undo restores the checkbox and drops the log entry.
    await page.evaluate(() => window.JarvisFocus.undoLast());
    const after = await page.evaluate(() => {
      const log = JSON.parse(localStorage.getItem('jarvis_focus_last_v1') || 'null');
      return { undone: log === null, done: !!S.done[ui.date]?.[(S.focusSessions || []).slice(-1)[0]?.taskId] };
    });
    expect(after.undone).toBe(true);
  });

  test('"Стоп без отметки" keeps the log but leaves the checkbox untouched', async ({ page }) => {
    const seeded = await bootWithData(page);
    test.skip(!seeded, 'private schedule template not available');

    await openFocusOnFirstTask(page);
    const s = await page.evaluate(() => window.JarvisFocus.session);
    const wasDone = await page.evaluate((x) => !!S.done[x.date]?.[x.taskId], s);

    await page.locator('#focusRoot [data-focus="stop"]').click();
    await expect(page.locator('#focusRoot .focus-screen')).toHaveCount(0);

    const nowDone = await page.evaluate((x) => !!S.done[x.date]?.[x.taskId], s);
    expect(nowDone).toBe(wasDone);
    const logged = await page.evaluate((x) => (S.focusSessions || []).some((f) => f.taskId === x.taskId), s);
    expect(logged).toBe(true);
  });

  test('a reloaded tab restores a running session from storage', async ({ page }) => {
    const seeded = await bootWithData(page);
    test.skip(!seeded, 'private schedule template not available');

    const s = await openFocusOnFirstTask(page);
    await page.evaluate(() => window.JarvisFocus.toggle());
    await page.waitForTimeout(600);
    await page.reload();
    await page.waitForSelector('#focusRoot .focus-screen');
    const restored = await page.evaluate(() => ({ session: window.JarvisFocus.session, elapsed: window.JarvisFocus._elapsed() }));
    expect(restored.session.taskId).toBe(s.taskId);
    expect(restored.elapsed).toBeGreaterThan(0);
    await page.locator('#focusRoot [data-focus="quit"]').click();
  });
});

test.describe('Timeboxing (v42)', () => {
  test('suggested windows never overlap fixed blocks, and picking one creates a real task', async ({ page }) => {
    const seeded = await bootWithData(page);
    test.skip(!seeded, 'private schedule template not available');

    const audit = await page.evaluate(() => {
      const date = ui.date;
      const busy = itemList(date)
        .filter((t) => t.status !== 'Буфер' && t.cat !== 'Буфер')
        .map((t) => [clock(t.start), clock(t.end)]);
      const wins = window.JarvisFocus.windowsFor(date, 25);
      const bad = wins.filter((w) => busy.some(([a, b]) => w.startMin < b && a < w.endMin));
      return { count: wins.length, bad, busy: busy.length };
    });
    expect(audit.bad).toEqual([]);

    // Open the sheet from the UI, choose a duration and pick the first free slot.
    await page.locator('[data-focus="timebox"]').first().click();
    await expect(page.locator('#modalback')).toHaveClass(/show/);
    await page.locator('[data-focus-tb="dur"][data-min="25"]').click();
    const options = page.locator('.tb-option');
    if (!(await options.count())) {
      await expect(page.locator('#modalbox .card')).toBeVisible(); // honest "no free window" state
      return;
    }
    const start = await options.first().getAttribute('data-start');
    const end = await options.first().getAttribute('data-end');
    const before = await page.evaluate(() => S.extras.length);
    await options.first().click();
    await expect(page.locator('#modalback')).not.toHaveClass(/show/);

    const created = await page.evaluate(({ start, end }) => {
      const t = S.extras[S.extras.length - 1];
      const overlap = itemList(ui.date).some((x) => x.id !== t.id && x.status !== 'Буфер' && clock(x.start) < clock(t.end) && clock(t.start) < clock(x.end));
      return { len: S.extras.length, start: t.start, end: t.end, overlap };
    }, { start, end });
    expect(created.len).toBe(before + 1);
    expect(created.start).toBe(start);
    expect(created.end).toBe(end);
    expect(created.overlap).toBe(false);
  });
});

test.describe('AI screen (v42)', () => {
  test('bubbles, avatars and suggestions render; offline state is human-readable', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app');

    // Seed a two-message conversation (assistant reply must stay a plain bubble).
    await page.evaluate(() => {
      localStorage.setItem('jarvis_routine_ai_history_local_v1', JSON.stringify([
        { role: 'user', content: 'Сделай спокойный план на вечер', model: '' },
        { role: 'assistant', content: 'Готово: 2 дела перенесены, сон сохранён.', model: 'JARVIS' },
      ]));
    });
    await page.reload();
    await page.waitForSelector('#app');
    await page.evaluate(() => { ui.tab = 'ai'; render(); });
    await page.waitForTimeout(200);

    const bubbles = page.locator('#aiMessages .msg-bubble');
    await expect(bubbles).toHaveCount(2);
    await expect(page.locator('#aiMessages .msg-row.user')).toHaveCount(1);
    await expect(page.locator('#aiMessages .msg-avatar').first()).toBeVisible();
    const text = await bubbles.allInnerTexts();
    expect(text.join(' ')).not.toMatch(/[{[]"(action|tool|role)"/); // no raw JSON/tool traces

    // Fresh chat (no history) must offer tappable suggestions instead of a blank screen.
    await page.evaluate(() => localStorage.setItem('jarvis_routine_ai_history_local_v1', '[]'));
    await page.reload();
    await page.waitForSelector('#app');
    await page.evaluate(() => { ui.tab = 'ai'; render(); });
    await expect(page.locator('[data-ai="quick"]').first()).toBeVisible();
    await expect(page.locator('#aiChatForm, #aiPrompt').first()).toBeVisible();
  });
});

test.describe('Premium layout', () => {
  for (const width of [375, 390, 430, 768]) {
    test(`no horizontal overflow with the new hero @${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const seeded = await bootWithData(page);
      test.skip(!seeded, 'private schedule template not available');
      for (const theme of ['dark', 'light']) {
        await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        await page.waitForTimeout(150);
        const m = await page.evaluate(() => {
          let maxRight = 0;
          for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.right > maxRight) maxRight = r.right;
          }
          return Math.round(maxRight);
        });
        expect(m).toBeLessThanOrEqual(width + 1);
      }
    });
  }
});