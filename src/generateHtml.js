/**
 * generateHtml.js
 * Executive health scorecard dashboard.
 * Two businesses side by side. Three KPIs each.
 * Color-coded by threshold. Mini bar chart shows 3-month trend.
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

// Sales health: are we on pace vs projected?
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

// Mini SVG bar chart — 3 values, current is highlighted
function sparkBars(values, colorClass) {
  const max = Math.max(...values.filter(v => v !== null), 1);
  const bars = values.map((v, i) => {
    const h = v !== null ? Math.max(4, Math.round((v / max) * 32)) : 4;
    const isCurrent = i === 0;
    const fill = isCurrent ? 'var(--bar-active)' : 'var(--bar-past)';
    const opacity = v === null ? '0.2' : '1';
    return `<rect x="${i * 14}" y="${36 - h}" width="10" height="${h}" rx="2" fill="${fill}" opacity="${opacity}"/>`;
  }).join('');
  return `<svg width="42" height="36" viewBox="0 0 42 36" class="spark ${colorClass}">${bars}</svg>`;
}

// Delta badge: current vs previous month
function deltaBadge(current, previous) {
  if (current === null || previous === null) return '';
  const diff = current - previous;
  if (Math.abs(diff) < 0.01) return '<span class="delta neutral">—</span>';
  const up = diff > 0;
  const sign = up ? '+' : '';
  const cls = up ? 'up' : 'down';
  const formatted = Number.isInteger(diff) ? `${sign}${Math.round(diff)}` : `${sign}${diff.toFixed(1)}`;
  return `<span class="delta ${cls}">${up ? '▲' : '▼'} ${formatted}</span>`;
}

function salesDelta(current, previous) {
  if (current === null || previous === null) return '';
  const diff = current - previous;
  const up = diff >= 0;
  const cls = up ? 'up' : 'down';
  const sign = up ? '+' : '';
  return `<span class="delta ${cls}">${up ? '▲' : '▼'} ${sign}${fmt$(Math.abs(diff))}</span>`;
}

function kpiBlock(opts) {
  const { label, sublabel, currentVal, currentDisplay, prevPeriods, spark, delta, health, projRow } = opts;

  const dot = health !== 'neutral'
    ? `<span class="health-dot ${health}"></span>`
    : `<span class="health-dot neutral"></span>`;

  const prevHtml = prevPeriods.map(p =>
    `<div class="prev-row">
      <span class="prev-label">${p.label}</span>
      <span class="prev-val">${p.display}</span>
    </div>`
  ).join('');

  return `
    <div class="kpi-block ${health}">
      <div class="kpi-top">
        <div class="kpi-name">${dot}${label}</div>
        <div class="kpi-spark">${spark}</div>
      </div>
      <div class="kpi-main">${currentDisplay}</div>
      ${sublabel ? `<div class="kpi-sub">${sublabel}</div>` : ''}
      ${projRow || ''}
      <div class="kpi-delta">${delta}</div>
      <div class="prev-periods">${prevHtml}</div>
    </div>`;
}

function businessPanel(biz) {
  const { label, periods, error } = biz;

  if (error) {
    return `
      <div class="biz-panel error-panel">
        <div class="biz-name">${label}</div>
        <div class="error-msg">⚠ ${error}</div>
      </div>`;
  }

  const [cur, m1, m2] = periods;

  // ── Sales ──────────────────────────────────────────────────────────────────
  const salesHealth_ = salesHealth(cur?.sales, cur?.projectedSales);
  const salesSpark = sparkBars(
    [cur?.sales, m1?.sales, m2?.sales].map(v => v ?? null),
    salesHealth_
  );
  const salesBlock = kpiBlock({
    label: 'Monthly Sales',
    health: salesHealth_,
    currentDisplay: fmt$(cur?.sales),
    sublabel: cur?.sales !== null ? `${fmtDate(new Date().toISOString()).split(',')[0]} MTD` : null,
    projRow: cur?.projectedSales !== null
      ? `<div class="proj-row"><span class="proj-label">Projected</span><span class="proj-val">${fmt$(cur?.projectedSales)}</span></div>`
      : '',
    delta: salesDelta(cur?.sales, m1?.sales),
    spark: salesSpark,
    prevPeriods: [
      { label: m1?.label || '', display: fmt$(m1?.sales) },
      { label: m2?.label || '', display: fmt$(m2?.sales) },
    ],
  });

  // ── Utilization ────────────────────────────────────────────────────────────
  const utilHealth = healthColor('utilization', cur?.utilization);
  const utilSpark = sparkBars(
    [cur?.utilization, m1?.utilization, m2?.utilization].map(v => v ?? null),
    utilHealth
  );
  const utilBlock = kpiBlock({
    label: 'Utilization',
    sublabel: 'booked hrs / available hrs',
    health: utilHealth,
    currentDisplay: fmtPct(cur?.utilization),
    projRow: '',
    delta: deltaBadge(cur?.utilization, m1?.utilization),
    spark: utilSpark,
    prevPeriods: [
      { label: m1?.label || '', display: fmtPct(m1?.utilization) },
      { label: m2?.label || '', display: fmtPct(m2?.utilization) },
    ],
  });

  // ── Retention ──────────────────────────────────────────────────────────────
  const retHealth = healthColor('retention', cur?.retention);
  const retSpark = sparkBars(
    [cur?.retention, m1?.retention, m2?.retention].map(v => v ?? null),
    retHealth
  );
  const retBlock = kpiBlock({
    label: 'Client Retention',
    sublabel: 'retained within 180 days',
    health: retHealth,
    currentDisplay: fmtPct(cur?.retention),
    projRow: '',
    delta: deltaBadge(cur?.retention, m1?.retention),
    spark: retSpark,
    prevPeriods: [
      { label: m1?.label || '', display: fmtPct(m1?.retention) },
      { label: m2?.label || '', display: fmtPct(m2?.retention) },
    ],
  });

  // Overall business health signal
  const signals = [salesHealth_, utilHealth, retHealth].filter(h => h !== 'neutral');
  const overallHealth = signals.includes('red') ? 'red'
    : signals.includes('amber') ? 'amber'
    : signals.length > 0 ? 'green' : 'neutral';

  const healthLabel = { green: 'On Track', amber: 'Watch', red: 'Needs Attention', neutral: 'No Data' };

  return `
    <div class="biz-panel">
      <div class="biz-header">
        <div class="biz-name">${label}</div>
        <div class="biz-health ${overallHealth}">${healthLabel[overallHealth]}</div>
      </div>
      <div class="kpi-grid">
        ${salesBlock}
        ${utilBlock}
        ${retBlock}
      </div>
    </div>`;
}

function generateHtml({ businesses, generatedAt, errors }) {
  const panels = businesses.map(businessPanel).join('\n');

  const errorBanner = errors.length > 0
    ? `<div class="error-banner">${errors.map(e => `<b>${e.account}</b>: ${e.error}`).join('<br>')}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KPI Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Fraunces:ital,wght@0,300;0,400;1,300&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:       #0f1117;
    --surface:  #1a1d27;
    --surface2: #22253a;
    --border:   #2d3148;
    --text:     #e8eaf0;
    --muted:    #6b7280;
    --green:    #22c55e;
    --green-bg: #052e16;
    --amber:    #f59e0b;
    --amber-bg: #1c1200;
    --red:      #ef4444;
    --red-bg:   #1f0707;
    --neutral:  #6b7280;
    --bar-active: #6366f1;
    --bar-past:   #2d3148;
    --serif: 'Fraunces', Georgia, serif;
    --sans:  'Inter', system-ui, sans-serif;
  }
  body {
    font-family: var(--sans);
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 40px 28px;
    font-size: 13px;
    line-height: 1.5;
  }

  /* ── Header ─────────────────────────────────────────────────────────── */
  header {
    margin-bottom: 36px;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  header h1 {
    font-family: var(--serif);
    font-weight: 300;
    font-size: 28px;
    letter-spacing: -0.02em;
    color: var(--text);
  }
  .gen-time { font-size: 11px; color: var(--muted); }

  /* ── Error banner ────────────────────────────────────────────────────── */
  .error-banner {
    margin-bottom: 20px;
    padding: 12px 16px;
    background: var(--red-bg);
    border: 1px solid var(--red);
    border-radius: 6px;
    font-size: 12px;
    color: var(--red);
  }

  /* ── Layout: two business panels ────────────────────────────────────── */
  .dashboard {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
  }
  @media (max-width: 800px) { .dashboard { grid-template-columns: 1fr; } }

  /* ── Business panel ──────────────────────────────────────────────────── */
  .biz-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
  }
  .biz-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
  }
  .biz-name {
    font-family: var(--serif);
    font-weight: 300;
    font-size: 20px;
    letter-spacing: -0.01em;
  }
  .biz-health {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 4px 10px;
    border-radius: 20px;
  }
  .biz-health.green  { background: var(--green-bg); color: var(--green); }
  .biz-health.amber  { background: var(--amber-bg); color: var(--amber); }
  .biz-health.red    { background: var(--red-bg);   color: var(--red);   }
  .biz-health.neutral { background: var(--surface2); color: var(--muted); }

  .error-panel .biz-name { padding: 16px 20px; border-bottom: 1px solid var(--border); }
  .error-msg { padding: 20px; color: var(--red); font-size: 13px; }

  /* ── KPI grid: 3 cards ───────────────────────────────────────────────── */
  .kpi-grid {
    display: flex;
    flex-direction: column;
  }

  /* ── KPI block ───────────────────────────────────────────────────────── */
  .kpi-block {
    padding: 18px 20px;
    border-bottom: 1px solid var(--border);
    position: relative;
  }
  .kpi-block:last-child { border-bottom: none; }
  .kpi-block.green  { border-left: 3px solid var(--green); }
  .kpi-block.amber  { border-left: 3px solid var(--amber); }
  .kpi-block.red    { border-left: 3px solid var(--red);   }
  .kpi-block.neutral { border-left: 3px solid var(--border); }

  .kpi-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .kpi-name {
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .health-dot {
    width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  }
  .health-dot.green   { background: var(--green); }
  .health-dot.amber   { background: var(--amber); }
  .health-dot.red     { background: var(--red);   }
  .health-dot.neutral { background: var(--muted); }

  .kpi-spark { flex-shrink: 0; }

  .kpi-main {
    font-family: var(--serif);
    font-size: 38px;
    font-weight: 300;
    letter-spacing: -0.02em;
    line-height: 1;
    margin-bottom: 4px;
  }
  .kpi-sub {
    font-size: 11px;
    color: var(--muted);
    margin-bottom: 6px;
  }

  /* Projected end-of-month row */
  .proj-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .proj-label {
    font-size: 11px;
    color: var(--muted);
  }
  .proj-val {
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
  }

  /* Delta badge */
  .kpi-delta { margin-bottom: 12px; }
  .delta {
    font-size: 12px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 4px;
  }
  .delta.up     { background: var(--green-bg); color: var(--green); }
  .delta.down   { background: var(--red-bg);   color: var(--red);   }
  .delta.neutral { background: var(--surface2); color: var(--muted); }

  /* Previous months */
  .prev-periods {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }
  .prev-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
  }
  .prev-label { color: var(--muted); }
  .prev-val   { font-weight: 500; }

  /* Spark bar colours */
  .spark.green rect:first-child   { fill: var(--green) !important; }
  .spark.amber rect:first-child   { fill: var(--amber) !important; }
  .spark.red   rect:first-child   { fill: var(--red)   !important; }

  /* ── Footer ──────────────────────────────────────────────────────────── */
  footer {
    margin-top: 32px;
    font-size: 11px;
    color: var(--muted);
    border-top: 1px solid var(--border);
    padding-top: 14px;
  }
</style>
</head>
<body>

<header>
  <h1>Business Health</h1>
  <span class="gen-time">Generated ${fmtDate(generatedAt)}</span>
</header>

${errorBanner}

<div class="dashboard">
${panels}
</div>

<footer>
  Sales = Adjusted Total (gross minus refunds). Utilization = booked hrs ÷ available hrs (all staff).
  Retention = clients retained within 180 days ÷ total clients from that month.
  Green ≥ 70% util / 65% retention · Amber ≥ 50% / 45% · Red below.
</footer>

</body>
</html>`;
}

module.exports = { generateHtml };
