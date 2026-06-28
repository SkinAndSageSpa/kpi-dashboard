/**
 * scraper.js
 * Scrapes KPI data from both Mangomint accounts and writes dashboard.html.
 *
 * Report rendering: Mangomint renders each generated report inside an <iframe>
 * at https://app.mangomint.com/api/v1/reports/<name>/html?settings=...
 * The iframe innerText is clean tab-separated data with a summary row at the bottom.
 *
 * Confirmed column layouts (from probe5 runs):
 *
 *   Sales Summary → "Total" row (last row):
 *     Date | #Sales | #Services | Service Sales | #Products | Product Sales |
 *     Subtotal | Taxes | Tips | Gross Total | Refunds | Adjusted Total (last col)
 *
 *   Business Intelligence: Appointments → "All Selected" row:
 *     Staff | Avail.# | Booked# | Booked% | ...
 *     cols[0]="All Selected", cols[3]=Booked %
 *
 *   Client Retention → "All Selected Staff" row:
 *     Staff | ExistingTotal# | ExistRet30# | ExistRet30% | ExistRet60# | ExistRet60% |
 *     ExistRet90# | ExistRet90% | ExistRet180# | ExistRet180% |
 *     NewTotal# | NewRet30# | NewRet30% | NewRet60# | NewRet60% |
 *     NewRet90# | NewRet90% | NewRet180# | NewRet180%
 *     cols[1]=ExistTotal, cols[8]=ExistRet180#, cols[10]=NewTotal, cols[17]=NewRet180#
 *     Formula: (cols[8] + cols[17]) / (cols[1] + cols[10]) * 100
 *
 * Env vars:
 *   SKINSAGE_MANGOMINT_COOKIES
 *   WAXON_MANGOMINT_COOKIES
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const { generateHtml } = require('./generateHtml');

const CACHE_FILE = process.env.CACHE_FILE || path.join(__dirname, '..', 'data-cache.json');

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return { businesses: {} }; }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

function periodKey(monthsAgo) {
  const n = ptNow();
  const d = new Date(n.getFullYear(), n.getMonth() - monthsAgo, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/kpi-screenshots';

const ACCOUNTS = [
  { key: 'skinsage', label: 'Skin & Sage', locationId: '560372', cookieEnv: 'SKINSAGE_MANGOMINT_COOKIES' },
  { key: 'waxon',    label: 'WAXON',       locationId: '812513', cookieEnv: 'WAXON_MANGOMINT_COOKIES'    },
];

// ── Date helpers ──────────────────────────────────────────────────────────────

function ptNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

function monthPickerLabel(monthsAgo = 0) {
  const n = ptNow();
  const d = new Date(n.getFullYear(), n.getMonth() - monthsAgo, 1);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function monthLabel(monthsAgo = 0) { return monthPickerLabel(monthsAgo); }

function daysInMonth(monthsAgo = 0) {
  const n = ptNow();
  return new Date(n.getFullYear(), n.getMonth() - monthsAgo + 1, 0).getDate();
}

function dayOfMonth() { return ptNow().getDate(); }

// ── Playwright helpers ────────────────────────────────────────────────────────

let _step = 0;
async function snap(page, label) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  _step++;
  const file = path.join(SCREENSHOT_DIR, `${String(_step).padStart(2, '0')}_${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  [snap] ${file}`);
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

async function dismissOverlays(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

// ── Period picker ─────────────────────────────────────────────────────────────
// Confirmed: trigger text patterns "Today (Jun 27)", "June 2026", etc.
// Use .last() when selecting a month that matches the current trigger text
// (both the trigger and the dropdown option show the same string).

// For the current month's BI Appointments report, use a Custom date range
// (1st of month → today) instead of the full month name. This excludes
// future scheduled hours from the available-hours denominator, giving true MTD.
async function selectCustomPeriod(page, snapPrefix) {
  const now   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const mm    = String(now.getMonth() + 1).padStart(2, '0');
  const dd    = String(now.getDate()).padStart(2, '0');
  const yyyy  = now.getFullYear();
  const start = `${mm}/01/${yyyy}`;
  const end   = `${mm}/${dd}/${yyyy}`;
  console.log(`  Selecting custom period: ${start} → ${end}`);

  await dismissOverlays(page);
  const PERIOD_RE = /Today \(|Yesterday \(|This Week|Last Week|Last Two|Custom|January|February|March|April|May|June|July|August|September|October|November|December/;
  const trigger = page.getByText(PERIOD_RE, { exact: false }).first();
  if (!await trigger.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.warn('  Period trigger not found for custom range');
    return;
  }
  await trigger.click();
  await page.waitForTimeout(1800);
  if (snapPrefix) await snap(page, `${snapPrefix}_picker_open`);

  // Click the "Custom" option in the dropdown
  const customOpt = page.getByText('Custom', { exact: true });
  const customCount = await customOpt.count().catch(() => 0);
  if (customCount === 0) {
    console.warn('  "Custom" option not found — falling back to month name');
    await page.keyboard.press('Escape');
    return;
  }
  await customOpt.last().click();
  await page.waitForTimeout(1500);
  if (snapPrefix) await snap(page, `${snapPrefix}_custom_selected`);

  // Fill start and end date inputs (Mangomint uses MM/DD/YYYY text inputs)
  const textInputs = page.locator('input[type="text"]').filter({ visible: true });
  const inputCount = await textInputs.count();
  console.log(`  Visible text inputs after Custom: ${inputCount}`);

  if (inputCount >= 2) {
    await textInputs.nth(0).click({ clickCount: 3 });
    await page.waitForTimeout(100);
    await textInputs.nth(0).type(start, { delay: 50 });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(400);
    await textInputs.nth(1).click({ clickCount: 3 });
    await page.waitForTimeout(100);
    await textInputs.nth(1).type(end, { delay: 50 });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(500);
    if (snapPrefix) await snap(page, `${snapPrefix}_dates_filled`);
    console.log(`  Filled custom dates: ${start} → ${end}`);
  } else {
    console.warn(`  Expected ≥2 text inputs, found ${inputCount} — custom range may not apply`);
  }
}

async function selectPeriod(page, targetOption, snapPrefix) {
  console.log(`  Selecting period: "${targetOption}"`);
  await dismissOverlays(page);

  const PERIOD_RE = /Today \(|Yesterday \(|This Week|Last Week|Last Two|Custom|January|February|March|April|May|June|July|August|September|October|November|December/;
  const trigger = page.getByText(PERIOD_RE, { exact: false }).first();
  if (!await trigger.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.warn('  Period trigger not found');
    return;
  }
  await trigger.click();
  await page.waitForTimeout(1800);
  if (snapPrefix) await snap(page, `${snapPrefix}_picker_open`);

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

// ── Report iframe access ──────────────────────────────────────────────────────
// After clicking Generate + settling, Mangomint renders the report inside an
// <iframe class="ReportDetailsWrapper_reportIFrame__..."> that loads:
//   https://app.mangomint.com/api/v1/reports/<name>/html?settings=...
// The iframe innerText contains clean tab-separated data rows + a summary row.

async function getReportFrameText(page) {
  const frame = page.frames().find(
    f => f.url().includes('/api/v1/reports/') && f.url().includes('/html')
  );
  if (!frame) {
    console.warn(`  No report iframe found. Active frames: ${page.frames().map(f => f.url()).join(' | ')}`);
    return null;
  }
  await frame.waitForLoadState('domcontentloaded').catch(() => {});
  const text = await frame.evaluate(() => document.body?.innerText || '').catch(() => null);
  console.log(`  Frame URL: ${frame.url()}`);
  return text;
}

// Parse "$1,234.56" → 1234.56
function parseDollar(str) {
  const n = parseFloat((str || '').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

// Parse a tab-separated report row into an array of column values
function parseRow(line) {
  return line.split('\t').map(s => s.trim());
}

// ── Report fetchers ───────────────────────────────────────────────────────────

/**
 * Sales Summary → Adjusted Total (last column of the "Total" row).
 *
 * Confirmed column layout (from probe5):
 * Date | #Sales | #Services | Service Sales | #Products | Product Sales |
 * Subtotal | Taxes | Tips | Gross Total | Refunds | Adjusted Total
 *
 * "Total" line example:
 * Total\t412\t544\t$30,180.50\t23\t$308.00\t$30,488.50\t$32.56\t$5,760.81\t$36,281.87\t$0.00\t$36,281.87
 */
async function fetchSales(page, base, monthOption, snapPrefix) {
  console.log(`\n  [Sales] ${monthOption}`);

  await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await dismissOverlays(page);

  await page.getByText('Sales Summary', { exact: true }).first().click();
  await settle(page, 3000);

  await selectPeriod(page, monthOption, `${snapPrefix}_sales`);
  await settle(page, 1000);

  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 7000);
  await snap(page, `${snapPrefix}_sales_generated`);

  const text = await getReportFrameText(page);
  if (!text) return null;

  const lines = text.split('\n');
  const totalLine = lines.find(l => l.startsWith('Total\t'));
  if (!totalLine) {
    console.warn(`  [Sales] "Total" row not found. First 3 lines: ${lines.slice(0, 3).join(' | ')}`);
    return null;
  }

  const cols = parseRow(totalLine);
  const adjustedTotal = parseDollar(cols[cols.length - 1]); // last column
  console.log(`  [Sales] Adjusted Total = ${cols[cols.length - 1]} → ${adjustedTotal}`);
  return adjustedTotal;
}

/**
 * Business Intelligence: Appointments → Hours Booked % ("All Selected" row, cols[3]).
 * For the current month, we first generate the full-month report to capture the iframe
 * URL (which contains staffIds, locationIds, etc.), then open a second page with
 * timePeriodEndExclusive set to tomorrow — giving true MTD utilization.
 */
async function fetchUtilizationMTD(page) {
  const frame = page.frames().find(
    f => f.url().includes('/reports/business-intelligence/appointments') && f.url().includes('/html')
  );
  if (!frame) { console.warn('  [Util MTD] iframe not found'); return null; }

  let settings;
  try {
    const urlObj = new URL(frame.url());
    settings = JSON.parse(urlObj.searchParams.get('settings') || '{}');
  } catch(e) {
    console.warn('  [Util MTD] could not parse settings:', e.message);
    return null;
  }

  // Shift end to tomorrow (timePeriodEndExclusive is exclusive, so today becomes included)
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  now.setDate(now.getDate() + 1);
  settings.timePeriodEndExclusive =
    `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

  const urlObj2 = new URL(frame.url());
  urlObj2.searchParams.set('settings', JSON.stringify(settings));
  const mtdUrl = urlObj2.toString();
  console.log(`  [Util MTD] end→${settings.timePeriodEndExclusive}`);

  const p = await page.context().newPage();
  try {
    await p.goto(mtdUrl, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(3000);
    const text = await p.evaluate(() => document.body?.innerText || '');
    const allRow = text.split('\n').find(l => l.startsWith('All Selected\t'));
    if (!allRow) { console.warn('  [Util MTD] All Selected row not found'); return null; }
    const cols = allRow.split('\t').map(s => s.trim());
    const util = parseFloat(cols[3]);
    console.log(`  [Util MTD] Avail=${cols[1]}, Booked=${cols[2]}, %=${cols[3]}`);
    return isNaN(util) ? null : util;
  } finally {
    await p.close();
  }
}

async function fetchUtilization(page, base, monthOption, snapPrefix, isCurrent = false) {
  console.log(`\n  [Utilization] ${monthOption}`);

  await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await dismissOverlays(page);

  await page.getByText('Business Intelligence: Appointments', { exact: true }).first().click();
  await settle(page, 3000);

  await selectPeriod(page, monthOption, `${snapPrefix}_util`);
  await settle(page, 1000);

  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 7000);
  await snap(page, `${snapPrefix}_util_generated`);

  // For current month: re-fetch with today as the end date (true MTD)
  if (isCurrent) {
    const mtd = await fetchUtilizationMTD(page).catch(e => {
      console.warn('  [Util MTD] error, falling back to full month:', e.message);
      return null;
    });
    if (mtd !== null) return mtd;
  }

  const text = await getReportFrameText(page);
  if (!text) return null;

  const lines = text.split('\n');
  const allSelectedLine = lines.find(l => l.startsWith('All Selected\t'));
  if (!allSelectedLine) {
    console.warn(`  [Utilization] "All Selected" row not found. Lines: ${lines.slice(0, 8).join(' | ')}`);
    return null;
  }

  const cols = parseRow(allSelectedLine);
  const util = parseFloat(cols[3]);
  console.log(`  [Utilization] All Selected → Avail=${cols[1]}, Booked=${cols[2]}, %=${cols[3]}`);
  return isNaN(util) ? null : util;
}

/**
 * Client Retention → (existingRet180 + newRet180) / (existingTotal + newTotal) * 100.
 *
 * Confirmed column layout (from probe5):
 * Staff | ExistTotal# | ExistRet30# | ExistRet30% | ExistRet60# | ExistRet60% |
 *   ExistRet90# | ExistRet90% | ExistRet180# | ExistRet180% |
 *   NewTotal# | NewRet30# | NewRet30% | NewRet60# | NewRet60% |
 *   NewRet90# | NewRet90% | NewRet180# | NewRet180%
 *
 * "All Selected Staff" line example:
 * All Selected Staff\t370\t35\t9.46\t77\t20.81\t80\t21.62\t80\t21.62\t58\t4\t6.90\t10\t17.24\t10\t17.24\t10\t17.24
 *   cols[1]=370 (existing total), cols[8]=80 (existing ret180), cols[10]=58 (new total), cols[17]=10 (new ret180)
 */
// After generating the single-month retention report (to capture iframe URL+settings),
// open a second page with explicit start/end dates for a 60-day rolling window.
// Anchor: today for current month, last day of month for completed months.
async function fetchRetentionWindow(page, startStr, endExclusiveStr) {
  const frame = page.frames().find(
    f => f.url().includes('/api/v1/reports/') && f.url().includes('/html')
  );
  if (!frame) { console.warn('  [Retention 60d] iframe not found'); return null; }

  let settings;
  try {
    const urlObj = new URL(frame.url());
    settings = JSON.parse(urlObj.searchParams.get('settings') || '{}');
  } catch(e) {
    console.warn('  [Retention 60d] could not parse settings:', e.message);
    return null;
  }

  settings.timePeriodStart         = startStr;
  settings.timePeriodEndExclusive  = endExclusiveStr;

  const urlObj2 = new URL(frame.url());
  urlObj2.searchParams.set('settings', JSON.stringify(settings));
  console.log(`  [Retention 60d] ${startStr} → ${endExclusiveStr}`);

  const p = await page.context().newPage();
  try {
    await p.goto(urlObj2.toString(), { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(3000);
    return await p.evaluate(() => document.body?.innerText || '');
  } finally {
    await p.close();
  }
}

async function fetchRetention(page, base, monthOption, snapPrefix, monthsAgo = 0) {
  console.log(`\n  [Retention] ${monthOption}`);

  await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await dismissOverlays(page);

  await page.getByText('Client Retention', { exact: true }).first().click();
  await settle(page, 3000);

  await selectPeriod(page, monthOption, `${snapPrefix}_ret`);
  await settle(page, 1000);

  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 7000);
  await snap(page, `${snapPrefix}_ret_generated`);

  // 2 full calendar months: each bar = [month - 1] + [month].
  // Current month always uses the 2 most recently completed months so partial-month
  // data never skews the window (e.g. in June: April + May regardless of the day).
  //   monthsAgo=0 (June):  Apr 1 → Jun 1
  //   monthsAgo=1 (May):   Apr 1 → Jun 1  (same — June is partial)
  //   monthsAgo=2 (April): Mar 1 → May 1
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const endMonthIdx = now.getMonth() - Math.max(0, monthsAgo - 1);
  const endDate     = new Date(now.getFullYear(), endMonthIdx, 1);
  const startDate   = new Date(now.getFullYear(), endMonthIdx - 2, 1);

  const windowText = await fetchRetentionWindow(page, fmt(startDate), fmt(endDate)).catch(e => {
    console.warn('  [Retention 60d] error, falling back to single month:', e.message);
    return null;
  });
  const text = windowText || await getReportFrameText(page);
  if (!text) return null;

  const lines = text.split('\n');
  const allStaffLine = lines.find(l => l.startsWith('All Selected Staff\t'));
  if (!allStaffLine) {
    console.warn(`  [Retention] "All Selected Staff" row not found. Lines: ${lines.slice(0, 8).join(' | ')}`);
    return null;
  }

  const cols = parseRow(allStaffLine);
  const existingTotal  = parseFloat(cols[1]);
  const existingRet180 = parseFloat(cols[8]);
  const newTotal       = parseFloat(cols[10]);
  const newRet180      = parseFloat(cols[17]);

  console.log(`  [Retention] existing total=${existingTotal} ret180=${existingRet180}`);
  console.log(`  [Retention] new total=${newTotal} ret180=${newRet180}`);

  const totalClients = existingTotal + newTotal;
  const retained     = existingRet180 + newRet180;
  const retention    = totalClients > 0 ? Math.round(retained / totalClients * 100) : null;
  const existingPct  = existingTotal > 0 ? parseFloat((existingRet180 / existingTotal * 100).toFixed(1)) : null;
  const newPct       = newTotal > 0      ? parseFloat((newRet180 / newTotal * 100).toFixed(1)) : null;
  console.log(`  [Retention] = ${retained}/${totalClients} = ${retention}% (existing ${existingPct}%, new ${newPct}%)`);
  return { combined: retention, existingPct, newPct };
}

// ── Account scraper ───────────────────────────────────────────────────────────

async function scrapeAccount(browser, account, cache) {
  const raw = process.env[account.cookieEnv];
  if (!raw) throw new Error(`${account.cookieEnv} not set`);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Scraping: ${account.label}`);
  console.log('='.repeat(50));

  const context = await browser.newContext({
    viewport:   { width: 1440, height: 900 },
    userAgent:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:     'en-US',
    timezoneId: 'America/Los_Angeles',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await context.addCookies(parseCookies(raw));

  const page = await context.newPage();
  const base = `https://app.mangomint.com/${account.locationId}`;

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await settle(page, 5000);
  if (page.url().includes('login')) {
    throw new Error(`${account.cookieEnv} expired — refresh the GitHub secret`);
  }
  console.log(`Logged in: ${page.url()}`);

  const periods = [
    { monthsAgo: 0, label: monthLabel(0), pickerLabel: monthPickerLabel(0), isCurrent: true  },
    { monthsAgo: 1, label: monthLabel(1), pickerLabel: monthPickerLabel(1), isCurrent: false },
    { monthsAgo: 2, label: monthLabel(2), pickerLabel: monthPickerLabel(2), isCurrent: false },
  ];

  const results = [];

  const bizCache = cache.businesses[account.key] || (cache.businesses[account.key] = { periods: {} });

  for (const p of periods) {
    const key    = periodKey(p.monthsAgo);
    const prefix = `${account.key}_${p.pickerLabel.replace(/\s/g, '_')}`;
    console.log(`\n── Period: ${p.label} (picker: "${p.pickerLabel}") ──`);

    if (!p.isCurrent && bizCache.periods[key]) {
      console.log(`  Using cached data for ${key}`);
      results.push({ label: p.label, monthsAgo: p.monthsAgo, isCurrent: false, ...bizCache.periods[key] });
      continue;
    }

    const sales       = await fetchSales(page, base, p.pickerLabel, prefix).catch(e => { console.error(`  Sales error: ${e.message}`); return null; });
    const utilization = await fetchUtilization(page, base, p.pickerLabel, prefix, p.isCurrent).catch(e => { console.error(`  Util error: ${e.message}`); return null; });
    const retResult   = await fetchRetention(page, base, p.pickerLabel, prefix, p.monthsAgo).catch(e => { console.error(`  Ret error: ${e.message}`); return null; });
    const retention      = retResult?.combined ?? null;
    const existingRetPct = retResult?.existingPct ?? null;
    const newRetPct      = retResult?.newPct ?? null;

    const daysElapsed = p.isCurrent ? dayOfMonth() : null;
    const totalDays   = p.isCurrent ? daysInMonth(0) : null;
    const projectedSales = (p.isCurrent && sales !== null && daysElapsed > 0)
      ? Math.round((sales / daysElapsed) * totalDays)
      : null;

    console.log(`  → sales=$${sales?.toLocaleString()} proj=$${projectedSales?.toLocaleString()} util=${utilization}% ret=${retention}%`);

    const periodData = { sales, projectedSales, utilization, retention, existingRetPct, newRetPct };
    if (!p.isCurrent) bizCache.periods[key] = periodData;

    results.push({ label: p.label, monthsAgo: p.monthsAgo, isCurrent: p.isCurrent, ...periodData });
  }

  await context.close();
  return { key: account.key, label: account.label, periods: results };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('KPI Dashboard scraper starting...');
  console.log(`Screenshots → ${SCREENSHOT_DIR}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });

  const cache = loadCache();
  const businessData = [];
  const errors = [];

  try {
    for (const account of ACCOUNTS) {
      try {
        businessData.push(await scrapeAccount(browser, account, cache));
      } catch (err) {
        console.error(`ERROR scraping ${account.label}: ${err.message}`);
        errors.push({ account: account.label, error: err.message });
        businessData.push({
          key: account.key, label: account.label, error: err.message,
          periods: [0, 1, 2].map(monthsAgo => ({
            label: monthLabel(monthsAgo), monthsAgo, isCurrent: monthsAgo === 0,
            sales: null, projectedSales: null, utilization: null, retention: null,
          })),
        });
      }
    }
  } finally {
    await browser.close();
  }

  saveCache(cache);

  const html = generateHtml({
    businesses: businessData, generatedAt: new Date().toISOString(), errors,
  });

  const outFile = process.env.DASHBOARD_OUT || path.join(__dirname, '..', 'dashboard.html');
  fs.writeFileSync(outFile, html, 'utf8');
  console.log(`\nDashboard written: ${outFile}`);

  if (errors.length > 0) {
    console.error(`\n${errors.length} account(s) had errors`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
