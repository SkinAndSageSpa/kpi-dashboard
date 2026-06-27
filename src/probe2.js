/**
 * probe2.js
 * Targeted second probe: navigates directly to each KPI report, opens the
 * month picker to see available options, clicks Generate, and captures the
 * full output so we can map the data selectors.
 *
 * Run after probe.js — this one requires knowing that the sidebar items are
 * directly clickable from /reports without intermediate category clicks.
 *
 * Env vars:
 *   SKINSAGE_MANGOMINT_COOKIES  (optional — skip if expired)
 *   WAXON_MANGOMINT_COOKIES
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/kpi-probe-screenshots';
const ACCOUNT_FILTER = process.env.PROBE_ACCOUNT || 'both';

const ACCOUNTS = [
  { name: 'skinsage', locationId: '560372', cookieEnv: 'SKINSAGE_MANGOMINT_COOKIES' },
  { name: 'waxon',    locationId: '812513', cookieEnv: 'WAXON_MANGOMINT_COOKIES'    },
].filter(a => ACCOUNT_FILTER === 'both' || a.name === ACCOUNT_FILTER);

let _step = 0;
async function snap(page, label) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  _step++;
  const file = path.join(SCREENSHOT_DIR, `${String(_step).padStart(2, '0')}_${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
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

function save(label, content) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SCREENSHOT_DIR, `${label}.txt`), content, 'utf8');
}

// Click a sidebar report item by exact name, wait for the right panel to update.
async function clickReport(page, reportName) {
  console.log(`  Clicking sidebar: "${reportName}"`);
  // The sidebar items are in the left panel; use a locator scoped to the left panel
  // to avoid matching any heading in the right panel.
  const sidebar = page.locator('nav, [class*="sidebar"], [class*="Sidebar"], [class*="leftPanel"], [class*="LeftPanel"], [class*="reportList"], [class*="ReportList"]').first();
  let clicked = false;

  if (await sidebar.isVisible({ timeout: 2000 }).catch(() => false)) {
    const item = sidebar.getByText(reportName, { exact: true }).first();
    if (await item.isVisible({ timeout: 2000 }).catch(() => false)) {
      await item.click();
      clicked = true;
    }
  }

  // Fallback: click anywhere on the page that matches the exact text
  if (!clicked) {
    const item = page.getByText(reportName, { exact: true }).first();
    await item.waitFor({ state: 'visible', timeout: 5000 });
    await item.click();
  }

  await settle(page, 3000);
}

// Open a dropdown (identified by its current visible label text) and capture
// the options. Returns the list of option texts.
async function openDropdownAndCapture(page, currentLabel, snapLabel) {
  console.log(`  Opening dropdown showing: "${currentLabel}"`);
  const trigger = page.getByText(currentLabel, { exact: true }).first();
  if (!await trigger.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.warn(`  Dropdown "${currentLabel}" not found`);
    return [];
  }
  await trigger.click();
  await page.waitForTimeout(1500);
  await snap(page, snapLabel);

  // Grab all visible option texts from any open listbox/menu
  const optionTexts = await page.evaluate(() => {
    const selectors = [
      '[role="option"]', '[role="listbox"] li', '[role="menu"] li',
      '[class*="option"]', '[class*="Option"]', '[class*="dropdownItem"]',
      '[class*="DropdownItem"]', '[class*="menuItem"]', '[class*="MenuItem"]',
    ];
    const texts = new Set();
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        const t = (el.innerText || '').trim();
        if (t) texts.add(t);
      });
    }
    return [...texts];
  });
  console.log(`  Dropdown options: ${optionTexts.join(' | ')}`);
  save(`${snapLabel}_options`, optionTexts.join('\n'));

  // Close dropdown without selecting anything
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  return optionTexts;
}

async function probeAccount(browser, account) {
  const raw = process.env[account.cookieEnv];
  if (!raw) {
    console.warn(`SKIP ${account.name}: ${account.cookieEnv} not set`);
    return;
  }

  console.log(`\n====== Probing ${account.name} ======`);

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
  const n    = account.name;

  // Verify session
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await settle(page, 5000);
  if (page.url().includes('login')) {
    console.error(`  SESSION EXPIRED — ${account.cookieEnv} needs refresh`);
    await snap(page, `${n}_login_expired`);
    await context.close();
    return;
  }

  // ── 1. Sales Summary ────────────────────────────────────────────────────────
  console.log('\n--- Sales Summary ---');
  try {
    await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
    await settle(page, 3000);
    await clickReport(page, 'Sales Summary');
    await snap(page, `${n}_sales_01_loaded`);

    // Capture the current state of all visible text so we know control labels
    save(`${n}_sales_01_text`, await page.locator('body').innerText().catch(() => ''));

    // Open the month/period dropdown — it will show "June 2026" or similar
    // Find any dropdown-like element in the report area
    const reportArea = page.locator('main, [class*="reportContent"], [class*="ReportContent"], [class*="content"]').first();
    const dropdowns  = reportArea.locator('[class*="select"], [class*="Select"], [class*="dropdown"], [class*="Dropdown"], [class*="picker"], [class*="Picker"]');
    const dCount = await dropdowns.count();
    console.log(`  Found ${dCount} dropdown-like elements in report area`);
    for (let i = 0; i < Math.min(dCount, 3); i++) {
      const txt = (await dropdowns.nth(i).innerText().catch(() => '')).trim();
      console.log(`    dropdown[${i}]: "${txt}"`);
    }

    // Try clicking the first dropdown (date picker)
    if (dCount > 0) {
      await dropdowns.first().click().catch(() => {});
      await page.waitForTimeout(1500);
      await snap(page, `${n}_sales_02_datepicker_open`);
      const opts = await page.evaluate(() => {
        const texts = [];
        document.querySelectorAll('[role="option"], [class*="option"], [class*="Option"], li').forEach(el => {
          const t = (el.innerText || '').trim();
          if (t && t.length < 50) texts.push(t);
        });
        return [...new Set(texts)];
      });
      console.log(`  Date picker options: ${opts.slice(0, 12).join(' | ')}`);
      save(`${n}_sales_datepicker_options`, opts.join('\n'));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }

    // Click Generate
    await page.getByText('Generate', { exact: true }).first().click();
    await settle(page, 5000);
    await snap(page, `${n}_sales_03_generated`);
    save(`${n}_sales_03_text`, await page.locator('body').innerText().catch(() => ''));

    // Dump all visible numeric/dollar values and their surrounding labels
    const numbers = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('td, th, [class*="value"], [class*="Value"], [class*="total"], [class*="Total"], [class*="amount"], [class*="Amount"]').forEach(el => {
        const t = (el.innerText || '').trim();
        if (/\$[\d,]+/.test(t) || /^\d[\d,]*\.?\d*$/.test(t)) {
          const parent = el.closest('tr') || el.parentElement;
          results.push({ value: t, context: (parent?.innerText || '').trim().slice(0, 100) });
        }
      });
      return results.slice(0, 30);
    });
    save(`${n}_sales_numbers`, JSON.stringify(numbers, null, 2));

  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    await snap(page, `${n}_sales_ERROR`);
  }

  // ── 2. Business Intelligence: Appointments ──────────────────────────────────
  console.log('\n--- Business Intelligence: Appointments ---');
  try {
    await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
    await settle(page, 3000);
    await clickReport(page, 'Business Intelligence: Appointments');
    await snap(page, `${n}_bi_01_loaded`);
    save(`${n}_bi_01_text`, await page.locator('body').innerText().catch(() => ''));

    // Open the date/period picker
    const allDropdowns = page.locator('[class*="select"], [class*="Select"], [class*="dropdown"], [class*="Dropdown"]');
    const bCount = await allDropdowns.count();
    console.log(`  ${bCount} dropdown(s) visible`);
    if (bCount > 0) {
      await allDropdowns.first().click().catch(() => {});
      await page.waitForTimeout(1500);
      await snap(page, `${n}_bi_02_datepicker_open`);
      const opts = await page.evaluate(() => {
        const texts = [];
        document.querySelectorAll('[role="option"], [class*="option"], [class*="Option"], li').forEach(el => {
          const t = (el.innerText || '').trim();
          if (t && t.length < 50) texts.push(t);
        });
        return [...new Set(texts)];
      });
      save(`${n}_bi_datepicker_options`, opts.join('\n'));
      console.log(`  Options: ${opts.slice(0, 10).join(' | ')}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }

    // Click Generate
    await page.getByText('Generate', { exact: true }).first().click();
    await settle(page, 5000);
    await snap(page, `${n}_bi_03_generated`);
    save(`${n}_bi_03_text`, await page.locator('body').innerText().catch(() => ''));

    // Look specifically for the "All Selected / Hours / Booked / %" value
    const tableText = await page.locator('table').allInnerTexts().catch(() => []);
    save(`${n}_bi_tables`, tableText.join('\n\n--- TABLE ---\n\n'));

  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    await snap(page, `${n}_bi_ERROR`);
  }

  // ── 3. Client Retention ─────────────────────────────────────────────────────
  console.log('\n--- Client Retention ---');
  try {
    await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
    await settle(page, 3000);
    await clickReport(page, 'Client Retention');
    await snap(page, `${n}_ret_01_loaded`);
    save(`${n}_ret_01_text`, await page.locator('body').innerText().catch(() => ''));

    // Open the "Time period of initial client visits" dropdown
    // It shows the current month, e.g. "June 2026"
    const allDropdowns = page.locator('[class*="select"], [class*="Select"], [class*="dropdown"], [class*="Dropdown"]');
    const rCount = await allDropdowns.count();
    console.log(`  ${rCount} dropdown(s) visible`);

    // Open each dropdown to see the options
    for (let i = 0; i < Math.min(rCount, 3); i++) {
      const label = (await allDropdowns.nth(i).innerText().catch(() => '')).trim();
      console.log(`  Opening dropdown[${i}]: "${label}"`);
      await allDropdowns.nth(i).click().catch(() => {});
      await page.waitForTimeout(1500);
      await snap(page, `${n}_ret_dropdown_${i}_open`);
      const opts = await page.evaluate(() => {
        const texts = [];
        document.querySelectorAll('[role="option"], [class*="option"], [class*="Option"], li').forEach(el => {
          const t = (el.innerText || '').trim();
          if (t && t.length < 80) texts.push(t);
        });
        return [...new Set(texts)];
      });
      save(`${n}_ret_dropdown_${i}_options`, opts.join('\n'));
      console.log(`  Options: ${opts.slice(0, 12).join(' | ')}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
    }

    // Click Generate with defaults first to see the table structure
    await page.getByText('Generate', { exact: true }).first().click();
    await settle(page, 5000);
    await snap(page, `${n}_ret_02_generated`);
    save(`${n}_ret_02_text`, await page.locator('body').innerText().catch(() => ''));

    const retTables = await page.locator('table').allInnerTexts().catch(() => []);
    save(`${n}_ret_tables`, retTables.join('\n\n--- TABLE ---\n\n'));

  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    await snap(page, `${n}_ret_ERROR`);
  }

  await context.close();
  console.log(`\nDone: ${account.name}`);
}

async function main() {
  console.log(`Screenshots → ${SCREENSHOT_DIR}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    for (const account of ACCOUNTS) {
      await probeAccount(browser, account);
    }
  } finally {
    await browser.close();
  }

  console.log('\nProbe2 complete.');
}

main().catch(e => { console.error(e); process.exit(1); });
