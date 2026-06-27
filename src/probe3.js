/**
 * probe3.js
 * Three focused goals:
 *   1. Open the date picker on Sales Summary + BI: Appointments → screenshot what options appear
 *   2. Open the period dropdown on Client Retention → screenshot options
 *   3. For each generated report, extract ALL text from every cell via page.evaluate
 *      so we can see the "All Selected" / total row values for BI and Retention
 *
 * Runs against one account at a time (set PROBE_ACCOUNT=skinsage or waxon).
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/kpi-probe3';
const ACCOUNT_FILTER = process.env.PROBE_ACCOUNT || 'skinsage';

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
  console.log(`  [snap] ${file}`);
}

function save(name, content) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SCREENSHOT_DIR, `${name}.txt`), content, 'utf8');
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

// Dismiss any open overlay/popup (phone panel, notifications, etc.)
async function dismissOverlays(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  // Click somewhere neutral in the top-left of the content area
  try { await page.mouse.click(700, 500); } catch {}
  await page.waitForTimeout(300);
}

// Click on the date period picker (identified by its current text) and capture the open dropdown.
// Returns the list of visible option texts.
async function openAndCapturePicker(page, currentText, snapLabel) {
  console.log(`  Opening picker: "${currentText}"`);
  await dismissOverlays(page);

  // Find the element that shows the current period text — it's the dropdown trigger.
  // We restrict to the main content area to avoid matching the sidebar.
  const trigger = page.locator('main, [class*="content"], [class*="Content"]')
    .getByText(currentText, { exact: false }).first();

  if (!await trigger.isVisible({ timeout: 5000 }).catch(() => false)) {
    // Fallback: try anywhere on page
    const fallback = page.getByText(currentText, { exact: false }).first();
    await fallback.waitFor({ state: 'visible', timeout: 5000 });
    await fallback.click();
  } else {
    await trigger.click();
  }

  await page.waitForTimeout(2000);
  await snap(page, snapLabel);

  // Extract ALL visible text from any newly-appeared overlay/dropdown
  const allText = await page.evaluate(() => {
    const results = [];
    // Look for any fixed/absolute positioned elements (dropdown overlays)
    document.querySelectorAll('*').forEach(el => {
      const style = window.getComputedStyle(el);
      if ((style.position === 'fixed' || style.position === 'absolute') &&
           style.display !== 'none' && style.visibility !== 'hidden' &&
           el.offsetHeight > 20 && el.offsetWidth > 50) {
        const t = (el.innerText || '').trim();
        if (t && t.length > 2 && t.length < 500) results.push(t);
      }
    });
    return [...new Set(results)];
  });

  console.log(`  Overlay text (${allText.length} elements):`);
  allText.forEach(t => console.log(`    - ${t.replace(/\n/g, ' | ')}`));
  save(`${snapLabel}_overlay_text`, allText.join('\n---\n'));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  return allText;
}

// Extract ALL cell values from the generated report using DOM queries.
async function extractAllCells(page, snapLabel) {
  const result = await page.evaluate(() => {
    const rows = [];
    // Try standard tables
    document.querySelectorAll('table tr').forEach(tr => {
      const cells = [...tr.querySelectorAll('td, th')].map(c => (c.innerText || '').trim());
      if (cells.some(c => c)) rows.push(cells);
    });
    // Also try div-based rows (React tables with role="row")
    document.querySelectorAll('[role="row"]').forEach(tr => {
      const cells = [...tr.querySelectorAll('[role="cell"], [role="columnheader"]')]
        .map(c => (c.innerText || '').trim());
      if (cells.some(c => c)) rows.push(cells);
    });
    // Try any element with class containing "row" or "Row"
    if (rows.length === 0) {
      document.querySelectorAll('[class*="tableRow"], [class*="TableRow"], [class*="dataRow"], [class*="DataRow"]').forEach(tr => {
        const cells = [...tr.children].map(c => (c.innerText || '').trim());
        if (cells.some(c => c)) rows.push(cells);
      });
    }
    return rows;
  });

  const txt = result.map(r => r.join('\t')).join('\n');
  save(`${snapLabel}_cells`, txt || '(no cells found)');
  console.log(`  Extracted ${result.length} rows. Preview:`);
  result.slice(0, 5).forEach(r => console.log(`    ${r.join(' | ')}`));
  if (result.length > 5) console.log(`    ... and ${result.length - 5} more`);
  return result;
}

async function probeAccount(browser, account) {
  const raw = process.env[account.cookieEnv];
  if (!raw) { console.warn(`SKIP ${account.name}: not set`); return; }

  console.log(`\n====== ${account.name} ======`);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US', timezoneId: 'America/Los_Angeles',
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  await context.addCookies(parseCookies(raw));

  const page = await context.newPage();
  const base = `https://app.mangomint.com/${account.locationId}`;
  const n = account.name;

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await settle(page, 5000);
  if (page.url().includes('login')) {
    console.error(`SESSION EXPIRED`); await snap(page, `${n}_expired`); await context.close(); return;
  }

  // ── 1. Sales Summary: open date picker + generate + extract cells ────────────
  console.log('\n--- Sales Summary ---');
  try {
    await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
    await settle(page, 3000);
    await dismissOverlays(page);
    await page.getByText('Sales Summary', { exact: true }).first().click();
    await settle(page, 3000);
    await snap(page, `${n}_sales_01_form`);

    await openAndCapturePicker(page, 'Today', `${n}_sales_02_picker`);

    // Try clicking "This Month" if it appeared
    const thisMonth = page.getByText('This Month', { exact: false }).first();
    if (await thisMonth.isVisible({ timeout: 2000 }).catch(() => false)) {
      await thisMonth.click();
      await settle(page, 1500);
      console.log('  Selected "This Month"');
    } else {
      console.warn('  "This Month" not found — keeping default period');
    }
    await snap(page, `${n}_sales_03_period_set`);

    await page.getByText('Generate', { exact: true }).first().click();
    await settle(page, 5000);
    await snap(page, `${n}_sales_04_generated`);
    await extractAllCells(page, `${n}_sales`);
  } catch (err) {
    console.error(`Sales ERROR: ${err.message}`); await snap(page, `${n}_sales_ERROR`);
  }

  // ── 2. Business Intelligence: Appointments: same + full cell extraction ─────
  console.log('\n--- BI: Appointments ---');
  try {
    await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
    await settle(page, 3000);
    await dismissOverlays(page);
    await page.getByText('Business Intelligence: Appointments', { exact: true }).first().click();
    await settle(page, 3000);
    await snap(page, `${n}_bi_01_form`);

    await openAndCapturePicker(page, 'Today', `${n}_bi_02_picker`);

    const thisMonthBI = page.getByText('This Month', { exact: false }).first();
    if (await thisMonthBI.isVisible({ timeout: 2000 }).catch(() => false)) {
      await thisMonthBI.click();
      await settle(page, 1500);
      console.log('  Selected "This Month"');
    } else {
      console.warn('  "This Month" not found — keeping default period');
    }
    await snap(page, `${n}_bi_03_period_set`);

    await page.getByText('Generate', { exact: true }).first().click();
    await settle(page, 5000);
    await snap(page, `${n}_bi_04_generated`);
    await extractAllCells(page, `${n}_bi`);
  } catch (err) {
    console.error(`BI ERROR: ${err.message}`); await snap(page, `${n}_bi_ERROR`);
  }

  // ── 3. Client Retention: open month picker, try to navigate to prior months ─
  console.log('\n--- Client Retention ---');
  try {
    await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
    await settle(page, 3000);
    await dismissOverlays(page);
    await page.getByText('Client Retention', { exact: true }).first().click();
    await settle(page, 3000);
    await snap(page, `${n}_ret_01_form`);

    // The period shows a month, e.g. "June 2026"
    const monthText = await page.locator('body').innerText().then(t => {
      const m = t.match(/(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}/);
      return m ? m[0] : null;
    }).catch(() => null);
    console.log(`  Current month period: "${monthText}"`);

    if (monthText) {
      await openAndCapturePicker(page, monthText, `${n}_ret_02_picker`);
      // Check if "Custom" or specific months appeared
      for (const opt of ['Custom', 'This Month', 'Last Month']) {
        if (await page.getByText(opt, { exact: true }).first().isVisible({ timeout: 1000 }).catch(() => false)) {
          console.log(`  Found option: "${opt}"`);
        }
      }
    }

    await dismissOverlays(page);

    // Click Generate with current defaults
    await page.getByText('Generate', { exact: true }).first().click();
    await settle(page, 5000);
    await snap(page, `${n}_ret_03_generated`);
    await extractAllCells(page, `${n}_ret`);

    // Also capture full page HTML snippet around the table for selector analysis
    const tableHtml = await page.evaluate(() => {
      const t = document.querySelector('table');
      return t ? t.outerHTML.slice(0, 5000) : 'no <table> found';
    });
    save(`${n}_ret_table_html`, tableHtml);
  } catch (err) {
    console.error(`Retention ERROR: ${err.message}`); await snap(page, `${n}_ret_ERROR`);
  }

  await context.close();
}

async function main() {
  console.log(`Screenshots → ${SCREENSHOT_DIR}`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    for (const account of ACCOUNTS) await probeAccount(browser, account);
  } finally {
    await browser.close();
  }
  console.log('\nProbe3 done.');
}

main().catch(e => { console.error(e); process.exit(1); });
