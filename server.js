const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

// --- SOVEREIGN SERVER ROUTING ---
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/landing.html'); // Elite Old Money Landing Page
});

app.get('/app', (req, res) => {
  res.sendFile(__dirname + '/public/index.html'); // WebRTC Chat App interface
});

// Secure One-Touch Download Route
app.get('/download-apk', (req, res) => {
  const apkFilePath = __dirname + '/public/GhostTalk.apk';
  res.download(apkFilePath, 'GhostTalk.apk', (err) => {
    if (err) {
      res.status(404).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head><meta charset="UTF-8"><title>Direct Download Notice</title></head>
        <body style="background:#0b0f0e; color:#f3f4f6; font-family:sans-serif; text-align:center; padding-top:120px;">
          <h2 style="color:#d4af37; font-family:serif; font-size:28px;">Sovereign Package Preparing</h2>
          <p style="color:#9ca3af; margin-top:16px; font-size:15px;">The local APK binary is currently queued for packaging. In the meantime, you can launch the <a href="/app" style="color:#d4af37; text-decoration:underline;">Secure Web Client</a> instantly.</p>
        </body>
        </html>
      `);
    }
  });
});
// ----------------------------

app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Map();
let clientTiers = new Map();
let clientExpirations = new Map();
let adminWs = null;

// Persistent Tiers Storage File Setup
const TIERS_FILE = path.join(__dirname, 'tiers.json');

function loadPersistedTiers() {
  try {
    if (fs.existsSync(TIERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TIERS_FILE, 'utf8'));
      const now = Date.now();
      if (data.tiers) {
        for (const [key, info] of Object.entries(data.tiers)) {
          if (info.expiresAt && info.expiresAt > now) {
            clientTiers.set(key, info.tier);
            clientExpirations.set(key, info.expiresAt);
          } else if (!info.expiresAt && info.tier === 'PREMIUM') {
            clientTiers.set(key, 'PREMIUM'); // Permanent admin grant if no expiry
          }
        }
      }
      console.log(`🛡️ Loaded ${clientTiers.size} active tiers from persistent storage.`);
    }
  } catch (e) {
    console.error('Error loading persistent tiers:', e);
  }
}

function savePersistedTiers() {
  try {
    const data = { tiers: {} };
    clientTiers.forEach((tier, key) => {
      if (tier === 'PREMIUM') {
        data.tiers[key] = {
          tier: 'PREMIUM',
          expiresAt: clientExpirations.get(key) || null
        };
      }
    });
    fs.writeFileSync(TIERS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error saving persistent tiers:', e);
  }
}

loadPersistedTiers();

let planPricing = {
  monthly: 9.99,
  yearly: 89.99
};

const NOWPAYMENTS_API_KEY = 'PWK9N5F-HBCME2K-JM7HY1F-CCG8KGQ';
const NOWPAYMENTS_IPN_KEY = 'etFGh8rCCnOtcK20TfsXbPPrbYXXkEk9';

function grantPremiumWithExpiry(userKey, durationDays = 30) {
  const expiryTimestamp = Date.now() + (durationDays * 24 * 60 * 60 * 1000);
  clientTiers.set(userKey, 'PREMIUM');
  clientExpirations.set(userKey, expiryTimestamp);
  savePersistedTiers();

  if (clients.has(userKey)) {
    clients.get(userKey).send(JSON.stringify({ 
      type: 'tier-updated', 
      tier: 'PREMIUM',
      expiresAt: expiryTimestamp
    }));
  }
  broadcastAdminMetrics();
}

// Check expirations every 60 seconds
setInterval(() => {
  const now = Date.now();
  let updated = false;
  clientExpirations.forEach((expiresAt, userKey) => {
    if (now >= expiresAt) {
      clientTiers.set(userKey, 'FREE');
      clientExpirations.delete(userKey);
      updated = true;

      if (clients.has(userKey)) {
        clients.get(userKey).send(JSON.stringify({ 
          type: 'tier-updated', 
          tier: 'FREE',
          message: '⌛ Premium pass expired. Reverted to Free Tier.'
        }));
      }
    }
  });
  if (updated) {
    savePersistedTiers();
    broadcastAdminMetrics();
  }
}, 60000);

wss.on('connection', (ws, req) => {
  let currentKey = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'admin-auth') {
        if (data.secret === 'GHOST-ADMIN-PASS-2026') {
          adminWs = ws;
          currentKey = 'ADMIN-ROOT';
          clients.set(currentKey, ws);
          ws.send(JSON.stringify({ type: 'admin-authenticated', pricing: planPricing }));
          broadcastAdminMetrics();
        } else {
          ws.send(JSON.stringify({ type: 'admin-error', message: 'Unauthorized Passphrase.' }));
        }
        return;
      }

      if (data.type === 'admin-set-tier' && ws === adminWs) {
        clientTiers.set(data.targetKey, data.tier);
        if (data.tier === 'PREMIUM') {
          // Default manual admin grants to 30 days expiry if not specified
          clientExpirations.set(data.targetKey, Date.now() + (30 * 24 * 60 * 60 * 1000));
        } else {
          clientExpirations.delete(data.targetKey);
        }
        savePersistedTiers();
        broadcastAdminMetrics();
        if (clients.has(data.targetKey)) {
          clients.get(data.targetKey).send(JSON.stringify({ 
            type: 'tier-updated', 
            tier: data.tier,
            expiresAt: clientExpirations.get(data.targetKey) || null
          }));
        }
        return;
      }

      if (data.type === 'admin-update-pricing' && ws === adminWs && data.pricing) {
        planPricing = { ...data.pricing };
        broadcastAdminMetrics();
        return;
      }

      if (data.type === 'admin-kick' && ws === adminWs && clients.has(data.targetKey)) {
        const target = clients.get(data.targetKey);
        target.send(JSON.stringify({ type: 'end-session' }));
        target.close();
        clients.delete(data.targetKey);
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
        broadcastAdminMetrics();
        return;
      }

      if (data.type === 'register') {
        currentKey = data.key.toUpperCase();
        clients.set(currentKey, ws);
        
        const currentTier = clientTiers.get(currentKey) || 'FREE';
        const expiry = clientExpirations.get(currentKey) || null;

        ws.send(JSON.stringify({ 
          type: 'registered',
          tier: currentTier,
          expiresAt: expiry
        }));
        broadcastAdminMetrics();
      } else if (data.targetKey) {
        const targetKeyUpper = data.targetKey.toUpperCase();
        if (clients.has(targetKeyUpper)) {
          const targetWs = clients.get(targetKeyUpper);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            data.senderKey = currentKey === 'ADMIN-ROOT' ? 'ADMIN DASHBOARD' : currentKey;
            targetWs.send(JSON.stringify(data));
          }
        }
      }
    } catch (err) {}
  });

  ws.on('close', () => {
    if (currentKey) {
      clients.delete(currentKey);
      if (currentKey === 'ADMIN-ROOT') adminWs = null;
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
    metrics: {
      totalConnections,
      premiumCount,
      freeCount: totalConnections - premiumCount,
      activePeers,
      pricing: planPricing,
      ramUsage: (process.memoryUsage().rss / 1024 / 1024).toFixed(2) + ' MB'
    }
  }));
}

app.use(express.json());

app.get('/api/payment-info', (req, res) => {
  res.json({ pricing: planPricing });
});

app.post('/api/create-payment', async (req, res) => {
  try {
    const { userKey, planType } = req.body;
    if (!userKey) return res.status(400).json({ success: false, message: 'User key required.' });
    const priceAmount = planType === 'yearly' ? planPricing.yearly : planPricing.monthly;
    
    const response = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price_amount: priceAmount,
        price_currency: 'usd',
        order_id: userKey,
        order_description: `Ghost Talk Premium Pass`,
        ipn_callback_url: 'https://ghost-talk-backend.onrender.com/api/nowpayments-webhook',
        success_url: 'https://ghosttalk.app/success',
        cancel_url: 'https://ghosttalk.app/cancel'
      })
    });
    const data = await response.json();
    if (data.invoice_url) res.json({ success: true, invoiceUrl: data.invoice_url });
    else res.status(400).json({ success: false, message: 'Gateway error.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/nowpayments-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const nowpaymentsSig = req.headers['x-nowpayments-sig'];
    if (!nowpaymentsSig) return res.status(400).send('Missing signature.');
    const hmac = crypto.createHmac('sha512', NOWPAYMENTS_IPN_KEY);
    hmac.update(req.body);
    if (hmac.digest('hex') !== nowpaymentsSig) return res.status(400).send('Invalid signature.');

    const bodyObj = JSON.parse(req.body.toString());
    if (bodyObj.payment_status === 'finished' || bodyObj.payment_status === 'confirmed') {
      grantPremiumWithExpiry(bodyObj.order_id, 30);
    }
    res.status(200).send('OK');
  } catch (err) {
    res.status(500).send('Error');
  }
});

app.get('/admin-panel', (req, res) => {
  if (req.query.key === 'GHOST-USB-KEY-999') {
    res.sendFile(__dirname + '/public/admin.html');
  } else {
    res.status(404).send('Not Found');
  }
});

const PORT = process.env.PORT || 8158;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🛡️ Ghost Talk Mesh live on port ${PORT}`);
});