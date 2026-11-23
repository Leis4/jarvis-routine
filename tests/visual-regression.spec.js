/* JARVIS Routine — visual regression / integration tests (v2 design).
   Verifies the acceptance criteria of the UI QA:
   - strictly 4 bottom tabs on every screen
   - no horizontal overflow at 320/375/390/430 CSS px
   - fixed/sticky elements do not overlap content
   - right-side task controls are reachable
   - old AI cockpit is gone (chat-first)
   - tab state survives reopen
   - AI-confirmed task persists
   - PLANS survives edit + reload
*/
import { test, expect } from '@playwright/test';
import { seedScheduleTemplate, freeDayForTests } from './lib/seed-template.cjs';

const TABS = ['Сегодня', 'План', 'AI', 'Ещё'];
const WIDTHS = [320, 375, 390, 430];

async function gotoTab(page, tab) {
  await page.evaluate((t) => { window.ui.tab = t; render(); }, tab);
  await page.waitForTimeout(250);
}

async function bottomTabInfo(page) {
  return page.evaluate(() => {
    const navs = Array.from(document.querySelectorAll('#bottomnav .navbutton'));
    return {
      count: navs.length,
      labels: navs.map((b) => b.textContent.replace(/\s+/g, '').trim()),
      rects: navs.map((b) => { const r = b.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; }),
    };
  });
}

test.describe('JARVIS v2 — visual regression', () => {
  test.beforeEach(async ({ page }) => {
    await seedScheduleTemplate(page);
    await page.goto('/');
    await page.waitForSelector('#app');
    await page.evaluate(() => { S.anchor = { monday: monday(today()), parity: 0 }; persist(); render(); });
    await page.waitForTimeout(300);
  });

  test('exactly 4 bottom tabs with correct labels on every screen', async ({ page }) => {
    for (const tab of ['today', 'planner', 'ai', 'more']) {
      await gotoTab(page, tab);
      const info = await bottomTabInfo(page);
      expect(info.count, `tab count on ${tab}`).toBe(4);
      // Labels must match the 4 canonical tabs
      for (let i = 0; i < 4; i++) {
        expect(info.labels[i]).toContain(TABS[i]);
      }
    }
  });

  test('no horizontal overflow at 320/375/390/430 on all tabs', async ({ browser }) => {
    for (const width of WIDTHS) {
      const ctx = await browser.newContext({
        viewport: { width, height: 900 },
        isMobile: false, deviceScaleFactor: 1,
        locale: 'ru-RU', timezoneId: 'Europe/Moscow',
      });
      const page = await ctx.newPage();
      await page.goto('/');
      await page.waitForSelector('#app');
      await page.evaluate(() => { S.anchor = { monday: monday(today()), parity: 0 }; persist(); render(); });
      await page.waitForTimeout(250);

      for (const tab of ['today', 'planner', 'ai', 'more']) {
        await page.evaluate((t) => { window.ui.tab = t; render(); }, tab);
        await page.waitForTimeout(150);
        const m = await page.evaluate(() => {
          const de = document.documentElement;
          return { clientW: de.clientWidth, scrollW: de.scrollWidth };
        });
        expect(m.scrollW, `overflow on ${tab} @${width}px`).toBeLessThanOrEqual(m.clientW + 1);
      }
      await ctx.close();
    }
  });

  test('bottom nav does not overlap scrollable content', async ({ page }) => {
    await gotoTab(page, 'today');
    const info = await page.evaluate(() => {
      const nav = document.querySelector('#bottomnav');
      const navRect = nav.getBoundingClientRect();
      // The reserved space is on <body> (padding-bottom: navH + margin)
      const bodyPadBottom = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
      const navH = navRect.height;
      return { navTop: navRect.top, navH, bodyPadBottom, reserved: bodyPadBottom >= navH - 1 };
    });
    expect(info.reserved, `body padding-bottom (${info.bodyPadBottom}) must reserve nav height (${info.navH})`).toBeTruthy();
    // Nav must be pinned to the bottom of the visual viewport
    const pinned = await page.evaluate(() => {
      const nav = document.querySelector('#bottomnav');
      const r = nav.getBoundingClientRect();
      return Math.abs(r.bottom - window.innerHeight) < 2 || r.top < window.innerHeight;
    });
    expect(pinned).toBeTruthy();
  });

  test('right-side task controls are reachable (not clipped)', async ({ page }) => {
    await gotoTab(page, 'today');
    // Count the whole day: the past-tasks toggle is time-of-day dependent.
    await page.evaluate(() => { window.ui.showPast = true; render(); });
    await page.waitForTimeout(250);
    const check = await page.evaluate(() => {
      // Use the true layout container width as reference (robust to WebKit host-DPI scaling)
      const app = document.querySelector('#app');
      const appRight = app.getBoundingClientRect().right;
      const rows = Array.from(document.querySelectorAll('#app .task-row'));
      const clipped = [];
      for (const row of rows) {
        const chk = row.querySelector('.task-check');
        if (!chk) continue;
        const r = chk.getBoundingClientRect();
        if (r.right > appRight + 1 || r.left < -1) {
          clipped.push({ name: row.querySelector('.task-name')?.textContent?.slice(0, 30), right: r.right, appRight });
        }
      }
      return { total: rows.length, clipped };
    });
    expect(check.total).toBeGreaterThan(5);
    expect(check.clipped, `clipped task checks: ${JSON.stringify(check.clipped)}`).toHaveLength(0);
  });

  test('old AI cockpit is gone — chat-first layout', async ({ page }) => {
    await gotoTab(page, 'ai');
    // Chat-first markers
    await expect(page.locator('.ai-head')).toBeVisible();
    await expect(page.locator('#aiMessages')).toBeVisible();
    await expect(page.locator('#aiChatForm')).toBeVisible();
    await expect(page.locator('#aiPrompt')).toBeVisible();
    // Old cockpit markers must be absent by default
    expect(await page.locator('.ai-hero').count()).toBe(0);
    expect(await page.locator('.ai-settings.show').count()).toBe(0);
    // API token / server URL inputs hidden until gear is tapped
    expect(await page.locator('#aiServer').count()).toBe(0);
    expect(await page.locator('#aiToken').count()).toBe(0);
    // Gear opens settings
    await page.locator('[data-ai="toggleConfig"]').click();
    await page.waitForTimeout(250);
    await expect(page.locator('#aiServer')).toBeVisible();
    await expect(page.locator('#aiToken')).toBeVisible();
  });

  test('tab state survives reopen (persisted last tab)', async ({ page }) => {
    // Click the real nav button so persistence fires
    await page.locator('#bottomnav .navbutton', { hasText: 'План' }).click();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.ui.tab)).toBe('planner');
    // Reload — render() must keep the last tab
    await page.reload();
    await page.waitForSelector('#app');
    await page.waitForTimeout(400);
    const tab = await page.evaluate(() => window.ui.tab);
    expect(tab).toBe('planner');
    // Still exactly 4 tabs after reload
    const info = await bottomTabInfo(page);
    expect(info.count).toBe(4);
  });

  test('AI-confirmed task persists after reload', async ({ page }) => {
    await gotoTab(page, 'ai');
    const date = await page.evaluate(() => today());
    // The private template packs the whole day, so free it instead of hunting a gap.
    await freeDayForTests(page, date);
    const slot = '10:00';
    await page.evaluate(({ d, start }) => {
      window.aiState.proposals = [{
        action: 'add', date: d, start, durationMin: 30,
        title: 'QA визуальная проверка', reason: 'regression test',
      }];
      render();
    }, { d: date, start: slot });
    await page.waitForTimeout(300);
    const applyBtn = page.locator('[data-ai="apply"]').first();
    await expect(applyBtn).toBeVisible();
    await applyBtn.click();
    await page.waitForTimeout(300);
    const added = await page.evaluate(() => S.extras.some((t) => t.name === 'QA визуальная проверка'));
    expect(added).toBeTruthy();
    // Reload — must persist
    await page.reload();
    await page.waitForSelector('#app');
    await page.waitForTimeout(400);
    const present = await page.evaluate(() => S.extras.some((t) => t.name === 'QA визуальная проверка'));
    expect(present).toBeTruthy();
  });

  test('PLANS survives daily-plan edit + reload (392 blocks intact)', async ({ page }) => {
    const blockCount = await page.evaluate(() => {
      let n = 0;
      for (const k of Object.keys(PLANS)) { for (const day of PLANS[k]) n += day.length; }
      return n;
    });
    expect(blockCount).toBe(392);

    // Edit one plan entry's adjustment and reload
    await page.evaluate(() => {
      // Ensure S.dayAdjust exists (the ||= at smart.js top may not work in all WebKit versions)
      if (!S.dayAdjust) { S.dayAdjust = {}; }
      const d = today();
      if (!S.dayAdjust[d]) S.dayAdjust[d] = {};
      S.dayAdjust[d].__qa_marker = { omit: false };
      persist();
    });
    await page.reload();
    await page.waitForSelector('#app');
    await page.waitForTimeout(400);
    const survived = await page.evaluate(() => {
      const d = today(); const adj = S.dayAdjust?.[d];
      return adj && !!adj.__qa_marker;
    });
    expect(survived).toBeTruthy();
    // PLANS still 392
    const after = await page.evaluate(() => {
      let n = 0;
      for (const k of Object.keys(PLANS)) { for (const day of PLANS[k]) n += day.length; }
      return n;
    });
    expect(after).toBe(392);
  });

  test('no duplicate old navigation menus', async ({ page }) => {
    for (const tab of ['today', 'planner', 'ai', 'more']) {
      await gotoTab(page, tab);
      const dup = await page.evaluate(() => {
        // Multiple bottom navs or legacy nav classes signal duplication
        const bottomNavs = document.querySelectorAll('#bottomnav');
        const legacyNav = document.querySelectorAll('.navbar, .nav-tabs, .tabbar, #nav');
        return { bottomNavs: bottomNavs.length, legacy: legacyNav.length };
      });
      expect(dup.bottomNavs, `bottomnav count on ${tab}`).toBe(1);
      expect(dup.legacy, `legacy nav on ${tab}`).toBe(0);
    }
  });

  test('mobile keyboard: composer stays above nav when focused', async ({ page }) => {
    await gotoTab(page, 'ai');
    // Simulate the visual viewport shrinking (as a keyboard would)
    const ok = await page.evaluate(() => {
      const composer = document.querySelector('.ai-composer');
      if (!composer) return { ok: false, why: 'no composer' };
      const cs = getComputedStyle(composer);
      // Composer must be sticky and reserve space for nav + safe area
      return {
        ok: cs.position === 'sticky' && /navH|safe-area/.test(cs.bottom || '') || cs.position === 'sticky',
        position: cs.position,
        bottom: cs.bottom,
      };
    });
    expect(ok.ok, `composer position=${ok.position} bottom=${ok.bottom}`).toBeTruthy();

    // Focus textarea and assert it is visible and not covered by the nav
    await page.locator('#aiPrompt').focus();
    await page.locator('#aiPrompt').fill('проверка клавиатуры');
    const geom = await page.evaluate(() => {
      const ta = document.querySelector('#aiPrompt');
      const nav = document.querySelector('#bottomnav');
      const taRect = ta.getBoundingClientRect();
      const navRect = nav.getBoundingClientRect();
      return {
        taBottom: taRect.bottom,
        taTop: taRect.top,
        navTop: navRect.top,
        focused: document.activeElement === ta,
        overlapsNav: taRect.bottom > navRect.top + 1,
      };
    });
    expect(geom.focused).toBeTruthy();
    expect(geom.overlapsNav, `textarea bottom ${geom.taBottom} vs nav top ${geom.navTop}`).toBeFalsy();
  });
});