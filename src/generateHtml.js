/**
 * generateHtml.js
 * Large-chart, minimal-text KPI dashboard. Light, soft, feminine.
 */

const THRESHOLDS = {
  utilization: { green: 70, amber: 50 },
  retention:   { green: 65, amber: 45 },
};

function healthColor(kpi, value) {
  if (value === null) return 'neutral';
  const t = THRESHOLDS[kpi];
  if (!t) return 'neutral';
  if (value >= t.green) return 'green';
  if (value >= t.amber) return 'amber';
  return 'red';
}

function salesHealth(sales, projected) {
  if (sales === null || projected === null) return 'neutral';
  const pct = sales / projected * 100;
  if (pct >= 75) return 'green';
  if (pct >= 55) return 'amber';
  return 'red';
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
  const W = 280, H = 100;
  const barW = 72, gap = 13;
  const maxBarH = 64;
  const botY = 80;
  const labY = 95;

  // Include projected total in scale so stacked bar doesn't overflow
  const allVals = values.filter(v => v !== null && v > 0);
  if (projectedTop !== null && values[0] !== null && values[0] > 0) {
    allVals.push(values[0] + projectedTop);
  }
  const maxVal = Math.max(...allVals, 1);

  const startX = (W - 3 * barW - 2 * gap) / 2;
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

function kpiCard({ label, currentDisplay, health, chart, projRow }) {
  return `
    <div class="kpi-card ${health}">
      <div class="kpi-card-top">
        <span class="kpi-label">${label}</span>
        <span class="kpi-value">${currentDisplay}</span>
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

  const [cur, m1, m2] = periods;
  const pLabels = [cur?.label, m1?.label, m2?.label];

  const sh = salesHealth(cur?.sales, cur?.projectedSales);
  const projectedTop = (cur?.projectedSales && cur?.sales && cur.projectedSales > cur.sales)
    ? cur.projectedSales - cur.sales
    : null;
  const salesCard = kpiCard({
    label: 'Sales',
    health: sh,
    currentDisplay: fmt$(cur?.sales),
    chart: bigChart(
      [cur?.sales, m1?.sales, m2?.sales].map(v => v ?? null),
      pLabels, sh,
      v => '$' + (v >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v)),
      projectedTop
    ),
    projRow: '',
  });

  const uh = healthColor('utilization', cur?.utilization);
  const utilCard = kpiCard({
    label: 'Utilization',
    health: uh,
    currentDisplay: fmtPct(cur?.utilization),
    chart: bigChart(
      [cur?.utilization, m1?.utilization, m2?.utilization].map(v => v ?? null),
      pLabels, uh,
      v => v.toFixed(1) + '%'
    ),
    projRow: '',
  });

  const rh = healthColor('retention', cur?.retention);
  const retCard = kpiCard({
    label: 'Retention',
    health: rh,
    currentDisplay: fmtPct(cur?.retention),
    chart: bigChart(
      [cur?.retention, m1?.retention, m2?.retention].map(v => v ?? null),
      pLabels, rh,
      v => Math.round(v) + '%'
    ),
    projRow: '',
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

function generateHtml({ businesses, generatedAt, errors }) {
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
  padding: 14px 18px 10px;
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

header {
  display: flex;
  align-items: baseline;
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
.gen-time { font-size: 11px; color: var(--muted); }

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
  flex: 1;
  min-height: 0;
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
  min-height: 0;
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
  font-size: 26px;
  line-height: 1;
  letter-spacing: -.02em;
}

.kpi-chart {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: flex-end;
  overflow: visible;
  padding-top: 6px;
}
.kpi-chart svg { width: 100%; height: 100%; min-height: 60px; }

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
  <span class="gen-time">Updated ${fmtDate(generatedAt)}</span>
</header>

${errorBanner}

<div class="dashboard">
${panels}
</div>

<footer>
  Sales = adjusted total &nbsp;·&nbsp; Utilization = booked ÷ available hrs &nbsp;·&nbsp; Retention = retained within 180 days &nbsp;·&nbsp; Green ≥70%/65% · Amber ≥50%/45%
</footer>

</body>
</html>`;
}

module.exports = { generateHtml };
