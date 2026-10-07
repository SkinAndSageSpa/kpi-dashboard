/**
 * probe-audit.js — READ-ONLY. Prints the full September BI Sales report as the
 * dashboard fetches it for the Esti column, plus the unfiltered report, so the
 * per-staff rows can be checked against a manual run in Mangomint.
 */

const { chromium } = require('playwright');

const ESTI = [34, 85, 1, 89, 87, 6, 79, 63];

function parseCookies(raw) {
  return JSON.parse(raw).map(c => ({
    name: c.name, value: c.value,
    domain: c.domain || '.mangomint.com', path: c.path || '/',
    httpOnly: c.httpOnly || false, secure: c.secure !== false, sameSite: 'Lax',
    ...(c.expirationDate ? { expires: Math.floor(c.expirationDate) } : {}),
  }));
}

async function settle(page, extra = 3000) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(extra);
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US', timezoneId: 'America/Los_Angeles',
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  await context.addCookies(parseCookies(process.env.SKINSAGE_MANGOMINT_COOKIES));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const base = 'https://app.mangomint.com/560372';

  await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 4000);
  await page.keyboard.press('Escape');
  await page.getByText('Business Intelligence: Sales', { exact: true }).first().click();
  await settle(page, 3000);
  const trigger = page.locator('[class*="staffSelectorTriggerBtn"]').first();
  await trigger.click(); await page.waitForTimeout(800);
  await page.getByText('Select all', { exact: true }).last().click(); await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 7000);
  const frame = page.frames().find(f => f.url().includes('/reports/business-intelligence/sales') && f.url().includes('/html'));
  const u = new URL(frame.url());
  const baseSettings = JSON.parse(u.searchParams.get('settings'));

  const run = async (title, overrides) => {
    const st = { ...baseSettings, timePeriodStart: '2026-09-01', timePeriodEndExclusive: '2026-10-01', ...overrides };
    const u2 = new URL(u); u2.searchParams.set('settings', JSON.stringify(st));
    const p = await context.newPage();
    await p.goto(u2.toString(), { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(3000);
    const text = await p.evaluate(() => document.body?.innerText || '');
    await p.close();
    console.log(`\n===== ${title} =====\nsettings: ${JSON.stringify(st)}\n${text}`);
  };

  await run('Dashboard Esti query (staffIds = Esti group)', { staffIds: ESTI });
  await run('All staff incl. archived (per-staff rows)', {});
  for (const locationIds of [[1], [2]]) {
    await run(`Esti, locationIds ${JSON.stringify(locationIds)}`, { staffIds: ESTI, locationIds });
  }
  await browser.close();
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
