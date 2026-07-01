/**
 * generateHtml.js
 * Large-chart, minimal-text KPI dashboard. Light, soft, feminine.
 */

// Health colors based on change vs prior month, not absolute thresholds.
// Sales: projected EOM vs prior month's full sales (±3% band = amber).
// Utilization / Retention: current vs prior month in pp (±2pp band = amber).

function trendHealthSales(projected, priorFull) {
  if (projected === null || priorFull === null || priorFull === 0) return 'neutral';
  const ratio = (projected - priorFull) / priorFull;
  if (ratio >  0.03) return 'green';
  if (ratio < -0.03) return 'red';
  return 'amber';
}

function trendHealthPp(current, prior, threshold = 2) {
  if (current === null || prior === null) return 'neutral';
  const delta = current - prior;
  if (delta >  threshold) return 'green';
  if (delta < -threshold) return 'red';
  return 'amber';
}

function fmt$(n) {
  if (n === null || n === undefined) return '—';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function fmtPct(n) {
  if (n === null || n === undefined) return '—';
  return n.toFixed(1) + '%';
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles',
  }) + ' PT';
}

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];
const MONTH_ABBR  = ['Jan','Feb','Mar','Apr','May','Jun',
                     'Jul','Aug','Sep','Oct','Nov','Dec'];

function monthAbbrev(label) {
  if (!label) return '?';
  for (let i = 0; i < MONTH_NAMES.length; i++) {
    if (label.startsWith(MONTH_NAMES[i])) return MONTH_ABBR[i];
  }
  return label.slice(0, 3);
}

const HEALTH_FILL = {
  green: '#5a8a6e', amber: '#c07848', red: '#c2546b', neutral: '#d4c0bc',
};

// Full-width 3-bar chart. Oldest month left, current month right.
// projectedTop: extra height to stack on the current bar (projected - actual sales).
function bigChart(values, labels, health, fmtBar, projectedTop = null) {
  const n = values.length;
  const pad = 8;
  const barW = 46, gap = 12;
  const W = n * barW + (n - 1) * gap + pad * 2, H = 100;
  const maxBarH = 64;
  const botY = 80;
  const labY = 95;

  // Include projected total in scale so stacked bar doesn't overflow
  const allVals = values.filter(v => v !== null && v > 0);
  if (projectedTop !== null && values[0] !== null && values[0] > 0) {
    allVals.push(values[0] + projectedTop);
  }
  const maxVal = Math.max(...allVals, 1);

  const startX = pad;
  const curFill = HEALTH_FILL[health] || HEALTH_FILL.neutral;

  const els = values.map((v, i) => {
    // Reverse: i=0 (newest/current) → rightmost position
    const pos = (values.length - 1) - i;
    const x = startX + pos * (barW + gap);
    const cx = (x + barW / 2).toFixed(1);
    const isCurrent = i === 0;

    const actualH = (v !== null && v > 0) ? Math.max(6, Math.round((v / maxVal) * maxBarH)) : 5;
    const actualY = botY - actualH;
    const fill = isCurrent ? curFill : '#e8ddd9';

    let out = '';

    if (isCurrent && projectedTop !== null && projectedTop > 0) {
      // Draw projected shell first (full stacked height, semi-transparent)
      const totalH = Math.max(actualH, Math.round(((v + projectedTop) / maxVal) * maxBarH));
      const projY = botY - totalH;
      out += `<rect x="${x.toFixed(1)}" y="${projY}" width="${barW}" height="${totalH}" rx="5" fill="${curFill}" opacity="0.25"/>`;
      // Draw solid actual on top of it
      out += `<rect x="${x.toFixed(1)}" y="${actualY}" width="${barW}" height="${actualH}" rx="5" fill="${curFill}"/>`;
      // Projected total label above full stack
      const projLabel = fmtBar(v + projectedTop);
      out += `<text x="${cx}" y="${projY - 6}" text-anchor="middle" font-size="10" fill="${curFill}" font-weight="500">${projLabel}</text>`;
    } else {
      out += `<rect x="${x.toFixed(1)}" y="${actualY}" width="${barW}" height="${actualH}" rx="5" fill="${fill}"/>`;
      // Value label above bar
      const hasVal = v !== null && v > 0;
      const valStr = hasVal ? fmtBar(v) : '';
      const textCol = isCurrent ? '#3c2f2a' : '#b09088';
      const fw = isCurrent ? '600' : '400';
      if (valStr) out += `<text x="${cx}" y="${actualY - 6}" text-anchor="middle" font-size="10" fill="${textCol}" font-weight="${fw}">${valStr}</text>`;
    }

    out += `<text x="${cx}" y="${labY}" text-anchor="middle" font-size="10" fill="#b09088">${monthAbbrev(labels[i] || '')}</text>`;
    return out;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">${els}</svg>`;
}

// Utilization bars (booked %) with available-hours dot + label below the dot.
// Dot Y axis uses 55% of bar height max so dots sit in the lower bar area,
// clear of the booked-% label at the top.
function utilizationChart(periods, health) {
  const n = periods.length;
  const pad = 8;
  const legendW = 68;
  const barW = 46, gap = 12;
  const W = legendW + n * barW + (n - 1) * gap + pad * 2, H = 108;
  const maxBarH = 62;
  const dotMaxH = Math.round(maxBarH * 0.5);
  const botY = 82;
  const labY = 97;

  const allUtil  = periods.map(p => p?.utilization).filter(v => v !== null && v > 0);
  const maxUtil  = Math.max(...allUtil, 1);
  const allHours = periods.map(p => p?.availableHours).filter(v => v !== null && v > 0);
  const maxHours = Math.max(...allHours, 1);
  const hasHours = allHours.length > 0;

  const startX = legendW + pad;
  const curFill = HEALTH_FILL[health] || HEALTH_FILL.neutral;

  const els = periods.map((p, i) => {
    const pos = (periods.length - 1) - i;
    const x  = startX + pos * (barW + gap);
    const cx = (x + barW / 2).toFixed(1);
    const isCur = i === 0;

    const util  = p?.utilization    ?? null;
    const avail = p?.availableHours ?? null;

    const fill = isCur ? curFill : '#e8ddd9';
    const barH = (util !== null && util > 0)
      ? Math.max(6, Math.round((util / maxUtil) * maxBarH)) : 5;
    const barY = botY - barH;

    let out = '';
    out += `<rect x="${x.toFixed(1)}" y="${barY}" width="${barW}" height="${barH}" rx="5" fill="${fill}"/>`;

    if (util !== null && util > 0) {
      const col = isCur ? '#3c2f2a' : '#b09088';
      const fw  = isCur ? '600' : '400';
      out += `<text x="${cx}" y="${barY - 6}" text-anchor="middle" font-size="10" fill="${col}" font-weight="${fw}">${util.toFixed(1)}%</text>`;
    }

    if (avail !== null && avail > 0) {
      const dotH = Math.max(4, Math.round((avail / maxHours) * dotMaxH));
      const dotY = botY - dotH;
      const lblY = Math.min(dotY + 12, botY - 3);
      out += `<circle cx="${cx}" cy="${dotY}" r="3" fill="#3c2f2a" opacity="0.55"/>`;
      out += `<text x="${cx}" y="${lblY}" text-anchor="middle" font-size="8" fill="#6b5951">${Math.round(avail)}h</text>`;
    }

    out += `<text x="${cx}" y="${labY}" text-anchor="middle" font-size="10" fill="#b09088">${monthAbbrev(p?.label || '')}</text>`;
    return out;
  }).join('');

  const legend = hasHours
    ? `<rect x="4" y="36" width="8" height="8" rx="2" fill="${curFill}"/>` +
      `<text x="16" y="44" font-size="8.5" fill="#b09088">Booked %</text>` +
      `<circle cx="8" cy="56" r="3" fill="#3c2f2a" opacity="0.55"/>` +
      `<text x="16" y="60" font-size="8.5" fill="#b09088">Avail hrs</text>`
    : '';

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">${legend}${els}</svg>`;
}

// Retention bars (combined%) with new-client-% dot + label below the dot.
// Dot Y axis uses 55% of bar height max so dots sit in lower bar area,
// clear of the combined-% label at the top.
function retentionChart(periods, health) {
  const n = periods.length;
  const pad = 8;
  const legendW = 68;
  const barW = 46, gap = 12;
  const W = legendW + n * barW + (n - 1) * gap + pad * 2, H = 108;
  const maxBarH = 62;
  const dotMaxH = Math.round(maxBarH * 0.5);
  const botY = 82;
  const labY = 97;

  const allVals  = periods.map(p => p?.retention).filter(v => v !== null && v > 0);
  const maxVal   = Math.max(...allVals, 1);
  const allNew   = periods.map(p => p?.newRetPct).filter(v => v !== null && v > 0);
  const maxNew   = Math.max(...allNew, 1);

  const startX = legendW + pad;
  const curFill = HEALTH_FILL[health] || HEALTH_FILL.neutral;

  const els = periods.map((p, i) => {
    const pos = (periods.length - 1) - i;
    const x = startX + pos * (barW + gap);
    const cx = (x + barW / 2).toFixed(1);
    const isCur = i === 0;

    const combined = p?.retention ?? null;
    const newPct   = p?.newRetPct ?? null;

    const fill = isCur ? curFill : '#e8ddd9';
    const barH = (combined !== null && combined > 0)
      ? Math.max(6, Math.round((combined / maxVal) * maxBarH)) : 5;
    const barY = botY - barH;

    let out = '';
    out += `<rect x="${x.toFixed(1)}" y="${barY}" width="${barW}" height="${barH}" rx="5" fill="${fill}"/>`;

    if (combined !== null && combined > 0) {
      const col = isCur ? '#3c2f2a' : '#b09088';
      const fw  = isCur ? '600' : '400';
      out += `<text x="${cx}" y="${barY - 6}" text-anchor="middle" font-size="10" fill="${col}" font-weight="${fw}">${Math.round(combined)}%</text>`;
    }

    if (newPct !== null && newPct > 0) {
      const dotH = Math.max(4, Math.round((newPct / maxNew) * dotMaxH));
      const dotY = botY - dotH;
      const lblY = Math.min(dotY + 12, botY - 3);
      out += `<circle cx="${cx}" cy="${dotY}" r="3" fill="#3c2f2a" opacity="0.55"/>`;
      out += `<text x="${cx}" y="${lblY}" text-anchor="middle" font-size="8" fill="#6b5951">${Math.round(newPct)}%</text>`;
    }

    out += `<text x="${cx}" y="${labY}" text-anchor="middle" font-size="10" fill="#b09088">${monthAbbrev(p?.label || '')}</text>`;
    return out;
  }).join('');

  const legend =
    `<rect x="4" y="36" width="8" height="8" rx="2" fill="${curFill}"/>` +
    `<text x="16" y="44" font-size="8.5" fill="#b09088">Combined</text>` +
    `<circle cx="8" cy="56" r="3" fill="#3c2f2a" opacity="0.55"/>` +
    `<text x="16" y="60" font-size="8.5" fill="#b09088">New clients</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">${legend}${els}</svg>`;
}

function kpiCard({ label, currentDisplay, health, chart, projRow, mtd = false }) {
  const mtdTag = mtd ? '<span class="mtd-tag">mtd</span>' : '';
  return `
    <div class="kpi-card ${health}">
      <div class="kpi-card-top">
        <span class="kpi-label">${label}</span>
        <span class="kpi-value">${currentDisplay}${mtdTag}</span>
      </div>
      <div class="kpi-chart">${chart}</div>
      ${projRow ? `<div class="proj-row">${projRow}</div>` : ''}
    </div>`;
}

function businessPanel(biz) {
  const { label, periods, error } = biz;

  if (error) {
    return `
      <div class="biz-panel error-panel">
        <div class="biz-header">
          <div class="biz-name">${label}</div>
        </div>
        <div class="error-body">Cookies expired — refresh the GitHub secret to restore data.</div>
      </div>`;
  }

  const [cur, m1] = periods;
  const pLabels = periods.map(p => p?.label);

  const sh = trendHealthSales(cur?.projectedSales, m1?.sales);
  const projectedTop = (cur?.projectedSales && cur?.sales && cur.projectedSales > cur.sales)
    ? cur.projectedSales - cur.sales
    : null;
  const salesCard = kpiCard({
    label: 'Sales',
    health: sh,
    currentDisplay: fmt$(cur?.sales),
    chart: bigChart(
      periods.map(p => p?.sales ?? null),
      pLabels, sh,
      v => '$' + (v >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v)),
      projectedTop
    ),
    projRow: '',
    mtd: true,
  });

  const uh = trendHealthPp(cur?.utilization, m1?.utilization);
  const utilCard = kpiCard({
    label: 'Utilization',
    health: uh,
    currentDisplay: fmtPct(cur?.utilization),
    chart: utilizationChart(periods, uh),
    projRow: '',
    mtd: true,
  });

  const rh = trendHealthPp(cur?.retention, m1?.retention);
  const retCard = kpiCard({
    label: 'Retention',
    health: rh,
    currentDisplay: fmtPct(cur?.retention),
    chart: retentionChart(periods, rh),
    projRow: '',
    mtd: true,
  });

  const signals = [sh, uh, rh].filter(h => h !== 'neutral');
  const overall = signals.includes('red') ? 'red'
    : signals.includes('amber') ? 'amber'
    : signals.length > 0 ? 'green' : 'neutral';

  const pill = { green: 'Thriving', amber: 'Watch', red: 'Needs Love', neutral: 'No Data' };

  return `
    <div class="biz-panel">
      <div class="biz-header">
        <div class="biz-name">${label}</div>
        <div class="health-pill ${overall}">${pill[overall]}</div>
      </div>
      <div class="cards">
        ${salesCard}
        ${utilCard}
        ${retCard}
      </div>
    </div>`;
}

function comingSoonPanel(label) {
  return `
    <div class="loc-panel">
      <div class="biz-header">
        <div class="biz-name">${label}</div>
      </div>
      <div class="placeholder-body">Opening soon</div>
    </div>`;
}

function locationPanel(loc) {
  if (loc.error) {
    return `
      <div class="loc-panel error-panel">
        <div class="biz-header"><div class="biz-name">${loc.label}</div></div>
        <div class="error-body">Cookies expired — refresh the GitHub secret to restore data.</div>
      </div>`;
  }

  const [cur, m1, m2] = loc.periods;
  const pLabels = [cur?.label, m1?.label, m2?.label];

  const sh = trendHealthSales(cur?.projectedSales, m1?.sales);
  const projectedTop = (cur?.projectedSales && cur?.sales && cur.projectedSales > cur.sales)
    ? cur.projectedSales - cur.sales : null;
  const salesCard = kpiCard({
    label: 'Sales', health: sh, currentDisplay: fmt$(cur?.sales),
    chart: bigChart([cur?.sales, m1?.sales, m2?.sales].map(v => v ?? null), pLabels, sh,
      v => '$' + (v >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v)), projectedTop),
    mtd: true,
  });

  const uh = trendHealthPp(cur?.utilization, m1?.utilization);
  const utilCard = kpiCard({
    label: 'Utilization', health: uh, currentDisplay: fmtPct(cur?.utilization),
    chart: utilizationChart([cur, m1, m2], uh), mtd: true,
  });

  const rh = trendHealthPp(cur?.retention, m1?.retention);
  const retCard = kpiCard({
    label: 'Retention', health: rh, currentDisplay: fmtPct(cur?.retention),
    chart: retentionChart([cur, m1, m2], rh),
    mtd: true,
  });

  const signals = [sh, uh, rh].filter(h => h !== 'neutral');
  const overall = signals.includes('red') ? 'red' : signals.includes('amber') ? 'amber'
    : signals.length > 0 ? 'green' : 'neutral';
  const pill = { green: 'Thriving', amber: 'Watch', red: 'Needs Love', neutral: 'No Data' };

  return `
    <div class="loc-panel">
      <div class="biz-header">
        <div class="biz-name">${loc.label}</div>
        <div class="health-pill ${overall}">${pill[overall]}</div>
      </div>
      <div class="cards">
        ${salesCard}
        ${utilCard}
        ${retCard}
      </div>
    </div>`;
}

function locationsSection(locations) {
  const byKey = Object.fromEntries(locations.map(l => [l.key, l]));
  const columns = [
    { key: 'skinsage_ravenna',   render: () => locationPanel(byKey['skinsage_ravenna']   || { label: 'S&S Ravenna',    error: 'No data' }) },
    { key: 'ss_coming_soon',     render: () => comingSoonPanel('Skin &amp; Sage Queen Anne') },
    { key: 'waxon_belltown',     render: () => locationPanel(byKey['waxon_belltown']     || { label: 'WAXON Belltown',   error: 'No data' }) },
    { key: 'waxon_capitol_hill', render: () => locationPanel(byKey['waxon_capitol_hill'] || { label: 'WAXON Capitol Hill', error: 'No data' }) },
  ];
  return `
<div class="section-divider"><h2>By Location</h2></div>
<div class="locations-grid">
${columns.map(c => c.render()).join('\n')}
</div>`;
}

function generateHtml({ businesses, locations = [], generatedAt, errors }) {
  const panels = businesses.map(businessPanel).join('\n');

  const errorBanner = errors.length > 0
    ? `<div class="error-banner">${errors.map(e => `<b>${e.account}</b> unavailable — cookies need refresh`).join(' · ')}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Business Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Fraunces:ital,opsz,wght@0,9..144,300;1,9..144,300&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:      #fff9f7;
  --surface: #ffffff;
  --border:  #f0e8e4;
  --text:    #3c2f2a;
  --muted:   #b09088;
  --faint:   #f7efec;
  --green:   #5a8a6e;  --green-bg: #edf5f0;
  --amber:   #c07848;  --amber-bg: #fdf3ec;
  --rose:    #c2546b;  --rose-bg:  #fdf0f3;
  --r: 14px;
  --serif: 'Fraunces', Georgia, serif;
  --sans:  'Inter', system-ui, sans-serif;
}

html, body { height: 100%; }

body {
  font-family: var(--sans);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  line-height: 1.4;
  padding: 14px 18px 14px;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  overflow-y: auto;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  flex-shrink: 0;
}
header h1 {
  font-family: var(--serif);
  font-style: italic;
  font-weight: 300;
  font-size: 20px;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.gen-time { font-size: 11px; color: var(--muted); }
.refresh-btn {
  font-size: 11px;
  font-weight: 600;
  color: var(--rose);
  background: var(--rose-bg);
  border: 1px solid #f0c0cc;
  border-radius: 8px;
  padding: 4px 11px;
  letter-spacing: .03em;
  cursor: pointer;
  transition: opacity .15s;
  font-family: inherit;
}
.refresh-btn:hover:not(:disabled) { opacity: .75; }
.refresh-btn:disabled { opacity: .5; cursor: default; }

.error-banner {
  margin-bottom: 8px;
  padding: 7px 12px;
  background: var(--rose-bg);
  border: 1px solid #f0c0cc;
  border-radius: 8px;
  font-size: 11px;
  color: var(--rose);
  flex-shrink: 0;
}

.dashboard {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.section-divider {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
  margin-bottom: 12px;
  flex-shrink: 0;
}
.section-divider h2 {
  font-family: var(--serif);
  font-style: italic;
  font-weight: 300;
  font-size: 15px;
  color: var(--muted);
  white-space: nowrap;
}
.section-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}

.locations-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  margin-bottom: 14px;
  flex-shrink: 0;
}

.loc-panel {
  background: var(--surface);
  border-radius: var(--r);
  box-shadow: 0 1px 8px rgba(60,30,24,.07), 0 0 0 1px var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.loc-panel .biz-name { font-size: 13px; }
.loc-panel .kpi-value { font-size: 19px; }
.loc-panel .kpi-chart { min-height: 52px; }

.placeholder-body {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 11px;
  font-style: italic;
  text-align: center;
  padding: 24px 16px;
  line-height: 1.7;
}

.biz-panel {
  background: var(--surface);
  border-radius: var(--r);
  box-shadow: 0 1px 8px rgba(60,30,24,.07), 0 0 0 1px var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.biz-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.biz-name {
  font-family: var(--serif);
  font-style: italic;
  font-weight: 300;
  font-size: 17px;
}
.health-pill {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .04em;
  padding: 3px 9px;
  border-radius: 20px;
}
.health-pill.green  { background: var(--green-bg); color: var(--green); }
.health-pill.amber  { background: var(--amber-bg); color: var(--amber); }
.health-pill.red    { background: var(--rose-bg);  color: var(--rose);  }
.health-pill.neutral{ background: var(--faint);    color: var(--muted); }

.error-panel .biz-header { border-bottom: none; }
.error-body { padding: 20px 16px; color: var(--rose); }

.cards {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.kpi-card {
  flex: 1;
  min-height: 128px;
  padding: 8px 16px 6px;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  position: relative;
}
.kpi-card:last-child { border-bottom: none; }

.kpi-card::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
  border-radius: 0 2px 2px 0;
}
.kpi-card.green::before  { background: #5a8a6e; }
.kpi-card.amber::before  { background: #c07848; }
.kpi-card.red::before    { background: #c2546b; }
.kpi-card.neutral::before{ background: var(--border); }

.kpi-card-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-shrink: 0;
}
.kpi-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .07em;
  text-transform: uppercase;
  color: var(--muted);
}
.kpi-value {
  font-family: var(--serif);
  font-weight: 300;
  font-size: 20px;
  line-height: 1;
  letter-spacing: -.02em;
}

.kpi-chart {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  overflow: visible;
  padding-top: 6px;
}
.kpi-chart svg { width: 100%; max-width: 380px; height: 100%; min-height: 90px; }

.mtd-tag {
  font-family: var(--sans);
  font-size: 10px;
  font-weight: 500;
  color: var(--muted);
  letter-spacing: .04em;
  margin-left: 5px;
  vertical-align: middle;
}

.proj-row {
  font-size: 10.5px;
  color: var(--muted);
  flex-shrink: 0;
  padding-top: 2px;
}
.proj-row strong { color: var(--text); font-weight: 500; }

footer {
  margin-top: 8px;
  font-size: 10px;
  color: var(--muted);
  flex-shrink: 0;
}
</style>
</head>
<body>

<header>
  <h1>Business Dashboard</h1>
  <div class="header-right">
    <span class="gen-time">Updated ${fmtDate(generatedAt)}</span>
    <button class="refresh-btn" onclick="triggerRefresh(this)">↻ Refresh</button>
  </div>
</header>

${errorBanner}

<div class="dashboard">
${panels}
</div>

${locationsSection(locations)}

<footer>
  Sales = adjusted total &nbsp;·&nbsp; Utilization = booked ÷ available hrs (MTD) &nbsp;·&nbsp; Retention = retained within 180 days &nbsp;·&nbsp; Colors = trend vs prior month: green ↑ · amber ≈ · red ↓
</footer>

<script>
const REPO = 'SkinAndSageSpa/kpi-dashboard';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function triggerRefresh(btn) {
  let token = localStorage.getItem('gh_pat');
  if (!token) {
    token = prompt('Enter a GitHub Personal Access Token with Actions read/write scope.\\nIt will be saved locally for future refreshes.');
    if (!token) return;
    token = token.trim();
    localStorage.setItem('gh_pat', token);
  }

  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
  const orig = btn.textContent;
  btn.disabled = true;

  const setLabel = t => { btn.textContent = t; };

  try {
    setLabel('↻ Starting…');
    const triggerTime = Date.now();

    const trigRes = await fetch('https://api.github.com/repos/' + REPO + '/actions/workflows/scrape.yml/dispatches', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'master' })
    });
    if (!trigRes.ok) {
      if (trigRes.status === 401) { localStorage.removeItem('gh_pat'); alert('Invalid token — please try again.'); }
      else alert('Could not trigger run: HTTP ' + trigRes.status);
      return;
    }

    // Wait a moment then locate the new run
    await sleep(6000);
    let runId = null;
    for (let i = 0; i < 20 && !runId; i++) {
      const r = await fetch('https://api.github.com/repos/' + REPO + '/actions/runs?event=workflow_dispatch&per_page=10', { headers });
      const runs = (await r.json()).workflow_runs || [];
      const hit = runs.find(r => new Date(r.created_at).getTime() >= triggerTime - 15000);
      if (hit) runId = hit.id;
      else await sleep(4000);
    }
    if (!runId) { alert('Could not locate the triggered run. Check GitHub Actions.'); return; }

    // Poll until complete
    let elapsed = 0;
    for (;;) {
      const m = Math.floor(elapsed / 60), s = elapsed % 60;
      setLabel('↻ Running… ' + m + 'm ' + String(s).padStart(2, '0') + 's');
      await sleep(30000);
      elapsed += 30;
      const r = await fetch('https://api.github.com/repos/' + REPO + '/actions/runs/' + runId, { headers });
      const run = await r.json();
      if (run.status === 'completed') {
        if (run.conclusion !== 'success') { alert('Run ended: ' + run.conclusion + '. Check GitHub Actions.'); return; }
        break;
      }
    }

    setLabel('↻ Downloading…');

    // Fetch index.html directly from the dist branch (no zip/redirect issues)
    const rawUrl = 'https://raw.githubusercontent.com/' + REPO + '/dist/index.html?t=' + Date.now();
    const rawRes = await fetch(rawUrl);
    if (!rawRes.ok) { alert('Could not fetch dashboard: HTTP ' + rawRes.status); return; }
    let html = await rawRes.text();

    // Inject the saved token so it survives navigation to the blob URL
    const savedToken = localStorage.getItem('gh_pat');
    if (savedToken) {
      const injection = \`<script>try{localStorage.setItem('gh_pat',\${JSON.stringify(savedToken)})}catch(e){}<\/script>\`;
      html = html.replace('<' + '/head>', injection + '\\n<' + '/head>');
    }

    const blob = new Blob([html], { type: 'text/html; charset=utf-8' });
    window.location.replace(URL.createObjectURL(blob));

  } catch(e) {
    alert('Refresh failed: ' + e.message);
    btn.textContent = orig;
    btn.disabled = false;
  }
}
</script>

</body>
</html>`;
}

module.exports = { generateHtml };
