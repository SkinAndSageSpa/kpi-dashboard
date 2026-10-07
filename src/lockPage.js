/**
 * lockPage.js
 * Password-protects the owner dashboard. GitHub Pages can't require a login, so
 * the page is encrypted instead: the published index.html holds only an AES-GCM
 * ciphertext plus a small unlock form; the browser derives the key from the typed
 * password (PBKDF2-SHA256, 600k iterations) and decrypts in place. Without the
 * password the numbers aren't in the page at all — not in view-source, not in the
 * dist branch.
 *
 * Usage: DASHBOARD_PASSWORD=... node src/lockPage.js dashboard.html
 *   Rewrites the file in place. With no DASHBOARD_PASSWORD set it fails closed:
 *   the file is replaced by a "not configured" page rather than published in the clear.
 */

const crypto = require('crypto');
const fs = require('fs');

const ITERATIONS = 600000;

function lockedPage(payload) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>Business Dashboard</title>
<style>
:root { --bg:#fff9f7; --surface:#fff; --border:#f0e8e4; --text:#3c2f2a; --muted:#b09088; --rose:#c2546b; --rose-bg:#fdf0f3; }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px;
  background:var(--bg); color:var(--text); font:14px/1.4 Inter, system-ui, sans-serif; }
form { width:100%; max-width:320px; background:var(--surface); border-radius:14px; padding:24px;
  box-shadow:0 1px 8px rgba(60,30,24,.07), 0 0 0 1px var(--border); }
h1 { margin:0 0 16px; font:italic 300 20px Fraunces, Georgia, serif; }
input[type=password] { width:100%; padding:9px 11px; border:1px solid var(--border); border-radius:8px; font:inherit; }
label { display:flex; gap:6px; align-items:center; margin:10px 0 14px; color:var(--muted); font-size:12px; }
button { width:100%; padding:9px; border:1px solid #f0c0cc; border-radius:8px; background:var(--rose-bg);
  color:var(--rose); font:600 13px inherit; cursor:pointer; }
.err { color:var(--rose); font-size:12px; min-height:16px; margin-top:8px; }
</style>
</head>
<body>
<form id="f" ${payload ? '' : 'hidden'}>
  <h1>Business Dashboard</h1>
  <input id="pw" type="password" placeholder="Password" autocomplete="current-password" autofocus>
  <label><input id="rem" type="checkbox"> Remember on this device</label>
  <button type="submit">Unlock</button>
  <div class="err" id="err"></div>
</form>
${payload ? '' : '<p>Dashboard password isn’t configured yet (DASHBOARD_PASSWORD secret).</p>'}
<script>
const P = ${JSON.stringify(payload)};
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function unlock(pw) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(P.salt), iterations: P.iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(P.iv) }, key, b64(P.data));
  return new TextDecoder().decode(plain);
}
function show(html) { document.open(); document.write(html); document.close(); }
async function tryUnlock(pw, remember) {
  const html = await unlock(pw);
  try { remember ? localStorage.setItem('kpi_pw', pw) : null; } catch (e) {}
  show(html);
}
if (P) {
  let saved = null;
  try { saved = localStorage.getItem('kpi_pw'); } catch (e) {}
  if (saved) tryUnlock(saved, false).catch(() => { try { localStorage.removeItem('kpi_pw'); } catch (e) {} });
  document.getElementById('f').addEventListener('submit', async e => {
    e.preventDefault();
    const err = document.getElementById('err');
    err.textContent = 'Unlocking…';
    try { await tryUnlock(document.getElementById('pw').value, document.getElementById('rem').checked); }
    catch (x) { err.textContent = 'Wrong password'; }
  });
}
</script>
</body>
</html>`;
}

function encrypt(html, password) {
  const salt = crypto.randomBytes(16);
  const iv   = crypto.randomBytes(12);
  const key  = crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
  const c    = crypto.createCipheriv('aes-256-gcm', key, iv);
  // WebCrypto expects the GCM auth tag appended to the ciphertext.
  const data = Buffer.concat([c.update(html, 'utf8'), c.final(), c.getAuthTag()]);
  return { salt: salt.toString('base64'), iv: iv.toString('base64'), iter: ITERATIONS, data: data.toString('base64') };
}

const file = process.argv[2];
if (!file) { console.error('usage: node src/lockPage.js <file.html>'); process.exit(2); }
if (!fs.existsSync(file)) { console.log(`${file} not found — nothing to lock`); process.exit(0); }

const password = process.env.DASHBOARD_PASSWORD || '';
const html = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, lockedPage(password ? encrypt(html, password) : null), 'utf8');
console.log(password ? `Locked ${file}` : `DASHBOARD_PASSWORD not set — replaced ${file} with a "not configured" page`);
