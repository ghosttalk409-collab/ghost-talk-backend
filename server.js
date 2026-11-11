'use strict';
/**
 * Ghost Talk backend (hardened & production-ready).
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
const db = { accounts: {}, orders: {}, payments: {}, campaigns: {}, settings: {} };
let storageMode = 'file';
let pool = null, saveTimer = null, saving = false, dirty = false;

async function initStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false }
    });
    await pool.query('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value JSONB NOT NULL)');
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
  saveTimer = setTimeout(() => { saveTimer = null; flush().catch(e => console.error('Save failed:', e.message)); }, 500);
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
const clients = new Map();
const handles = new Map();
let adminWs = null;
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
  send(adminWs, {
    type: 'admin-telemetry',
    metrics: { totalConnections: activePeers.length, activePeers, dormantPeers, pricing: planPricing }
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
  const base = tierOf(acc) === 'PREMIUM' && acc.expiresAt ? acc.expiresAt : now;
  acc.tier = 'PREMIUM';
  acc.expiresAt = base + days * DAY;
  if (paid) { acc.paid = true; acc.lastPaidAt = now; }
  scheduleSave();
  notifyTier(key);
  queueAdminMetrics();
}

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
  for (const [id, o] of Object.entries(db.orders)) if (now - o.createdAt > 14 * DAY) { delete db.orders[id]; changed = true; }
  for (const [id, ts] of Object.entries(db.payments)) if (now - ts > 180 * DAY) { delete db.payments[id]; changed = true; }
  if (changed) { scheduleSave(); queueAdminMetrics(); }
}, 60000).unref();

// ---------------------------------------------------------------- http
const app = express();
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const origin = req.headers.origin;
  if (origin && (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.length ? origin : '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

const WS_HOST = (() => { try { return new URL(PUBLIC_URL).host; } catch { return ''; } })();
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  `connect-src 'self' ${PUBLIC_URL} wss://${WS_HOST} https://ghost-talk-backend.onrender.com wss://ghost-talk-backend.onrender.com`,
  "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'"
].join('; ');

app.get('/app', (req, res) => {
  res.setHeader('Content-Security-Policy', APP_CSP);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin-panel', limit(30, 60000), (req, res) => {
  if (!adminKeyOk(req)) return res.status(404).send('Not Found');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

function verifyNowSignature(rawBody, parsedBody, sig) {
  let sigBuf;
  try { sigBuf = Buffer.from(sig, 'hex'); } catch { return false; }
  if (sigBuf.length !== 64) return false;
  const candidates = [];
  if (rawBody) {
    try { candidates.push(rawBody.trim()); } catch {}
  }
  candidates.push(JSON.stringify(sortKeys(parsedBody)));
  candidates.push(JSON.stringify(parsedBody, Object.keys(parsedBody).sort()));
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
      if (!sig || !req.body || typeof req.body !== 'object') return res.status(400).send('Bad request');
      if (!verifyNowSignature(req.rawBody, req.body, sig)) {
        console.warn('Webhook INVALID SIGNATURE for payment', req.body.payment_id);
        return res.status(400).send('Invalid sig');
      }

      const body = req.body;
      const paymentId = String(body.payment_id || '');
      const order = db.orders[String(body.order_id || '')];
      if (!order || !paymentId) return res.status(200).send('Ignored');
      if (db.payments[paymentId]) return res.status(200).send('Already processed');
      if (body.payment_status !== 'finished') return res.status(200).send('Pending');

      const paid = Number(body.price_amount);
      if (String(body.price_currency || '').toLowerCase() !== 'usd' || !(paid >= order.price - 0.01)) {
        console.warn('Webhook amount mismatch for order', body.order_id);
        return res.status(200).send('Amount mismatch');
      }
      db.payments[paymentId] = Date.now();
      order.paid = true;
      grantPremium(order.key, PLAN_DAYS[order.plan] || 30, true);
      await flush();
      res.status(200).send('OK');
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(500).send('Error');
    }
  });

const BLOCKED_STATIC = /^\/(admin\.html|_env|\.env.*|server[^/]*\.js|package(-lock)?\.json|data\.json.*|capacitor[^/]*\.json)$/i;
app.use((req, res, next) => {
  let p = req.path;
  try { p = decodeURIComponent(p); } catch { return res.status(400).send('Bad request'); }
  return BLOCKED_STATIC.test(p) ? res.status(404).send('Not Found') : next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50kb' }));

app.get('/api/payment-info', (req, res) => res.json({ pricing: planPricing }));

app.post('/api/create-payment', limit(10, 60000), async (req, res) => {
  try {
    if (!NOWPAYMENTS_API_KEY) return res.status(503).json({ success: false, error: 'Payments disabled' });
    const key = normalizeKey(req.body && req.body.userKey);
    const plan = req.body && req.body.planType === 'yearly' ? 'yearly' : 'monthly';
    if (!key || !db.accounts[key]) return res.status(400).json({ success: false, error: 'Unknown account' });

    const orderId = crypto.randomBytes(12).toString('hex');
    const price = planPricing[plan];
    db.orders[orderId] = { key, plan, price, createdAt: Date.now() };
    await flush();

    const response = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: price, price_currency: 'usd', order_id: orderId,
        order_description: `Ghost Talk ${plan} pass`,
        ipn_callback_url: `${PUBLIC_URL}/api/nowpayments-webhook`,
        success_url: `${SITE_URL}/app`, cancel_url: `${SITE_URL}/app`
      }),
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));
    if (data.invoice_url) {
      return res.json({ success: true, invoiceUrl: data.invoice_url });
    }
    delete db.orders[orderId];
    await flush();
    res.status(502).json({ success: false, error: 'Gateway error' });
  } catch (err) {
    console.error('create-payment error:', err.message);
    res.status(500).json({ success: false });
  }
});

app.post('/api/generate-affiliate-link', limit(20, 60000), async (req, res) => {
  const { influencer, days, masterKey } = req.body || {};
  if (!safeEqual(String(masterKey || ''), MASTER_KEY) || typeof influencer !== 'string' || !influencer.trim()) {
    return res.status(403).json({ success: false });
  }
  const token = crypto.randomBytes(16).toString('hex');
  const code = crypto.randomBytes(5).toString('hex').toUpperCase();
  const durationDays = Math.min(90, Math.max(1, parseInt(days, 10) || 10));
  const now = Date.now();
  db.campaigns[token] = { influencer: influencer.trim().slice(0, 40), code, createdAt: now, expiresAt: now + durationDays * DAY };
  await flush();
  res.json({
    success: true,
    url: `${PUBLIC_URL}/affiliate-registry?token=${token}`,
    referralUrl: `${SITE_URL}/?ref=${code}`
  });
});

// ---------------------------------------------------------------- websocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 10 * 1024 * 1024 });

const wsAdminFails = new Map();

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.accountKey = null;
  ws.isAdmin = false;
  ws.remoteIp = req.socket.remoteAddress || 'unknown';
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let data; try { data = JSON.parse(raw.toString()); } catch { return; }
    if (!data || typeof data.type !== 'string') return;

    if (data.type === 'admin-auth') {
      const attempts = wsAdminFails.get(ws.remoteIp) || 0;
      if (attempts >= 10) {
        send(ws, { type: 'admin-error', message: 'Too many failed attempts. Temporarily blocked.' });
        return ws.close(4003, 'blocked');
      }
      if (ADMIN_SECRET && safeEqual(String(data.secret || ''), ADMIN_SECRET)) {
        adminWs = ws; ws.isAdmin = true;
        wsAdminFails.delete(ws.remoteIp);
        send(ws, { type: 'admin-authenticated', pricing: planPricing, storage: storageMode });
        broadcastAdminMetrics();
      } else {
        wsAdminFails.set(ws.remoteIp, attempts + 1);
        send(ws, { type: 'admin-error', message: 'Unauthorized passphrase.' });
        ws.close(4003, 'unauthorized');
      }
    }
  });

  ws.on('close', () => {
    if (ws.accountKey && clients.get(ws.accountKey) === ws) clients.delete(ws.accountKey);
    if (ws === adminWs) adminWs = null;
    queueAdminMetrics();
  });
});

async function shutdown() {
  console.log('Shutting down cleanly...');
  try { await flush(); } catch (e) { console.error(e.message); }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

initStore().then(() => {
  rebuildHandles();
  server.listen(PORT, '0.0.0.0', () => console.log(`Ghost Talk live on port ${PORT}`));
}).catch(err => { console.error('Failed to start:', err); process.exit(1); });