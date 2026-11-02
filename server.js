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
const clients = new Map();         // Key (Upper) -> WebSocket instance
const wsToKey = new Map();         // WebSocket instance -> Key (Upper) [Universal Lookup]
const clientTiers = new Map();     // Key (Upper) -> 'FREE' | 'PREMIUM'
const clientExpirations = new Map(); // Key (Upper) -> Timestamp
const customHandles = new Map();   // Handle (Upper) -> Key (Upper)
let adminWs = null;

const TIERS_FILE = path.join(__dirname, 'tiers.json');
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
      for (const [handle, ownerKey] of customHandles.entries()) {
        if (ownerKey === userKey) { customHandles.delete(handle); break; }
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
            if (ownerKey === targetUpper) { customHandles.delete(handle); break; }
          }
        }
        savePersistedData();
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
          if (ownerKey === currentKey) customHandles.delete(handle);
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
        const targetAddress = customHandles.get(targetKeyUpper) || targetKeyUpper;
        
        if (clients.has(targetAddress)) {
          const targetWs = clients.get(targetAddress);
          if (targetWs && targetWs.readyState === 1) {
            let senderHandle = senderKey;
            for (const [handle, ownerKey] of customHandles.entries()) {
              if (ownerKey === senderKey) { senderHandle = handle; break; }
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
      wsToKey.delete(ws);
      if (closedKey === 'ADMIN-ROOT') adminWs = null;
      broadcastAdminMetrics();
    }
  });
});

function broadcastAdminMetrics() {
  if (!adminWs || adminWs.readyState !== 1) return;
  const totalConnections = Math.max(0, clients.size - 1);
  let premiumCount = 0;
  const activePeers = [];

  clients.forEach((ws, key) => {
    if (key !== 'ADMIN-ROOT') {
      const tier = clientTiers.get(key) || 'FREE';
      if (tier === 'PREMIUM') premiumCount++;
      activePeers.push({ key, tier });
    }
  });

  adminWs.send(JSON.stringify({
    type: 'admin-telemetry',
    metrics: { totalConnections, premiumCount, freeCount: totalConnections - premiumCount, activePeers, pricing: planPricing }
  }));
}

app.use(express.json());
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