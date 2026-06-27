/**
 * probe4.js — dumps document.body.textContent after generating each report.
 * Purpose: verify the parsing approach before full scraper run.
 * Saves text dumps to PROBE_DIR for artifact upload.
 *
 * Usage: node src/probe4.js
 * Env:   WAXON_MANGOMINT_COOKIES (or SKINSAGE_MANGOMINT_COOKIES)
 *        PROBE_ACCOUNT=waxon|skinsage (default: waxon)
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const PROBE_DIR     = process.env.PROBE_DIR || '/tmp/probe4-results';
const ACCOUNT_KEY   = process.env.PROBE_ACCOUNT || 'waxon';
const LOCATION_IDS  = { waxon: '812513', skinsage: '560372' };
const COOKIE_ENVS   = { waxon: 'WAXON_MANGOMINT_COOKIES', skinsage: 'SKINSAGE_MANGOMINT_COOKIES' };

fs.mkdirSync(PROBE_DIR, { recursive: true });

function save(name, text) {
  const file = path.join(PROBE_DIR, name);
  fs.writeFileSync(file, text, 'utf8');
  console.log(`  Saved: ${file} (${text.length} chars)`);
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
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(extra);
}

async function snap(page, label) {
  const file = path.join(PROBE_DIR, `${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  [snap] ${file}`);
}

async function dismissOverlays(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

// Month label (matches picker options confirmed in probe3)
function monthPickerLabel(monthsAgo = 0) {
  const n = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const d = new Date(n.getFullYear(), n.getMonth() - monthsAgo, 1);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

async function selectPeriod(page, targetOption) {
  await dismissOverlays(page);
  const PERIOD_RE = /Today \(|Yesterday \(|This Week|Last Week|Last Two|Custom|January|February|March|April|May|June|July|August|September|October|November|December/;
  const trigger = page.getByText(PERIOD_RE, { exact: false }).first();
  if (!await trigger.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.warn('  Trigger not found');
    return;
  }
  await trigger.click();
  await page.waitForTimeout(1800);
  const options = page.getByText(targetOption, { exact: true });
  const count = await options.count().catch(() => 0);
  if (count === 0) {
    console.warn(`  Option "${targetOption}" not found`);
    await page.keyboard.press('Escape');
    return;
  }
  await options.last().click();
  await page.waitForTimeout(800);
  console.log(`  Selected: "${targetOption}" (${count} match(es))`);
}

async function main() {
  const locationId = LOCATION_IDS[ACCOUNT_KEY];
  const cookieEnv  = COOKIE_ENVS[ACCOUNT_KEY];
  const raw = process.env[cookieEnv];
  if (!raw) { console.error(`${cookieEnv} not set`); process.exit(1); }

  const base = `https://app.mangomint.com/${locationId}`;
  const monthOption = monthPickerLabel(0); // current month
  console.log(`Account: ${ACCOUNT_KEY}, base: ${base}, month: "${monthOption}"`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US', timezoneId: 'America/Los_Angeles',
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  await context.addCookies(parseCookies(raw));
  const page = await context.newPage();

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await settle(page, 5000);
  if (page.url().includes('login')) { console.error('Cookies expired'); process.exit(1); }
  console.log(`Logged in: ${page.url()}`);

  // ── 1. Sales Summary ───────────────────────────────────────────────────────
  console.log('\n── Sales Summary ──');
  await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await dismissOverlays(page);
  await page.getByText('Sales Summary', { exact: true }).first().click();
  await settle(page, 3000);
  await selectPeriod(page, monthOption);
  await settle(page, 1000);
  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 7000);
  await snap(page, 'sales_generated');

  const salesText = await page.evaluate(() => document.body.textContent || '');
  save('sales_body_textcontent.txt', salesText);

  // Also save innerText for comparison
  const salesInner = await page.evaluate(() => document.body.innerText || '');
  save('sales_body_innertext.txt', salesInner);

  // ── 2. BI: Appointments ────────────────────────────────────────────────────
  console.log('\n── BI: Appointments ──');
  await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await dismissOverlays(page);
  await page.getByText('Business Intelligence: Appointments', { exact: true }).first().click();
  await settle(page, 3000);
  await selectPeriod(page, monthOption);
  await settle(page, 1000);
  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 7000);
  await snap(page, 'bi_generated');

  // Scroll to bottom to ensure "All Selected" loads
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);
  await snap(page, 'bi_scrolled_bottom');

  const biText = await page.evaluate(() => document.body.textContent || '');
  save('bi_body_textcontent.txt', biText);
  const biInner = await page.evaluate(() => document.body.innerText || '');
  save('bi_body_innertext.txt', biInner);

  // ── 3. Client Retention ────────────────────────────────────────────────────
  console.log('\n── Client Retention ──');
  await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await dismissOverlays(page);
  await page.getByText('Client Retention', { exact: true }).first().click();
  await settle(page, 3000);
  await selectPeriod(page, monthOption);
  await settle(page, 1000);
  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 7000);
  await snap(page, 'ret_generated');

  // Scroll to bottom
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);
  await snap(page, 'ret_scrolled_bottom');

  const retText = await page.evaluate(() => document.body.textContent || '');
  save('ret_body_textcontent.txt', retText);
  const retInner = await page.evaluate(() => document.body.innerText || '');
  save('ret_body_innertext.txt', retInner);

  await browser.close();
  console.log('\nProbe4 complete. Results saved to', PROBE_DIR);
}

main().catch(e => { console.error(e); process.exit(1); });
