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
 * Outputs (paths overridable via env):
 *   DASHBOARD_OUT       owner dashboard (both businesses)        → dist/index.html
 *   TEAM_SKINSAGE_OUT   Skin & Sage employee page, Esti vs LMT    → dist/skinsage/index.html
 *   TEAM_WAXON_OUT      WAXON employee page                       → dist/waxon/index.html
 *
 * Env vars:
 *   SKINSAGE_MANGOMINT_COOKIES
 *   WAXON_MANGOMINT_COOKIES
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const { generateHtml, generateTeamHtml } = require('./generateHtml');
const { resolveRoles } = require('./staffRoles');

const CACHE_FILE    = process.env.CACHE_FILE || path.join(__dirname, '..', 'data-cache.json');
const CACHE_VERSION = 7; // bump when cached period schema changes, or when a scrape-logic
                          // change (e.g. archived-staff inclusion, or excluding staff with
                          // <1 booked hr from Avail to work around Mangomint's stale-hours
                          // bug) invalidates prior numbers.
                          // v7: completed-month sales/util now fetch via explicit
                          // date-range URL rewrite instead of the (now broken) month
                          // picker preset — drops cached months poisoned by the
                          // picker collapsing every past month to a single $0 day.

function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    // Staff roles (see staffRoles.js) aren't KPI numbers — keep them across version bumps.
    if (c.version !== CACHE_VERSION) return { version: CACHE_VERSION, businesses: {}, staffRoles: c.staffRoles || {} };
    c.staffRoles = c.staffRoles || {};
    return c;
  } catch { return { version: CACHE_VERSION, businesses: {}, staffRoles: {} }; }
}

function saveCache(cache) {
  cache.version = CACHE_VERSION;
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

// A single failed report fetch (click timeout, transient Mangomint slowness, etc.)
// shouldn't leave a hole in the dashboard — retry once after a short pause before
// giving up and returning null.
async function withRetry(fn, label) {
  try {
    return await fn();
  } catch (e) {
    console.error(`  ${label} error (attempt 1): ${e.message} — retrying`);
    await new Promise(r => setTimeout(r, 3000));
    try {
      return await fn();
    } catch (e2) {
      console.error(`  ${label} error (attempt 2): ${e2.message}`);
      return null;
    }
  }
}

function periodKey(monthsAgo) {
  const n = ptNow();
  const d = new Date(n.getFullYear(), n.getMonth() - monthsAgo, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/kpi-screenshots';

// Business-level (2-column) panels show 3 historic months + current; location
// panels show 2 historic + current — same fetch/calc code, just fewer months back.
const ACCOUNTS = [
  { key: 'skinsage', label: 'Skin & Sage', locationId: '560372', cookieEnv: 'SKINSAGE_MANGOMINT_COOKIES', monthsBack: 4 },
  { key: 'waxon',    label: 'WAXON',       locationId: '812513', cookieEnv: 'WAXON_MANGOMINT_COOKIES',    monthsBack: 4, metrics: ['sales', 'util', 'ret', 'pps'] },
];

// Metrics an account scrape fetches (default: the owner dashboard's three).
// 'pps' = BI Sales "Avg Product Total Per Sale" — only the manager pages show it.
const DEFAULT_METRICS = ['sales', 'util', 'ret'];

// Per-location scrapes: same flow, but each report's settings URL gets its
// locationIds overridden to exactly this location (see applyLocationIds).
// IDs are Mangomint's per-account location ids, read from real report iframe
// URLs: Skin & Sage Ravenna=1 (its only id before Queen Anne was added
// 2026-09-17), Queen Anne=2; WAXON Capitol Hill=1, Belltown=2.
//
// Don't go back to clicking the Reports-page location dropdown: it's a
// multi-select with every location checked by default, so clicking a location
// name *unchecks* it and leaves only the others. That's why WAXON's "Belltown"
// click used to return Capitol Hill's numbers (previously misread as Mangomint
// swapping its labels), and why Ravenna silently collapsed to Queen Anne's $0
// from 2026-09-18 onward once Skin & Sage had a second location.
//
// openedPeriod: months before this (YYYY-MM) are shown as empty without scraping.
const LOCATION_ACCOUNTS = [
  { key: 'skinsage', locationKey: 'skinsage_ravenna',   label: 'Skin & Sage Ravenna',    locationId: '560372', cookieEnv: 'SKINSAGE_MANGOMINT_COOKIES', location: 'Ravenna',      locationIds: [1] },
  { key: 'skinsage', locationKey: 'skinsage_queenanne', label: 'Skin & Sage Queen Anne', locationId: '560372', cookieEnv: 'SKINSAGE_MANGOMINT_COOKIES', location: 'Queen Anne',   locationIds: [2], openedPeriod: '2026-09' },
  { key: 'waxon',    locationKey: 'waxon_belltown',     label: 'WAXON Belltown',         locationId: '812513', cookieEnv: 'WAXON_MANGOMINT_COOKIES',    location: 'Belltown',     locationIds: [2] },
  { key: 'waxon',    locationKey: 'waxon_capitol_hill', label: 'WAXON Capitol Hill',     locationId: '812513', cookieEnv: 'WAXON_MANGOMINT_COOKIES',    location: 'Capitol Hill', locationIds: [1] },
];

// Per-role scrapes for the Skin & Sage employee page: same flow again, but each
// report's settings.staffIds is overridden to just that role's providers. The ids
// are filled in each run by prepareStaffGroups() (see staffRoles.js), so new hires
// and departures need no code change. All three reports honor a narrowed staffIds — confirmed by
// probe 2026-10-06: the two halves of the staff list summed back to the full
// utilization hours exactly, and to within ~0.3% (sales) / ~1% (retention clients)
// since a sale or client shared by two providers counts for each of them.
const STAFF_GROUP_ACCOUNTS = [
  { key: 'skinsage', locationKey: 'skinsage_esti', label: 'Estheticians',       locationId: '560372', cookieEnv: 'SKINSAGE_MANGOMINT_COOKIES', monthsBack: 6, role: 'esti', staffIds: null, metrics: ['util', 'ret', 'pps'] },
  { key: 'skinsage', locationKey: 'skinsage_lmt',  label: 'Massage Therapists', locationId: '560372', cookieEnv: 'SKINSAGE_MANGOMINT_COOKIES', monthsBack: 6, role: 'lmt',  staffIds: null, metrics: ['util', 'ret', 'pps'] },
];

// Narrow a harvested (all-locations) report settings object to one location.
// Warns if the report didn't include that id at all, i.e. Mangomint's ids
// changed and the mapping above needs re-checking.
function applyLocationIds(settings, locationIds, tag) {
  if (!locationIds) return;
  const avail = Array.isArray(settings.locationIds) ? settings.locationIds : [];
  const missing = locationIds.filter(id => !avail.includes(id));
  if (missing.length) {
    console.warn(`  [${tag}] locationIds ${JSON.stringify(missing)} not in report's ${JSON.stringify(avail)} — location id mapping may be stale`);
  }
  settings.locationIds = locationIds;
}

// Narrow a harvested report settings object to a set of staff (Sales Summary's
// default is staffIds: null = everyone; the others list every selected id).
function applyStaffIds(settings, staffIds) {
  if (staffIds) settings.staffIds = staffIds;
}

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

function dayOfMonth() {
  const n = ptNow();
  // GitHub Actions' schedule trigger has repeatedly fired this run many hours
  // late — sometimes landing the next morning instead of the prior evening
  // (see kpi-dashboard memory, 2026-08-27/28 incident). When that happens,
  // "today" per the wall clock is a day that's barely started (near-zero
  // sales/completed appointments so far), but dayOfMonth() would still count
  // it as a fully elapsed day — understating the sales-per-day rate and
  // skewing the EOM projection low. Treat any run before noon PT as still
  // reporting on the previous day.
  if (n.getHours() < 12) {
    n.setDate(n.getDate() - 1);
  }
  return n.getDate();
}

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

// Occasionally a modal using one of Mangomint's generic "Dialog" components
// covers the page and blocks every click — Escape alone doesn't close it.
// First seen repeatedly on Skin & Sage as "DialogV2_componentCt"; on
// 2026-08-29 the same failure mode showed up on WAXON as plain
// "Dialog_componentCt" instead — a different component variant the old
// selector didn't match — so this now matches any class containing both
// "Dialog" and "componentCt" to catch current and future variants. We've
// never captured what it actually says (only Playwright's "intercepts
// pointer events" class name), so log its text the moment it's seen — that's
// the next real clue — and best-effort try to close it before giving up.
async function dismissOverlays(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  const dialog = page.locator('[class*="Dialog"][class*="componentCt"]').first();
  if (await dialog.isVisible({ timeout: 1000 }).catch(() => false)) {
    const text = await dialog.innerText().catch(() => '(unreadable)');
    console.warn(`  [Dialog] blocking modal detected: ${JSON.stringify(text.slice(0, 500))}`);

    const closeBtn = dialog.locator(
      'button[aria-label="Close" i], [class*="close" i], button:has-text("Got it"), button:has-text("Dismiss"), button:has-text("OK"), button:has-text("Skip"), button:has-text("Close")'
    ).first();
    if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeBtn.click().catch(() => {});
    } else {
      await page.mouse.click(5, 5).catch(() => {});
    }
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
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

// Parse the per-staff rows of a Business Intelligence: Appointments report,
// between the "Staff\t#\t#\t%..." header and the "All Selected" summary row.
function parseStaffAvailBooked(text) {
  const lines = text.split('\n');
  const headerIdx = lines.findIndex(l => l.startsWith('Staff\t'));
  const allSelectedIdx = lines.findIndex(l => l.startsWith('All Selected\t'));
  if (headerIdx === -1 || allSelectedIdx === -1 || allSelectedIdx <= headerIdx) return null;

  const rows = [];
  for (const line of lines.slice(headerIdx + 1, allSelectedIdx)) {
    const cols = parseRow(line);
    const avail = parseFloat(cols[1]);
    const booked = parseFloat(cols[2]);
    if (isNaN(avail) || isNaN(booked)) continue;
    rows.push({ name: cols[0], avail, booked });
  }
  return rows;
}

// Mangomint bug: archived staff sometimes carry stale "available hours" into months
// they never actually worked (e.g. hours from years ago bleeding into the current
// month), inflating Avail and understating Booked %. Work around it by recomputing
// the aggregate ourselves from the per-staff rows, excluding anyone with < 1 booked
// hour rather than trusting Mangomint's own "All Selected" total.
function aggregateUtilization(rows) {
  const active = rows.filter(r => r.booked >= 1);
  const excluded = rows.length - active.length;
  if (excluded > 0) {
    console.log(`  [Utilization] excluding ${excluded} staff with <1 booked hr (Mangomint archived-staff bug)`);
  }
  const avail = active.reduce((s, r) => s + r.avail, 0);
  const booked = active.reduce((s, r) => s + r.booked, 0);
  const availableHours = Math.round(avail * 100) / 100;
  if (avail === 0) return { utilization: null, availableHours };
  return { utilization: Math.round((booked / avail) * 10000) / 100, availableHours };
}

// ── Staff picker ──────────────────────────────────────────────────────────────
// Utilization and Retention reports each have their own staff multi-select,
// defaulting to "Active" staff only — archived staff are listed separately
// and unchecked by default. Click "Select all" to include them so terminated/
// archived staff still count toward historical hours and retention totals.
// Trigger class is stable across report types: "...staffSelectorTriggerBtn...".

async function selectAllStaff(page, snapPrefix) {
  console.log('  Selecting all staff (incl. archived)');
  await dismissOverlays(page);

  const trigger = page.locator('[class*="staffSelectorTriggerBtn"]').first();
  if (!await trigger.isVisible({ timeout: 4000 }).catch(() => false)) {
    console.warn('  [Staff] trigger not found — skipping (will use default/active-only)');
    return;
  }
  await trigger.click();
  await page.waitForTimeout(800);
  if (snapPrefix) await snap(page, `${snapPrefix}_before_staff`);

  const selectAll = page.getByText('Select all', { exact: true });
  if (await selectAll.count().catch(() => 0) === 0) {
    console.warn('  [Staff] "Select all" option not found');
    await page.keyboard.press('Escape');
    return;
  }
  await selectAll.last().click();
  await page.waitForTimeout(500);
  console.log('  [Staff] selected all (active + archived)');
  if (snapPrefix) await snap(page, `${snapPrefix}_after_staff`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
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
function parseSalesTotal(text) {
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

// The "August 2026"-style preset click in selectPeriod is unreliable for BOTH
// the current month (it hits inert calendar-header text, not a real option) and,
// since ~Sep 2026, completed past months too (Mangomint stopped surfacing full
// month names as selectable dropdown options — "Option \"August 2026\" not
// found" — so Generate quietly runs against whatever default range is loaded,
// which after a month rollover is a single day → every completed-month sales
// figure collapsed to $0). Retention already sidesteps the picker entirely by
// rewriting the iframe settings URL with explicit dates; sales and utilization
// now do the same for every month. Flow: let Generate produce *a* report (any
// range) so the iframe exists, harvest its real settings (staffIds, locationIds,
// report name) from the URL, then rewrite timePeriodStart/EndExclusive and
// reload in a fresh page.
async function fetchSalesWindow(page, startStr, endExclusiveStr, locationIds = null, staffIds = null) {
  const frame = page.frames().find(
    f => f.url().includes('/api/v1/reports/total-sales') && f.url().includes('/html')
  );
  if (!frame) { console.warn('  [Sales window] iframe not found'); return null; }

  let settings;
  try {
    const urlObj = new URL(frame.url());
    settings = JSON.parse(urlObj.searchParams.get('settings') || '{}');
  } catch (e) {
    console.warn('  [Sales window] could not parse settings:', e.message);
    return null;
  }

  settings.timePeriodStart        = startStr;
  settings.timePeriodEndExclusive = endExclusiveStr;
  applyLocationIds(settings, locationIds, 'Sales window');
  applyStaffIds(settings, staffIds);

  const urlObj2 = new URL(frame.url());
  urlObj2.searchParams.set('settings', JSON.stringify(settings));
  console.log(`  [Sales window] range→${startStr}..${endExclusiveStr}`);

  const p = await page.context().newPage();
  try {
    await p.goto(urlObj2.toString(), { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(3000);
    const text = await p.evaluate(() => document.body?.innerText || '');
    return parseSalesTotal(text);
  } finally {
    await p.close();
  }
}

// 1st of month → tomorrow (exclusive, so today is included) for the current
// month's MTD sales figure.
function salesMTDWindow() {
  const now = ptNow();
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { start: `${yyyy}-${mm}-01`, endExclusive: fmt(tomorrow) };
}

async function fetchSales(page, base, monthOption, snapPrefix, location = null, isCurrent = false, monthsAgo = 0, locationIds = null, staffIds = null) {
  console.log(`\n  [Sales] ${monthOption}${location ? ` [${location}]` : ''}`);

  await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await dismissOverlays(page);

  await page.getByText('Sales Summary', { exact: true }).first().click();
  await settle(page, 3000);

  await selectPeriod(page, monthOption, `${snapPrefix}_sales`);
  await settle(page, 1000);
  await dismissOverlays(page);

  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 7000);
  await snap(page, `${snapPrefix}_sales_generated`);

  // Don't trust the picker (see fetchSalesWindow) — always re-fetch against an
  // explicit date range: 1st→tomorrow for the current month, the full calendar
  // month for a completed one.
  const win = isCurrent ? salesMTDWindow() : completedMonthWindow(monthsAgo);
  const windowed = await fetchSalesWindow(page, win.start, win.endExclusive, locationIds, staffIds).catch(e => {
    console.warn('  [Sales window] error, falling back to full-report read:', e.message);
    return null;
  });
  if (windowed !== null) return windowed;
  // The Generate frame covers all locations and staff — never report it as one
  // location's or one staff group's number.
  if (locationIds || staffIds) return null;

  const text = await getReportFrameText(page);
  if (!text) return null;
  return parseSalesTotal(text);
}

/**
 * Business Intelligence: Appointments → Hours Booked %.
 * Recomputed from the per-staff rows (see aggregateUtilization) rather than trusting
 * Mangomint's own "All Selected" row, because archived staff can carry stale available
 * hours into months they never worked, inflating Avail and understating Booked %.
 * For the current month, we first generate the full-month report to capture the iframe
 * URL (which contains staffIds, locationIds, etc.), then open a second page with
 * timePeriodEndExclusive set to tomorrow — giving true MTD utilization.
 */
// Same underlying Mangomint quirk as fetchSalesWindow: for the current, incomplete
// month, the "August 2026"-style preset click in selectPeriod silently fails to
// apply (it's an inert calendar header until the month is complete), so the
// report Generate produces stayed on the default "Today" range. The previous
// version of this function only rewrote timePeriodEndExclusive and inherited
// timePeriodStart from that broken frame — so the "MTD" fetch was really still
// just today→tomorrow, a single day, not the 1st-of-month→today range it
// claimed to be. Now takes both bounds explicitly so callers control the window.
async function fetchUtilizationWindow(page, startStr, endExclusiveStr, locationIds = null, staffIds = null) {
  const frame = page.frames().find(
    f => f.url().includes('/reports/business-intelligence/appointments') && f.url().includes('/html')
  );
  if (!frame) { console.warn('  [Util window] iframe not found'); return null; }

  let settings;
  try {
    const urlObj = new URL(frame.url());
    settings = JSON.parse(urlObj.searchParams.get('settings') || '{}');
  } catch(e) {
    console.warn('  [Util window] could not parse settings:', e.message);
    return null;
  }

  settings.timePeriodStart = startStr;
  settings.timePeriodEndExclusive = endExclusiveStr;
  applyLocationIds(settings, locationIds, 'Util window');
  applyStaffIds(settings, staffIds);

  const urlObj2 = new URL(frame.url());
  urlObj2.searchParams.set('settings', JSON.stringify(settings));
  const windowUrl = urlObj2.toString();
  console.log(`  [Util window] range→${startStr}..${endExclusiveStr}`);

  const p = await page.context().newPage();
  try {
    await p.goto(windowUrl, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(3000);
    const text = await p.evaluate(() => document.body?.innerText || '');
    const rows = parseStaffAvailBooked(text);
    if (!rows) { console.warn('  [Util window] Staff rows not found'); return null; }
    const agg = aggregateUtilization(rows);
    console.log(`  [Util window] Avail=${agg.availableHours}, %=${agg.utilization}`);
    return agg.utilization === null ? null : agg;
  } finally {
    await p.close();
  }
}

// 1st-of-month → tomorrow (MTD, exclusive) and 1st-of-month → 1st-of-next-month
// (full month, including future scheduled hours) in the account's local time.
function currentMonthWindows() {
  const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, '0');
  const monthStart = `${yyyy}-${mm}-01`;

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const mtdEnd = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const fullMonthEnd = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`;

  return { monthStart, mtdEnd, fullMonthEnd };
}

// 1st of a completed month → 1st of the following month (exclusive), in the
// account's local time. monthsAgo is 1-based here (1 = last month).
function completedMonthWindow(monthsAgo) {
  const n = ptNow();
  const start = new Date(n.getFullYear(), n.getMonth() - monthsAgo, 1);
  const end   = new Date(n.getFullYear(), n.getMonth() - monthsAgo + 1, 1);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { start: fmt(start), endExclusive: fmt(end) };
}

async function fetchUtilization(page, base, monthOption, snapPrefix, isCurrent = false, location = null, monthsAgo = 0, locationIds = null, staffIds = null) {
  console.log(`\n  [Utilization] ${monthOption}${location ? ` [${location}]` : ''}`);

  await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await dismissOverlays(page);

  await page.getByText('Business Intelligence: Appointments', { exact: true }).first().click();
  await settle(page, 3000);

  await selectPeriod(page, monthOption, `${snapPrefix}_util`);
  await settle(page, 1000);
  await selectAllStaff(page, snapPrefix ? `${snapPrefix}_util` : null);
  await dismissOverlays(page);

  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 7000);
  await snap(page, `${snapPrefix}_util_generated`);

  // The frame Generate just produced is only trustworthy as-is for a completed
  // month's full-month preset. For the current month that preset silently failed
  // to apply (see fetchUtilizationWindow), so its date range is actually just
  // "today" — reading availableHours straight from it would badly understate the
  // full month's scheduled hours. Read it directly only for non-current months.
  const frameText = await getReportFrameText(page);
  let frameAvail = null;
  let frameRows = null;
  if (frameText) {
    frameRows = parseStaffAvailBooked(frameText);
    if (frameRows) {
      frameAvail = aggregateUtilization(frameRows).availableHours;
      console.log(`  [Utilization] frame Avail=${frameAvail} (after archived-staff filter)`);
    }
  }

  if (isCurrent) {
    const { monthStart, mtdEnd, fullMonthEnd } = currentMonthWindows();
    const [fullMonth, mtd] = await Promise.all([
      fetchUtilizationWindow(page, monthStart, fullMonthEnd, locationIds, staffIds).catch(e => {
        console.warn('  [Util window] full-month error:', e.message);
        return null;
      }),
      fetchUtilizationWindow(page, monthStart, mtdEnd, locationIds, staffIds).catch(e => {
        console.warn('  [Util window] MTD error:', e.message);
        return null;
      }),
    ]);
    if (mtd !== null) {
      // % booked stays MTD, but Avail hrs shows the full month's scheduled
      // availability (incl. future days), not just hours available through today.
      return { utilization: mtd.utilization, availableHours: fullMonth?.availableHours ?? ((locationIds || staffIds) ? null : frameAvail) };
    }
  }

  // Completed month: the picker preset can't be trusted either (see
  // fetchSalesWindow) — the frame Generate produced may be on a stale 1-day
  // default range after a month rollover. Re-fetch against the explicit full
  // calendar month instead of reading that frame directly.
  if (!isCurrent) {
    const { start, endExclusive } = completedMonthWindow(monthsAgo);
    const windowed = await fetchUtilizationWindow(page, start, endExclusive, locationIds, staffIds).catch(e => {
      console.warn('  [Util window] completed-month error:', e.message);
      return null;
    });
    if (windowed) {
      return { utilization: windowed.utilization, availableHours: windowed.availableHours };
    }
  }

  if (locationIds || staffIds) return null; // Generate frame is all-locations/staff, see fetchSales
  if (!frameRows) {
    console.warn(`  [Utilization] Staff rows not found. Lines: ${frameText ? frameText.split('\n').slice(0, 8).join(' | ') : 'n/a'}`);
    return null;
  }
  const agg = aggregateUtilization(frameRows);
  console.log(`  [Utilization] All Selected (filtered) → Avail=${agg.availableHours}, %=${agg.utilization}`);
  return agg.utilization === null ? null : { utilization: agg.utilization, availableHours: frameAvail };
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
// After generating the retention report (to capture iframe URL+settings), open a
// second page with explicit start/end dates for the rolling window (see fetchRetention).
async function fetchRetentionWindow(page, startStr, endExclusiveStr, locationIds = null, staffIds = null) {
  const frame = page.frames().find(
    f => f.url().includes('/api/v1/reports/') && f.url().includes('/html')
  );
  if (!frame) { console.warn('  [Retention window] iframe not found'); return null; }

  let settings;
  try {
    const urlObj = new URL(frame.url());
    settings = JSON.parse(urlObj.searchParams.get('settings') || '{}');
  } catch(e) {
    console.warn('  [Retention window] could not parse settings:', e.message);
    return null;
  }

  settings.timePeriodStart         = startStr;
  settings.timePeriodEndExclusive  = endExclusiveStr;
  applyLocationIds(settings, locationIds, 'Retention window');
  applyStaffIds(settings, staffIds);

  const urlObj2 = new URL(frame.url());
  urlObj2.searchParams.set('settings', JSON.stringify(settings));
  console.log(`  [Retention window] ${startStr} → ${endExclusiveStr}`);

  const p = await page.context().newPage();
  try {
    await p.goto(urlObj2.toString(), { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(3000);
    return await p.evaluate(() => document.body?.innerText || '');
  } finally {
    await p.close();
  }
}

const RETENTION_WINDOW_DAYS = 60;
// Stamped on cached months so a window change re-fetches just retention, not every metric.
const RETENTION_METHOD = `rolling${RETENTION_WINDOW_DAYS}`;

async function fetchRetention(page, base, monthOption, snapPrefix, monthsAgo = 0, location = null, locationIds = null, staffIds = null) {
  console.log(`\n  [Retention] ${monthOption}${location ? ` [${location}]` : ''}`);

  await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await dismissOverlays(page);

  await page.getByText('Client Retention', { exact: true }).first().click();
  await settle(page, 3000);

  await selectPeriod(page, monthOption, `${snapPrefix}_ret`);
  await settle(page, 1000);
  await selectAllStaff(page, snapPrefix ? `${snapPrefix}_ret` : null);
  await dismissOverlays(page);

  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 7000);
  await snap(page, `${snapPrefix}_ret_generated`);

  // Window: rolling RETENTION_WINDOW_DAYS ending on the month's last day (through
  // today for the current month). Each month is its own discrete figure — the
  // quarterly manager view averages the months, it never spans the quarter in one
  // report. (2026-06-28 → 2026-10-07 this was quarter-start → month-end, which made
  // "monthly" bars cumulative within each quarter; Morgan restored rolling 60 days.)
  //   on Oct 7 (end exclusive): Oct = Aug 9 → Oct 8   Sep = Aug 2 → Oct 1   Aug = Jul 3 → Sep 1
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const endDate = monthsAgo === 0
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    : new Date(now.getFullYear(), now.getMonth() - monthsAgo + 1, 1);
  const startDate = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - RETENTION_WINDOW_DAYS);

  const windowText = await fetchRetentionWindow(page, fmt(startDate), fmt(endDate), locationIds, staffIds).catch(e => {
    console.warn('  [Retention window] error, falling back to the generated report:', e.message);
    return null;
  });
  if (!windowText && (locationIds || staffIds)) return null; // Generate frame is all-locations/staff, see fetchSales
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

/**
 * Business Intelligence: Sales → "Avg Product Total Per Sale" (manager pages'
 * "Product Sales per Service"). Summary row:
 *   Selected Staff Total | # Sales | Avg Product Total Per Sale | Avg Service Total Per Sale | Avg # of Products Per Sale
 * Same harvest-then-rewrite flow as the other reports: Generate once (all staff,
 * incl. archived), then reload with explicit dates/locations/staff. Also returns
 * # Sales so quarter figures can be weighted correctly.
 */
async function fetchProductPerSale(page, base, monthsAgo, isCurrent, locationIds = null, staffIds = null) {
  console.log(`\n  [Product/sale] ${monthLabel(monthsAgo)}`);
  await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await dismissOverlays(page);
  await page.getByText('Business Intelligence: Sales', { exact: true }).first().click();
  await settle(page, 3000);
  await selectAllStaff(page, null);
  await dismissOverlays(page);
  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 7000);

  const frame = page.frames().find(f => f.url().includes('/reports/business-intelligence/sales') && f.url().includes('/html'));
  if (!frame) throw new Error('BI Sales iframe not found');
  const url = new URL(frame.url());
  const settings = JSON.parse(url.searchParams.get('settings') || '{}');
  const win = isCurrent ? salesMTDWindow() : completedMonthWindow(monthsAgo);
  settings.timePeriodStart        = win.start;
  settings.timePeriodEndExclusive = win.endExclusive;
  applyLocationIds(settings, locationIds, 'Product/sale');
  applyStaffIds(settings, staffIds);
  url.searchParams.set('settings', JSON.stringify(settings));

  const p = await page.context().newPage();
  try {
    await p.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(3000);
    const text = await p.evaluate(() => document.body?.innerText || '');
    const line = text.split('\n').find(l => l.startsWith('Selected Staff Total\t'));
    if (!line) { console.warn(`  [Product/sale] summary row not found. First lines: ${text.split('\n').slice(0, 4).join(' | ')}`); return null; }
    const cols = parseRow(line);
    const salesCount = parseInt(cols[1], 10) || 0;
    const productPerSale = parseDollar(cols[2]);
    console.log(`  [Product/sale] ${win.start}..${win.endExclusive}: ${cols[2]} over ${salesCount} sales`);
    return { productPerSale, salesCount };
  } finally {
    await p.close();
  }
}

// Supply Cost % comes from the accountant's Google Sheet ("Supply Cost % KPI"),
// read through its CSV export (the sheet is link-shared, so no credentials).
// Layout: row 1 = headers (blank, "Skin & Sage - Esti Team", "Skin & Sage - LMT Team",
// "Waxon"); then one row per month labelled like "October 2026" with "36%" cells.
// Returns { esti: { 'October 2026': 36 }, lmt: {...}, waxon: {...} }.
const SUPPLY_SHEET_CSV = process.env.SUPPLY_SHEET_CSV ||
  'https://docs.google.com/spreadsheets/d/1hkzoEyDnJXmyC7fPXsP62bm_M9qQs6XYVibkCkM4jJE/export?format=csv&gid=0';

async function fetchSupplyCosts() {
  const res = await fetch(SUPPLY_SHEET_CSV, { redirect: 'follow' });
  if (!res.ok) throw new Error(`supply sheet HTTP ${res.status}`);
  const rows = (await res.text()).trim().split(/\r?\n/).map(l => l.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
  const header = rows[0] || [];
  const colFor = re => header.findIndex(h => re.test(h));
  const cols = { esti: colFor(/esti/i), lmt: colFor(/lmt/i), waxon: colFor(/wax/i) };
  const out = { esti: {}, lmt: {}, waxon: {} };
  for (const row of rows.slice(1)) {
    const month = row[0];
    if (!month) continue;
    for (const [k, i] of Object.entries(cols)) {
      if (i < 0) continue;
      const v = parseFloat((row[i] || '').replace('%', ''));
      if (!isNaN(v)) out[k][month] = v;
    }
  }
  console.log(`[Supply] ${Object.keys(out.waxon).length} WAXON / ${Object.keys(out.esti).length} Esti / ${Object.keys(out.lmt).length} LMT months from sheet`);
  return out;
}

// ── Account scraper ───────────────────────────────────────────────────────────

// New browser context logged into an account's Mangomint via its cookie secret.
// Returns { context, page, base }; throws if the cookies have expired.
async function openAccount(browser, account) {
  const raw = process.env[account.cookieEnv];
  if (!raw) throw new Error(`${account.cookieEnv} not set`);

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
  // Remember the headers Mangomint's own app sends on its /api/v1 calls (auth
  // token, app version) so staffRoles.js can call the same JSON endpoints.
  const apiHeaders = {};
  page.on('request', req => {
    if (Object.keys(apiHeaders).length || !req.url().includes('app.mangomint.com/api/v1/')) return;
    for (const [k, v] of Object.entries(req.headers())) {
      if (!/^(cookie|content-length|content-type|host)$/i.test(k)) apiHeaders[k] = v;
    }
  });
  // Default Playwright actionability timeout is 30s per click attempt (x2 retries
  // x3 report types x4 periods = up to 12 minutes wasted on one account if every
  // click hits a blocking element). 12s is generous next to real click latency
  // (normally well under 2s) but caps worst-case cost if something's stuck.
  page.setDefaultTimeout(12000);
  const base = `https://app.mangomint.com/${account.locationId}`;

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await settle(page, 5000);
  if (page.url().includes('login')) {
    throw new Error(`${account.cookieEnv} expired — refresh the GitHub secret`);
  }
  console.log(`Logged in: ${page.url()}`);
  return { context, page, base, apiHeaders };
}

async function scrapeAccount(browser, account, cache) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Scraping: ${account.label}`);
  console.log('='.repeat(50));

  const { context, page, base } = await openAccount(browser, account);

  const monthsBack = account.monthsBack || 3;
  const periods = Array.from({ length: monthsBack }, (_, monthsAgo) => ({
    monthsAgo, label: monthLabel(monthsAgo), pickerLabel: monthPickerLabel(monthsAgo), isCurrent: monthsAgo === 0,
  }));

  const results = [];

  const cacheKey = account.locationKey || account.key;
  const location = account.location || null;
  const locationIds = account.locationIds || null;
  const staffIds = account.staffIds || null;
  const metrics = account.metrics || DEFAULT_METRICS;
  const bizCache = cache.businesses[cacheKey] || (cache.businesses[cacheKey] = { periods: {} });

  for (const p of periods) {
    const key    = periodKey(p.monthsAgo);
    const prefix = `${cacheKey}_${p.pickerLabel.replace(/\s/g, '_')}`;
    console.log(`\n── Period: ${p.label} (picker: "${p.pickerLabel}")${location ? ` [${location}]` : ''} ──`);

    // A month cached before 'pps' existed lacks productPerSale — refetch it once.
    const cached = bizCache.periods[key];
    if (!p.isCurrent && cached && cached.retentionMethod !== RETENTION_METHOD
        && (!metrics.includes('pps') || 'productPerSale' in cached)) {
      console.log(`  Cached ${key} has ${cached.retentionMethod || 'quarter-start'} retention — re-fetching retention only`);
      const r = await withRetry(() => fetchRetention(page, base, p.pickerLabel, prefix, p.monthsAgo, location, locationIds, staffIds), 'Ret');
      if (r) {
        Object.assign(cached, { retention: r.combined, existingRetPct: r.existingPct, newRetPct: r.newPct, retentionMethod: RETENTION_METHOD });
      }
    }
    if (!p.isCurrent && cached && cached.retentionMethod === RETENTION_METHOD
        && (!metrics.includes('pps') || 'productPerSale' in cached)) {
      console.log(`  Using cached data for ${key}`);
      results.push({ label: p.label, monthsAgo: p.monthsAgo, isCurrent: false, ...bizCache.periods[key] });
      continue;
    }

    if (account.openedPeriod && key < account.openedPeriod) {
      console.log(`  Before ${account.label} opened (${account.openedPeriod}) — skipping`);
      results.push({ label: p.label, monthsAgo: p.monthsAgo, isCurrent: p.isCurrent,
        sales: null, projectedSales: null, utilization: null, availableHours: null,
        retention: null, existingRetPct: null, newRetPct: null, productPerSale: null, productSalesCount: null });
      continue;
    }

    const sales      = metrics.includes('sales')
      ? await withRetry(() => fetchSales(page, base, p.pickerLabel, prefix, location, p.isCurrent, p.monthsAgo, locationIds, staffIds), 'Sales')
      : null;
    const utilResult = await withRetry(() => fetchUtilization(page, base, p.pickerLabel, prefix, p.isCurrent, location, p.monthsAgo, locationIds, staffIds), 'Util');
    const utilization    = utilResult?.utilization ?? null;
    const availableHours = utilResult?.availableHours ?? null;
    const retResult      = await withRetry(() => fetchRetention(page, base, p.pickerLabel, prefix, p.monthsAgo, location, locationIds, staffIds), 'Ret');
    const retention      = retResult?.combined ?? null;
    const existingRetPct = retResult?.existingPct ?? null;
    const newRetPct      = retResult?.newPct ?? null;
    const ppsResult      = metrics.includes('pps')
      ? await withRetry(() => fetchProductPerSale(page, base, p.monthsAgo, p.isCurrent, locationIds, staffIds), 'Product/sale')
      : null;
    const productPerSale    = ppsResult?.productPerSale ?? null;
    const productSalesCount = ppsResult?.salesCount ?? null;

    const daysElapsed = p.isCurrent ? dayOfMonth() : null;
    const totalDays   = p.isCurrent ? daysInMonth(0) : null;
    const projectedSales = (p.isCurrent && sales !== null && daysElapsed > 0)
      ? Math.round((sales / daysElapsed) * totalDays)
      : null;

    console.log(`  → sales=$${sales?.toLocaleString()} proj=$${projectedSales?.toLocaleString()} util=${utilization}% avail=${availableHours}h ret=${retention}% product/sale=$${productPerSale}`);

    const periodData = { sales, projectedSales, utilization, availableHours, retention, existingRetPct, newRetPct, retentionMethod: RETENTION_METHOD };
    if (metrics.includes('pps')) Object.assign(periodData, { productPerSale, productSalesCount });
    // Only cache a completed month once every metric actually came back —
    // otherwise a transient failure (e.g. a stuck overlay blocking a click)
    // gets baked in as permanent nulls until the cache schema version bumps.
    const complete = (!metrics.includes('sales') || sales !== null) && utilization !== null && retention !== null
      && (!metrics.includes('pps') || productPerSale !== null);
    if (!p.isCurrent && complete) bizCache.periods[key] = periodData;

    results.push({ label: p.label, monthsAgo: p.monthsAgo, isCurrent: p.isCurrent, ...periodData });
  }

  await context.close();
  return { key: cacheKey, label: account.label, periods: results };
}

// ── Staff role groups ─────────────────────────────────────────────────────────
// Works out which Mangomint staff ids are Estis vs LMTs for this run (staffRoles.js),
// and lists anyone with booked hours who lands in neither column so the owner
// dashboard can show it.

// Generate a report with all staff selected; return its iframe URL.
async function generateReportUrl(page, base, reportName, urlFragment, allStaff) {
  await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await dismissOverlays(page);
  await page.getByText(reportName, { exact: true }).first().click();
  await settle(page, 3000);
  if (allStaff) await selectAllStaff(page, null);
  await dismissOverlays(page);
  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 7000);
  const frame = page.frames().find(f => f.url().includes(urlFragment) && f.url().includes('/html'));
  if (!frame) throw new Error(`${reportName}: iframe not found`);
  return frame.url();
}

async function prepareStaffGroups(browser, account, cache) {
  const { context, page, base, apiHeaders } = await openAccount(browser, account);
  try {
    const utilUrl  = await generateReportUrl(page, base, 'Business Intelligence: Appointments', '/reports/business-intelligence/appointments', true);
    const salesUrl = await generateReportUrl(page, base, 'Service & Product Sales By Staff', '/api/v1/reports/sales-by-staff', true);
    const allStaffIds = JSON.parse(new URL(utilUrl).searchParams.get('settings') || '{}').staffIds || [];
    if (!allStaffIds.length) throw new Error('no staff ids in report settings');

    // Performed-services lookback for archived staff: comfortably wider than the dashboard.
    const lookbackStart = completedMonthWindow(6).start;
    const windowEnd     = currentMonthWindows().mtdEnd;
    await resolveRoles({
      page, apiHeaders, salesByStaffUrl: salesUrl, allStaffIds, store: cache.staffRoles,
      windowStart: lookbackStart, windowEndExclusive: windowEnd,
    });

    const idsFor = role => allStaffIds.filter(id => cache.staffRoles[id]?.role === role);
    const esti = idsFor('esti');
    const lmt  = idsFor('lmt');
    console.log(`  [Roles] esti=${JSON.stringify(esti)} lmt=${JSON.stringify(lmt)}`);

    // Anyone else who actually booked hours in the dashboard window is in neither column.
    const others = allStaffIds.filter(id => !esti.includes(id) && !lmt.includes(id));
    let notCounted = [];
    if (others.length) {
      const u = new URL(utilUrl);
      const settings = JSON.parse(u.searchParams.get('settings') || '{}');
      settings.timePeriodStart        = completedMonthWindow(account.monthsBack - 1).start;
      settings.timePeriodEndExclusive = windowEnd;
      settings.staffIds               = others;
      u.searchParams.set('settings', JSON.stringify(settings));
      const p = await context.newPage();
      await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(3000);
      const rows = parseStaffAvailBooked(await p.evaluate(() => document.body?.innerText || '')) || [];
      await p.close();
      notCounted = rows.filter(r => r.booked >= 1).map(r => r.name);
    }
    return { esti, lmt, notCounted };
  } finally {
    await context.close();
  }
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
  const businessData  = [];
  const locationData  = [];
  const groupData     = [];
  const errors = [];
  let notCounted = [];

  const nullPeriods = (monthsBack = 3) => Array.from({ length: monthsBack }, (_, monthsAgo) => ({
    label: monthLabel(monthsAgo), monthsAgo, isCurrent: monthsAgo === 0,
    sales: null, projectedSales: null, utilization: null, retention: null,
  }));

  try {
    for (const account of ACCOUNTS) {
      try {
        businessData.push(await scrapeAccount(browser, account, cache));
        saveCache(cache); // checkpoint — a run killed by the job timeout keeps what it fetched
      } catch (err) {
        console.error(`ERROR scraping ${account.label}: ${err.message}`);
        errors.push({ account: account.label, error: err.message });
        businessData.push({ key: account.key, label: account.label, error: err.message, periods: nullPeriods(account.monthsBack) });
      }
    }

    for (const account of LOCATION_ACCOUNTS) {
      try {
        locationData.push(await scrapeAccount(browser, account, cache));
        saveCache(cache);
      } catch (err) {
        console.error(`ERROR scraping ${account.label}: ${err.message}`);
        errors.push({ account: account.label, error: err.message });
        locationData.push({ key: account.locationKey, label: account.label, error: err.message, periods: nullPeriods(account.monthsBack) });
      }
    }

    let groups = null;
    try {
      groups = await prepareStaffGroups(browser, ACCOUNTS.find(a => a.key === 'skinsage'), cache);
      notCounted = groups.notCounted;
      if (notCounted.length) console.warn(`  [Roles] booked hours but neither Esti nor LMT: ${notCounted.join(', ')}`);
    } catch (err) {
      console.error(`  [Roles] failed: ${err.message}`);
    }

    for (const account of STAFF_GROUP_ACCOUNTS) {
      try {
        if (!groups) throw new Error('staff roles unavailable');
        account.staffIds = groups[account.role];
        if (!account.staffIds.length) throw new Error(`no ${account.role} staff found`);
        // Cached completed months were computed for a particular set of staff —
        // recompute them if the group's membership changed since.
        const sig = [...account.staffIds].sort((a, b) => a - b).join(',');
        const gc = cache.businesses[account.locationKey];
        if (gc && gc.staffSig !== sig) {
          console.log(`  [${account.label}] membership changed — dropping cached months`);
          gc.periods = {};
        }
        groupData.push(await scrapeAccount(browser, account, cache));
        cache.businesses[account.locationKey].staffSig = sig;
        saveCache(cache);
      } catch (err) {
        console.error(`ERROR scraping ${account.label}: ${err.message}`);
        errors.push({ account: `Skin & Sage ${account.label}`, error: err.message });
        groupData.push({ key: account.locationKey, label: account.label, error: err.message, periods: nullPeriods(account.monthsBack) });
      }
    }

  } finally {
    await browser.close();
  }

  saveCache(cache);

  let supply = { esti: {}, lmt: {}, waxon: {} };
  try {
    supply = await fetchSupplyCosts();
  } catch (err) {
    console.error(`[Supply] ${err.message}`);
  }
  const withSupply = (data, col) => data && data.periods
    ? { ...data, periods: data.periods.map(p => ({ ...p, supplyPct: supply[col][p.label] ?? null })) }
    : data;

  const generatedAt = new Date().toISOString();
  const notices = notCounted.length
    ? [`Skin &amp; Sage team page: <b>${notCounted.join(', ')}</b> had booked hours but no Signature Facial or massage services in Mangomint, so they're counted in neither the Esti nor the LMT column.`]
    : [];

  const html = generateHtml({
    businesses: businessData, locations: locationData, generatedAt, errors, notices,
  });

  const outFile = process.env.DASHBOARD_OUT || path.join(__dirname, '..', 'dashboard.html');
  fs.writeFileSync(outFile, html, 'utf8');
  console.log(`\nDashboard written: ${outFile}`);

  // Manager pages. KPIs: Client Retention, Product Sales per Service, Supply Cost %
  // (accountant's sheet), Bookable Hours. Skin & Sage: one column per role, quarterly
  // view. WAXON: one combined panel for both locations, monthly view (Morgan doesn't
  // want WAXON broken out by location).
  const byKey = Object.fromEntries([...businessData, ...locationData, ...groupData].map(d => [d.key, d]));
  const missing = (key, label) => byKey[key] || { key, label, error: 'No data', periods: [] };
  const teamPages = [
    {
      out: process.env.TEAM_SKINSAGE_OUT || path.join(__dirname, '..', 'team-skinsage.html'),
      title: 'Skin &amp; Sage Team',
      columns: 2,
      view: 'quarterly',
      panels: [
        { data: withSupply(missing('skinsage_esti', 'Estheticians'), 'esti'),      supply: true },
        { data: withSupply(missing('skinsage_lmt',  'Massage Therapists'), 'lmt'), supply: true },
      ],
      note: 'Each column counts only that role’s providers, at both locations · Quarterly goals: last quarter, then each month this quarter · headline = quarter to date',
    },
    {
      out: process.env.TEAM_WAXON_OUT || path.join(__dirname, '..', 'team-waxon.html'),
      title: 'WAXON Team',
      columns: 1,
      view: 'monthly',
      panels: [
        { data: withSupply(missing('waxon', 'WAXON'), 'waxon'), supply: true },
      ],
      note: 'Monthly goals · Belltown and Capitol Hill combined · headline = month to date',
    },
  ];
  for (const t of teamPages) {
    fs.writeFileSync(t.out, generateTeamHtml({ ...t, generatedAt }), 'utf8');
    console.log(`Team page written: ${t.out}`);
  }

  if (errors.length > 0) {
    console.error(`\n${errors.length} account(s) had errors`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
