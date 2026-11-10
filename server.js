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
const db = { accounts: {}, orders: {}, payments: {}, campaigns: {} };
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
const clients = new Map();   // accountKey -> ws
const handles = new Map();   // custom handle -> accountKey
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
function grantPremium(key, days) {
  let acc = db.accounts[key];
  if (!acc) acc = db.accounts[key] = { secretHash: null, tier: 'FREE', expiresAt: null, handle: null, registeredAt: Date.now() };
  const now = Date.now();
  const base = tierOf(acc) === 'PREMIUM' && acc.expiresAt ? acc.expiresAt : now; // stack renewals
  acc.tier = 'PREMIUM';
  acc.expiresAt = base + days * DAY;
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

app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/admin-panel', limit(30, 60000), (req, res) => {
  if (!adminKeyOk(req)) return res.status(404).send('Not Found');
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
// NOWPayments signs HMAC-SHA512 over the JSON body with keys sorted alphabetically.
app.post('/api/nowpayments-webhook', express.json({ limit: '100kb' }), (req, res) => {
  try {
    if (!NOWPAYMENTS_IPN_KEY) return res.status(503).send('Disabled');
    const sig = String(req.headers['x-nowpayments-sig'] || '');
    if (!sig || !req.body || typeof req.body !== 'object') return res.status(400).send('Bad request');
    const expected = crypto.createHmac('sha512', NOWPAYMENTS_IPN_KEY).update(JSON.stringify(sortKeys(req.body))).digest('hex');
    const a = Buffer.from(sig, 'hex'), b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(400).send('Invalid sig');

    const body = req.body;
    const paymentId = String(body.payment_id || '');
    const order = db.orders[String(body.order_id || '')];
    if (!order || !paymentId) return res.status(200).send('Ignored');          // unknown order
    if (db.payments[paymentId]) return res.status(200).send('Already processed'); // idempotent
    if (body.payment_status !== 'finished') return res.status(200).send('Pending'); // only final status

    const paid = Number(body.price_amount);
    if (String(body.price_currency || '').toLowerCase() !== 'usd' || !(paid >= order.price - 0.01)) {
      console.warn('Webhook amount mismatch for order', body.order_id);
      return res.status(200).send('Amount mismatch');
    }
    db.payments[paymentId] = Date.now();
    order.paid = true;
    grantPremium(order.key, PLAN_DAYS[order.plan] || 30);
    console.log(`Premium granted: ${order.key} (${order.plan})`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Error');
  }
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
  res.json({ iceServers });
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
        success_url: `${SITE_URL}/app`, cancel_url: `${SITE_URL}/app`
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

app.get('/master-registry', limit(30, 60000), (req, res) => {
  if (!adminKeyOk(req)) return res.status(404).send('Not Found');
  const users = Object.entries(db.accounts)
    .map(([key, a]) => ({ key, registeredAt: a.registeredAt || 0, tier: tierOf(a) }))
    .sort((x, y) => y.registeredAt - x.registeredAt);
  const premiumCount = users.filter(u => u.tier === 'PREMIUM').length;
  let rows = users.slice(0, 1000).map(u => `<tr>
    <td style="font-weight:bold;color:#c5a059;">${escapeHtml(u.key)}</td>
    <td>${escapeHtml(new Date(u.registeredAt).toLocaleString())}</td>
    <td><span style="color:${u.tier === 'PREMIUM' ? '#c5a059' : '#8892b0'};">${u.tier}</span></td></tr>`).join('');
  if (!rows) rows = '<tr><td colspan="3" style="text-align:center;color:#8892b0;">No registered users yet.</td></tr>';
  const keyJs = JSON.stringify(String(req.query.key)).replace(/</g, '\\u003c');

  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ghost Talk - Master Registry</title><style>${PAGE_CSS}</style></head><body>
<h2 style="color:#c5a059;margin-bottom:6px;">MASTER REGISTRY LEDGER</h2>
<p style="color:#8892b0;margin-bottom:20px;">Signup and conversion registry (read-only).</p>
<div class="card">
  <h3 style="font-size:12px;color:#8892b0;text-transform:uppercase;margin-bottom:12px;">Generate temporary influencer link</h3>
  <input type="text" id="influencerName" maxlength="40" placeholder="Influencer name (e.g. ALEX)">
  <input type="number" id="durationDays" value="10" style="width:80px;" min="1" max="90"> <span style="color:#8892b0;margin-right:12px;">Days</span>
  <button onclick="generateLink()">Create scoped link</button>
  <div id="generatedLinkResult" style="margin-top:12px;word-break:break-all;font-family:monospace;color:#00ff88;"></div>
</div>
<div class="card">
  <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
    <span>Total signups: <strong>${users.length}</strong></span><span>Premium: <strong>${premiumCount}</strong></span>
  </div>
  <table><thead><tr><th>User key</th><th>Registered</th><th>Tier</th></tr></thead><tbody>${rows}</tbody></table>
</div>
<script>
const MASTER_KEY = ${keyJs};
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
    box.append('Generated link:', document.createElement('br'));
    const a = document.createElement('a'); a.href = data.url; a.target = '_blank'; a.rel = 'noopener';
    a.style.color = '#c5a059'; a.textContent = data.url; box.appendChild(a);
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
  const durationDays = Math.min(90, Math.max(1, parseInt(days, 10) || 10));
  const now = Date.now();
  db.campaigns[token] = { influencer: influencer.trim().slice(0, 40), createdAt: now, expiresAt: now + durationDays * DAY };
  scheduleSave();
  res.json({ success: true, url: `${PUBLIC_URL}/affiliate-registry?token=${token}` });
});

app.get('/affiliate-registry', limit(60, 60000), (req, res) => {
  const msg = (code, text) => res.status(code).send(`<h2 style="color:#d95764;text-align:center;margin-top:100px;font-family:sans-serif;">${text}</h2>`);
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const campaign = token && db.campaigns[token];
  if (!campaign) return msg(404, 'Invalid or expired campaign link.');
  if (Date.now() > Number(campaign.expiresAt)) return msg(403, 'This campaign has expired.');

  const cohort = Object.values(db.accounts).filter(a => a.registeredAt >= campaign.createdAt && a.registeredAt <= campaign.expiresAt);
  const premium = cohort.filter(a => tierOf(a) === 'PREMIUM').length;
  // Aggregate counts only: partners never see individual user keys.
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Partner Dashboard</title><style>${PAGE_CSS}</style></head><body>
<h2 style="color:#c5a059;margin-bottom:4px;">Partner Dashboard: ${escapeHtml(campaign.influencer)}</h2>
<p style="color:#8892b0;margin-bottom:20px;">Active campaign window. Expires: ${escapeHtml(new Date(campaign.expiresAt).toLocaleString())}</p>
<div class="card"><div style="display:flex;justify-content:space-between;">
<span>Cohort signups: <strong>${cohort.length}</strong></span><span>Premium conversions: <strong>${premium}</strong></span>
</div></div></body></html>`);
});

// ---------------------------------------------------------------- websocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 10 * 1024 * 1024 });

const RELAY_TYPES = new Set(['offer', 'answer', 'ice-candidate', 'chat', 'file-transfer', 'decline', 'end-session', 'text-notify']);
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
    case 'chat':
      if (!isStr(data.text, 4000) || !data.text.trim()) return;
      out.text = data.text;
      break;
    case 'file-transfer':
      if (senderTier !== 'PREMIUM') { send(ws, { type: 'error', message: 'File transfer requires Premium.' }); return; }
      if (!isStr(data.fileName, 200) || !isStr(data.fileType, 100) || !isStr(data.fileData, 7500000) || !data.fileData.startsWith('data:')) return;
      out.fileName = data.fileName; out.fileType = data.fileType; out.fileData = data.fileData;
      break;
    default: break; // decline, end-session, text-notify carry no payload
  }
  send(targetWs, out);
}

function handleMessage(ws, data) {
  const type = data.type;

  if (type === 'ping') return send(ws, { type: 'pong' });

  if (type === 'admin-auth') {
    if (ADMIN_SECRET && safeEqual(String(data.secret || ''), ADMIN_SECRET)) {
      adminWs = ws; ws.isAdmin = true;
      send(ws, { type: 'admin-authenticated', pricing: planPricing });
      broadcastAdminMetrics();
    } else {
      send(ws, { type: 'admin-error', message: 'Unauthorized passphrase.' });
      ws.adminFails = (ws.adminFails || 0) + 1;
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
    } else if (type === 'admin-update-pricing' && isObj(data.pricing)) {
      const m = Number(data.pricing.monthly), y = Number(data.pricing.yearly);
      if (Number.isFinite(m) && m > 0 && Number.isFinite(y) && y > 0) { planPricing = { monthly: m, yearly: y }; queueAdminMetrics(); }
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
    send(ws, { type: 'registered', key, ...accountStatus(key) });
    queueAdminMetrics();
    return;
  }

  if (!ws.accountKey && !ws.isAdmin) return; // everything below needs an authenticated socket

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

wss.on('connection', ws => {
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

initStore().then(() => {
  rebuildHandles();
  server.listen(PORT, '0.0.0.0', () => console.log(`Ghost Talk live on port ${PORT}`));
}).catch(err => { console.error('Failed to start:', err); process.exit(1); });
