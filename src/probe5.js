/**
 * probe5.js — frame / shadow-DOM inspector.
 * After generating Sales Summary, dumps:
 *   - all frame URLs + their textContent
 *   - shadow root deep text traversal
 *   - element with id/class containing table-like keywords
 * Goal: locate where the report table lives.
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const PROBE_DIR   = process.env.PROBE_DIR || '/tmp/probe5-results';
const ACCOUNT_KEY = process.env.PROBE_ACCOUNT || 'waxon';
const LOCATION_IDS = { waxon: '812513', skinsage: '560372' };
const COOKIE_ENVS  = { waxon: 'WAXON_MANGOMINT_COOKIES', skinsage: 'SKINSAGE_MANGOMINT_COOKIES' };

fs.mkdirSync(PROBE_DIR, { recursive: true });

function save(name, text) {
  const file = path.join(PROBE_DIR, name);
  fs.writeFileSync(file, String(text), 'utf8');
  console.log(`  Saved: ${name} (${String(text).length} chars)`);
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

async function snap(page, label) {
  const file = path.join(PROBE_DIR, `${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  [snap] ${file}`);
}

async function dismissOverlays(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
}

function monthPickerLabel(monthsAgo = 0) {
  const n = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const d = new Date(n.getFullYear(), n.getMonth() - monthsAgo, 1);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

async function selectPeriod(page, targetOption) {
  await dismissOverlays(page);
  const PERIOD_RE = /Today \(|Yesterday \(|This Week|Last Week|Last Two|Custom|January|February|March|April|May|June|July|August|September|October|November|December/;
  const trigger = page.getByText(PERIOD_RE, { exact: false }).first();
  if (!await trigger.isVisible({ timeout: 5000 }).catch(() => false)) {
    console.warn('  Trigger not found'); return;
  }
  await trigger.click();
  await page.waitForTimeout(1800);
  const options = page.getByText(targetOption, { exact: true });
  const count = await options.count().catch(() => 0);
  if (count === 0) { await page.keyboard.press('Escape'); return; }
  await options.last().click();
  await page.waitForTimeout(800);
}

async function main() {
  const locationId = LOCATION_IDS[ACCOUNT_KEY];
  const cookieEnv  = COOKIE_ENVS[ACCOUNT_KEY];
  const raw = process.env[cookieEnv];
  if (!raw) { console.error(`${cookieEnv} not set`); process.exit(1); }

  const base = `https://app.mangomint.com/${locationId}`;
  const monthOption = monthPickerLabel(0);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US', timezoneId: 'America/Los_Angeles',
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  await context.addCookies(parseCookies(raw));
  const page = await context.newPage();

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await settle(page, 5000);
  if (page.url().includes('login')) { console.error('Cookies expired'); process.exit(1); }

  // ── 0a. BI: Appointments ────────────────────────────────────────────────────
  console.log('\n── BI: Appointments ──');
  await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await dismissOverlays(page);
  await page.getByText('Business Intelligence: Appointments', { exact: true }).first().click();
  await settle(page, 3000);
  await selectPeriod(page, monthOption);
  await settle(page, 1000);
  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 8000);
  await snap(page, 'bi_generated');
  {
    const frame = page.frames().find(f => f.url().includes('/api/v1/reports/') && f.url().includes('/html'));
    if (frame) {
      const t = await frame.evaluate(() => document.body.innerText || '');
      save('bi_frame_innertext.txt', t);
      console.log('  BI frame URL:', frame.url());
    } else {
      console.warn('  BI: no report frame found');
      save('bi_frame_innertext.txt', '(no frame)');
    }
  }

  // ── 0b. Client Retention ────────────────────────────────────────────────────
  console.log('\n── Client Retention ──');
  await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await dismissOverlays(page);
  await page.getByText('Client Retention', { exact: true }).first().click();
  await settle(page, 3000);
  await selectPeriod(page, monthOption);
  await settle(page, 1000);
  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 8000);
  await snap(page, 'ret_generated');
  {
    const frame = page.frames().find(f => f.url().includes('/api/v1/reports/') && f.url().includes('/html'));
    if (frame) {
      const t = await frame.evaluate(() => document.body.innerText || '');
      save('ret_frame_innertext.txt', t);
      console.log('  Retention frame URL:', frame.url());
    } else {
      console.warn('  Retention: no report frame found');
      save('ret_frame_innertext.txt', '(no frame)');
    }
  }

  // Generate Sales Summary for current month
  await page.goto(`${base}/reports`, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);
  await dismissOverlays(page);
  await page.getByText('Sales Summary', { exact: true }).first().click();
  await settle(page, 3000);
  await selectPeriod(page, monthOption);
  await settle(page, 1000);
  await page.getByText('Generate', { exact: true }).first().click();
  await settle(page, 8000);
  await snap(page, 'sales_generated');

  // ── 1. List all frames ────────────────────────────────────────────────────
  const frames = page.frames();
  const frameReport = [];
  console.log(`\nTotal frames: ${frames.length}`);
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const url = frame.url();
    const textContent = await frame.evaluate(() => document.body?.textContent?.slice(0, 2000) || '').catch(e => `(error: ${e.message})`);
    const innerText = await frame.evaluate(() => document.body?.innerText?.slice(0, 2000) || '').catch(e => `(error: ${e.message})`);
    frameReport.push(`\n=== Frame ${i}: ${url} ===\n--- textContent (first 2000) ---\n${textContent}\n--- innerText (first 2000) ---\n${innerText}`);
    console.log(`  Frame ${i}: ${url} (textContent len: ${textContent.length})`);
  }
  save('frames_report.txt', frameReport.join('\n\n'));

  // ── 2. Shadow DOM deep text ────────────────────────────────────────────────
  const shadowText = await page.evaluate(() => {
    function deepText(root) {
      let out = '';
      const walk = (el) => {
        if (el.shadowRoot) walk(el.shadowRoot);
        if (el.childNodes) {
          for (const child of el.childNodes) {
            if (child.nodeType === 3) out += child.textContent; // text node
            else walk(child);
          }
        }
      };
      walk(root);
      return out;
    }
    return deepText(document.documentElement);
  });
  save('shadow_deep_text.txt', shadowText);
  console.log(`\nShadow deep text length: ${shadowText.length}`);

  // Check if "Total" appears in shadow text
  const hasTotalInShadow = shadowText.includes('Total');
  const hasDollarInShadow = shadowText.includes('$');
  console.log(`  Contains "Total": ${hasTotalInShadow}`);
  console.log(`  Contains "$": ${hasDollarInShadow}`);

  // ── 3. Find all iframes/frame elements in DOM ──────────────────────────────
  const iframeInfo = await page.evaluate(() => {
    const iframes = document.querySelectorAll('iframe, frame');
    return Array.from(iframes).map(el => ({
      tag: el.tagName,
      src: el.src || el.getAttribute('src') || '(no src)',
      id: el.id,
      className: el.className,
      width: el.offsetWidth,
      height: el.offsetHeight,
    }));
  });
  save('iframes_in_dom.txt', JSON.stringify(iframeInfo, null, 2));
  console.log(`\nIframe elements in DOM: ${iframeInfo.length}`);
  console.log(JSON.stringify(iframeInfo, null, 2));

  // ── 4. Try page.locator on visible text ───────────────────────────────────
  // Check if Playwright's locator API can find "Total" text directly
  const totalLocators = page.getByText('Total', { exact: true });
  const totalCount = await totalLocators.count().catch(() => 0);
  console.log(`\npage.getByText('Total', exact) count: ${totalCount}`);
  save('locator_total_count.txt', String(totalCount));

  // Try to get any element containing dollar amounts
  const dollarEl = page.locator('*').filter({ hasText: /\$\d{1,3},?\d{3}/ }).first();
  const dollarVisible = await dollarEl.isVisible({ timeout: 3000 }).catch(() => false);
  console.log(`Dollar amount element visible: ${dollarVisible}`);

  // ── 5. Get ALL frame textcontent if "Total" found ─────────────────────────
  // Look for "Total" across all frames
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const fullText = await frame.evaluate(() => document.body?.textContent || '').catch(() => '');
    if (fullText.includes('Total') || fullText.includes('$')) {
      console.log(`  Frame ${i} contains "Total" or "$" — saving full text`);
      save(`frame_${i}_full_textcontent.txt`, fullText);
      const fullInner = await frame.evaluate(() => document.body?.innerText || '').catch(() => '');
      save(`frame_${i}_full_innertext.txt`, fullInner);
    }
  }

  // ── 6. DOM structure around the report output area ────────────────────────
  const domStructure = await page.evaluate(() => {
    // Find the element that visually contains the report table
    // by looking for the element with the most children that appears after the Generate button
    function describe(el, depth = 0) {
      if (depth > 3) return '';
      const tag = el.tagName?.toLowerCase() || '?';
      const id = el.id ? `#${el.id}` : '';
      const cls = el.className && typeof el.className === 'string'
        ? `.${el.className.trim().split(/\s+/).join('.')}`
        : '';
      const childCount = el.children?.length || 0;
      const textPreview = (el.textContent || '').trim().slice(0, 80).replace(/\s+/g, ' ');
      const hasShadow = !!el.shadowRoot;
      let out = `${'  '.repeat(depth)}${tag}${id}${cls} (children:${childCount}${hasShadow ? ' SHADOW' : ''}) "${textPreview}"\n`;
      if (depth < 2) {
        for (const child of Array.from(el.children || []).slice(0, 8)) {
          out += describe(child, depth + 1);
        }
      }
      return out;
    }
    return describe(document.body);
  });
  save('dom_structure.txt', domStructure);
  console.log('\nDOM structure saved.');

  await browser.close();
  console.log('\nProbe5 complete. Results in', PROBE_DIR);
}

main().catch(e => { console.error(e); process.exit(1); });
