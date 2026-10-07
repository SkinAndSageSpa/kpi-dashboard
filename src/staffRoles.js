/**
 * staffRoles.js
 * Classifies Skin & Sage providers as Esti or LMT from Mangomint data, so the
 * team page's columns keep working as staff come and go:
 *
 *   1. Enabled services (active staff) — GET /api/v1/company-settings/staff/<id>/services,
 *      matched against the service catalog. Enabled for a Signature Facial → esti;
 *      otherwise enabled for a massage → lmt. Facial wins when both are enabled
 *      (Estis are commonly enabled for the scalp-massage add-on).
 *   2. Performed services (archived staff, whose enabled services come back empty) —
 *      the "Service & Product Sales By Staff" report for that one staff id over the
 *      last ~6 months, same rule on the services they actually did.
 *   3. Remembered roles — every resolved role is kept in the data cache (survives
 *      CACHE_VERSION bumps), so someone archived later stays in their column for the
 *      months they worked.
 *
 * Staff matching neither rule (e.g. Botox-only, brows/lashes-only) are 'none' and
 * counted in neither column.
 */

const SIGNATURE_FACIAL = /signature facial/i;
const MASSAGE          = /massage/i;
const NONE_RECHECK_DAYS = 30;

function roleFromServiceNames(names) {
  if (names.some(n => SIGNATURE_FACIAL.test(n))) return 'esti';
  if (names.some(n => MASSAGE.test(n)))          return 'lmt';
  return 'none';
}

// Service rows of a single-staff "Sales By Staff" report: the second
// "Service Category/Service" table, up to its "Total" row. Category header rows
// are included too, which is harmless for the name match.
function parsePerformed(text) {
  const lines = text.split('\n');
  const nameLine = lines.filter(l => l.startsWith('Name:\t')).map(l => l.split('\t')[1]?.trim()).find(n => n && n !== 'Overview');
  const start = lines.findIndex(l => l.startsWith('Service Category/Service\t'));
  if (start === -1) return { name: nameLine || null, services: [] };
  const services = [];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('Total\t')) break;
    const name = l.split('\t')[0].trim();
    if (name) services.push(name);
  }
  return { name: nameLine || null, services };
}

/**
 * Resolves roles for every staff id in `allStaffIds`, updating `store` in place
 * (`store[id] = { role, name, source, checkedAt }`).
 *
 * page:            a logged-in Mangomint page (same origin as the API)
 * apiHeaders:      headers the app itself sends on /api/v1 calls (auth token etc.)
 * salesByStaffUrl: any generated "Sales By Staff" report iframe URL, to rewrite per id
 */
async function resolveRoles({ page, apiHeaders, salesByStaffUrl, allStaffIds, store, windowStart, windowEndExclusive }) {
  const getJson = url => page.evaluate(async ({ url, hdr }) => {
    const r = await fetch(url, { headers: hdr, credentials: 'include' });
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return r.json();
  }, { url, hdr: apiHeaders });

  const catalog = await getJson('/api/v1/company-settings/services');
  const services = catalog.servicesById || {};
  const now = Date.now();
  let enabledHits = 0, performedFetches = 0;

  for (const id of allStaffIds) {
    // 1. Enabled services
    let enabledNames = [];
    try {
      const r = await getJson(`/api/v1/company-settings/staff/${id}/services`);
      enabledNames = Object.keys(r.services || {}).map(sid => services[sid]?.name).filter(Boolean);
    } catch (e) {
      console.warn(`  [Roles] staff ${id} services: ${e.message}`);
    }
    if (enabledNames.length) {
      const role = roleFromServiceNames(enabledNames);
      store[id] = { ...store[id], role, source: 'enabled', checkedAt: now };
      enabledHits++;
      continue;
    }

    // 3. Remembered esti/lmt role — keep it (archived staff)
    const known = store[id];
    if (known && known.role !== 'none') continue;
    if (known && known.role === 'none' && now - known.checkedAt < NONE_RECHECK_DAYS * 86400000) continue;

    // 2. Performed services
    const u = new URL(salesByStaffUrl);
    const settings = JSON.parse(u.searchParams.get('settings') || '{}');
    settings.timePeriodStart = windowStart;
    settings.timePeriodEndExclusive = windowEndExclusive;
    settings.staffIds = [id];
    u.searchParams.set('settings', JSON.stringify(settings));
    const p = await page.context().newPage();
    try {
      await p.goto(u.toString(), { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(2000);
      const { name, services: performed } = parsePerformed(await p.evaluate(() => document.body?.innerText || ''));
      store[id] = { role: roleFromServiceNames(performed), name: name || known?.name || null, source: 'performed', checkedAt: now };
      performedFetches++;
    } catch (e) {
      console.warn(`  [Roles] staff ${id} performed services: ${e.message}`);
    } finally {
      await p.close();
    }
  }

  console.log(`  [Roles] ${enabledHits} from enabled services, ${performedFetches} performed-services lookups`);
  return store;
}

module.exports = { resolveRoles, roleFromServiceNames };
