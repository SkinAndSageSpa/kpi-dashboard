/**
 * probe.js
 * Navigates to each of the three KPI report pages in both Mangomint accounts
 * and captures screenshots + page text to map selectors for scraper.js.
 *
 * Reports to probe:
 *   Sales         → Reports → Sales → Sales Summary
 *   Utilization   → Reports → Business → Business Intelligence: Appointments
 *   Retention     → Reports → Business → Client Retention
 *
 * Env vars:
 *   SKINSAGE_MANGOMINT_COOKIES
 *   WAXON_MANGOMINT_COOKIES
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/kpi-probe-screenshots';
const ACCOUNT_FILTER = process.env.PROBE_ACCOUNT || 'both'; // 'both' | 'skinsage' | 'waxon'

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

function saveText(label, content) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const file = path.join(SCREENSHOT_DIR, `${label}.txt`);
  fs.writeFileSync(file, content, 'utf8');
  console.log(`  [text] ${file}`);
}

async function dumpClasses(page, label) {
  const names = await page.evaluate(() => {
    const s = new Set();
    document.querySelectorAll('[class]').forEach(el =>
      el.className.split(/\s+/).forEach(c => { if (c) s.add(c); })
    );
    return [...s].sort();
  });
  saveText(label, names.join('\n'));
}

async function probeReport(page, accountName, reportName, navigateFn) {
  const prefix = `${accountName}_${reportName}`;
  console.log(`\n  --- Probing: ${reportName} ---`);

  try {
    await navigateFn(page);
    await settle(page, 4000);
    await snap(page, `${prefix}_01_loaded`);

    const bodyText = await page.locator('body').innerText().catch(() => '');
    saveText(`${prefix}_page_text`, `URL: ${page.url()}\n\n${bodyText}`);
    await dumpClasses(page, `${prefix}_classes`);

    // Try clicking Generate / Run if visible
    for (const label of ['Generate', 'Run', 'Apply', 'Submit']) {
      const btn = page.getByText(label, { exact: true }).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        console.log(`  Clicking "${label}" button...`);
        await btn.click();
        await settle(page, 4000);
        await snap(page, `${prefix}_02_after_generate`);
        const afterText = await page.locator('body').innerText().catch(() => '');
        saveText(`${prefix}_after_generate_text`, afterText);
        await dumpClasses(page, `${prefix}_after_generate_classes`);
        break;
      }
    }
  } catch (err) {
    console.error(`  ERROR probing ${reportName}: ${err.message}`);
    await snap(page, `${prefix}_ERROR`);
  }
}

async function probeAccount(browser, account) {
  const raw = process.env[account.cookieEnv];
  if (!raw) {
    console.warn(`SKIP ${account.name}: ${account.cookieEnv} not set`);
    return;
  }

  console.log(`\n====== Probing ${account.name} (location ${account.locationId}) ======`);

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

  // Verify session
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await settle(page, 5000);
  if (page.url().includes('login')) {
    console.error(`  SESSION EXPIRED — ${account.cookieEnv} needs refresh`);
    await snap(page, `${account.name}_login_expired`);
    await context.close();
    return;
  }
  console.log(`  Session OK: ${page.url()}`);
  await snap(page, `${account.name}_00_home`);

  // ── 1. Sales Summary ────────────────────────────────────────────────────────
  await probeReport(page, account.name, 'sales_summary', async (p) => {
    await p.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
    await settle(p, 3000);
    await snap(p, `${account.name}_reports_landing`);

    // Try to find Sales section and Sales Summary sub-item
    const salesLink = p.getByText('Sales', { exact: true }).first();
    if (await salesLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await salesLink.click();
      await settle(p, 2000);
      await snap(p, `${account.name}_sales_category`);
    }
    const summaryLink = p.getByText('Sales Summary', { exact: true }).first();
    if (await summaryLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await summaryLink.click();
      await settle(p, 2000);
    }
  });

  // ── 2. Business Intelligence: Appointments ──────────────────────────────────
  await probeReport(page, account.name, 'business_intelligence', async (p) => {
    await p.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
    await settle(p, 3000);

    const bizLink = p.getByText('Business', { exact: true }).first();
    if (await bizLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await bizLink.click();
      await settle(p, 2000);
      await snap(p, `${account.name}_business_category`);
    }
    // Try "Business Intelligence" link
    const biLink = p.getByText('Business Intelligence', { exact: false }).first();
    if (await biLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await biLink.click();
      await settle(p, 2000);
    }
    // May need to click an "Appointments" sub-tab
    const apptTab = p.getByText('Appointments', { exact: true }).first();
    if (await apptTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await apptTab.click();
      await settle(p, 2000);
    }
  });

  // ── 3. Client Retention ─────────────────────────────────────────────────────
  await probeReport(page, account.name, 'client_retention', async (p) => {
    await p.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
    await settle(p, 3000);

    const bizLink = p.getByText('Business', { exact: true }).first();
    if (await bizLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await bizLink.click();
      await settle(p, 2000);
    }
    const retLink = p.getByText('Client Retention', { exact: true }).first();
    if (await retLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await retLink.click();
      await settle(p, 2000);
    }
    // Try switching to Custom time period so we can see the date picker
    const customOption = p.getByText('Custom', { exact: true }).first();
    if (await customOption.isVisible({ timeout: 3000 }).catch(() => false)) {
      await customOption.click();
      await settle(p, 2000);
    } else {
      // Look for a time period dropdown and open it
      const periodDropdown = p.locator('[class*="period"], [class*="Period"], [class*="date"], [class*="Date"]').first();
      if (await periodDropdown.isVisible({ timeout: 2000 }).catch(() => false)) {
        await periodDropdown.click();
        await settle(p, 1500);
        await snap(p, `${account.name}_retention_period_dropdown`);
      }
    }
  });

  await context.close();
  console.log(`\n  Done probing ${account.name}`);
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

  console.log(`\nProbe complete. Download the artifact and review screenshots.`);
}

main().catch(e => { console.error(e); process.exit(1); });
