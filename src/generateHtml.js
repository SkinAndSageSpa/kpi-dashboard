/**
 * generateHtml.js
 * Renders KPI data as a standalone HTML file in the existing dashboard style.
 */

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

// Render a trend arrow + colour class comparing current to previous
function trend(current, previous, higherIsBetter = true) {
  if (current === null || previous === null) return '';
  const up = current >= previous;
  const better = higherIsBetter ? up : !up;
  const arrow = up ? '↑' : '↓';
  const cls   = better ? 'green' : 'red';
  return `<span class="trend ${cls}">${arrow}</span>`;
}

// One KPI card — stacked: current (large) + 2 prior months (small rows)
function kpiCard(label, periods, fmtFn, extraFn = null, higherIsBetter = true) {
  const [cur, m1, m2] = periods;
  const curVal  = cur  ? fmtFn(cur)  : '—';
  const m1Val   = m1   ? fmtFn(m1)   : '—';
  const m2Val   = m2   ? fmtFn(m2)   : '—';

  const extra = (extraFn && cur) ? `<div class="kpi-sub">${extraFn(cur)}</div>` : '';

  const t1 = trend(cur  ? cur._raw  : null, m1 ? m1._raw  : null, higherIsBetter);
  const t2 = trend(m1   ? m1._raw   : null, m2 ? m2._raw  : null, higherIsBetter);

  return `
    <div class="kpi-card">
      <div class="kpi-label">${label}</div>
      <div class="kpi-current">${curVal}</div>
      ${extra}
      <div class="kpi-history">
        <div class="kpi-row">
          <span class="kpi-month">${m1 ? m1.label : ''}</span>
          <span class="kpi-val">${m1Val}</span>${t1}
        </div>
        <div class="kpi-row">
          <span class="kpi-month">${m2 ? m2.label : ''}</span>
          <span class="kpi-val">${m2Val}</span>${t2}
        </div>
      </div>
    </div>`;
}

// Map period data into a shape the kpiCard helper can consume
function salesPeriods(periods) {
  return periods.map(p => p ? { _raw: p.sales, label: p.label, projected: p.projectedSales } : null);
}
function utilPeriods(periods) {
  return periods.map(p => p ? { _raw: p.utilization, label: p.label } : null);
}
function retPeriods(periods) {
  return periods.map(p => p ? { _raw: p.retention, label: p.label, window: p.retentionWindow } : null);
}

function businessColumn(biz) {
  const { label, periods, error } = biz;

  if (error) {
    return `
      <div class="biz-col">
        <div class="biz-header">${label}</div>
        <div class="error-card">Error loading data: ${error}</div>
      </div>`;
  }

  const sp = salesPeriods(periods);
  const up = utilPeriods(periods);
  const rp = retPeriods(periods);

  const salesCard = kpiCard(
    'Monthly Sales',
    sp,
    d => fmt$(d._raw),
    d => d.projected !== null ? `Projected: ${fmt$(d.projected)}` : null,
  );

  const utilCard = kpiCard(
    'Utilization',
    up,
    d => fmtPct(d._raw),
  );

  const retCard = kpiCard(
    'Client Retention',
    rp,
    d => fmtPct(d._raw),
    d => d.window ? `<span class="window-label">90-day window: ${d.window}</span>` : null,
  );

  return `
    <div class="biz-col">
      <div class="biz-header">${label}</div>
      ${salesCard}
      ${utilCard}
      ${retCard}
    </div>`;
}

function generateHtml({ businesses, generatedAt, errors }) {
  const cols = businesses.map(businessColumn).join('\n');

  const errorBanner = errors.length > 0
    ? `<div class="alert">${errors.map(e => `${e.account}: ${e.error}`).join('<br>')}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KPI Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Fraunces:ital,wght@0,300;0,400;1,300&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #f7f5f0; --surface: #ffffff; --border: #e2ddd6;
    --text: #1a1814; --muted: #7a7570; --accent: #2d5a3d;
    --danger: #c0392b; --danger-light: #fdf0ef;
    --warn: #b8700a; --warn-light: #fef8ec;
    --success: #2d5a3d; --success-light: #e8f0ea;
    --mono: 'DM Mono', monospace; --serif: 'Fraunces', Georgia, serif;
  }
  body {
    font-family: var(--mono);
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 48px 32px;
    font-size: 13px;
    line-height: 1.6;
  }
  header { margin-bottom: 40px; }
  header h1 { font-family: var(--serif); font-weight: 300; font-size: 32px; letter-spacing: -0.02em; margin-bottom: 4px; }
  header p { color: var(--muted); font-size: 12px; }
  .alert {
    margin-bottom: 24px;
    padding: 12px 16px;
    border-radius: 4px;
    font-size: 12px;
    border-left: 3px solid var(--danger);
    background: var(--danger-light);
    color: var(--danger);
  }
  .dashboard {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 32px;
  }
  .biz-col {}
  .biz-header {
    font-family: var(--serif);
    font-weight: 300;
    font-size: 22px;
    letter-spacing: -0.01em;
    margin-bottom: 16px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  .kpi-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 20px 24px;
    margin-bottom: 16px;
  }
  .kpi-label {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 8px;
    font-weight: 500;
  }
  .kpi-current {
    font-family: var(--serif);
    font-weight: 300;
    font-size: 40px;
    line-height: 1;
    margin-bottom: 4px;
    letter-spacing: -0.02em;
  }
  .kpi-sub {
    font-size: 11px;
    color: var(--muted);
    margin-bottom: 16px;
    margin-top: 4px;
  }
  .window-label { font-size: 10px; }
  .kpi-history {
    border-top: 1px solid var(--border);
    margin-top: 16px;
    padding-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .kpi-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }
  .kpi-month { color: var(--muted); flex: 1; }
  .kpi-val   { font-weight: 500; }
  .trend     { font-size: 11px; font-weight: 500; }
  .trend.green { color: var(--success); }
  .trend.red   { color: var(--danger); }
  .error-card {
    background: var(--danger-light);
    border: 1px solid var(--border);
    border-left: 3px solid var(--danger);
    border-radius: 4px;
    padding: 16px 20px;
    font-size: 12px;
    color: var(--danger);
  }
  footer {
    margin-top: 48px;
    font-size: 11px;
    color: var(--muted);
    border-top: 1px solid var(--border);
    padding-top: 16px;
  }
  @media (max-width: 720px) {
    .dashboard { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<header>
  <h1>KPI Dashboard</h1>
  <p>WAXON &amp; Skin &amp; Sage — generated ${fmtDate(generatedAt)}</p>
</header>

${errorBanner}

<div class="dashboard">
${cols}
</div>

<footer>
  Data sourced from Mangomint reports. Monthly Sales includes MTD total and projected end-of-month.
  Utilization = booked hours / available hours. Client Retention = rolling 90-day window.
</footer>

</body>
</html>`;
}

module.exports = { generateHtml };
