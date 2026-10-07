/**
 * probe-roles.js — READ-ONLY. For every staff id in the BI Appointments report,
 * fetch the services Mangomint has enabled for them and show how a
 * services-based Esti/LMT rule would classify them.
 *   GET /api/v1/company-settings/services            → catalog (names, categories)
 *   GET /api/v1/company-settings/staff/<id>/services → enabled services for one staff
 * Also checks whether archived staff are reachable by that same endpoint.
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const OUT  = process.env.PROBE_DIR || '/tmp/probe-roles';
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

  // Capture the app's own headers for a services request so we can replay them.
  let replayHeaders = null;
  page.on('request', req => {
    if (!replayHeaders && /\/api\/v1\/company-settings\/staff\/\d+\/services/.test(req.url())) {
      replayHeaders = req.headers();
    }
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await settle(page, 5000);
  if (page.url().includes('login')) throw new Error('cookies expired');
  await page.goto(`${BASE}/settings/staff`, { waitUntil: 'domcontentloaded' });
  await settle(page, 5000);
  await page.getByText('Pamella Kropp', { exact: true }).first().click();
  await settle(page, 2000);
  await page.getByText('Services', { exact: true }).first().click();
  await settle(page, 3000);
  const hdr = Object.fromEntries(Object.entries(replayHeaders || {}).filter(([k]) => !/^(cookie|content-length|host)$/i.test(k)));
  console.log('Replay headers:', Object.keys(hdr).join(', '));

  // In-page fetch (same origin, app cookies) with the app's headers.
  const getJson = url => page.evaluate(async ({ url, hdr }) => {
    const r = await fetch(url, { headers: hdr, credentials: 'include' });
    return { status: r.status, body: r.ok ? await r.json() : (await r.text()).slice(0, 200) };
  }, { url, hdr });

  const cat = await getJson('/api/v1/company-settings/services');
  if (cat.status !== 200) throw new Error(`catalog HTTP ${cat.status}: ${cat.body}`);
  const services   = cat.body.servicesById;
  const categories = Object.fromEntries(cat.body.serviceCategories.map(c => [c.id, c.name]));

  // All staff ids the reports know about (active + archived), from a util report's settings.
  await page.goto(`${BASE}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await page.getByText('Business Intelligence: Appointments', { exact: true }).first().click();
  await settle(page, 3000);
  const trigger = page.locator('[class*="staffSelectorTriggerBtn"]').first();
  await trigger.click(); await page.waitForTimeout(800);
  await page.getByText('Select all', { exact: true }).last().click(); await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 7000);
  const frame = page.frames().find(f => f.url().includes('/reports/business-intelligence/appointments') && f.url().includes('/html'));
  const staffIds = JSON.parse(new URL(frame.url()).searchParams.get('settings')).staffIds;
  console.log(`\n${staffIds.length} staff ids in report settings`);

  const rows = [];
  for (const id of staffIds) {
    const r = await getJson(`/api/v1/company-settings/staff/${id}/services`);
    if (r.status !== 200) { rows.push({ id, status: r.status }); continue; }
    const enabled = Object.keys(r.body.services || {}).map(sid => services[sid]).filter(Boolean);
    const sig = enabled.filter(s => /signature facial/i.test(s.name));
    const massageCat = enabled.filter(s => categories[s.serviceCategoryId] === 'Massage & Body Treatments');
    const massageNamed = enabled.filter(s => /massage/i.test(s.name));
    rows.push({
      id, status: 200, enabledCount: enabled.length,
      signatureFacial: sig.map(s => s.name),
      massageCategory: massageCat.map(s => s.name),
      massageNamed: massageNamed.map(s => s.name),
    });
  }
  out('roles.json', rows);

  // Names: from the util report rows, one staffId at a time is slow — use the
  // probe-staff mapping file instead if present; else print ids only.
  console.log('\nid | enabled | signatureFacial | massage-category services');
  for (const r of rows) {
    if (r.status !== 200) { console.log(`${r.id} | HTTP ${r.status}`); continue; }
    if (!r.enabledCount) continue;
    console.log(`${r.id} | ${r.enabledCount} | ${r.signatureFacial.length ? 'YES ' + JSON.stringify(r.signatureFacial) : '-'} | ${JSON.stringify(r.massageCategory)}`);
  }
  const counts = rows.reduce((m, r) => (m[r.status === 200 ? (r.enabledCount ? 'withServices' : 'noServices') : `http${r.status}`] = (m[r.status === 200 ? (r.enabledCount ? 'withServices' : 'noServices') : `http${r.status}`] || 0) + 1, m), {});
  console.log('\nSummary:', JSON.stringify(counts));

  // Fallback for archived staff: which services did they actually perform?
  for (const reportName of ['Service Sales', 'Service & Product Sales By Staff']) {
    await page.goto(`${BASE}/reports`, { waitUntil: 'domcontentloaded' });
    await settle(page, 3000);
    await page.getByText(reportName, { exact: true }).first().click();
    await settle(page, 3000);
    await page.getByText('Generate', { exact: true }).first().click();
    await settle(page, 7000);
    const f = page.frames().find(fr => fr.url().includes('/api/v1/reports/') && fr.url().includes('/html'));
    if (!f) { console.log(`[${reportName}] no iframe`); continue; }
    const u = new URL(f.url());
    console.log(`
=== ${reportName} ===
${u.pathname}
settings: ${u.searchParams.get('settings')}`);
    for (const ids of [[81], [84], [67], [28]]) {
      const st = JSON.parse(u.searchParams.get('settings'));
      st.timePeriodStart = '2026-06-01'; st.timePeriodEndExclusive = '2026-10-08'; st.staffIds = ids;
      u.searchParams.set('settings', JSON.stringify(st));
      const p2 = await context.newPage();
      await p2.goto(u.toString(), { waitUntil: 'domcontentloaded' });
      await p2.waitForTimeout(3000);
      const text = await p2.evaluate(() => document.body?.innerText || '');
      await p2.close();
      out(`${reportName.replace(/\W+/g, '_')}_${ids[0]}.txt`, text);
      console.log(`--- staffIds ${JSON.stringify(ids)} ---
${text.slice(0, 1500)}`);
    }
  }

  await browser.close();
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
