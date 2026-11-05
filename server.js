const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

// --- HTTP ROUTES ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin-panel', (req, res) => {
  if (req.query.key === 'GHOST-USB-KEY-999') {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  } else {
    res.status(404).send('Not Found');
  }
});

app.get('/download-apk', (req, res) => {
  const apkFilePath = path.join(__dirname, 'public', 'GhostTalk.apk');
  res.download(apkFilePath, 'GhostTalk.apk', (err) => {
    if (err) {
      res.status(404).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head><meta charset="UTF-8"><title>Direct Download Notice</title></head>
        <body style="background:#0b0f0e; color:#f3f4f6; font-family:sans-serif; text-align:center; padding-top:120px;">
          <h2 style="color:#d4af37; font-family:serif; font-size:28px;">Sovereign Package Preparing</h2>
          <p style="color:#9ca3af; margin-top:16px; font-size:15px;">The local APK binary is currently queued for packaging. In the meantime, launch the <a href="/app" style="color:#d4af37; text-decoration:underline;">Secure Web Client</a>.</p>
        </body>
        </html>
      `);
    }
  });
});

app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ 
  server, 
  maxPayload: 10 * 1024 * 1024 
});

// --- SCALABLE IN-MEMORY MAPPINGS & REGISTRIES ---
const clients = new Map();         // Key/Handle (Upper) -> WebSocket instance
const wsToKey = new Map();         // WebSocket instance -> Key (Upper)
const clientTiers = new Map();     // Key (Upper) -> 'FREE' | 'PREMIUM'
const clientExpirations = new Map(); // Key (Upper) -> Timestamp
const customHandles = new Map();   // Handle (Upper) -> Owner Base Key (Upper)
let adminWs = null;

const TIERS_FILE = path.join(__dirname, 'tiers.json');
const REGISTRY_FILE = path.join(__dirname, 'registry.json');
const CAMPAIGNS_FILE = path.join(__dirname, 'campaigns.json');
const HANDLE_REGEX = /^GHOST-[A-Z0-9]{3,16}$/;

function loadPersistedData() {
  try {
    if (fs.existsSync(TIERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TIERS_FILE, 'utf8'));
      const now = Date.now();
      if (data.tiers) {
        for (const [key, info] of Object.entries(data.tiers)) {
          const upperKey = key.toUpperCase();
          if (!info.expiresAt || info.expiresAt > now) {
            clientTiers.set(upperKey, info.tier);
            if (info.expiresAt) clientExpirations.set(upperKey, info.expiresAt);
            if (info.customHandle) {
              customHandles.set(info.customHandle.toUpperCase(), upperKey);
            }
          }
        }
      }
    }
  } catch (e) {}
}

function savePersistedData() {
  try {
    const data = { tiers: {} };
    clientTiers.forEach((tier, key) => {
      if (tier === 'PREMIUM') {
        let userHandle = null;
        for (const [handle, ownerKey] of customHandles.entries()) {
          if (ownerKey === key) { userHandle = handle; break; }
        }
        data.tiers[key] = {
          tier: 'PREMIUM',
          expiresAt: clientExpirations.get(key) || null,
          customHandle: userHandle
        };
      }
    });
    fs.writeFileSync(TIERS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {}
}

function loadRegistryData() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    }
  } catch (e) {}
  return { users: [] };
}

function saveRegistryUser(userKey, tier) {
  try {
    const data = loadRegistryData();
    const upperKey = userKey.toUpperCase();
    const existing = data.users.find(u => u.userKey === upperKey);
    const now = Date.now();

    if (existing) {
      existing.tier = tier;
    } else {
      data.users.push({
        userKey: upperKey,
        registeredAt: now,
        tier: tier || 'FREE'
      });
    }
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2));
  } catch (e) {}
}

function loadCampaigns() {
  try {
    if (fs.existsSync(CAMPAIGNS_FILE)) {
      return JSON.parse(fs.readFileSync(CAMPAIGNS_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveCampaign(token, info) {
  try {
    const campaigns = loadCampaigns();
    campaigns[token] = info;
    fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify(campaigns, null, 2));
  } catch (e) {}
}

loadPersistedData();

let planPricing = { monthly: 9.99, yearly: 89.99 };
const NOWPAYMENTS_API_KEY = 'PWK9N5F-HBCME2K-JM7HY1F-CCG8KGQ';
const NOWPAYMENTS_IPN_KEY = 'etFGh8rCCnOtcK20TfsXbPPrbYXXkEk9';

function grantPremiumWithExpiry(userKey, durationDays = 30) {
  const upperKey = userKey.toUpperCase();
  const expiryTimestamp = Date.now() + (durationDays * 24 * 60 * 60 * 1000);
  clientTiers.set(upperKey, 'PREMIUM');
  clientExpirations.set(upperKey, expiryTimestamp);
  savePersistedData();
  saveRegistryUser(upperKey, 'PREMIUM');

  const ws = clients.get(upperKey);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ 
      type: 'tier-updated', 
      tier: 'PREMIUM',
      expiresAt: expiryTimestamp
    }));
  }
  broadcastAdminMetrics();
}

setInterval(() => {
  const now = Date.now();
  let updated = false;
  clientExpirations.forEach((expiresAt, userKey) => {
    if (now >= expiresAt) {
      clientTiers.set(userKey, 'FREE');
      clientExpirations.delete(userKey);
      saveRegistryUser(userKey, 'FREE');
      for (const [handle, ownerKey] of customHandles.entries()) {
        if (ownerKey === userKey) { 
          clients.delete(handle);
          customHandles.delete(handle); 
          break; 
        }
      }
      updated = true;
      const ws = clients.get(userKey);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'tier-updated', tier: 'FREE', message: '⌛ Pass expired.' }));
      }
    }
  });
  if (updated) { savePersistedData(); broadcastAdminMetrics(); }
}, 60000);

wss.on('connection', (ws) => {
  let messageCount = 0;
  
  const rateLimitInterval = setInterval(() => {
    messageCount = 0;
  }, 1000);

  const heartbeatInterval = setInterval(() => {
    if (ws.readyState === 1) {
      ws.ping();
    } else {
      clearInterval(heartbeatInterval);
    }
  }, 25000);

  ws.on('message', (message) => {
    messageCount++;
    if (messageCount > 40) {
      ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded. Slow down.' }));
      return;
    }

    try {
      const data = JSON.parse(message);

      if (data.type === 'admin-auth') {
        if (data.secret === 'GHOST-ADMIN-PASS-2026') {
          adminWs = ws;
          wsToKey.set(ws, 'ADMIN-ROOT');
          clients.set('ADMIN-ROOT', ws);
          ws.send(JSON.stringify({ type: 'admin-authenticated', pricing: planPricing }));
          broadcastAdminMetrics();
        } else {
          ws.send(JSON.stringify({ type: 'admin-error', message: 'Unauthorized Passphrase.' }));
        }
        return;
      }

      if (data.type === 'admin-set-tier' && ws === adminWs) {
        const targetUpper = data.targetKey.toUpperCase();
        clientTiers.set(targetUpper, data.tier);
        if (data.tier === 'PREMIUM') {
          clientExpirations.set(targetUpper, Date.now() + (30 * 24 * 60 * 60 * 1000));
        } else {
          clientExpirations.delete(targetUpper);
          for (const [handle, ownerKey] of customHandles.entries()) {
            if (ownerKey === targetUpper) { 
              clients.delete(handle);
              customHandles.delete(handle); 
              break; 
            }
          }
        }
        savePersistedData();
        saveRegistryUser(targetUpper, data.tier);
        broadcastAdminMetrics();
        const target = clients.get(targetUpper);
        if (target && target.readyState === 1) {
          target.send(JSON.stringify({ 
            type: 'tier-updated', 
            tier: data.tier,
            expiresAt: clientExpirations.get(targetUpper) || null
          }));
        }
        return;
      }

      if (data.type === 'admin-update-pricing' && ws === adminWs && data.pricing) {
        planPricing = { ...data.pricing };
        broadcastAdminMetrics();
        return;
      }

      if (data.type === 'admin-kick' && ws === adminWs) {
        const targetKeyUpper = data.targetKey.toUpperCase();
        const target = clients.get(targetKeyUpper);
        if (target) {
          target.send(JSON.stringify({ type: 'end-session' }));
          target.close();
        }
        clients.delete(targetKeyUpper);
        for (const [handle, ownerKey] of customHandles.entries()) {
          if (ownerKey === targetKeyUpper) clients.delete(handle);
        }
        broadcastAdminMetrics();
        return;
      }

      if (data.type === 'admin-wipe-ram' && ws === adminWs) {
        clients.forEach((clientWs, key) => {
          if (key !== 'ADMIN-ROOT') {
            clientWs.send(JSON.stringify({ type: 'end-session' }));
            clientWs.close();
          }
        });
        clients.clear();
        clients.set('ADMIN-ROOT', adminWs);
        wsToKey.set(ws, 'ADMIN-ROOT');
        broadcastAdminMetrics();
        return;
      }

      if (data.type === 'set-custom-key') {
        const currentKey = wsToKey.get(ws);
        const userTier = clientTiers.get(currentKey) || data.claimedTier || 'FREE';
        
        if (!currentKey || userTier !== 'PREMIUM') {
          ws.send(JSON.stringify({ type: 'custom-key-error', message: 'Premium tier required for custom handles.' }));
          return;
        }
        let desiredKey = data.customKey.trim().toUpperCase();
        if (!desiredKey.startsWith('GHOST-')) desiredKey = 'GHOST-' + desiredKey;

        if (!HANDLE_REGEX.test(desiredKey)) {
          ws.send(JSON.stringify({ type: 'custom-key-error', message: 'Format must be GHOST-[A-Z0-9] (3-16 chars).' }));
          return;
        }

        if ((customHandles.has(desiredKey) && customHandles.get(desiredKey) !== currentKey) || clients.has(desiredKey)) {
          ws.send(JSON.stringify({ type: 'custom-key-error', message: '⚠️ This custom handle is already claimed.' }));
          return;
        }

        for (const [handle, ownerKey] of customHandles.entries()) {
          if (ownerKey === currentKey) {
            clients.delete(handle);
            customHandles.delete(handle);
          }
        }

        customHandles.set(desiredKey, currentKey);
        savePersistedData();
        ws.send(JSON.stringify({ type: 'custom-key-success', customKey: desiredKey }));
        return;
      }

      if (data.type === 'register') {
        const regKey = data.key.toUpperCase();
        const oldKey = wsToKey.get(ws);
        if (oldKey && oldKey !== regKey) {
          clients.delete(oldKey);
        }

        wsToKey.set(ws, regKey);
        clients.set(regKey, ws);

        for (const [handle, ownerKey] of customHandles.entries()) {
          if (ownerKey === regKey || handle === regKey) {
            clients.set(handle, ws);
            clients.set(ownerKey, ws);
          }
        }
        
        const existingTier = clientTiers.get(regKey);
        const resolvedTier = existingTier === 'PREMIUM' || data.claimedTier === 'PREMIUM' ? 'PREMIUM' : 'FREE';
        
        clientTiers.set(regKey, resolvedTier);
        if (resolvedTier === 'PREMIUM') {
          if (data.claimedExpiry) {
            clientExpirations.set(regKey, parseInt(data.claimedExpiry));
          } else if (!clientExpirations.has(regKey)) {
            clientExpirations.set(regKey, Date.now() + (30 * 24 * 60 * 60 * 1000));
          }
          savePersistedData();
        }

        const currentTier = clientTiers.get(regKey) || 'FREE';
        const expiry = clientExpirations.get(regKey) || null;

        saveRegistryUser(regKey, currentTier);

        ws.send(JSON.stringify({ type: 'registered', tier: currentTier, expiresAt: expiry }));
        broadcastAdminMetrics();
      } else if (data.targetKey) {
        let senderKey = wsToKey.get(ws);
        if (!senderKey && data.key) {
          senderKey = data.key.toUpperCase();
          wsToKey.set(ws, senderKey);
          clients.set(senderKey, ws);
        }
        if (!senderKey) return;

        const targetKeyUpper = data.targetKey.toUpperCase();
        let targetAddress = targetKeyUpper;
        if (!clients.has(targetAddress) && customHandles.has(targetAddress)) {
          targetAddress = customHandles.get(targetAddress);
        }
        
        if (clients.has(targetAddress)) {
          const targetWs = clients.get(targetAddress);
          if (targetWs && targetWs.readyState === 1) {
            let senderHandle = senderKey;
            for (const [handle, ownerKey] of customHandles.entries()) {
              if (ownerKey === senderKey || handle === senderKey) { 
                senderHandle = handle; 
                break; 
              }
            }
            data.senderKey = senderKey === 'ADMIN-ROOT' ? 'ADMIN DASHBOARD' : senderHandle;
            targetWs.send(JSON.stringify(data));
          }
        }
      }
    } catch (err) {}
  });

  ws.on('close', () => {
    clearInterval(rateLimitInterval);
    clearInterval(heartbeatInterval);
    const closedKey = wsToKey.get(ws);
    if (closedKey) {
      clients.delete(closedKey);
      for (const [handle, ownerKey] of customHandles.entries()) {
        if (ownerKey === closedKey || handle === closedKey) clients.delete(handle);
      }
      wsToKey.delete(ws);
      if (closedKey === 'ADMIN-ROOT') adminWs = null;
      broadcastAdminMetrics();
    }
  });
});

function broadcastAdminMetrics() {
  if (!adminWs || adminWs.readyState !== 1) return;
  const activePeers = [];
  const uniqueKeys = new Set();

  clients.forEach((ws, key) => {
    if (key !== 'ADMIN-ROOT') {
      const baseOwnerKey = customHandles.get(key) || key;
      if (!uniqueKeys.has(baseOwnerKey)) {
        uniqueKeys.add(baseOwnerKey);
        const tier = clientTiers.get(baseOwnerKey) || 'FREE';
        let userHandle = baseOwnerKey;
        for (const [handle, ownerKey] of customHandles.entries()) {
          if (ownerKey === baseOwnerKey) { userHandle = handle; break; }
        }
        activePeers.push({ key: userHandle, tier });
      }
    }
  });

  adminWs.send(JSON.stringify({
    type: 'admin-telemetry',
    metrics: { totalConnections: uniqueKeys.size, activePeers, pricing: planPricing }
  }));
}

// --- MASTER REGISTRY ROUTE (Permanent, No Controls) ---
app.get('/master-registry', (req, res) => {
  if (req.query.key !== 'GHOST-USB-KEY-999') {
    return res.status(404).send('Not Found');
  }

  const registryData = loadRegistryData();
  const totalSignups = registryData.users.length;
  const premiumCount = registryData.users.filter(u => u.tier === 'PREMIUM').length;

  let rows = registryData.users.map(u => `
    <tr>
      <td style="font-weight:bold; color:#c5a059;">${u.userKey}</td>
      <td>${new Date(u.registeredAt).toLocaleString()}</td>
      <td><span style="color:${u.tier === 'PREMIUM' ? '#c5a059' : '#8892b0'};">${u.tier}</span></td>
    </tr>
  `).join('');

  if (!rows) rows = '<tr><td colspan="3" style="text-align:center; color:#8892b0;">No registered users yet.</td></tr>';

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"><title>Ghost Talk - Master Registry</title>
      <style>
        body { background: #0e1110; color: #e2e8f0; font-family: sans-serif; padding: 24px; font-size: 13px; }
        .card { background: #141817; border: 1px solid #232d2a; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; text-align: left; margin-top: 10px; }
        th, td { padding: 10px; border-bottom: 1px solid #232d2a; }
        th { color: #8892b0; font-size: 11px; text-transform: uppercase; }
        input, select { background: #0b0e0d; border: 1px solid #232d2a; color: #fff; padding: 8px; border-radius: 4px; margin-right: 8px; }
        button { background: #1a2220; color: #c5a059; border: 1px solid #c5a059; padding: 8px 14px; border-radius: 4px; cursor: pointer; font-weight: 600; }
        button:hover { background: #c5a059; color: #000; }
      </style>
    </head>
    <body>
      <h2 style="color: #c5a059; margin-bottom: 6px;">🛡️ MASTER REGISTRY LEDGER</h2>
      <p style="color: #8892b0; margin-bottom: 20px;">Permanent zero-knowledge user growth and conversion registry (Read-Only).</p>

      <div class="card">
        <h3 style="font-size: 12px; color: #8892b0; text-transform: uppercase; margin-bottom: 12px;">🔗 Generate Temporary Influencer Link</h3>
        <input type="text" id="influencerName" placeholder="Influencer Name (e.g. ALEX)">
        <input type="number" id="durationDays" value="10" style="width: 80px;" min="1" max="90"> <span style="color:#8892b0; margin-right:12px;">Days</span>
        <button onclick="generateLink()">Create Scoped Link</button>
        <div id="generatedLinkResult" style="margin-top: 12px; word-break: break-all; font-family: monospace; color: #00ff88;"></div>
      </div>

      <div class="card">
        <div style="display:flex; justify-content:space-between; margin-bottom:12px;">
          <span>📊 Total Signups: <strong>${totalSignups}</strong></span>
          <span>✨ Premium Conversions: <strong>${premiumCount}</strong></span>
        </div>
        <table>
          <thead><tr><th>User Key</th><th>Registration Timestamp</th><th>Tier</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <script>
        async function generateLink() {
          const name = document.getElementById('influencerName').value.trim();
          const days = document.getElementById('durationDays').value;
          if (!name) { alert('Enter influencer name.'); return; }
          const res = await fetch('/api/generate-affiliate-link', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ influencer: name, days: parseInt(days), masterKey: 'GHOST-USB-KEY-999' })
          });
          const data = await res.json();
          if (data.success) {
            document.getElementById('generatedLinkResult').innerHTML = 'Generated Link:<br><a href="' + data.url + '" target="_blank" style="color:#c5a059;">' + data.url + '</a>';
          } else { alert('Generation failed.'); }
        }
      </script>
    </body>
    </html>
  `);
});

// --- API TO GENERATE AFFILIATE TOKENS ---
app.use(express.json());
app.post('/api/generate-affiliate-link', (req, res) => {
  const { influencer, days, masterKey } = req.body;
  if (masterKey !== 'GHOST-USB-KEY-999' || !influencer) {
    return res.status(403).json({ success: false });
  }

  const token = crypto.randomBytes(16).toString('hex');
  const durationDays = days || 10;
  const expiresAt = Date.now() + (durationDays * 24 * 60 * 60 * 1000);
  const createdAt = Date.now();

  saveCampaign(token, { influencer, createdAt, expiresAt });

  const host = req.headers['host'] || 'ghosttalk.app';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = `${proto}://${host}/affiliate-registry?token=${token}`;

  res.json({ success: true, url });
});

// --- TEMPORARY AFFILIATE REGISTRY VIEW (Self-Expiring, Read-Only) ---
app.get('/affiliate-registry', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(404).send('Link Not Found');

  const campaigns = loadCampaigns();
  const campaign = campaigns[token];

  if (!campaign) {
    return res.status(404).send('<h2 style="color:#d95764; text-align:center; margin-top:100px; font-family:sans-serif;">❌ Invalid or Expired Campaign Link.</h2>');
  }

  if (Date.now() > campaign.expiresAt) {
    return res.status(403).send('<h2 style="color:#d95764; text-align:center; margin-top:100px; font-family:sans-serif;">⌛ This campaign contract has expired and is no longer accessible.</h2>');
  }

  const registryData = loadRegistryData();
  const cohortUsers = registryData.users.filter(u => u.registeredAt >= campaign.createdAt && u.registeredAt <= campaign.expiresAt);
  const totalSignups = cohortUsers.length;
  const premiumConversions = cohortUsers.filter(u => u.tier === 'PREMIUM').length;

  let rows = cohortUsers.map(u => `
    <tr>
      <td style="font-weight:bold; color:#c5a059;">${u.userKey}</td>
      <td>${new Date(u.registeredAt).toLocaleString()}</td>
      <td><span style="color:${u.tier === 'PREMIUM' ? '#c5a059' : '#8892b0'};">${u.tier}</span></td>
    </tr>
  `).join('');

  if (!rows) rows = '<tr><td colspan="3" style="text-align:center; color:#8892b0;">No signups recorded during this campaign window yet.</td></tr>';

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"><title>Affiliate Cohort Ledger - ${campaign.influencer}</title>
      <style>
        body { background: #0e1110; color: #e2e8f0; font-family: sans-serif; padding: 24px; font-size: 13px; }
        .card { background: #141817; border: 1px solid #232d2a; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; text-align: left; margin-top: 10px; }
        th, td { padding: 10px; border-bottom: 1px solid #232d2a; }
        th { color: #8892b0; font-size: 11px; text-transform: uppercase; }
      </style>
    </head>
    <body>
      <h2 style="color: #c5a059; margin-bottom: 4px;">📊 Partner Dashboard: ${campaign.influencer}</h2>
      <p style="color: #8892b0; margin-bottom: 20px;">Active campaign window. Link expires on: ${new Date(campaign.expiresAt).toLocaleString()}</p>

      <div class="card">
        <div style="display:flex; justify-content:space-between; margin-bottom:12px;">
          <span>👥 Cohort Signups: <strong>${totalSignups}</strong></span>
          <span>✨ Premium Conversions: <strong>${premiumConversions}</strong></span>
        </div>
        <table>
          <thead><tr><th>User Key</th><th>Join Timestamp</th><th>Tier Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </body>
    </html>
  `);
});

app.get('/api/payment-info', (req, res) => res.json({ pricing: planPricing }));
app.post('/api/create-payment', async (req, res) => {
  try {
    const { userKey, planType } = req.body;
    if (!userKey) return res.status(400).json({ success: false });
    const priceAmount = planType === 'yearly' ? planPricing.yearly : planPricing.monthly;
    const response = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: priceAmount, price_currency: 'usd', order_id: userKey,
        order_description: `Ghost Talk Pass`,
        ipn_callback_url: 'https://ghost-talk-backend.onrender.com/api/nowpayments-webhook',
        success_url: 'https://ghosttalk.app/success', cancel_url: 'https://ghosttalk.app/cancel'
      })
    });
    const data = await response.json();
    if (data.invoice_url) res.json({ success: true, invoiceUrl: data.invoice_url });
    else res.status(400).json({ success: false });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/nowpayments-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const nowpaymentsSig = req.headers['x-nowpayments-sig'];
    if (!nowpaymentsSig) return res.status(400).send('Missing sig.');
    const hmac = crypto.createHmac('sha512', NOWPAYMENTS_IPN_KEY);
    hmac.update(req.body);
    if (hmac.digest('hex') !== nowpaymentsSig) return res.status(400).send('Invalid sig.');
    const bodyObj = JSON.parse(req.body.toString());
    if (bodyObj.payment_status === 'finished' || bodyObj.payment_status === 'confirmed') {
      grantPremiumWithExpiry(bodyObj.order_id, 30);
    }
    res.status(200).send('OK');
  } catch (err) { res.status(500).send('Error'); }
});

const PORT = process.env.PORT || 8158;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🛡️ Sovereign Mesh live on port ${PORT}`);
});