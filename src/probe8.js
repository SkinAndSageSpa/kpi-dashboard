/**
 * probe8.js — Apps → Memberships list inspector (read-only).
 * Goal: find where Mangomint exposes the live list of memberships + status, so the
 * dashboard can count "Active" memberships each day for the current month.
 *
 * This repo's artifacts and logs are public and the list is per-client, so nothing
 * is saved raw: no screenshots, page text is reduced to UI labels / column headers /
 * aggregate counts, and API responses are reduced to their shape (keys, array
 * lengths) plus value counts for status-like fields only.
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const PROBE_DIR = process.env.PROBE_DIR || '/tmp/probe8-results';
const ACCOUNTS = [
  { key: 'skinsage', locationId: '560372', cookieEnv: 'SKINSAGE_MANGOMINT_COOKIES' },
  { key: 'waxon',    locationId: '812513', cookieEnv: 'WAXON_MANGOMINT_COOKIES' },
];

fs.mkdirSync(PROBE_DIR, { recursive: true });

function save(name, obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  fs.writeFileSync(path.join(PROBE_DIR, name), redact(text), 'utf8');
  console.log(`  Saved: ${name} (${text.length} chars)`);
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const PHONE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
function redact(s) { return String(s).replace(EMAIL, '[email]').replace(PHONE, '[phone]'); }

const STATUS_KEY = /status|state|active|canceled|cancelled|paused|frozen|plan|type|location/i;
const PII_KEY    = /name|first|last|email|phone|mobile|address|note|comment|birth|dob|client(?!Count)|customer/i;

// JSON → shape only. Arrays: length + merged element shape. Status-like scalar
// fields under arrays get value counts (only if ≤20 distinct); everything else
// is reduced to its type.
function shape(v, depth = 0) {
  if (depth > 5) return '…';
  if (Array.isArray(v)) {
    const out = { _array: v.length };
    if (v.length && v.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
      const keys = {};
      for (const el of v) for (const k of Object.keys(el)) (keys[k] ||= []).push(el[k]);
      out.items = {};
      for (const [k, vals] of Object.entries(keys)) {
        const scalars = vals.filter(x => x === null || ['string', 'number', 'boolean'].includes(typeof x));
        if (scalars.length === vals.length) {
          const entry = { type: [...new Set(vals.map(x => x === null ? 'null' : typeof x))].join('|') };
          if (STATUS_KEY.test(k) && !PII_KEY.test(k)) {
            const counts = {};
            for (const x of vals) counts[String(x)] = (counts[String(x)] || 0) + 1;
            if (Object.keys(counts).length <= 20) entry.counts = counts;
          }
          out.items[k] = entry;
        } else {
          out.items[k] = shape(vals.find(x => x && typeof x === 'object') ?? null, depth + 1);
        }
      }
    }
    return out;
  }
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (x && typeof x === 'object') out[k] = shape(x, depth + 1);
      else if (typeof x === 'number' && /count|total|size|page/i.test(k)) out[k] = x;   // pagination totals are the point
      else out[k] = x === null ? 'null' : typeof x;
    }
    return out;
  }
  return v === null ? 'null' : typeof v;
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

// Non-PII UI chrome: buttons, tabs, selects, headers, column headers. Long or
// person-looking strings are dropped.
async function uiLabels(page) {
  return page.evaluate(() => {
    const pick = sel => [...new Set([...document.querySelectorAll(sel)]
      .map(e => (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '))
      .filter(t => t && t.length <= 40))].slice(0, 60);
    return {
      headings: pick('h1, h2, h3, [class*="title" i], [class*="header" i] > *'),
      buttons:  pick('button, [role="button"], [role="tab"], a[class*="tab" i], [class*="Tab" i]'),
      selects:  pick('select, [class*="select" i], [class*="filter" i], [class*="dropdown" i]'),
      columnHeaders: pick('th, [role="columnheader"], [class*="headerCell" i], [class*="HeaderCell" i], [class*="columnHeader" i]'),
      tableRows: document.querySelectorAll('tr, [role="row"]').length,
    };
  });
}

// Count status-ish words in the page text without keeping the text.
async function statusWordCounts(page) {
  const text = await page.evaluate(() => document.body?.innerText || '');
  const counts = {};
  for (const w of ['Active', 'Canceled', 'Cancelled', 'Paused', 'Frozen', 'Expired', 'Pending', 'Past due', 'Failed', 'Inactive', 'Ended', 'Scheduled']) {
    const n = (text.match(new RegExp(`(^|[\\t\\n ])${w}([\\t\\n ]|$)`, 'g')) || []).length;
    if (n) counts[w] = n;
  }
  return { counts, lines: text.split('\n').length, hasTabs: text.includes('\t') };
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

  // Record every JSON API response from the moment Memberships is opened.
  const api = [];
  let recording = false;
  page.on('response', async res => {
    if (!recording) return;
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    try {
      const u = new URL(res.url());
      if (!u.hostname.endsWith('mangomint.com')) return;
      const body = await res.json();
      api.push({ method: res.request().method(), path: u.pathname, queryKeys: [...u.searchParams.keys()], status: res.status(), shape: shape(body) });
    } catch {}
  });

  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await settle(page, 5000);
    if (page.url().includes('login')) { console.error('Cookies expired'); return; }
    await dismissOverlays(page);

    // Apps → Memberships, via clicks (direct internal URLs can spin forever).
    const apps = page.locator('a, button, div, span').filter({ hasText: /^Apps$/ }).first();
    await apps.click();
    await settle(page, 3000);
    save(`${acct.key}_apps_url.txt`, page.url());
    save(`${acct.key}_apps_ui.json`, await uiLabels(page));

    recording = true;
    await page.getByText('Memberships', { exact: true }).first().click();
    await settle(page, 6000);
    await dismissOverlays(page);
    console.log(`  Memberships URL: ${page.url()}`);
    save(`${acct.key}_memberships_url.txt`, page.url());
    save(`${acct.key}_memberships_ui.json`, await uiLabels(page));
    save(`${acct.key}_memberships_status_words.json`, await statusWordCounts(page));

    // Scroll to trigger lazy loading / pagination, then re-count.
    for (let i = 0; i < 15; i++) { await page.mouse.wheel(0, 3000); await page.waitForTimeout(700); }
    await settle(page, 2000);
    save(`${acct.key}_memberships_status_words_scrolled.json`, await statusWordCounts(page));
    save(`${acct.key}_memberships_api.json`, api);
    console.log(`  ${api.length} JSON responses: ${api.map(a => `${a.method} ${a.path}`).join(', ')}`);
  } catch (e) {
    console.error(`  ${acct.key} failed: ${e.message}`);
    save(`${acct.key}_error.txt`, `${e.message}\nURL: ${page.url()}`);
    save(`${acct.key}_memberships_api.json`, api);
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
