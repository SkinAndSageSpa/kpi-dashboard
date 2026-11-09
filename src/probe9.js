/**
 * Probe 9 — Skin & Sage Ravenna revenue vs LMT hours (read-only investigation, 2026-11-09).
 *
 * Per month (Oct 2025 → current), per location (Ravenna=1, Queen Anne=2), per role
 * (LMT / Esti / other-unclassified):
 *   available hours, booked hours, # staff with ≥1 booked hr  (BI: Appointments)
 *   revenue attributed to that role's staff + location total  (Sales Summary)
 *
 * Reuses scraper.js helpers without running its main(). Logs and the uploaded JSON
 * are AGGREGATES ONLY: no staff names, no client data (public repo).
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { chromium } = require('playwright');

// Load scraper.js internals without triggering main().
const scraperPath = path.join(__dirname, 'scraper.js');
let src = fs.readFileSync(scraperPath, 'utf8');
src = src.replace(/\nmain\(\)\.catch\([^\n]*\n?$/, '\n');
src += '\nmodule.exports = { ACCOUNTS, openAccount, generateReportUrl, parseStaffAvailBooked, parseSalesTotal, settle, dismissOverlays, selectAllStaff };\n';
const m = new Module(scraperPath, module);
m.filename = scraperPath;
m.paths = Module._nodeModulePaths(__dirname);
m._compile(src, scraperPath);
const S = m.exports;
const { resolveRoles } = require('./staffRoles');

const OUT = process.env.PROBE_DIR || '/tmp/probe9-results';
fs.mkdirSync(OUT, { recursive: true });

const LOCATIONS = { ravenna: [1], queenanne: [2] };
const FIRST = { y: 2025, m: 10 }; // Oct 2025

function months() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const out = [];
  let y = FIRST.y, mo = FIRST.m;
  while (y < now.getFullYear() || (y === now.getFullYear() && mo <= now.getMonth() + 1)) {
    const start = `${y}-${String(mo).padStart(2, '0')}-01`;
    const ny = mo === 12 ? y + 1 : y, nm = mo === 12 ? 1 : mo + 1;
    const end = `${ny}-${String(nm).padStart(2, '0')}-01`;
    const isCurrent = y === now.getFullYear() && mo === now.getMonth() + 1;
    const t = new Date(now); t.setDate(t.getDate() + 1);
    const mtdEnd = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    out.push({ key: start.slice(0, 7), start, end, isCurrent, mtdEnd: isCurrent ? mtdEnd : end });
    y = ny; mo = nm;
  }
  return out;
}

async function loadWith(context, baseUrl, mutate) {
  const u = new URL(baseUrl);
  const settings = JSON.parse(u.searchParams.get('settings') || '{}');
  mutate(settings);
  u.searchParams.set('settings', JSON.stringify(settings));
  const p = await context.newPage();
  try {
    await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(3500);
    return await p.evaluate(() => document.body?.innerText || '');
  } finally { await p.close(); }
}

const r2 = v => v == null ? null : Math.round(v * 100) / 100;

(async () => {
  const account = S.ACCOUNTS.find(a => a.key === 'skinsage');
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
  const result = { generatedAt: new Date().toISOString(), months: [] };
  try {
    const { context, page, base, apiHeaders } = await S.openAccount(browser, account);
    const utilUrl  = await S.generateReportUrl(page, base, 'Business Intelligence: Appointments', '/reports/business-intelligence/appointments', true);
    const sbsUrl   = await S.generateReportUrl(page, base, 'Service & Product Sales By Staff', '/api/v1/reports/sales-by-staff', true);
    const salesUrl = await S.generateReportUrl(page, base, 'Sales Summary', '/api/v1/reports/total-sales', false);
    const allStaffIds = JSON.parse(new URL(utilUrl).searchParams.get('settings') || '{}').staffIds || [];
    console.log(`staff ids in report: ${allStaffIds.length}`);

    // Classify roles over the whole investigation window (wider than the dashboard's 6 months).
    const store = {};
    const ms = months();
    await resolveRoles({ page, apiHeaders, salesByStaffUrl: sbsUrl, allStaffIds, store,
      windowStart: ms[0].start, windowEndExclusive: ms[ms.length - 1].mtdEnd });
    const groups = {
      lmt:  allStaffIds.filter(id => store[id]?.role === 'lmt'),
      esti: allStaffIds.filter(id => store[id]?.role === 'esti'),
    };
    groups.other = allStaffIds.filter(id => !groups.lmt.includes(id) && !groups.esti.includes(id));
    console.log(`roles: lmt=${groups.lmt.length} esti=${groups.esti.length} other=${groups.other.length}`);

    for (const mo of ms) {
      const row = { month: mo.key, partial: mo.isCurrent, locations: {} };
      for (const [locKey, locIds] of Object.entries(LOCATIONS)) {
        const loc = { roles: {} };
        // Location total revenue (all staff + unattributed like membership billing).
        loc.salesTotal = r2(S.parseSalesTotal(await loadWith(context, salesUrl, s => {
          s.timePeriodStart = mo.start; s.timePeriodEndExclusive = mo.mtdEnd; s.locationIds = locIds;
        })));
        for (const [role, ids] of Object.entries(groups)) {
          if (!ids.length) continue;
          const text = await loadWith(context, utilUrl, s => {
            s.timePeriodStart = mo.start; s.timePeriodEndExclusive = mo.end; s.locationIds = locIds; s.staffIds = ids;
          });
          const rows = (S.parseStaffAvailBooked(text) || []).filter(r => r.booked >= 1); // archived-staff filter, as dashboard
          let bookedToDate = null;
          if (mo.isCurrent) {
            const t2 = await loadWith(context, utilUrl, s => {
              s.timePeriodStart = mo.start; s.timePeriodEndExclusive = mo.mtdEnd; s.locationIds = locIds; s.staffIds = ids;
            });
            const keep = new Set(rows.map(r => r.name));
            bookedToDate = r2((S.parseStaffAvailBooked(t2) || []).filter(r => keep.has(r.name)).reduce((a, r) => a + r.booked, 0));
          }
          const sales = S.parseSalesTotal(await loadWith(context, salesUrl, s => {
            s.timePeriodStart = mo.start; s.timePeriodEndExclusive = mo.mtdEnd; s.locationIds = locIds; s.staffIds = ids;
          }));
          loc.roles[role] = {
            staffWorking: rows.length,
            availHours: r2(rows.reduce((a, r) => a + r.avail, 0)),
            bookedHours: r2(rows.reduce((a, r) => a + r.booked, 0)),
            ...(mo.isCurrent ? { bookedHoursToDate: bookedToDate } : {}),
            sales: r2(sales),
          };
        }
        row.locations[locKey] = loc;
      }
      result.months.push(row);
      const rv = row.locations.ravenna;
      console.log(`${mo.key}${mo.isCurrent ? '*' : ''} RAV total=$${rv.salesTotal} | LMT n=${rv.roles.lmt?.staffWorking} avail=${rv.roles.lmt?.availHours} booked=${rv.roles.lmt?.bookedHours} $${rv.roles.lmt?.sales} | ESTI n=${rv.roles.esti?.staffWorking} avail=${rv.roles.esti?.availHours} booked=${rv.roles.esti?.bookedHours} $${rv.roles.esti?.sales} | QA LMT avail=${row.locations.queenanne.roles.lmt?.availHours} booked=${row.locations.queenanne.roles.lmt?.bookedHours}`);
      fs.writeFileSync(path.join(OUT, 'probe9.json'), JSON.stringify(result, null, 2));
    }
    await context.close();
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
