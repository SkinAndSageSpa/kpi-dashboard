/**
 * scraper.js
 * Scrapes KPI data from both Mangomint accounts and writes dashboard.html.
 *
 * KPIs per business:
 *   Monthly Sales    — Reports → Sales → Sales Summary → set month → Generate
 *   Utilization      — Reports → Business → Business Intelligence: Appointments → set month → Generate → "All Selected / Hours / Booked / %"
 *   Client Retention — Reports → Business → Client Retention → Custom 90-day window → Generate
 *                      formula: (# existing retained + # new retained) / # total from first column
 *
 * Each KPI is shown for: current month, last month, month before that.
 * Retention window for each period ends on the last day of that month (or today for current).
 *
 * Env vars:
 *   SKINSAGE_MANGOMINT_COOKIES
 *   WAXON_MANGOMINT_COOKIES
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const { generateHtml } = require('./generateHtml');

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/kpi-screenshots';

const ACCOUNTS = [
  { key: 'skinsage', label: 'Skin & Sage', locationId: '560372', cookieEnv: 'SKINSAGE_MANGOMINT_COOKIES' },
  { key: 'waxon',    label: 'WAXON',       locationId: '812513', cookieEnv: 'WAXON_MANGOMINT_COOKIES'    },
];

// ── Date helpers ──────────────────────────────────────────────────────────────

function ptNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
}

function todayPT() {
  const n = ptNow();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

// First day of the month N months ago (PT), YYYY-MM-DD
function monthStart(monthsAgo = 0) {
  const n = ptNow();
  const d = new Date(n.getFullYear(), n.getMonth() - monthsAgo, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

// Last day of the month N months ago (PT), YYYY-MM-DD
function monthEnd(monthsAgo = 0) {
  const n = ptNow();
  const d = new Date(n.getFullYear(), n.getMonth() - monthsAgo + 1, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "June 2026" for N months ago
function monthLabel(monthsAgo = 0) {
  const n = ptNow();
  const d = new Date(n.getFullYear(), n.getMonth() - monthsAgo, 1);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// Days in month N months ago
function daysInMonth(monthsAgo = 0) {
  const n = ptNow();
  return new Date(n.getFullYear(), n.getMonth() - monthsAgo + 1, 0).getDate();
}

// Day-of-month today
function dayOfMonth() {
  return ptNow().getDate();
}

// YYYY-MM-DD that is N days before dateStr
function daysBeforeDate(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// ── Playwright helpers ────────────────────────────────────────────────────────

let _step = 0;
async function snap(page, label) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  _step++;
  const file = path.join(SCREENSHOT_DIR, `${String(_step).padStart(2, '0')}_${label}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  [screenshot] ${file}`);
}

function parseCookies(raw) {
  return JSON.parse(raw).map(c => ({
    name:     c.name,
    value:    c.value,
    domain:   c.domain   || '.mangomint.com',
    path:     c.path     || '/',
    httpOnly: c.httpOnly || false,
    secure:   c.secure   !== false,
    sameSite: 'Lax',
    ...(c.expirationDate ? { expires: Math.floor(c.expirationDate) } : {}),
  }));
}

async function settle(page, extra = 3000) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(extra);
}

// Parses "$12,345.67" → 12345.67
function parseDollar(str) {
  const n = parseFloat((str || '').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

// Parses "78.3%" or "78.3" → 78.3
function parsePct(str) {
  const n = parseFloat((str || '').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

// Parses "1,234" or "1234" → 1234
function parseInt2(str) {
  const n = parseInt((str || '').replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? null : n;
}

// ── Report: Monthly Sales ─────────────────────────────────────────────────────
// Path: Reports → Sales → Sales Summary → set date range → Generate

async function fetchSales(page, base, startDate, endDate, snapPrefix) {
  console.log(`    Sales: ${startDate} → ${endDate}`);

  // TODO: Navigate to Sales Summary report and set the date range.
  // Probe confirmed selectors will replace these stubs.
  //
  // Expected flow:
  //   await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  //   await page.getByText('Sales', { exact: false }).first().click();
  //   await page.getByText('Sales Summary', { exact: true }).click();
  //   await settle(page, 3000);
  //   // set date range inputs (selectors TBD from probe)
  //   await page.locator('TODO_DATE_START_SELECTOR').fill(startDate);
  //   await page.locator('TODO_DATE_END_SELECTOR').fill(endDate);
  //   await page.getByText('Generate', { exact: true }).click();
  //   await settle(page, 4000);

  await snap(page, `${snapPrefix}_sales`);

  // TODO: Read the total sales figure from the report.
  // Example:
  //   const raw = await page.locator('TODO_SALES_TOTAL_SELECTOR').first().innerText().catch(() => '');
  //   return parseDollar(raw);

  return null; // TODO: replace with parsed value
}

// ── Report: Utilization ───────────────────────────────────────────────────────
// Path: Reports → Business → Business Intelligence: Appointments → set month → Generate
// Value: "All Selected" row, "Hours" section, "Booked" column, "%" cell

async function fetchUtilization(page, base, startDate, endDate, snapPrefix) {
  console.log(`    Utilization: ${startDate} → ${endDate}`);

  // TODO: Navigate to Business Intelligence: Appointments and set date range.
  //
  // Expected flow:
  //   await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  //   await page.getByText('Business', { exact: false }).first().click();
  //   await page.getByText('Business Intelligence', { exact: false }).first().click();
  //   // may need to select "Appointments" sub-tab
  //   await settle(page, 3000);
  //   // set month/date range (selectors TBD from probe)
  //   await page.locator('TODO_DATE_START_SELECTOR').fill(startDate);
  //   await page.locator('TODO_DATE_END_SELECTOR').fill(endDate);
  //   await page.getByText('Generate', { exact: true }).click();
  //   await settle(page, 4000);

  await snap(page, `${snapPrefix}_utilization`);

  // TODO: Read the "All Selected / Hours / Booked / %" cell from the report table.
  // Example:
  //   const raw = await page.locator('TODO_UTILIZATION_PCT_SELECTOR').first().innerText().catch(() => '');
  //   return parsePct(raw);

  return null; // TODO: replace with parsed value
}

// ── Report: Client Retention ──────────────────────────────────────────────────
// Path: Reports → Business → Client Retention → Custom date range (90-day window) → Generate
// Formula: (# existing retained + # new retained) / # total (first column)

async function fetchRetention(page, base, windowStart, windowEnd, snapPrefix) {
  console.log(`    Retention window: ${windowStart} → ${windowEnd}`);

  // TODO: Navigate to Client Retention report and set custom 90-day date range.
  //
  // Expected flow:
  //   await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  //   await page.getByText('Business', { exact: false }).first().click();
  //   await page.getByText('Client Retention', { exact: true }).click();
  //   await settle(page, 3000);
  //   // switch to Custom time period (selector TBD from probe)
  //   await page.locator('TODO_TIME_PERIOD_SELECTOR').click();
  //   await page.getByText('Custom', { exact: true }).click();
  //   await page.locator('TODO_DATE_START_SELECTOR').fill(windowStart);
  //   await page.locator('TODO_DATE_END_SELECTOR').fill(windowEnd);
  //   await page.getByText('Generate', { exact: true }).click();
  //   await settle(page, 4000);

  await snap(page, `${snapPrefix}_retention`);

  // TODO: Read the three "#" columns from the generated report table.
  //
  // Column layout (from user description):
  //   Col 0: Total clients (denominator)
  //   Existing client retention: "# retained within 180 days" column
  //   New client retention:      "# retained within 180 days" column
  //
  // Example:
  //   const rows = page.locator('TODO_TABLE_ROW_SELECTOR');
  //   // find "Existing client retention" row and "New client retention" row
  //   const total        = parseInt2(await page.locator('TODO_TOTAL_COUNT_SELECTOR').innerText().catch(() => ''));
  //   const existingKept = parseInt2(await page.locator('TODO_EXISTING_RETAINED_SELECTOR').innerText().catch(() => ''));
  //   const newKept      = parseInt2(await page.locator('TODO_NEW_RETAINED_SELECTOR').innerText().catch(() => ''));
  //   if (total && total > 0) return Math.round((existingKept + newKept) / total * 100);

  return null; // TODO: replace with parsed value
}

// ── Account scraper ───────────────────────────────────────────────────────────

async function scrapeAccount(browser, account) {
  const raw = process.env[account.cookieEnv];
  if (!raw) throw new Error(`${account.cookieEnv} not set`);

  console.log(`\n=== Scraping ${account.label} ===`);

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
  if (page.url().includes('login')) throw new Error(`${account.cookieEnv} expired — refresh the secret`);
  console.log(`  Logged in: ${page.url()}`);

  const todayStr = todayPT();
  const daysElapsed = dayOfMonth();
  const totalDays   = daysInMonth(0);

  // Three periods: current month, last month, 2 months ago
  const periods = [
    { monthsAgo: 0, label: monthLabel(0), start: monthStart(0), end: todayStr },
    { monthsAgo: 1, label: monthLabel(1), start: monthStart(1), end: monthEnd(1) },
    { monthsAgo: 2, label: monthLabel(2), start: monthStart(2), end: monthEnd(2) },
  ];

  const results = [];

  for (const p of periods) {
    const prefix = `${account.key}_${p.label.replace(/\s/g, '_')}`;
    console.log(`\n  Period: ${p.label}`);

    const sales       = await fetchSales(page, base, p.start, p.end, prefix);
    const utilization = await fetchUtilization(page, base, p.start, p.end, prefix);

    // Retention uses a 90-day rolling window ending on the last day of the period
    const retentionEnd   = p.monthsAgo === 0 ? todayStr : p.end;
    const retentionStart = daysBeforeDate(retentionEnd, 90);
    const retention      = await fetchRetention(page, base, retentionStart, retentionEnd, prefix);

    // Project end-of-month sales for current month only
    const projectedSales = (p.monthsAgo === 0 && sales !== null && daysElapsed > 0)
      ? Math.round((sales / daysElapsed) * totalDays)
      : null;

    results.push({
      label:          p.label,
      monthsAgo:      p.monthsAgo,
      isCurrent:      p.monthsAgo === 0,
      sales,
      projectedSales,
      utilization,
      retention,
      retentionWindow: `${retentionStart} → ${retentionEnd}`,
    });
  }

  await context.close();
  return { key: account.key, label: account.label, periods: results };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('KPI Dashboard scraper starting...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });

  const businessData = [];
  const errors = [];

  try {
    for (const account of ACCOUNTS) {
      try {
        businessData.push(await scrapeAccount(browser, account));
      } catch (err) {
        console.error(`  ERROR scraping ${account.label}: ${err.message}`);
        errors.push({ account: account.label, error: err.message });
        businessData.push({
          key:    account.key,
          label:  account.label,
          error:  err.message,
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

  const html = generateHtml({
    businesses:  businessData,
    generatedAt: new Date().toISOString(),
    errors,
  });

  const outFile = process.env.DASHBOARD_OUT || path.join(__dirname, '..', 'dashboard.html');
  fs.writeFileSync(outFile, html, 'utf8');
  console.log(`\nDashboard written: ${outFile}`);

  if (errors.length > 0) {
    console.error(`\n${errors.length} account(s) had errors — check screenshots`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
