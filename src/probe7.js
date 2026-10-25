/**
 * probe7.js — Memberships Started / Memberships Cancellations inspector (read-only).
 * For each account: dumps the Reports list text, opens each report, generates it,
 * saves the iframe URL/settings, then re-fetches it with explicit date ranges
 * (this month MTD, last month) via the same settings URL rewrite the scraper uses.
 *
 * These reports list individual clients and this repo's artifacts are public, so
 * report output is never saved raw — summarize() reduces it to column headers,
 * row counts and per-column aggregates in the runner, and redact() scrubs any
 * email/phone that slips through. No screenshots are taken once a report is open.
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const PROBE_DIR = process.env.PROBE_DIR || '/tmp/probe7-results';
const ACCOUNTS = [
  { key: 'skinsage', locationId: '560372', cookieEnv: 'SKINSAGE_MANGOMINT_COOKIES' },
  { key: 'waxon',    locationId: '812513', cookieEnv: 'WAXON_MANGOMINT_COOKIES' },
];

fs.mkdirSync(PROBE_DIR, { recursive: true });

function save(name, text) {
  fs.writeFileSync(path.join(PROBE_DIR, name), String(text), 'utf8');
  console.log(`  Saved: ${name} (${String(text).length} chars)`);
}

const PII_HEADER  = /\b(client|customer|member|name|first|last|phone|mobile|cell|email|e-mail|address|note|notes|comment|comments|dob|birthday)\b/i;
const SAFE_HEADER = /membership|plan|location|reason|status|type/i;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const PHONE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
const DATE  = /^(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2} \d{1,2},? \d{4})/;
const MONEY = /^-?\$?-?[\d,]+(\.\d+)?$/;

function redact(s) {
  return String(s).replace(EMAIL, '[email]').replace(PHONE, '[phone]');
}

// Report innerText (tab-separated rows) → aggregate-only summary. Values are only
// listed for non-PII columns that repeat (≤15 distinct, ≤ half the row count), so
// per-client columns never get enumerated even if their header looks harmless.
function summarize(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const head = lines.findIndex(l => l.split('\t').length >= 3);
  if (head < 0) return { headerFound: false, lineCount: lines.length };
  const headers = lines[head].split('\t').map(h => h.trim());
  const rows = [], totals = [];
  for (const l of lines.slice(head + 1)) {
    const cells = l.split('\t').map(c => c.trim());
    if (cells.length < 2) continue;
    (/^totals?$/i.test(cells[0]) ? totals : rows).push(cells);
  }
  const columns = headers.map((h, i) => {
    const vals = rows.map(r => r[i] ?? '').filter(v => v !== '');
    const col = { header: h, nonEmpty: vals.length };
    if (PII_HEADER.test(h) && !SAFE_HEADER.test(h)) { col.redacted = true; return col; }
    if (vals.length && vals.every(v => MONEY.test(v))) {
      col.kind = 'number';
      col.sum = vals.reduce((a, v) => a + (parseFloat(v.replace(/[$,]/g, '')) || 0), 0);
      return col;
    }
    if (vals.length && vals.every(v => DATE.test(v))) {
      col.kind = 'date';
      col.perDay = {};
      for (const v of vals) { const d = v.match(DATE)[0]; col.perDay[d] = (col.perDay[d] || 0) + 1; }
      return col;
    }
    const counts = {};
    for (const v of vals) counts[v] = (counts[v] || 0) + 1;
    const distinct = Object.keys(counts).length;
    col.distinct = distinct;
    if (distinct <= 15 && distinct <= vals.length / 2) col.valueCounts = counts;
    return col;
  });
  // Total row: keep only cells under columns that weren't redacted.
  const totalRows = totals.map(t => Object.fromEntries(
    headers.map((h, i) => [h, columns[i].redacted ? '[redacted]' : (t[i] ?? '')])));
  return {
    headerFound: true,
    preamble: lines.slice(0, head).filter(l => l.length <= 80).slice(0, 8),
    rowCount: rows.length,
    columns,
    totalRows,
  };
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

    for (const [tag, report] of [['started', 'Memberships Started'], ['cancel', 'Memberships Cancellations']]) {
      await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
      await settle(page, 3000);
      await dismissOverlays(page);
      await page.getByText(report, { exact: true }).first().click();
      await settle(page, 3000);
      save(`${acct.key}_${tag}_form.txt`, await page.evaluate(() => document.body.innerText.split('DATA EXPORT').pop()));
      await page.screenshot({ path: path.join(PROBE_DIR, `${acct.key}_${tag}_form.png`), fullPage: true });
      await dismissOverlays(page);
      await page.getByText('Generate', { exact: true }).first().click();
      await settle(page, 8000);
      const frame = page.frames().find(f => f.url().includes('/html'));
      if (!frame) { console.warn(`  ${report}: no /html report frame`); continue; }
      const url = new URL(frame.url());
      const settings = JSON.parse(url.searchParams.get('settings') || '{}');
      save(`${acct.key}_${tag}_settings.json`, JSON.stringify({ url: frame.url().split('?')[0], settings }, null, 2));
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
      const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
      const windows = [
        ['mtd',       ymd(new Date(now.getFullYear(), now.getMonth(), 1)),     ymd(tomorrow)],
        ['lastmonth', ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), ymd(new Date(now.getFullYear(), now.getMonth(), 1))],
      ];
      for (const [w, start, end] of windows) {
        const s2 = { ...settings, timePeriodStart: start, timePeriodEndExclusive: end };
        const u = new URL(frame.url());
        u.searchParams.set('settings', JSON.stringify(s2));
        const p = await context.newPage();
        await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
        await p.waitForTimeout(4000);
        const summary = summarize(await p.evaluate(() => document.body?.innerText || ''));
        const out = redact(JSON.stringify({ window: `${start}..${end}`, ...summary }, null, 2));
        save(`${acct.key}_${tag}_${w}.json`, out);
        console.log(`  ${report} ${w}: ${summary.rowCount ?? '?'} rows, headers: ${(summary.columns || []).map(c => c.header).join(' | ')}`);
        await p.close();
      }
    }
  } catch (e) {
    // No error screenshot — the page may have a generated report on it.
    console.error(`  ${acct.key} failed: ${redact(e.message)}`);
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
