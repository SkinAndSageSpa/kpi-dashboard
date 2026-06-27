/**
 * scraper.js
 * Scrapes KPI data from both Mangomint accounts and writes dashboard.html.
 *
 * Reports (confirmed from probe runs):
 *   Sales Summary        → /reports → "Sales Summary" → month picker → Generate
 *                          Parse: "Total" row → last dollar value = Adjusted Total
 *
 *   Business Intelligence: Appointments → month picker → Generate
 *                          Parse: "All Selected" row → Hours Booked %
 *                          Column layout: [Staff] [Avail.#] [Booked#] [Booked%] ...
 *
 *   Client Retention     → month picker (months, not date range) → Generate
 *                          Parse: sum each staff's Existing/New Retained-180 # and Total #
 *                          Formula: (existingRetained180 + newRetained180) / (existingTotal + newTotal)
 *
 * Date picker options (confirmed): "June 2026", "May 2026", "April 2026", "Custom Time Period", ...
 * Tables are div-based (no <table> element) — parse via document.body.textContent.
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

// "June 2026" for N months ago
function monthPickerLabel(monthsAgo = 0) {
  const n = ptNow();
  const d = new Date(n.getFullYear(), n.getMonth() - monthsAgo, 1);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// "June 2026" → display label for the dashboard
function monthLabel(monthsAgo = 0) {
  return monthPickerLabel(monthsAgo);
}

// Days in month N months ago
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
// Confirmed options: "June 2026", "May 2026", "April 2026", "Custom Time Period", ...
// The trigger shows the current selection ("Today (Jun 27)" or "June 2026" etc.).
// Mangomint uses hashed React CSS Modules — never target by class name here.
//
// Edge case: when the picker already shows "June 2026" AND the dropdown also lists
// "June 2026", we have two elements with the same text in the DOM.
// Using .last() picks the dropdown item (rendered later in DOM order than the trigger).

async function selectPeriod(page, targetOption, snapPrefix) {
  console.log(`  Selecting period: "${targetOption}"`);
  await dismissOverlays(page);

  // Click the picker trigger — matches any visible period text.
  // Probe confirmed: "Today (Jun 27)", month names like "June 2026", etc.
  const PERIOD_RE = /Today \(|Yesterday \(|This Week|Last Week|Last Two|Custom|January|February|March|April|May|June|July|August|September|October|November|December/;
  const trigger = page.getByText(PERIOD_RE, { exact: false }).first();
  if (!await trigger.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.warn('  Period trigger not found — skipping selectPeriod');
    return;
  }
  await trigger.click();
  await page.waitForTimeout(1800);
  if (snapPrefix) await snap(page, `${snapPrefix}_picker_open`);

  // Click target option. Use .last() to avoid re-clicking the trigger when
  // trigger text matches option text (both showing same month name).
  const options = page.getByText(targetOption, { exact: true });
  const count = await options.count().catch(() => 0);
  if (count === 0) {
    console.warn(`  Option "${targetOption}" not found — closing picker`);
    await page.keyboard.press('Escape');
    return;
  }
  await options.last().click();
  await page.waitForTimeout(800);
  console.log(`  Selected: "${targetOption}" (${count} match(es), clicked last)`);
}

// ── Parsing: get all body text via textContent (CSS-agnostic) ─────────────────
// The report tables are div-based (no <table> element confirmed in probe runs).
// document.body.textContent captures all text regardless of CSS visibility.

async function bodyTextContent(page) {
  return page.evaluate(() => document.body.textContent || '');
}

// Parse "$1,234.56" → 1234.56
function parseDollar(str) {
  const n = parseFloat((str || '').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

// Parse "78.33" or "78.33%" → 78.33
function parsePct(str) {
  const n = parseFloat((str || '').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

// Parse an integer from a string like "133" or "133\n"
function parseCount(str) {
  const n = parseInt((str || '').replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? null : n;
}

// ── Report fetchers ───────────────────────────────────────────────────────────

/**
 * Sales Summary → Adjusted Total for the month.
 * Table columns: Date | # Sales | # Services | Service Sales | # Products |
 *   Product Sales | Subtotal | Taxes | Tips | Gross Total | Refunds | Adjusted Total
 * "Total" row at bottom has the month aggregate.
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
  await settle(page, 6000);
  await snap(page, `${snapPrefix}_sales_generated`);

  // Wait for "Total" row to appear in the DOM
  await page.getByText('Total', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

  const text = await bodyTextContent(page);

  // The "Total" row ends with the Adjusted Total dollar value.
  // Pattern in body text: "Total" ... "$X,XXX.XX" (last dollar in the Total line context)
  // Strategy: split on "Total", take the chunk after the last "Total", find last dollar amount.
  const totalIdx = text.lastIndexOf('Total');
  if (totalIdx === -1) {
    console.warn('  [Sales] "Total" not found in page text');
    await snap(page, `${snapPrefix}_sales_parse_fail`);
    return null;
  }

  const afterTotal = text.slice(totalIdx, totalIdx + 500);
  const dollars = [...afterTotal.matchAll(/\$[\d,]+\.?\d*/g)].map(m => parseDollar(m[0]));
  if (dollars.length === 0) {
    console.warn('  [Sales] No dollar amounts found after "Total"');
    return null;
  }

  // The Adjusted Total is the LAST dollar value on the Total row
  const adjustedTotal = dollars[dollars.length - 1];
  console.log(`  [Sales] Adjusted Total = $${adjustedTotal?.toLocaleString()}`);
  return adjustedTotal;
}

/**
 * Business Intelligence: Appointments → Hours Booked % for "All Selected" (all staff).
 * Table: [Staff] [Hours: Avail.# Booked# %] [Appointments(All): Total# ...] [Appointments(New): ...]
 * "All Selected" summary row appears at the bottom after all staff rows.
 */
async function fetchUtilization(page, base, monthOption, snapPrefix) {
  console.log(`\n  [Utilization] ${monthOption}`);

  await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await dismissOverlays(page);

  await page.getByText('Business Intelligence: Appointments', { exact: true }).first().click();
  await settle(page, 3000);

  await selectPeriod(page, monthOption, `${snapPrefix}_util`);
  await settle(page, 1000);

  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 6000);
  await snap(page, `${snapPrefix}_util_generated`);

  // Wait for the generated report text to appear
  await page.getByText('All Selected', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

  const text = await bodyTextContent(page);

  // "All Selected" row: look for "All Selected" then read Avail, Booked, % in sequence.
  // The body text chunk after "All Selected" contains: avail# \n booked# \n pct% \n ...
  const allSelectedIdx = text.indexOf('All Selected');
  if (allSelectedIdx === -1) {
    // Fallback: look for the last occurrence of a standalone percentage after the table header
    // The "%" column value for the total is the last standalone % number in the Hours section
    console.warn('  [Utilization] "All Selected" not found — trying percentage fallback');
    const pctMatches = [...text.matchAll(/(\d{1,3}\.\d{2})/g)].map(m => parseFloat(m[1]));
    const util = pctMatches.find(n => n > 0 && n <= 100) ?? null;
    console.log(`  [Utilization] fallback util = ${util}%`);
    return util;
  }

  // Extract the chunk after "All Selected"
  const afterAllSelected = text.slice(allSelectedIdx + 'All Selected'.length, allSelectedIdx + 200);
  // Numbers appear as: avail# \n booked# \n pct \n ...
  const nums = [...afterAllSelected.matchAll(/(\d+\.?\d*)/g)].map(m => parseFloat(m[1]));
  // nums[0] = avail#, nums[1] = booked#, nums[2] = booked%
  const util = nums.length >= 3 ? nums[2] : (nums.length >= 1 ? nums[0] : null);
  console.log(`  [Utilization] All Selected Hours Booked% = ${util}%`);
  return util;
}

/**
 * Client Retention → (existingRetained180 + newRetained180) / (existingTotal + newTotal)
 * Table: [Staff] [Existing: Total# | Ret30#% | Ret60#% | Ret90#% | Ret180#%] [New: Total# | ...]
 * Sums across all staff rows.
 */
async function fetchRetention(page, base, monthOption, snapPrefix) {
  console.log(`\n  [Retention] ${monthOption}`);

  await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await dismissOverlays(page);

  await page.getByText('Client Retention', { exact: true }).first().click();
  await settle(page, 3000);

  await selectPeriod(page, monthOption, `${snapPrefix}_ret`);
  await settle(page, 1000);

  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 6000);
  await snap(page, `${snapPrefix}_ret_generated`);

  const text = await bodyTextContent(page);

  // The retention table structure (from screenshots):
  //   Existing Clients section: Total # | Ret30 #% | Ret60 #% | Ret90 #% | Ret180 #%
  //   New Clients section:      Total # | Ret30 #% | Ret60 #% | Ret90 #% | Ret180 #%
  //
  // We need to sum ACROSS ALL STAFF (not just read one row).
  // Strategy: locate "Existing Clients" and "New Clients" section starts,
  // then extract and sum the relevant column values from all staff rows.
  //
  // Alternative simpler strategy: the body text contains all numbers. We parse
  // each staff row as a repeating pattern and sum columns by position.
  //
  // Each staff row in the Existing section has this value pattern:
  //   [total#] [ret30#] [ret30%] [ret60#] [ret60%] [ret90#] [ret90%] [ret180#] [ret180%]
  // Then the New Clients section for the same staff row:
  //   [total#] [ret30#] [ret30%] [ret60#] [ret60%] [ret90#] [ret90%] [ret180#] [ret180%]
  //
  // We'll try using Playwright's locator to directly target the "Retained within 180 days" columns.

  // Approach: find all elements with "Retained within\n180 days" in headers,
  // then get values in those columns for all rows, including the totals row if present.
  //
  // Simpler backup: look for a "Total" summary row at the bottom which sums all staff.
  // If that exists, read from it. Otherwise sum individual rows.

  const totalIdx = text.lastIndexOf('\nTotal\n');
  let existingTotal = null, existingRet180 = null, newTotal = null, newRet180 = null;

  if (totalIdx !== -1) {
    // Total row pattern: [existingTotal, ret30#, ret30%, ret60#, ret60%, ret90#, ret90%, ret180#, ret180%, newTotal, ...]
    const afterTotal = text.slice(totalIdx, totalIdx + 400);
    const nums = [...afterTotal.matchAll(/(\d+\.?\d*)/g)].map(m => parseFloat(m[1]));
    // Column layout confirmed from screenshots:
    // Existing: [0]=total, [1]=ret30#, [2]=ret30%, [3]=ret60#, [4]=ret60%, [5]=ret90#, [6]=ret90%, [7]=ret180#, [8]=ret180%
    // New:      [9]=total, [10]=ret30#, [11]=ret30%, ... [16]=ret180#, [17]=ret180%
    if (nums.length >= 18) {
      existingTotal  = nums[0];
      existingRet180 = nums[7];
      newTotal       = nums[9];
      newRet180      = nums[16];
    } else if (nums.length >= 9) {
      existingTotal  = nums[0];
      existingRet180 = nums[7];
    }
  }

  if (existingTotal === null) {
    // No "Total" row — sum across all staff rows by scanning the text.
    // Each staff name is followed by numbers. This is fragile but better than nothing.
    // We look for the pattern between "Existing Clients" and "New Clients" headers.
    const existingStart = text.indexOf('Existing Clients');
    const newStart = text.indexOf('New Clients');
    if (existingStart !== -1 && newStart !== -1) {
      const existingSection = text.slice(existingStart, newStart);
      const newSection = text.slice(newStart, newStart + 2000);

      // In each section, after the header row, numbers appear in repeating groups.
      // Group: total#, ret30#, ret30%, ret60#, ret60%, ret90#, ret90%, ret180#, ret180%
      const existingNums = [...existingSection.matchAll(/(\d+\.?\d*)/g)].map(m => parseFloat(m[1]));
      const newNums      = [...newSection.matchAll(/(\d+\.?\d*)/g)].map(m => parseFloat(m[1]));

      // Skip the header row numbers (column count label like "9" or "0") and sum column 0 and column 7
      // This is an approximation — sum of all total# values and all ret180# values
      let exTotal = 0, exRet180 = 0, nTotal = 0, nRet180 = 0;
      const GROUP = 9; // values per staff row
      for (let i = 0; i + GROUP <= existingNums.length; i += GROUP) {
        exTotal  += existingNums[i];
        exRet180 += existingNums[i + 7];
      }
      for (let i = 0; i + GROUP <= newNums.length; i += GROUP) {
        nTotal  += newNums[i];
        nRet180 += newNums[i + 7];
      }
      existingTotal = exTotal; existingRet180 = exRet180;
      newTotal = nTotal;       newRet180 = nRet180;
    }
  }

  const totalClients = (existingTotal || 0) + (newTotal || 0);
  const retained     = (existingRet180 || 0) + (newRet180 || 0);
  const retention = totalClients > 0 ? Math.round(retained / totalClients * 100) : null;

  console.log(`  [Retention] existing total=${existingTotal} ret180=${existingRet180}`);
  console.log(`  [Retention] new total=${newTotal} ret180=${newRet180}`);
  console.log(`  [Retention] retention = ${retention}%`);
  return retention;
}

// ── Account scraper ───────────────────────────────────────────────────────────

async function scrapeAccount(browser, account) {
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
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  await context.addCookies(parseCookies(raw));

  const page = await context.newPage();
  const base = `https://app.mangomint.com/${account.locationId}`;

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await settle(page, 5000);
  if (page.url().includes('login')) throw new Error(`${account.cookieEnv} expired — refresh the secret`);
  console.log(`Logged in: ${page.url()}`);

  const periods = [
    { monthsAgo: 0, label: monthLabel(0), pickerLabel: monthPickerLabel(0), isCurrent: true  },
    { monthsAgo: 1, label: monthLabel(1), pickerLabel: monthPickerLabel(1), isCurrent: false },
    { monthsAgo: 2, label: monthLabel(2), pickerLabel: monthPickerLabel(2), isCurrent: false },
  ];

  const results = [];

  for (const p of periods) {
    const prefix = `${account.key}_${p.pickerLabel.replace(/\s/g, '_')}`;
    console.log(`\n── Period: ${p.label} (picker: "${p.pickerLabel}") ──`);

    const sales       = await fetchSales(page, base, p.pickerLabel, prefix);
    const utilization = await fetchUtilization(page, base, p.pickerLabel, prefix);
    const retention   = await fetchRetention(page, base, p.pickerLabel, prefix);

    // Project end-of-month sales for current month
    const daysElapsed = p.isCurrent ? dayOfMonth() : null;
    const totalDays   = p.isCurrent ? daysInMonth(0) : null;
    const projectedSales = (p.isCurrent && sales !== null && daysElapsed > 0)
      ? Math.round((sales / daysElapsed) * totalDays)
      : null;

    results.push({
      label: p.label, monthsAgo: p.monthsAgo, isCurrent: p.isCurrent,
      sales, projectedSales, utilization, retention,
    });
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

  const businessData = [];
  const errors = [];

  try {
    for (const account of ACCOUNTS) {
      try {
        businessData.push(await scrapeAccount(browser, account));
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
