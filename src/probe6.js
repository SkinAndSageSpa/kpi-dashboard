/**
 * probe6.js — Membership Payments report inspector (read-only).
 * For each account: dumps the Reports list text, opens "Membership Payments",
 * generates it, saves the iframe URL/settings + innerText, then re-fetches it
 * with explicit date ranges (this month MTD, last month) via the same settings
 * URL rewrite the scraper uses.
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const PROBE_DIR = process.env.PROBE_DIR || '/tmp/probe6-results';
const ACCOUNTS = [
  { key: 'skinsage', locationId: '560372', cookieEnv: 'SKINSAGE_MANGOMINT_COOKIES' },
  { key: 'waxon',    locationId: '812513', cookieEnv: 'WAXON_MANGOMINT_COOKIES' },
];

fs.mkdirSync(PROBE_DIR, { recursive: true });

function save(name, text) {
  fs.writeFileSync(path.join(PROBE_DIR, name), String(text), 'utf8');
  console.log(`  Saved: ${name} (${String(text).length} chars)`);
}

function parseCookies(raw) {
  return JSON.parse(raw).map(c => ({
    name: c.name, value: c.value,
    domain: c.domain || '.mangomint.com', path: c.path || '/',
    httpOnly: c.httpOnly || false, secure: c.secure !== false, sameSite: 'Lax',
    ...(c.expirationDate ? { expires: Math.floor(c.expirationDate) } : {}),
  }));
}

async function settle(page, extra = 3000) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(extra);
}

async function dismissOverlays(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function probeAccount(browser, acct) {
  console.log(`\n===== ${acct.key} =====`);
  const raw = process.env[acct.cookieEnv];
  if (!raw) { console.error(`${acct.cookieEnv} not set`); return; }
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US', timezoneId: 'America/Los_Angeles',
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  await context.addCookies(parseCookies(raw));
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const base = `https://app.mangomint.com/${acct.locationId}`;

  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await settle(page, 5000);
    if (page.url().includes('login')) { console.error('Cookies expired'); return; }

    await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
    await settle(page, 3000);
    await dismissOverlays(page);
    save(`${acct.key}_reports_list.txt`, await page.evaluate(() => document.body.innerText));
    await page.screenshot({ path: path.join(PROBE_DIR, `${acct.key}_reports_list.png`), fullPage: true });

    await page.getByText('Membership Payments', { exact: true }).first().click();
    await settle(page, 3000);
    await page.screenshot({ path: path.join(PROBE_DIR, `${acct.key}_mp_form.png`), fullPage: true });
    save(`${acct.key}_mp_form.txt`, await page.evaluate(() => document.body.innerText));

    await dismissOverlays(page);
    await page.getByText('Generate', { exact: true }).first().click();
    await settle(page, 8000);
    await page.screenshot({ path: path.join(PROBE_DIR, `${acct.key}_mp_generated.png`), fullPage: true });

    const frames = page.frames().map(f => f.url()).filter(u => u.includes('/api/v1/reports/') || u.includes('/reports/'));
    save(`${acct.key}_frame_urls.txt`, frames.join('\n'));
    const frame = page.frames().find(f => f.url().includes('/html'));
    if (!frame) { console.warn('  no /html report frame'); return; }
    const url = new URL(frame.url());
    const settings = JSON.parse(url.searchParams.get('settings') || '{}');
    save(`${acct.key}_mp_settings.json`, JSON.stringify({ url: frame.url().split('?')[0], settings }, null, 2));
    save(`${acct.key}_mp_default.txt`, await frame.evaluate(() => document.body.innerText || ''));

    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    const windows = [
      ['mtd',       ymd(new Date(now.getFullYear(), now.getMonth(), 1)),     ymd(tomorrow)],
      ['fullmonth', ymd(new Date(now.getFullYear(), now.getMonth(), 1)),     ymd(new Date(now.getFullYear(), now.getMonth() + 1, 1))],
      ['lastmonth', ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), ymd(new Date(now.getFullYear(), now.getMonth(), 1))],
    ];
    for (const [tag, start, end] of windows) {
      if (!('timePeriodStart' in settings)) { console.warn('  settings have no timePeriodStart — keys:', Object.keys(settings)); break; }
      const s = { ...settings, timePeriodStart: start, timePeriodEndExclusive: end };
      const u = new URL(frame.url());
      u.searchParams.set('settings', JSON.stringify(s));
      const p = await context.newPage();
      await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(4000);
      save(`${acct.key}_mp_${tag}.txt`, `${start}..${end}\n` + await p.evaluate(() => document.body?.innerText || ''));
      await p.close();
    }
  } catch (e) {
    console.error(`  ${acct.key} failed: ${e.message}`);
    await page.screenshot({ path: path.join(PROBE_DIR, `${acct.key}_error.png`), fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  for (const a of ACCOUNTS) await probeAccount(browser, a);
  await browser.close();
})();
