/**
 * probe-bisales.js — READ-ONLY. Business Intelligence: Sales report:
 * settings shape, column headers, summary row, and whether a narrowed staffIds
 * (one Esti, one LMT) changes "Avg Product Total Per Sale". Runs for both accounts.
 */

const { chromium } = require('playwright');

const ACCOUNTS = [
  { label: 'Skin & Sage', id: '560372', env: 'SKINSAGE_MANGOMINT_COOKIES', staffSets: [[34, 89, 87, 6, 79, 85, 63], [91, 86, 82, 83, 57, 77, 61]] },
  { label: 'WAXON',       id: '812513', env: 'WAXON_MANGOMINT_COOKIES',    staffSets: [] },
];

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
  for (const acct of ACCOUNTS) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US', timezoneId: 'America/Los_Angeles',
    });
    await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    await context.addCookies(parseCookies(process.env[acct.env]));
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const base = `https://app.mangomint.com/${acct.id}`;

    await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
    await settle(page, 4000);
    await page.keyboard.press('Escape');
    await page.getByText('Business Intelligence: Sales', { exact: true }).first().click();
    await settle(page, 3000);
    await page.getByText('Generate', { exact: true }).first().click();
    await settle(page, 7000);
    const frame = page.frames().find(f => f.url().includes('/api/v1/reports/') && f.url().includes('/html'));
    if (!frame) { console.log(`[${acct.label}] no iframe`); await context.close(); continue; }
    const u = new URL(frame.url());
    console.log(`\n===== ${acct.label} =====\n${u.pathname}\nsettings: ${u.searchParams.get('settings')}`);

    const fetchText = async overrides => {
      const st = { ...JSON.parse(u.searchParams.get('settings')), ...overrides };
      const u2 = new URL(u); u2.searchParams.set('settings', JSON.stringify(st));
      const p = await context.newPage();
      await p.goto(u2.toString(), { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(3000);
      const t = await p.evaluate(() => document.body?.innerText || '');
      await p.close();
      return t;
    };

    const sept = { timePeriodStart: '2026-09-01', timePeriodEndExclusive: '2026-10-01' };
    const full = await fetchText(sept);
    console.log(`--- September, default staff ---\n${full.slice(0, 3500)}`);
    for (const ids of acct.staffSets) {
      const t = await fetchText({ ...sept, staffIds: ids });
      const lines = t.split('\n');
      console.log(`--- staffIds ${JSON.stringify(ids)} ---`);
      console.log(lines.filter(l => /^(Staff|All Selected|Total)\b/.test(l) || l.includes('Avg Product')).join('\n'));
    }
    await context.close();
  }
  await browser.close();
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
