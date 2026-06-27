/**
 * generateHtml.js
 * Soft, warm business health dashboard — light mode, fits on screen without scrolling.
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

// Mini sparkline bars — 3 bars, current month highlighted
function sparkBars(values) {
  const valid = values.filter(v => v !== null && v > 0);
  const max = valid.length ? Math.max(...valid) : 1;
  const bars = values.map((v, i) => {
    const h = (v !== null && v > 0) ? Math.max(4, Math.round((v / max) * 28)) : 3;
    const x = i * 13;
    const isCurrent = i === 0;
    const fill = isCurrent ? 'var(--bar-active)' : 'var(--bar-past)';
    const opacity = (v === null || v === 0) ? '0.3' : '1';
    return `<rect x="${x}" y="${30 - h}" width="9" height="${h}" rx="2" fill="${fill}" opacity="${opacity}"/>`;
  }).join('');
  return `<svg width="39" height="30" viewBox="0 0 39 30">${bars}</svg>`;
}

function deltaBadge(current, previous, isMoney = false) {
  if (current === null || previous === null) return '<span class="delta neutral">—</span>';
  const diff = current - previous;
  if (Math.abs(diff) < 0.01) return '<span class="delta neutral">—</span>';
  const up = diff > 0;
  const cls = up ? 'up' : 'down';
  const arrow = up ? '↑' : '↓';
  let display;
  if (isMoney) {
    display = `${arrow} ${fmt$(Math.abs(diff))} vs last month`;
  } else {
    display = `${arrow} ${Math.abs(diff).toFixed(1)}pp vs last month`;
  }
  return `<span class="delta ${cls}">${display}</span>`;
}

function kpiCard(opts) {
  const { label, sublabel, currentDisplay, prevPeriods, spark, delta, health, projRow } = opts;

  const accent = { green: '#5c8a6e', amber: '#c47c4a', red: '#c2546b', neutral: '#c4b5ae' }[health];

  const prevHtml = prevPeriods.map(p =>
    `<div class="prev-row">
      <span class="prev-label">${p.label}</span>
      <span class="prev-val">${p.display}</span>
    </div>`
  ).join('');

  return `
    <div class="kpi-card ${health}">
      <div class="kpi-card-top">
        <div class="kpi-label">${label}</div>
        <div class="kpi-spark">${spark}</div>
      </div>
      <div class="kpi-value">${currentDisplay}</div>
      ${sublabel ? `<div class="kpi-sub">${sublabel}</div>` : ''}
      ${projRow || ''}
      ${delta}
      <div class="prev-rows">${prevHtml}</div>
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
        <div class="error-body">Cookies expired — refresh the secret to restore data.</div>
      </div>`;
  }

  const [cur, m1, m2] = periods;

  // Sales
  const sh = salesHealth(cur?.sales, cur?.projectedSales);
  const salesCard = kpiCard({
    label: 'Monthly Sales',
    sublabel: 'MTD adjusted total',
    health: sh,
    currentDisplay: fmt$(cur?.sales),
    projRow: cur?.projectedSales
      ? `<div class="proj-row"><span>Projected EOM</span><strong>${fmt$(cur?.projectedSales)}</strong></div>`
      : '',
    delta: deltaBadge(cur?.sales, m1?.sales, true),
    spark: sparkBars([cur?.sales, m1?.sales, m2?.sales].map(v => v ?? null)),
    prevPeriods: [
      { label: m1?.label || '', display: fmt$(m1?.sales) },
      { label: m2?.label || '', display: fmt$(m2?.sales) },
    ],
  });

  // Utilization
  const uh = healthColor('utilization', cur?.utilization);
  const utilCard = kpiCard({
    label: 'Utilization',
    sublabel: 'booked hrs / available hrs',
    health: uh,
    currentDisplay: fmtPct(cur?.utilization),
    projRow: '',
    delta: deltaBadge(cur?.utilization, m1?.utilization),
    spark: sparkBars([cur?.utilization, m1?.utilization, m2?.utilization].map(v => v ?? null)),
    prevPeriods: [
      { label: m1?.label || '', display: fmtPct(m1?.utilization) },
      { label: m2?.label || '', display: fmtPct(m2?.utilization) },
    ],
  });

  // Retention
  const rh = healthColor('retention', cur?.retention);
  const retCard = kpiCard({
    label: 'Client Retention',
    sublabel: 'retained within 180 days',
    health: rh,
    currentDisplay: fmtPct(cur?.retention),
    projRow: '',
    delta: deltaBadge(cur?.retention, m1?.retention),
    spark: sparkBars([cur?.retention, m1?.retention, m2?.retention].map(v => v ?? null)),
    prevPeriods: [
      { label: m1?.label || '', display: fmtPct(m1?.retention) },
      { label: m2?.label || '', display: fmtPct(m2?.retention) },
    ],
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
    ? `<div class="error-banner">${errors.map(e => `<b>${e.account}</b> data unavailable — cookies need refresh`).join(' &nbsp;·&nbsp; ')}</div>`
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
  --bg:        #fff9f7;
  --surface:   #ffffff;
  --border:    #f0e8e4;
  --text:      #3c2f2a;
  --muted:     #b09088;
  --faint:     #f7efec;

  --green:     #5a8a6e;
  --green-bg:  #edf5f0;
  --amber:     #c07848;
  --amber-bg:  #fdf3ec;
  --rose:      #bf5068;
  --rose-bg:   #fdf0f3;
  --neutral:   #c4b5ae;

  --bar-active: #d4919d;
  --bar-past:   #ede5e2;

  --r: 14px;
  --serif: 'Fraunces', Georgia, serif;
  --sans:  'Inter', system-ui, sans-serif;
}

html, body {
  height: 100%;
}

body {
  font-family: var(--sans);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  line-height: 1.45;
  padding: 18px 22px 14px;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

/* ── Header ──────────────────────────────────────────────────────────── */
header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 14px;
  flex-shrink: 0;
}
header h1 {
  font-family: var(--serif);
  font-style: italic;
  font-weight: 300;
  font-size: 22px;
  color: var(--text);
  letter-spacing: -0.01em;
}
.gen-time {
  font-size: 11px;
  color: var(--muted);
}

/* ── Error banner ─────────────────────────────────────────────────────── */
.error-banner {
  margin-bottom: 10px;
  padding: 8px 14px;
  background: var(--rose-bg);
  border: 1px solid #f0c0cc;
  border-radius: 8px;
  font-size: 11.5px;
  color: var(--rose);
  flex-shrink: 0;
}

/* ── Two-column layout ────────────────────────────────────────────────── */
.dashboard {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  flex: 1;
}

/* ── Business panel ───────────────────────────────────────────────────── */
.biz-panel {
  background: var(--surface);
  border-radius: var(--r);
  box-shadow: 0 1px 8px rgba(60, 30, 24, 0.07), 0 0 0 1px var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.biz-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.biz-name {
  font-family: var(--serif);
  font-style: italic;
  font-weight: 300;
  font-size: 18px;
  color: var(--text);
}

.health-pill {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 3px 10px;
  border-radius: 20px;
}
.health-pill.green   { background: var(--green-bg); color: var(--green); }
.health-pill.amber   { background: var(--amber-bg); color: var(--amber); }
.health-pill.red     { background: var(--rose-bg);  color: var(--rose);  }
.health-pill.neutral { background: var(--faint);    color: var(--muted); }

.error-panel .biz-header { border-bottom: none; }
.error-body {
  padding: 20px 16px;
  color: var(--rose);
  font-size: 12px;
}

/* ── KPI cards ────────────────────────────────────────────────────────── */
.cards {
  display: flex;
  flex-direction: column;
  flex: 1;
}

.kpi-card {
  flex: 1;
  padding: 11px 16px;
  border-bottom: 1px solid var(--border);
  position: relative;
  display: flex;
  flex-direction: column;
}
.kpi-card:last-child { border-bottom: none; }

/* Left accent line */
.kpi-card::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
  border-radius: 0 2px 2px 0;
}
.kpi-card.green::before  { background: var(--green); }
.kpi-card.amber::before  { background: var(--amber); }
.kpi-card.red::before    { background: var(--rose);  }
.kpi-card.neutral::before { background: var(--border); }

.kpi-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.kpi-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--muted);
}
.kpi-spark { flex-shrink: 0; }

.kpi-value {
  font-family: var(--serif);
  font-weight: 300;
  font-size: 30px;
  line-height: 1;
  letter-spacing: -0.02em;
  margin-bottom: 2px;
  color: var(--text);
}
.kpi-sub {
  font-size: 10.5px;
  color: var(--muted);
  margin-bottom: 4px;
}

/* Projected EOM */
.proj-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 4px;
}
.proj-row strong {
  color: var(--text);
  font-weight: 500;
}

/* Delta */
.delta {
  display: inline-block;
  font-size: 10.5px;
  font-weight: 500;
  padding: 1px 7px;
  border-radius: 6px;
  margin-bottom: 6px;
}
.delta.up      { background: var(--green-bg); color: var(--green); }
.delta.down    { background: var(--rose-bg);  color: var(--rose);  }
.delta.neutral { background: var(--faint);    color: var(--muted); }

/* Prev months */
.prev-rows {
  margin-top: auto;
  padding-top: 6px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.prev-row {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
}
.prev-label { color: var(--muted); }
.prev-val   { font-weight: 500; color: var(--text); }

/* ── Footer ───────────────────────────────────────────────────────────── */
footer {
  margin-top: 10px;
  font-size: 10.5px;
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
  Sales = adjusted total (gross − refunds) &nbsp;·&nbsp; Utilization = booked ÷ available hours &nbsp;·&nbsp;
  Retention = retained within 180 days ÷ total clients &nbsp;·&nbsp;
  Thriving ≥ 70% util / 65% ret &nbsp;·&nbsp; Watch ≥ 50% / 45%
</footer>

</body>
</html>`;
}

module.exports = { generateHtml };
