/**
 * probe-roles.js — READ-ONLY. Looks for a dynamic way to tell Estheticians from
 * Massage Therapists in Mangomint:
 *   1. Every JSON API response the app loads on Settings → Staff and a staff profile
 *      (staff records may carry a job title / service ids)
 *   2. The staff profile page text + its tabs (Details / Services)
 *   3. The list of available reports (a services-by-staff report would also work)
 * Writes everything to $PROBE_DIR.
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

  // Capture JSON API responses
  let n = 0;
  const index = [];
  page.on('response', async res => {
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    try {
      const body = await res.text();
      const file = `api_${String(++n).padStart(3, '0')}.json`;
      out(file, `${res.request().method()} ${res.url()}\n\n${body}`);
      index.push({ file, url: res.url(), bytes: body.length });
    } catch {}
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await settle(page, 5000);
  if (page.url().includes('login')) throw new Error('cookies expired');
  console.log('Logged in:', page.url());

  // Reports list
  await page.goto(`${BASE}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 4000);
  out('reports.txt', await page.evaluate(() => document.body?.innerText || ''));
  console.log('\n=== Reports page ===\n' + (await page.evaluate(() => document.body?.innerText || '')).slice(0, 3000));

  // Settings → Staff, then a staff profile
  const mark = index.length;
  await page.goto(`${BASE}/settings/staff`, { waitUntil: 'domcontentloaded' });
  await settle(page, 5000);
  await page.getByText('Pamella Kropp', { exact: true }).first().click().catch(e => console.log('click staff:', e.message));
  await settle(page, 4000);
  out('profile.txt', `${page.url()}\n\n${await page.evaluate(() => document.body?.innerText || '')}`);
  await page.screenshot({ path: path.join(OUT, 'profile.png'), fullPage: true });
  console.log('\n=== Profile ===\n' + page.url() + '\n' + (await page.evaluate(() => document.body?.innerText || '')).slice(0, 2500));

  // Services tab on the profile, if any
  for (const tab of ['Services', 'Service']) {
    const t = page.getByText(tab, { exact: true }).first();
    if (await t.isVisible({ timeout: 2000 }).catch(() => false)) {
      await t.click();
      await settle(page, 3000);
      out('profile_services.txt', `${page.url()}\n\n${await page.evaluate(() => document.body?.innerText || '')}`);
      await page.screenshot({ path: path.join(OUT, 'profile_services.png'), fullPage: true });
      console.log('\n=== Profile services tab ===\n' + (await page.evaluate(() => document.body?.innerText || '')).slice(0, 2500));
      break;
    }
  }

  out('api_index.json', index);
  console.log('\n=== JSON responses since Settings → Staff ===');
  for (const r of index.slice(mark)) console.log(`${r.file}  ${r.bytes}B  ${r.url}`);

  // Grep captured bodies for role-ish fields
  console.log('\n=== Role-ish keys in captured JSON ===');
  const keys = /"(jobTitle|title|position|role|roleName|staffType|serviceIds|serviceCategoryIds|categoryName|serviceCategory)"/g;
  for (const r of index) {
    const body = fs.readFileSync(path.join(OUT, r.file), 'utf8');
    const hits = [...new Set((body.match(keys) || []))];
    if (hits.length) console.log(`${r.file} ${r.url.slice(0, 120)} → ${hits.join(', ')}`);
  }

  await browser.close();
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
