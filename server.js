'use strict';
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

if (!ADMIN_SECRET || !MASTER_KEY) console.warn('WARNING: ADMIN_SECRET / MASTER_KEY not set.');
if (!NOWPAYMENTS_API_KEY || !NOWPAYMENTS_IPN_KEY) console.warn('WARNING: NOWPayments keys not set.');

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
    console.log('Storage: local file');
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
  if (rawBody) { try { candidates.push(rawBody.trim()); } catch {} }
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
      if (!verifyNowSignature(req.rawBody, req.body, sig)) return res.status(400).send('Invalid sig');

      const body = req.body;
      const paymentId = String(body.payment_id || '');
      const order = db.orders[String(body.order_id || '')];
      if (!order || !paymentId) return res.status(200).send('Ignored');
      if (db.payments[paymentId]) return res.status(200).send('Already processed');
      if (body.payment_status !== 'finished') return res.status(200).send('Pending');

      db.payments[paymentId] = Date.now();
      order.paid = true;
      grantPremium(order.key, PLAN_DAYS[order.plan] || 30, true);
      await flush();
      res.status(200).send('OK');
    } catch (err) {
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

app.get('/api/ice-servers', limit(60, 60000), (req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URLS) {
    iceServers.push({
      urls: process.env.TURN_URLS.split(',').map(s => s.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || ''
    });
  }
  res.json({ iceServers, iceTransportPolicy: 'all' });
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
    if (data.invoice_url) return res.json({ success: true, invoiceUrl: data.invoice_url });
    delete db.orders[orderId];
    await flush();
    res.status(502).json({ success: false, error: 'Gateway error' });
  } catch (err) {
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
  res.json({ success: true, url: `${PUBLIC_URL}/affiliate-registry?token=${token}`, referralUrl: `${SITE_URL}/?ref=${code}` });
});

// ---------------------------------------------------------------- websocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 10 * 1024 * 1024 });

const RELAY_TYPES = new Set(['offer', 'answer', 'ice-candidate', 'e2e-key', 'e2e-msg', 'decline', 'end-session', 'text-notify']);
const SMALL_PAYLOAD = 24000;
const MAX_PAYLOAD = 7500000;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, max) => typeof v === 'string' && v.length <= max;

function relay(ws, data) {
  const type = data.type;
  if (!RELAY_TYPES.has(type) || typeof data.targetKey !== 'string') return;
  const senderKey = ws.isAdmin ? null : ws.accountKey;
  const senderTier = ws.isAdmin ? 'PREMIUM' : tierOf(db.accounts[senderKey]);
  const targetKey = resolveAddress(data.targetKey);
  const targetWs = targetKey && clients.get(targetKey);
  if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
    send(ws, { type: 'peer-offline', targetKey: data.targetKey, forType: type });
    return;
  }
  const out = { type, senderKey: ws.isAdmin ? 'ADMIN DASHBOARD' : displayName(senderKey) };
  switch (type) {
    case 'offer':
      if (!isObj(data.offer) || !isStr(data.offer.sdp, 100000)) return;
      if (data.hasVideo && senderTier !== 'PREMIUM') { send(ws, { type: 'error', message: 'Video requires Premium.' }); return; }
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
      if (!isStr(data.pub, 200) || !/^[a-f0-9]{16}$/.test(String(data.hid || ''))) return;
      out.pub = data.pub; out.hid = data.hid; out.reply = !!data.reply;
      break;
    case 'e2e-msg':
      if (!isStr(data.payload, MAX_PAYLOAD) || !data.payload) return;
      if (data.payload.length > SMALL_PAYLOAD && senderTier !== 'PREMIUM') {
        send(ws, { type: 'error', message: 'File transfer requires Premium.' });
        return;
      }
      out.payload = data.payload;
      break;
    default: break;
  }
  send(targetWs, out);
}

function handleMessage(ws, data) {
  const type = data.type;
  if (type === 'ping') return send(ws, { type: 'pong' });

  if (type === 'admin-auth') {
    if (ADMIN_SECRET && safeEqual(String(data.secret || ''), ADMIN_SECRET)) {
      adminWs = ws; ws.isAdmin = true;
      send(ws, { type: 'admin-authenticated', pricing: planPricing, storage: storageMode });
      broadcastAdminMetrics();
    } else {
      send(ws, { type: 'admin-error', message: 'Unauthorized.' });
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
      if (Number.isFinite(m) && m >= 1 && Number.isFinite(y) && y >= 1) {
        planPricing = { monthly: Math.round(m * 100) / 100, yearly: Math.round(y * 100) / 100 };
        db.settings.pricing = planPricing;
        scheduleSave();
        send(ws, { type: 'admin-pricing-updated', pricing: planPricing });
        queueAdminMetrics();
      }
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
      const ref = typeof data.ref === 'string' ? data.ref.trim().toUpperCase() : '';
      if (/^[A-Z0-9]{6,12}$/.test(ref) && Object.values(db.campaigns).some(c => c.code === ref && Date.now() <= c.expiresAt)) acc.ref = ref;
    } else if (!acc.secretHash) {
      acc.secretHash = hash;
    } else if (!safeEqual(acc.secretHash, hash)) {
      return send(ws, { type: 'register-error', reason: 'identity-taken', message: 'Identity belongs to someone else.' });
    }
    if (tierOf(acc) === 'FREE' && acc.tier === 'PREMIUM') setFree(key);
    scheduleSave();

    const old = clients.get(key);
    if (old && old !== ws) { send(old, { type: 'replaced' }); old.accountKey = null; old.close(4000, 'replaced'); }
    ws.accountKey = key;
    clients.set(key, ws);
    send(ws, { type: 'registered', key, ...accountStatus(key) });
    queueAdminMetrics();
    return;
  }

  if (!ws.accountKey && !ws.isAdmin) return;
  if (type === 'get-status') { if (ws.accountKey) notifyTier(ws.accountKey); return; }
  if (type === 'set-custom-key') {
    const key = ws.accountKey;
    if (!key) return;
    const acc = db.accounts[key];
    const fail = message => send(ws, { type: 'custom-key-error', message });
    if (tierOf(acc) !== 'PREMIUM') return fail('Premium required.');
    let desired = String(data.customKey || '').trim().toUpperCase();
    if (!desired.startsWith('GHOST-')) desired = 'GHOST-' + desired;
    if (!KEY_REGEX.test(desired)) return fail('Invalid format.');
    if (desired !== key && (db.accounts[desired] || (handles.has(desired) && handles.get(desired) !== key))) {
      return fail('Handle already claimed.');
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

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.accountKey = null;
  ws.isAdmin = false;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let data; try { data = JSON.parse(raw.toString()); } catch { return; }
    if (!isObj(data) || typeof data.type !== 'string') return;
    try { handleMessage(ws, data); } catch (err) { console.error(err); }
  });

  ws.on('close', () => {
    if (ws.accountKey && clients.get(ws.accountKey) === ws) clients.delete(ws.accountKey);
    if (ws === adminWs) adminWs = null;
    queueAdminMetrics();
  });
  ws.on('error', () => {});
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 25000).unref();

async function shutdown() {
  try { await flush(); } catch (e) {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

initStore().then(() => {
  rebuildHandles();
  const sp = db.settings && db.settings.pricing;
  if (sp && sp.monthly >= 1 && sp.yearly >= 1) planPricing = { monthly: Number(sp.monthly), yearly: Number(sp.yearly) };
  server.listen(PORT, '0.0.0.0', () => console.log(`Ghost Talk live on port ${PORT}`));
}).catch(err => { console.error('Failed to start:', err); process.exit(1); });