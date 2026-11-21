'use strict';
/**
 * Ghost Talk backend (hardened).
 *
 * Environment variables (set these in Render > Environment):
 *   NOWPAYMENTS_API_KEY   NOWPayments API key (NEW one - rotate the leaked one)
 *   NOWPAYMENTS_IPN_KEY   NOWPayments IPN secret (NEW one)
 *   ADMIN_SECRET          passphrase for the admin dashboard websocket
 *   MASTER_KEY            key for /admin-panel and /master-registry URLs
 *   DATABASE_URL          Postgres URL (Neon/Supabase free tier). Strongly recommended:
 *                         Render's free disk is wiped on every restart.
 *   PUBLIC_URL            optional, defaults to RENDER_EXTERNAL_URL
 *   SITE_URL              optional, where users return after paying
 *   ALLOWED_ORIGINS       optional, comma list of frontend origins for CORS
 *   TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL   optional TURN relay for calls
 *   KEEP_ALIVE=false      disables the self-ping that fights Render's 15 min sleep
 *   FIREBASE_SERVICE_ACCOUNT  optional: Firebase service-account JSON (or base64 of it) to enable wake-up push alerts
 *                         for the Android app. Alerts never contain names or message text.
 */
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8158;
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SITE_URL = (process.env.SITE_URL || PUBLIC_URL).replace(/\/$/, '');
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY || '';
const NOWPAYMENTS_IPN_KEY = process.env.NOWPAYMENTS_IPN_KEY || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const MASTER_KEY = process.env.MASTER_KEY || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const DAY = 24 * 60 * 60 * 1000;
const KEY_REGEX = /^GHOST-[A-Z0-9]{3,16}$/;

if (!ADMIN_SECRET || !MASTER_KEY) console.warn('WARNING: ADMIN_SECRET / MASTER_KEY not set - admin features are disabled.');
if (!NOWPAYMENTS_API_KEY || !NOWPAYMENTS_IPN_KEY) console.warn('WARNING: NOWPayments keys not set - payments are disabled.');

// ---------------------------------------------------------------- helpers
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function normalizeKey(k) {
  if (typeof k !== 'string') return null;
  const up = k.trim().toUpperCase();
  return KEY_REGEX.test(up) ? up : null;
}
function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === 'object') return Object.keys(o).sort().reduce((a, k) => { a[k] = sortKeys(o[k]); return a; }, {});
  return o;
}

// ---------------------------------------------------------------- storage
// All state lives in memory and is persisted as 4 JSON documents, either in
// Postgres (DATABASE_URL) or in a local file (dev only - lost on Render free).
const db = { accounts: {}, orders: {}, payments: {}, campaigns: {}, settings: {} };
let storageMode = 'file';
let pool = null, saveTimer = null, saving = false, dirty = false;

async function initStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
      max: 3, idleTimeoutMillis: 20000, connectionTimeoutMillis: 10000
    });
    pool.on('error', e => console.error('Postgres pool error (will reconnect):', e.message)); // an idle drop must never crash the server
    await pool.query('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value JSONB NOT NULL)');
    // Supabase exposes the public schema over its REST API: lock this table down.
    try { await pool.query('ALTER TABLE kv ENABLE ROW LEVEL SECURITY'); } catch (e) { console.warn('RLS:', e.message); }
    try { await pool.query('REVOKE ALL ON kv FROM anon, authenticated'); } catch (e) { /* roles only exist on Supabase */ }
    const r = await pool.query('SELECT key, value FROM kv');
    for (const row of r.rows) if (row.key in db) db[row.key] = row.value;
    storageMode = 'postgres';
    console.log('Storage: Postgres');
  } else {
    if (fs.existsSync(DATA_FILE)) {
      try { Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); }
      catch (e) { console.error('Could not read data file:', e.message); }
    }
    console.log('Storage: local file' + (IS_PROD ? ' (WARNING: ephemeral on Render - set DATABASE_URL)' : ''));
  }
}
function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush().catch(e => { console.error('Save failed, retrying in 5s:', e.message); dirty = true; setTimeout(scheduleSave, 5000); });
  }, 500);
}
async function flush() {
  if (saving) { dirty = true; return; }
  saving = true; dirty = false;
  try {
    if (pool) {
      for (const k of Object.keys(db)) {
        await pool.query(
          'INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
          [k, JSON.stringify(db[k])]
        );
      }
    } else {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DATA_FILE);
    }
  } finally {
    saving = false;
    if (dirty) scheduleSave();
  }
}

// ---------------------------------------------------------------- state
const clients = new Map();   // accountKey -> ws
const handles = new Map();   // custom handle -> accountKey
let adminWs = null;
let adminFails = 0, adminLockUntil = 0;   // global brake on admin-passphrase guessing
let planPricing = { monthly: 9.99, yearly: 89.99 };
const PLAN_DAYS = { monthly: 30, yearly: 365 };

function rebuildHandles() {
  handles.clear();
  for (const [key, acc] of Object.entries(db.accounts)) if (acc.handle) handles.set(acc.handle, key);
}
function tierOf(acc) {
  if (!acc) return 'FREE';
  if (acc.tier === 'PREMIUM' && (!acc.expiresAt || acc.expiresAt > Date.now())) return 'PREMIUM';
  return 'FREE';
}
function resolveAddress(addr) {
  if (typeof addr !== 'string') return null;
  const up = addr.trim().toUpperCase();
  if (db.accounts[up]) return up;
  if (handles.has(up)) return handles.get(up);
  return null;
}
const displayName = key => (db.accounts[key] && db.accounts[key].handle) || key;
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function accountStatus(key) {
  const acc = db.accounts[key];
  return { tier: tierOf(acc), expiresAt: (acc && acc.expiresAt) || null, handle: (acc && acc.handle) || null };
}
function notifyTier(key, extra = {}) {
  send(clients.get(key), { type: 'tier-updated', ...accountStatus(key), ...extra });
}

let metricsTimer = null;
function queueAdminMetrics() {
  if (metricsTimer) return;
  metricsTimer = setTimeout(() => { metricsTimer = null; broadcastAdminMetrics(); }, 300);
}
function broadcastAdminMetrics() {
  if (!adminWs || adminWs.readyState !== WebSocket.OPEN) return;
  const activePeers = [], dormantPeers = [];
  for (const [key, acc] of Object.entries(db.accounts)) {
    const entry = { key: acc.handle || key, tier: tierOf(acc) };
    if (clients.has(key)) activePeers.push(entry);
    else if (dormantPeers.length < 500) dormantPeers.push(entry);
  }
  const all = Object.values(db.accounts);
  send(adminWs, {
    type: 'admin-telemetry',
    metrics: {
      totalConnections: activePeers.length, activePeers, dormantPeers, pricing: planPricing,
      totals: { accounts: all.length, premium: all.filter(a => tierOf(a) === 'PREMIUM').length, paid: all.filter(a => a.paid).length }
    }
  });
}

function setFree(key) {
  const acc = db.accounts[key];
  if (!acc) return;
  acc.tier = 'FREE';
  acc.expiresAt = null;
  if (acc.handle) { handles.delete(acc.handle); acc.handle = null; }
}
function grantPremium(key, days, paid = false) {
  let acc = db.accounts[key];
  if (!acc) acc = db.accounts[key] = { secretHash: null, tier: 'FREE', expiresAt: null, handle: null, registeredAt: Date.now() };
  const now = Date.now();
  const base = tierOf(acc) === 'PREMIUM' && acc.expiresAt ? acc.expiresAt : now; // stack renewals
  acc.tier = 'PREMIUM';
  acc.expiresAt = base + days * DAY;
  if (paid) { acc.paid = true; acc.lastPaidAt = now; } // real purchase (used for affiliate conversions)
  scheduleSave();
  notifyTier(key);
  queueAdminMetrics();
}

// Expire passes every minute.
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [key, acc] of Object.entries(db.accounts)) {
    if (acc.tier === 'PREMIUM' && acc.expiresAt && now >= acc.expiresAt) {
      setFree(key);
      notifyTier(key, { message: 'Pass expired.' });
      changed = true;
    }
  }
  // prune old unpaid orders (14 days) and old payment ids (180 days)
  for (const [id, o] of Object.entries(db.orders)) if (now - o.createdAt > 14 * DAY) { delete db.orders[id]; changed = true; }
  for (const [id, ts] of Object.entries(db.payments)) if (now - ts > 180 * DAY) { delete db.payments[id]; changed = true; }
  if (changed) { scheduleSave(); queueAdminMetrics(); }
}, 60000).unref();

// ---------------------------------------------------------------- http
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Which origins may call this API. No wildcard: a random website must not be able to read API
// responses (pricing, ICE/TURN credentials) or post on a user's behalf. The Android app loads its
// WebView from https://localhost (Capacitor) and must stay allowed, otherwise calls break.
const APP_ORIGINS = new Set(['https://localhost', 'http://localhost', 'capacitor://localhost']);
function originAllowed(origin) {
  if (!origin || typeof origin !== 'string') return false;
  if (APP_ORIGINS.has(origin) || ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;   // local testing on any port
  for (const base of [PUBLIC_URL, SITE_URL]) {
    try { if (new URL(base).origin === origin) return true; } catch {}
  }
  return false;
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  // The page needs camera/mic for calls and the QR scanner; nothing else. Geolocation, payments and
  // display capture are switched off for the app origin, so injected code cannot ask for them either.
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), display-capture=(self)');
  // Render terminates TLS in front of the app: tell browsers never to downgrade to http again.
  if (/^https:/i.test(PUBLIC_URL)) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Vary', 'Origin');
    if (originAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const k = req.ip + '|' + req.path, now = Date.now(), e = hits.get(k);
    if (!e || now > e.reset) { hits.set(k, { n: 1, reset: now + windowMs }); return next(); }
    if (++e.n > max) return res.status(429).json({ success: false, error: 'Too many requests' });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, e] of hits) if (now > e.reset) hits.delete(k); }, 60000).unref();

const adminKeyOk = req => safeEqual(String(req.query.key || ''), MASTER_KEY);

app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()), storage: storageMode }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
function appCsp(req) {
  const host = /^[a-z0-9.-]+(:\d+)?$/i.test(String(req.headers.host || '')) ? req.headers.host : '';
  const extra = new Set();
  if (host) { extra.add(`https://${host}`); extra.add(`wss://${host}`); }
  try { const u = new URL(PUBLIC_URL); extra.add(`${u.protocol}//${u.host}`); extra.add(`${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}`); } catch {}
  return [
    "default-src 'self'",
    // The two QR libraries come from a CDN but are pinned by Subresource Integrity in index.html, so
    // the browser refuses any other bytes. The startup guard moved to boot.js (no inline script).
    "script-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    `connect-src 'self' ${[...extra].join(' ')}`,
    "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'"
  ].join('; ');
}
app.get('/app', (req, res) => {
  res.setHeader('Content-Security-Policy', appCsp(req));   // limits what an XSS bug could do to the encrypted client
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin-panel', limit(30, 60000), (req, res) => {
  if (!adminKeyOk(req)) return res.status(404).send('Not Found');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/download-apk', (req, res) => {
  const apkFilePath = path.join(__dirname, 'public', 'GhostTalk.apk');
  res.download(apkFilePath, 'GhostTalk.apk', err => {
    if (err && !res.headersSent) {
      res.status(404).send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Direct Download Notice</title></head>
<body style="background:#0b0f0e;color:#f3f4f6;font-family:sans-serif;text-align:center;padding-top:120px;">
<h2 style="color:#d4af37;font-family:serif;font-size:28px;">Sovereign Package Preparing</h2>
<p style="color:#9ca3af;margin-top:16px;font-size:15px;">The APK is currently queued for packaging. In the meantime, launch the <a href="/app" style="color:#d4af37;text-decoration:underline;">Secure Web Client</a>.</p>
</body></html>`);
    }
  });
});

// ---- Payment webhook. Registered BEFORE the global express.json() on purpose.
// NOWPayments signs HMAC-SHA512 over the body with keys sorted alphabetically (recursively).
// Implementations differ in number/escape formatting, so we re-canonicalise the RAW text
// (keeping number literals exactly as sent) and also try the other common variants.
function canonicalJson(text, asciiEscape) {
  let i = 0;
  const fail = () => { throw new Error('bad json'); };
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  const str = () => {
    if (text[i] !== '"') fail();
    const start = i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') i += 2;
      else if (c === '"') { i++; return text.slice(start, i); }
      else i++;
    }
    return fail();
  };
  const enc = lit => {
    let o = JSON.stringify(JSON.parse(lit));
    if (asciiEscape) o = o.replace(/[\u007f-\uffff]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
    return o;
  };
  const val = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws();
      if (text[i] === '}') { i++; return '{}'; }
      const items = [];
      for (;;) {
        ws(); const k = str(); ws();
        if (text[i++] !== ':') fail();
        items.push([JSON.parse(k), enc(k) + ':' + val()]);
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; break; }
        fail();
      }
      items.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return '{' + items.map(x => x[1]).join(',') + '}';
    }
    if (c === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return '[]'; }
      const out = [];
      for (;;) {
        out.push(val()); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; break; }
        fail();
      }
      return '[' + out.join(',') + ']';
    }
    if (c === '"') return enc(str());
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) fail();
    i += m[0].length;
    return m[0];
  };
  const out = val();
  ws();
  if (i !== text.length) fail();
  return out;
}

function verifyNowSignature(rawBody, parsedBody, sig) {
  let sigBuf;
  try { sigBuf = Buffer.from(sig, 'hex'); } catch { return false; }
  if (sigBuf.length !== 64) return false;
  const candidates = [];
  if (rawBody) for (const ascii of [false, true]) { try { candidates.push(canonicalJson(rawBody, ascii)); } catch {} }
  candidates.push(JSON.stringify(sortKeys(parsedBody)));
  candidates.push(JSON.stringify(parsedBody, Object.keys(parsedBody).sort())); // variant from NOWPayments' own Node sample
  return candidates.some(c => {
    const d = crypto.createHmac('sha512', NOWPAYMENTS_IPN_KEY).update(c).digest();
    return crypto.timingSafeEqual(d, sigBuf);
  });
}

app.post('/api/nowpayments-webhook',
  express.json({ limit: '100kb', verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }),
  async (req, res) => {
    try {
      if (!NOWPAYMENTS_IPN_KEY) return res.status(503).send('Disabled');
      const sig = String(req.headers['x-nowpayments-sig'] || '');
      if (!sig || !isObj(req.body)) return res.status(400).send('Bad request');
      if (!verifyNowSignature(req.rawBody, req.body, sig)) {
        console.warn('Webhook: INVALID SIGNATURE for payment', req.body.payment_id, '- check NOWPAYMENTS_IPN_KEY matches the IPN secret in your NOWPayments dashboard');
        return res.status(400).send('Invalid sig');
      }

      const body = req.body;
      const paymentId = String(body.payment_id || '');
      const order = db.orders[String(body.order_id || '')];
      console.log(`Webhook: payment ${paymentId} status=${body.payment_status} order=${body.order_id}`);
      if (!order || !paymentId) return res.status(200).send('Ignored');            // unknown order
      if (db.payments[paymentId]) return res.status(200).send('Already processed'); // idempotent
      // 'confirmed' = full amount received and confirmed on-chain; don't make the customer wait for payout ('finished').
      if (!['confirmed', 'sending', 'finished'].includes(body.payment_status)) return res.status(200).send('Pending');

      const paid = Number(body.price_amount);
      if (String(body.price_currency || '').toLowerCase() !== 'usd' || !(paid >= order.price - 0.01)) {
        console.warn('Webhook amount mismatch for order', body.order_id);
        return res.status(200).send('Amount mismatch');
      }
      db.payments[paymentId] = Date.now();
      order.paid = true;
      grantPremium(order.key, PLAN_DAYS[order.plan] || 30, true);
      console.log(`Premium granted: ${order.key.slice(0, 8)}... (${order.plan})`);
      try { await flush(); } catch (e) { console.error('Immediate save failed (will retry):', e.message); scheduleSave(); }
      res.status(200).send('OK');
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(500).send('Error');
    }
  });

// Never serve server-side or admin files from the public folder.
const BLOCKED_STATIC = /^\/(admin\.html|_env|\.env.*|server[^/]*\.js|package(-lock)?\.json|data\.json.*|capacitor[^/]*\.json)$/i;
// The old check only looked at the raw path, so "/./admin.html", "//admin.html" or "%2e/admin.html"
// still reached express.static and served the admin page. Normalise first, then compare the file name.
app.use((req, res, next) => {
  let p = req.path;
  try { p = decodeURIComponent(p); } catch { return res.status(400).send('Bad request'); }
  let clean = '/';
  try { clean = path.posix.normalize(p.replace(/\\/g, '/')).toLowerCase(); } catch {}
  const name = clean.split('/').filter(Boolean).pop() || '';
  const blocked = BLOCKED_STATIC.test(clean)
    || ['admin.html', '.env', 'data.json', 'package.json', 'package-lock.json'].includes(name)
    || name.startsWith('.env')
    || /^server.*\.js$/.test(name)
    || /^capacitor.*\.json$/.test(name);
  return blocked ? res.status(404).send('Not Found') : next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50kb' }));

app.get('/api/payment-info', (req, res) => res.json({ pricing: planPricing }));

app.get('/api/ice-servers', limit(60, 60000), (req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  if (process.env.TURN_URLS) {
    iceServers.push({
      urls: process.env.TURN_URLS.split(',').map(s => s.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || ''
    });
  }
  // TURN_RELAY_ONLY=true hides users' IP addresses from each other (all media goes through your TURN server).
  const relayOnly = process.env.TURN_RELAY_ONLY === 'true' && !!process.env.TURN_URLS;
  res.json({ iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all' });
});

app.post('/api/create-payment', limit(10, 60000), async (req, res) => {
  try {
    if (!NOWPAYMENTS_API_KEY) return res.status(503).json({ success: false, error: 'Payments disabled' });
    const key = normalizeKey(req.body && req.body.userKey);
    const plan = req.body && req.body.planType === 'yearly' ? 'yearly' : 'monthly';
    if (!key || !db.accounts[key]) return res.status(400).json({ success: false, error: 'Unknown account' });

    const orderId = crypto.randomBytes(12).toString('hex');
    const price = planPricing[plan];
    db.orders[orderId] = { key, plan, price, createdAt: Date.now() };

    const response = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: price, price_currency: 'usd', order_id: orderId,
        order_description: `Ghost Talk ${plan} pass`,
        ipn_callback_url: `${PUBLIC_URL}/api/nowpayments-webhook`,
        success_url: `${SITE_URL}/app?paid=1`, cancel_url: `${SITE_URL}/app`
      }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));
    if (data.invoice_url) {
      scheduleSave();
      return res.json({ success: true, invoiceUrl: data.invoice_url });
    }
    delete db.orders[orderId];
    console.error('NOWPayments invoice error:', response.status, JSON.stringify(data));
    res.status(502).json({ success: false, error: 'Gateway error' });
  } catch (err) {
    console.error('create-payment error:', err.message);
    res.status(500).json({ success: false });
  }
});

// ---- Admin HTML pages (all dynamic values are escaped)
const PAGE_CSS = `
body{background:#0e1110;color:#e2e8f0;font-family:sans-serif;padding:24px;font-size:13px}
.card{background:#141817;border:1px solid #232d2a;border-radius:8px;padding:20px;margin-bottom:20px}
table{width:100%;border-collapse:collapse;text-align:left;margin-top:10px}
th,td{padding:10px;border-bottom:1px solid #232d2a}
th{color:#8892b0;font-size:11px;text-transform:uppercase}
input{background:#0b0e0d;border:1px solid #232d2a;color:#fff;padding:8px;border-radius:4px;margin-right:8px}
button{background:#1a2220;color:#c5a059;border:1px solid #c5a059;padding:8px 14px;border-radius:4px;cursor:pointer;font-weight:600}
button:hover{background:#c5a059;color:#000}`;

const campaignStats = c => {
  const cohort = c.code
    ? Object.values(db.accounts).filter(a => a.ref === c.code)
    : Object.values(db.accounts).filter(a => a.registeredAt >= c.createdAt && a.registeredAt <= c.expiresAt); // legacy campaigns
  return { signups: cohort.length, paying: cohort.filter(a => a.paid).length };
};

app.get('/master-registry', limit(30, 60000), (req, res) => {
  if (!adminKeyOk(req)) return res.status(404).send('Not Found');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const users = Object.entries(db.accounts)
    .map(([key, a]) => ({ key, registeredAt: a.registeredAt || 0, tier: tierOf(a), ref: a.ref || '' }))
    .sort((x, y) => y.registeredAt - x.registeredAt);
  const premiumCount = users.filter(u => u.tier === 'PREMIUM').length;
  let rows = users.slice(0, 1000).map(u => `<tr>
    <td style="font-weight:bold;color:#c5a059;">${escapeHtml(u.key)}</td>
    <td>${escapeHtml(new Date(u.registeredAt).toLocaleString())}</td>
    <td><span style="color:${u.tier === 'PREMIUM' ? '#c5a059' : '#8892b0'};">${u.tier}</span></td>
    <td>${escapeHtml(u.ref || '-')}</td></tr>`).join('');
  if (!rows) rows = '<tr><td colspan="4" style="text-align:center;color:#8892b0;">No registered users yet.</td></tr>';

  const now = Date.now();
  let campRows = Object.entries(db.campaigns)
    .sort((x, y) => y[1].createdAt - x[1].createdAt)
    .map(([token, c]) => {
      const st = campaignStats(c);
      const active = now <= c.expiresAt;
      return `<tr><td>${escapeHtml(c.influencer)}</td><td>${escapeHtml(c.code || '(legacy)')}</td>
        <td style="color:${active ? '#00ff88' : '#d95764'};">${active ? 'ACTIVE' : 'EXPIRED'}<br><span style="color:#8892b0;">${escapeHtml(new Date(c.expiresAt).toLocaleString())}</span></td>
        <td>${st.signups} / ${st.paying}</td>
        <td><a style="color:#c5a059;" target="_blank" rel="noopener" href="/affiliate-registry?token=${encodeURIComponent(token)}">Dashboard</a></td></tr>`;
    }).join('');
  if (!campRows) campRows = '<tr><td colspan="5" style="text-align:center;color:#8892b0;">No campaigns yet.</td></tr>';

  const warn = (storageMode === 'file' && IS_PROD)
    ? '<div class="card" style="border-color:#d95764;color:#d95764;">WARNING: no DATABASE_URL set. Data (users, premium, campaigns) is stored on Render\'s temporary disk and is erased on every restart or redeploy. This is why links and passes "expire early". Set DATABASE_URL.</div>'
    : '';
  const keyJs = JSON.stringify(String(req.query.key)).replace(/</g, '\\u003c');

  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ghost Talk - Master Registry</title><style>${PAGE_CSS}</style></head><body>
<h2 style="color:#c5a059;margin-bottom:6px;">MASTER REGISTRY LEDGER</h2>
<p style="color:#8892b0;margin-bottom:20px;">Signup and conversion registry (read-only). Storage: ${escapeHtml(storageMode)}.</p>${warn}
<div class="card">
  <h3 style="font-size:12px;color:#8892b0;text-transform:uppercase;margin-bottom:12px;">Generate temporary influencer campaign</h3>
  <input type="text" id="influencerName" maxlength="40" placeholder="Influencer name (e.g. ALEX)">
  <input type="number" id="durationDays" value="10" style="width:80px;" min="1" max="90"> <span style="color:#8892b0;margin-right:12px;">Days</span>
  <button onclick="generateLink()">Create campaign</button>
  <div id="generatedLinkResult" style="margin-top:12px;word-break:break-all;font-family:monospace;color:#00ff88;"></div>
</div>
<div class="card">
  <h3 style="font-size:12px;color:#8892b0;text-transform:uppercase;margin-bottom:6px;">Campaigns</h3>
  <div style="overflow-x:auto;"><table><thead><tr><th>Partner</th><th>Code</th><th>Status / expires</th><th>Signups / paying</th><th>Partner link</th></tr></thead><tbody>${campRows}</tbody></table></div>
</div>
<div class="card">
  <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
    <span>Total signups: <strong>${users.length}</strong></span><span>Premium now: <strong>${premiumCount}</strong></span>
  </div>
  <div style="overflow-x:auto;"><table><thead><tr><th>User key</th><th>Registered</th><th>Tier</th><th>Ref</th></tr></thead><tbody>${rows}</tbody></table></div>
</div>
<script>
const MASTER_KEY = ${keyJs};
function addLine(box, label, url) {
  box.append(label, document.createElement('br'));
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener';
  a.style.color = '#c5a059'; a.textContent = url; box.appendChild(a); box.appendChild(document.createElement('br'));
}
async function generateLink() {
  const name = document.getElementById('influencerName').value.trim();
  const days = parseInt(document.getElementById('durationDays').value, 10);
  if (!name) { alert('Enter influencer name.'); return; }
  const res = await fetch('/api/generate-affiliate-link', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ influencer: name, days, masterKey: MASTER_KEY }) });
  const data = await res.json();
  const box = document.getElementById('generatedLinkResult');
  box.textContent = '';
  if (data.success) {
    addLine(box, 'Referral link (give this to the influencer\\'s audience):', data.referralUrl);
    box.appendChild(document.createElement('br'));
    addLine(box, 'Partner dashboard (give this to the influencer):', data.url);
    if (data.warning) box.append(document.createElement('br'), data.warning);
    setTimeout(() => location.reload(), 8000);
  } else { alert('Generation failed.'); }
}
</script></body></html>`);
});

app.post('/api/generate-affiliate-link', limit(20, 60000), (req, res) => {
  const { influencer, days, masterKey } = req.body || {};
  if (!safeEqual(String(masterKey || ''), MASTER_KEY) || typeof influencer !== 'string' || !influencer.trim()) {
    return res.status(403).json({ success: false });
  }
  const token = crypto.randomBytes(16).toString('hex');
  const code = crypto.randomBytes(5).toString('hex').toUpperCase();   // public referral code
  const durationDays = Math.min(90, Math.max(1, parseInt(days, 10) || 10));
  const now = Date.now();
  db.campaigns[token] = { influencer: influencer.trim().slice(0, 40), code, createdAt: now, expiresAt: now + durationDays * DAY };
  scheduleSave();
  res.json({
    success: true,
    url: `${PUBLIC_URL}/affiliate-registry?token=${token}`,
    referralUrl: `${SITE_URL}/?ref=${code}`,
    warning: (storageMode === 'file' && IS_PROD) ? 'WARNING: DATABASE_URL is not set, so this campaign will be lost on the next restart.' : undefined
  });
});

app.get('/affiliate-registry', limit(60, 60000), (req, res) => {
  const msg = (code, text) => res.status(code).send(`<h2 style="color:#d95764;text-align:center;margin-top:100px;font-family:sans-serif;">${text}</h2>`);
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const campaign = token && db.campaigns[token];
  if (!campaign) return msg(404, 'Invalid campaign link.');
  if (Date.now() > Number(campaign.expiresAt)) return msg(403, 'This campaign has expired.');

  const st = campaignStats(campaign);
  // Aggregate counts only: partners never see individual user keys.
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Partner Dashboard</title><style>${PAGE_CSS}</style></head><body>
<h2 style="color:#c5a059;margin-bottom:4px;">Partner Dashboard: ${escapeHtml(campaign.influencer)}</h2>
<p style="color:#8892b0;margin-bottom:20px;">Active campaign. Expires: ${escapeHtml(new Date(campaign.expiresAt).toLocaleString())}</p>
<div class="card"><div style="display:flex;justify-content:space-between;">
<span>Signups via your link: <strong>${st.signups}</strong></span><span>Paying customers: <strong>${st.paying}</strong></span>
</div></div></body></html>`);
});

// Any error thrown by a route or by the JSON body parser is answered as plain JSON. Without this,
// Express replies with an HTML page containing the server stack trace when NODE_ENV is not 'production'.
app.use((err, req, res, next) => {
  const raw = err && (err.status || err.statusCode);
  const status = Number.isInteger(raw) && raw >= 400 && raw < 500 ? raw : 400;
  if (err && err.message) console.warn('Request rejected:', req.method, req.path, '-', err.message);
  if (res.headersSent) return next(err);
  res.status(status).json({ success: false, error: 'Bad request' });
});

// ---------------------------------------------------------------- wake-up push (Android app, optional)
// A push only says "Incoming secure call" / "New secure message". It carries no names, no text, no keys.
// The server stays memory-only: it remembers WHO tried to reach an offline user for 2 minutes (RAM) so those
// senders' apps can deliver automatically once the user opens the app. Nothing else is stored or queued.
let fcm = null;
(function initFcm() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return;
  try {
    const txt = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const j = JSON.parse(txt);
    if (!j.project_id || !j.client_email || !j.private_key) throw new Error('missing fields');
    fcm = { projectId: j.project_id, clientEmail: j.client_email, privateKey: j.private_key };
    console.log('Push alerts: enabled');
  } catch (e) { console.warn('FIREBASE_SERVICE_ACCOUNT is invalid, push alerts disabled:', e.message); }
})();
const b64u = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
let fcmTok = { value: '', exp: 0 };
async function fcmAccessToken() {
  if (fcmTok.value && Date.now() < fcmTok.exp - 60000) return fcmTok.value;
  const iat = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({ iss: fcm.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
  const sig = b64u(crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(fcm.privateKey));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
    signal: AbortSignal.timeout(10000)
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error('Firebase auth failed (HTTP ' + r.status + ')');
  fcmTok = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return fcmTok.value;
}
async function fcmPush(token, kind) {
  const call = kind === 'call';
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${fcm.projectId}/messages:send`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + await fcmAccessToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: {
      token,
      notification: { title: 'Ghost Talk', body: call ? 'Incoming secure call' : 'New secure message' },
      data: { kind },
      android: { priority: 'HIGH', ttl: call ? '45s' : '120s',
        notification: { channel_id: call ? 'ghost_calls' : 'ghost_msgs', sound: 'default', visibility: 'PRIVATE', tag: 'gt-' + kind } }
    } }),
    signal: AbortSignal.timeout(10000)
  });
  if (r.ok) return 'ok';
  const t = await r.text().catch(() => '');
  if (r.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(t)) return 'unregistered';
  throw new Error('FCM HTTP ' + r.status);
}

const wakeWaiters = new Map();   // target account -> Map(sender account -> expiry)   (RAM only, 2 minutes)
const lastPush = new Map();      // target account -> { msg, call, day, n }
const pairHits = new Map();      // `${target}|${sender}` -> { t0, n }: one sender can only alert one person a few times per hour
const isBlocked = (targetKey, senderKey) => {
  const acc = db.accounts[targetKey];
  return !!(acc && Array.isArray(acc.blocked) && senderKey && acc.blocked.includes(sha256(senderKey)));
};
const WAKE_TTL = 120000;
/** Called when a user-initiated message/call/handshake finds its target offline. Returns true if the target has been (or was just) alerted. */
function maybeWake(targetKey, senderKey, kind) {
  const acc = db.accounts[targetKey];
  if (!fcm || !acc || !acc.push || !acc.push.token) return false;
  const now = Date.now();
  const lp = lastPush.get(targetKey) || { msg: 0, call: 0, day: now, n: 0 };
  if (now - lp.day > DAY) { lp.day = now; lp.n = 0; }
  if (lp.n >= 100) return false;                                  // hard daily cap: nobody can be spammed
  const pk = targetKey + '|' + senderKey;
  let ph = pairHits.get(pk);
  if (!ph || now - ph.t0 > 3600000) ph = { t0: now, n: 0 };
  if (ph.n >= 6) return false;                                    // the same person cannot keep pinging you
  const gap = kind === 'call' ? 8000 : 20000;
  if (now - lp[kind] >= gap) {
    lp[kind] = now; lp.n++;
    ph.n++; pairHits.set(pk, ph);
    lastPush.set(targetKey, lp);
    fcmPush(acc.push.token, kind).then(res => {
      if (res === 'unregistered') { delete acc.push; scheduleSave(); }
    }).catch(e => console.warn('Push failed:', e.message));
  } else lastPush.set(targetKey, lp);                             // already alerted a moment ago: just wait for them
  let m = wakeWaiters.get(targetKey);
  if (!m) { m = new Map(); wakeWaiters.set(targetKey, m); }
  m.set(senderKey, now + WAKE_TTL);
  return true;
}
function announceOnline(key) {
  const m = wakeWaiters.get(key);
  if (!m) return;
  wakeWaiters.delete(key);
  const now = Date.now();
  for (const [senderKey, exp] of m) if (exp > now) send(clients.get(senderKey), { type: 'peer-online', senderKey: displayName(key) });
}
setInterval(() => {
  const now = Date.now();
  for (const [k, m] of wakeWaiters) { for (const [s, exp] of m) if (exp <= now) m.delete(s); if (!m.size) wakeWaiters.delete(k); }
  for (const [k, v] of lastPush) if (now - v.day > 2 * DAY) lastPush.delete(k);
  for (const [k, v] of pairHits) if (now - v.t0 > 3600000) pairHits.delete(k);
}, 60000).unref();

// ---------------------------------------------------------------- websocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 10 * 1024 * 1024 });

// Plain 'chat' / 'file-transfer' no longer exist: all content travels as opaque end-to-end ciphertext ('e2e-msg').
const RELAY_TYPES = new Set(['offer', 'answer', 'ice-candidate', 'e2e-key', 'e2e-msg', 'decline', 'end-session', 'text-notify',
  // group calls (Premium host): small signalling messages only, media stays peer-to-peer
  'group-invite', 'group-accept', 'group-decline', 'group-roster', 'group-offer', 'group-answer', 'group-ice', 'group-end']);
const GROUP_MAX = 4;                   // 1 host + 3 guests, matches the client mesh limit
const isGhostKey = v => typeof v === 'string' && /^GHOST-[A-Z0-9]{3,16}$/.test(v);
const SMALL_PAYLOAD = 24000;          // chat-sized ciphertext, allowed for everyone
const MAX_PAYLOAD = 7500000;          // ~5 MB file after encryption + base64, Premium only
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, max) => typeof v === 'string' && v.length <= max;

function relay(ws, data) {
  const type = data.type;
  if (!RELAY_TYPES.has(type) || typeof data.targetKey !== 'string') return;

  const senderKey = ws.isAdmin ? null : ws.accountKey;
  const senderTier = ws.isAdmin ? 'PREMIUM' : tierOf(db.accounts[senderKey]);
  const targetKey = resolveAddress(data.targetKey);
  if (targetKey && senderKey && isBlocked(targetKey, senderKey)) {   // blocked: looks exactly like "offline", never alerts
    send(ws, { type: 'peer-offline', targetKey: data.targetKey, forType: type });
    return;
  }
  const targetWs = targetKey && clients.get(targetKey);
  if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
    // Only deliberate, user-initiated traffic may wake someone (never heartbeats, typing or receipts).
    const kind = type === 'offer' ? 'call'
      : (['e2e-key', 'e2e-msg', 'e2e-file'].includes(type) && (data.wake === 'msg' || data.wake === 'call')) ? data.wake : null;
    const notified = !!(kind && targetKey && !ws.isAdmin && maybeWake(targetKey, senderKey, kind));
    send(ws, { type: 'peer-offline', targetKey: data.targetKey, forType: type, ...(notified ? { notified: true } : {}) });
    return;
  }

  const out = { type, senderKey: ws.isAdmin ? 'ADMIN DASHBOARD' : displayName(senderKey) };
  switch (type) {
    case 'offer':
      if (!isObj(data.offer) || !isStr(data.offer.sdp, 100000)) return;
      if (data.hasVideo && senderTier !== 'PREMIUM') { send(ws, { type: 'error', message: 'Video calls require Premium.' }); return; }
      out.offer = { type: 'offer', sdp: data.offer.sdp };
      out.hasVideo = !!data.hasVideo;
      break;
    case 'answer':
      if (!isObj(data.answer) || !isStr(data.answer.sdp, 100000)) return;
      out.answer = { type: 'answer', sdp: data.answer.sdp };
      break;
    case 'ice-candidate':
      if (!isObj(data.candidate) || JSON.stringify(data.candidate).length > 4000) return;
      out.candidate = data.candidate;
      break;
    case 'e2e-key':
      // Handshake: a public key (base64, 65 bytes), a handshake id, and whether this is the answer.
      if (!isStr(data.pub, 200) || !/^[a-f0-9]{16}$/.test(String(data.hid || ''))) return;
      out.pub = data.pub; out.hid = data.hid; out.reply = !!data.reply;
      if (/^[a-f0-9]{16}$/.test(String(data.saw || ''))) out.saw = data.saw;
      break;
    // ---- group calls: the server only forwards, it never sees media or keys
    case 'group-invite':
      if (!isStr(data.groupId, 64) || !Array.isArray(data.members)) return;
      if (senderTier !== 'PREMIUM') { send(ws, { type: 'error', message: 'Group calls require Premium.' }); return; }
      out.groupId = data.groupId;
      out.hasVideo = !!data.hasVideo;
      out.members = data.members.filter(isGhostKey).slice(0, GROUP_MAX);
      if (!out.members.length) return;
      break;
    case 'group-accept':
    case 'group-decline':
    case 'group-end':
      if (!isStr(data.groupId, 64)) return;
      out.groupId = data.groupId;
      if (isGhostKey(data.me)) out.me = data.me;
      break;
    case 'group-roster':
      if (!isStr(data.groupId, 64) || !Array.isArray(data.members)) return;
      out.groupId = data.groupId;
      out.members = data.members.filter(isGhostKey).slice(0, GROUP_MAX);
      if (isGhostKey(data.me)) out.me = data.me;
      break;
    case 'group-offer':
      if (!isStr(data.groupId, 64) || !isObj(data.offer) || !isStr(data.offer.sdp, 100000)) return;
      if (data.hasVideo && senderTier !== 'PREMIUM') { send(ws, { type: 'error', message: 'Video calls require Premium.' }); return; }
      out.groupId = data.groupId;
      out.offer = { type: 'offer', sdp: data.offer.sdp };
      out.hasVideo = !!data.hasVideo;
      if (isGhostKey(data.me)) out.me = data.me;
      break;
    case 'group-answer':
      if (!isStr(data.groupId, 64) || !isObj(data.answer) || !isStr(data.answer.sdp, 100000)) return;
      out.groupId = data.groupId;
      out.answer = { type: 'answer', sdp: data.answer.sdp };
      if (isGhostKey(data.me)) out.me = data.me;
      break;
    case 'group-ice':
      if (!isStr(data.groupId, 64) || !isObj(data.candidate) || JSON.stringify(data.candidate).length > 4000) return;
      out.groupId = data.groupId;
      out.candidate = data.candidate;
      if (isGhostKey(data.me)) out.me = data.me;
      break;
    case 'e2e-msg':
      // Opaque ciphertext. The server cannot read it; it only enforces size and the Premium file limit.
      if (!isStr(data.payload, MAX_PAYLOAD) || !data.payload) return;
      if (data.payload.length > SMALL_PAYLOAD && senderTier !== 'PREMIUM') {
        send(ws, { type: 'error', message: 'File transfer requires Premium.' });
        return;
      }
      out.payload = data.payload;
      break;
    default: break; // decline, end-session, text-notify carry no payload
  }
  send(targetWs, out);
}

async function checkGateway() {
  if (!NOWPAYMENTS_API_KEY) return { ok: false, message: 'NOWPAYMENTS_API_KEY is not set.' };
  if (!NOWPAYMENTS_IPN_KEY) return { ok: false, message: 'NOWPAYMENTS_IPN_KEY is not set (webhooks cannot be verified).' };
  try {
    const r = await fetch('https://api.nowpayments.io/v1/currencies', { headers: { 'x-api-key': NOWPAYMENTS_API_KEY }, signal: AbortSignal.timeout(10000) });
    if (r.ok) return { ok: true, message: 'NOWPayments accepted your API key. Webhook URL: ' + PUBLIC_URL + '/api/nowpayments-webhook' };
    return { ok: false, message: `NOWPayments rejected the API key (HTTP ${r.status}). Create a new key in your NOWPayments dashboard.` };
  } catch (e) {
    return { ok: false, message: 'Could not reach NOWPayments: ' + e.message };
  }
}

function handleMessage(ws, data) {
  const type = data.type;

  if (type === 'ping') return send(ws, { type: 'pong' });

  if (type === 'admin-auth') {
    if (!ADMIN_SECRET) {
      return send(ws, { type: 'admin-error', message: 'ADMIN_SECRET is not set on the server (Render > Environment).' });
    }
    // Guessing the admin passphrase must not be free: after 40 wrong tries in 15 minutes the
    // login pauses for everyone (a correct passphrase works again once the pause ends).
    if (adminLockUntil > Date.now()) {
      return send(ws, { type: 'admin-error', message: 'Too many failed attempts. Try again in a few minutes.' });
    }
    if (safeEqual(String(data.secret || ''), ADMIN_SECRET)) {
      adminFails = 0;
      adminWs = ws; ws.isAdmin = true;
      send(ws, {
        type: 'admin-authenticated', pricing: planPricing, storage: storageMode,
        config: { push: !!fcm, paymentsKey: !!NOWPAYMENTS_API_KEY, ipnSecret: !!NOWPAYMENTS_IPN_KEY, webhookUrl: `${PUBLIC_URL}/api/nowpayments-webhook`, publicUrl: PUBLIC_URL }
      });
      broadcastAdminMetrics();
    } else {
      send(ws, { type: 'admin-error', message: 'Unauthorized passphrase.' });
      ws.adminFails = (ws.adminFails || 0) + 1;
      adminFails++;
      if (adminFails >= 40) {
        adminLockUntil = Date.now() + 15 * 60000;
        adminFails = 0;
        console.warn('Admin login paused for 15 minutes after repeated failed attempts.');
      }
      if (ws.adminFails >= 5) ws.close(4003, 'too many attempts');
    }
    return;
  }

  if (type && type.startsWith('admin-')) {
    if (!ws.isAdmin || ws !== adminWs) return;
    if (type === 'admin-set-tier') {
      const key = resolveAddress(data.targetKey);
      if (!key || !['FREE', 'PREMIUM'].includes(data.tier)) return;
      if (data.tier === 'PREMIUM') grantPremium(key, 30); else { setFree(key); scheduleSave(); notifyTier(key); }
      queueAdminMetrics();
    } else if (type === 'admin-update-pricing') {
      const m = isObj(data.pricing) ? Number(data.pricing.monthly) : NaN;
      const y = isObj(data.pricing) ? Number(data.pricing.yearly) : NaN;
      if (Number.isFinite(m) && m >= 1 && m <= 10000 && Number.isFinite(y) && y >= 1 && y <= 100000) {
        planPricing = { monthly: Math.round(m * 100) / 100, yearly: Math.round(y * 100) / 100 };
        db.settings.pricing = planPricing;          // survives restarts
        scheduleSave();
        send(ws, { type: 'admin-pricing-updated', pricing: planPricing });
        queueAdminMetrics();
      } else {
        send(ws, { type: 'admin-error', message: 'Invalid pricing. Use numbers of at least 1.00.' });
      }
    } else if (type === 'admin-check-payments') {
      checkGateway().then(r => send(ws, { type: 'admin-payments-status', ...r }));
    } else if (type === 'admin-kick') {
      const key = resolveAddress(data.targetKey);
      const target = key && clients.get(key);
      if (target) { send(target, { type: 'end-session' }); target.close(); }
    } else if (type === 'admin-wipe-ram') {
      for (const [, cws] of clients) { send(cws, { type: 'end-session' }); cws.close(); }
      clients.clear();
      queueAdminMetrics();
    }
    return;
  }

  if (type === 'register') {
    const key = normalizeKey(data.key);
    const secret = data.secret;
    if (!key || !isStr(secret, 128) || secret.length < 32) {
      return send(ws, { type: 'register-error', reason: 'invalid', message: 'Invalid identity.' });
    }
    const hash = sha256(secret);
    let acc = db.accounts[key];
    if (!acc) {
      acc = db.accounts[key] = { secretHash: hash, tier: 'FREE', expiresAt: null, handle: null, registeredAt: Date.now() };
      // A brand-new account key always wins over somebody else's custom handle with the same text,
      // otherwise two different people would show up under one name.
      if (handles.has(key)) {
        const owner = handles.get(key);
        if (owner !== key && db.accounts[owner] && db.accounts[owner].handle === key) db.accounts[owner].handle = null;
        handles.delete(key);
      }
      // Attribute the signup to an affiliate campaign (new accounts only, campaign must still be active).
      const ref = typeof data.ref === 'string' ? data.ref.trim().toUpperCase() : '';
      if (/^[A-Z0-9]{6,12}$/.test(ref) && Object.values(db.campaigns).some(c => c.code === ref && Date.now() <= c.expiresAt)) acc.ref = ref;
    } else if (!acc.secretHash) {
      acc.secretHash = hash; // stub created by a payment before first login
    } else if (!safeEqual(acc.secretHash, hash)) {
      return send(ws, { type: 'register-error', reason: 'identity-taken', message: 'This identity belongs to someone else.' });
    }
    if (tierOf(acc) === 'FREE' && acc.tier === 'PREMIUM') setFree(key); // lazily expire
    scheduleSave();

    const old = clients.get(key);
    if (old && old !== ws) { send(old, { type: 'replaced' }); old.accountKey = null; old.close(4000, 'replaced'); }
    ws.accountKey = key;
    clients.set(key, ws);
    send(ws, { type: 'registered', key, push: !!fcm, ...accountStatus(key) });
    announceOnline(key);                        // lets people who tried to reach you deliver automatically
    queueAdminMetrics();
    return;
  }

  if (!ws.accountKey && !ws.isAdmin) return; // everything below needs an authenticated socket

  if (type === 'push-register') {
    const acc = ws.accountKey && db.accounts[ws.accountKey];
    if (!acc || !fcm || !isStr(data.token, 4096) || data.token.length < 20) return;
    acc.push = { token: data.token, at: Date.now() };
    scheduleSave();
    send(ws, { type: 'push-registered', enabled: true });
    return;
  }
  if (type === 'block') {
    const acc = ws.accountKey && db.accounts[ws.accountKey];
    const who = acc && resolveAddress(data.targetKey);
    if (!acc || !who || who === ws.accountKey) return;
    acc.blocked = Array.isArray(acc.blocked) ? acc.blocked : [];
    const h = sha256(who);                       // only a hash is kept: the list cannot be read back as names
    if (!acc.blocked.includes(h) && acc.blocked.length < 500) acc.blocked.push(h);
    const m = wakeWaiters.get(ws.accountKey); if (m) m.delete(who);
    scheduleSave();
    send(ws, { type: 'blocked', count: acc.blocked.length });
    return;
  }
  if (type === 'unblock-all') {
    const acc = ws.accountKey && db.accounts[ws.accountKey];
    if (!acc) return;
    delete acc.blocked;
    scheduleSave();
    send(ws, { type: 'blocked', count: 0 });
    return;
  }
  if (type === 'push-unregister') {
    const acc = ws.accountKey && db.accounts[ws.accountKey];
    if (!acc) return;
    delete acc.push;
    scheduleSave();
    send(ws, { type: 'push-registered', enabled: false });
    return;
  }

  if (type === 'get-status') {
    if (ws.accountKey) notifyTier(ws.accountKey);
    return;
  }

  if (type === 'set-custom-key') {
    const key = ws.accountKey;
    if (!key) return;
    const acc = db.accounts[key];
    const fail = message => send(ws, { type: 'custom-key-error', message });
    if (tierOf(acc) !== 'PREMIUM') return fail('Premium tier required for custom handles.');
    let desired = String(data.customKey || '').trim().toUpperCase();
    if (!desired.startsWith('GHOST-')) desired = 'GHOST-' + desired;
    if (!KEY_REGEX.test(desired)) return fail('Format must be GHOST-[A-Z0-9] (3-16 chars).');
    if (desired !== key && (db.accounts[desired] || (handles.has(desired) && handles.get(desired) !== key))) {
      return fail('This handle is already claimed.');
    }
    if (acc.handle) handles.delete(acc.handle);
    if (desired === key) acc.handle = null; else { acc.handle = desired; handles.set(desired, key); }
    scheduleSave();
    send(ws, { type: 'custom-key-success', customKey: desired });
    queueAdminMetrics();
    return;
  }

  relay(ws, data);
}

wss.on('connection', (ws, req) => {
  // A random website must not be able to open a socket here (guessing account/admin secrets, or
  // probing which Ghost IDs are online). The Android app sends no Origin header, so it is unaffected.
  const wsOrigin = req && req.headers && req.headers.origin;
  if (wsOrigin && !originAllowed(wsOrigin)) { try { ws.close(4008, 'origin not allowed'); } catch {} return; }
  ws.isAlive = true;
  ws.accountKey = null;
  ws.isAdmin = false;
  ws.on('pong', () => { ws.isAlive = true; });

  let count = 0;
  const rl = setInterval(() => { count = 0; }, 1000);
  const authTimer = setTimeout(() => { if (!ws.accountKey && !ws.isAdmin) ws.close(4001, 'register timeout'); }, 15000);

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    if (++count > 40) {
      if (count === 41) send(ws, { type: 'error', message: 'Rate limit exceeded. Slow down.' });
      return;
    }
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (!isObj(data) || typeof data.type !== 'string') return;
    try { handleMessage(ws, data); } catch (err) { console.error('WS handler error:', err); }
  });

  ws.on('close', () => {
    clearInterval(rl);
    clearTimeout(authTimer);
    if (ws.accountKey && clients.get(ws.accountKey) === ws) clients.delete(ws.accountKey);
    if (ws === adminWs) adminWs = null;
    queueAdminMetrics();
  });
  ws.on('error', () => {});
});

// One heartbeat for all sockets; drops dead connections.
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 25000).unref();

// Best-effort fight against Render free-tier sleep (an external pinger or a paid plan is more reliable).
if (process.env.RENDER_EXTERNAL_URL && process.env.KEEP_ALIVE !== 'false') {
  setInterval(() => { fetch(`${PUBLIC_URL}/health`).catch(() => {}); }, 10 * 60 * 1000).unref();
}

// ---------------------------------------------------------------- boot
async function shutdown() {
  console.log('Shutting down, flushing data...');
  try { await flush(); } catch (e) { console.error(e.message); }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));

async function initStoreWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try { return await initStore(); }
    catch (e) {
      console.error(`Database connection failed (attempt ${attempt}/5): ${e.message}`);
      if (attempt >= 5) {
        console.error('Hint (Supabase): use the "Session pooler" or "Transaction pooler" connection string, not the direct one - Render cannot reach Supabase\'s IPv6-only direct host. Also make sure the project is not paused.');
        throw e;
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

initStoreWithRetry().then(() => {
  rebuildHandles();
  const sp = db.settings && db.settings.pricing;
  if (sp && sp.monthly >= 1 && sp.yearly >= 1) planPricing = { monthly: Number(sp.monthly), yearly: Number(sp.yearly) };
  server.listen(PORT, '0.0.0.0', () => console.log(`Ghost Talk live on port ${PORT}`));
}).catch(err => { console.error('Failed to start:', err); process.exit(1); });
