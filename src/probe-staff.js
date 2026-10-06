/**
 * probe-staff.js — READ-ONLY feasibility probe for a Skin & Sage employee dashboard
 * that splits KPIs into Esti vs LMT columns.
 *
 * Answers:
 *   1. What do each report's iframe settings look like (staffIds shape)?
 *   2. Staff id → name mapping (one util fetch per staffId).
 *   3. Do Sales Summary / BI Appointments / Client Retention honor a narrowed staffIds?
 *   4. Does Mangomint's staff list expose a role/job title we could classify by?
 *
 * Writes everything to $PROBE_DIR (uploaded as an artifact) and stdout.
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const OUT  = process.env.PROBE_DIR || '/tmp/probe-staff';
const BASE = 'https://app.mangomint.com/560372';
fs.mkdirSync(OUT, { recursive: true });

const out = (name, data) => fs.writeFileSync(path.join(OUT, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));

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
  const dialog = page.locator('[class*="Dialog"][class*="componentCt"]').first();
  if (await dialog.isVisible({ timeout: 1000 }).catch(() => false)) {
    const closeBtn = dialog.locator('button[aria-label="Close" i], [class*="close" i], button:has-text("Got it"), button:has-text("Dismiss"), button:has-text("OK"), button:has-text("Close")').first();
    if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) await closeBtn.click().catch(() => {});
    else await page.mouse.click(5, 5).catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function selectAllStaff(page) {
  const trigger = page.locator('[class*="staffSelectorTriggerBtn"]').first();
  if (!await trigger.isVisible({ timeout: 4000 }).catch(() => false)) return false;
  await trigger.click();
  await page.waitForTimeout(800);
  const selectAll = page.getByText('Select all', { exact: true });
  if (await selectAll.count().catch(() => 0) === 0) { await page.keyboard.press('Escape'); return false; }
  await selectAll.last().click();
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  return true;
}

// Generate a report and return its iframe URL (settings harvested from it).
async function generate(page, reportName, urlFragment, withAllStaff) {
  await page.goto(`${BASE}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await dismissOverlays(page);
  await page.getByText(reportName, { exact: true }).first().click();
  await settle(page, 3000);
  if (withAllStaff) console.log(`  [${reportName}] select all staff: ${await selectAllStaff(page)}`);
  await dismissOverlays(page);
  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 7000);
  const frame = page.frames().find(f => f.url().includes(urlFragment) && f.url().includes('/html'));
  if (!frame) throw new Error(`${reportName}: iframe not found`);
  return frame.url();
}

async function fetchWith(context, frameUrl, overrides) {
  const u = new URL(frameUrl);
  const settings = { ...JSON.parse(u.searchParams.get('settings') || '{}'), ...overrides };
  u.searchParams.set('settings', JSON.stringify(settings));
  const p = await context.newPage();
  try {
    await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(2500);
    return await p.evaluate(() => document.body?.innerText || '');
  } finally { await p.close(); }
}

const SEPT = { timePeriodStart: '2026-09-01', timePeriodEndExclusive: '2026-10-01' };
const line = (text, prefix) => (text.split('\n').find(l => l.startsWith(prefix)) || '(not found)');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US', timezoneId: 'America/Los_Angeles',
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  await context.addCookies(parseCookies(process.env.SKINSAGE_MANGOMINT_COOKIES));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await settle(page, 5000);
  if (page.url().includes('login')) throw new Error('cookies expired');
  console.log('Logged in:', page.url());

  // 1. Settings shapes
  const salesUrl = await generate(page, 'Sales Summary', '/api/v1/reports/total-sales', false);
  const utilUrl  = await generate(page, 'Business Intelligence: Appointments', '/reports/business-intelligence/appointments', true);
  const retUrl   = await generate(page, 'Client Retention', '/api/v1/reports/', true);
  const settingsOf = u => JSON.parse(new URL(u).searchParams.get('settings') || '{}');
  const shapes = { sales: settingsOf(salesUrl), util: settingsOf(utilUrl), ret: settingsOf(retUrl) };
  out('settings.json', { urls: { salesUrl, utilUrl, retUrl }, shapes });
  for (const [k, s] of Object.entries(shapes)) {
    console.log(`\n[${k}] settings keys: ${Object.keys(s).join(', ')}`);
    console.log(`[${k}] staffIds: ${Array.isArray(s.staffIds) ? `${s.staffIds.length} ids, e.g. ${JSON.stringify(s.staffIds.slice(0, 5))}` : JSON.stringify(s.staffIds)}`);
  }

  // 2. Staff id → name, one util fetch per id (Sept window)
  const allIds = shapes.util.staffIds || [];
  const allUtil = await fetchWith(context, utilUrl, SEPT);
  out('util-all-sept.txt', allUtil);
  const idToName = {};
  for (const id of allIds) {
    const text = await fetchWith(context, utilUrl, { ...SEPT, staffIds: [id] });
    const lines = text.split('\n');
    const h = lines.findIndex(l => l.startsWith('Staff\t'));
    const a = lines.findIndex(l => l.startsWith('All Selected\t'));
    const rows = (h >= 0 && a > h) ? lines.slice(h + 1, a) : [];
    idToName[id] = rows.map(r => r.split('\t').slice(0, 4).join(' | '));
    console.log(`  staff ${id}: ${JSON.stringify(idToName[id])}`);
  }
  out('staff-ids.json', idToName);

  // 3. Does each report honor a narrowed staffIds? Compare all vs first-half vs second-half.
  const half = Math.ceil(allIds.length / 2);
  const groups = { all: allIds, firstHalf: allIds.slice(0, half), secondHalf: allIds.slice(half) };
  const filterResults = {};
  for (const [g, ids] of Object.entries(groups)) {
    const s = await fetchWith(context, salesUrl, { ...SEPT, staffIds: ids });
    const u = await fetchWith(context, utilUrl,  { ...SEPT, staffIds: ids });
    const r = await fetchWith(context, retUrl,   { timePeriodStart: '2026-07-01', timePeriodEndExclusive: '2026-10-01', staffIds: ids });
    filterResults[g] = {
      n: ids.length,
      salesTotal: line(s, 'Total\t'),
      utilAllSelected: line(u, 'All Selected\t'),
      retAllSelected: line(r, 'All Selected Staff\t'),
    };
    out(`sales-${g}.txt`, s); out(`ret-${g}.txt`, r);
    console.log(`\n[filter ${g}] n=${ids.length}\n  sales: ${filterResults[g].salesTotal}\n  util:  ${filterResults[g].utilAllSelected}\n  ret:   ${filterResults[g].retAllSelected}`);
  }
  out('filter-results.json', filterResults);

  // 3b. Sales Summary with NO staffIds key at all vs all — does the staff filter drop unattributed sales?
  const salesNoKey = await (async () => {
    const u = new URL(salesUrl);
    const s = { ...JSON.parse(u.searchParams.get('settings') || '{}'), ...SEPT };
    delete s.staffIds;
    u.searchParams.set('settings', JSON.stringify(s));
    const p = await context.newPage();
    try { await p.goto(u.toString(), { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2500); return await p.evaluate(() => document.body?.innerText || ''); }
    finally { await p.close(); }
  })();
  console.log(`\n[sales, staffIds key removed] ${line(salesNoKey, 'Total\t')}`);

  // 4. Staff list — any role/title exposed?
  for (const p of ['/staff', '/settings/staff', '/apps/staff']) {
    try {
      await page.goto(`${BASE}${p}`, { waitUntil: 'domcontentloaded' });
      await settle(page, 4000);
      const text = await page.evaluate(() => document.body?.innerText || '');
      out(`page${p.replace(/\//g, '_')}.txt`, `${page.url()}\n\n${text}`);
      await page.screenshot({ path: path.join(OUT, `page${p.replace(/\//g, '_')}.png`), fullPage: true });
      console.log(`\n[page ${p}] → ${page.url()}\n${text.slice(0, 1500)}`);
    } catch (e) { console.log(`[page ${p}] error: ${e.message}`); }
  }

  await browser.close();
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
