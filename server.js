const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

// 1. CLIENT GATEWAY (Landing page with Web App & APK download options)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Direct Web App launch route
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. ADMIN COMMAND DASHBOARD LINK (Accessed via secret query key)
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
          <p style="color:#9ca3af; margin-top:16px; font-size:15px;">The local APK binary is queued. Launch the <a href="/app" style="color:#d4af37; text-decoration:underline;">Secure Web Client</a> instantly.</p>
        </body>
        </html>
      `);
    }
  });
});

app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 10 * 1024 * 1024 });

const clients = new Map();
const clientTiers = new Map();
const clientExpirations = new Map();
const customHandles = new Map();
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
    ws.send(JSON.stringify({ type: 'tier-updated', tier: 'PREMIUM', expiresAt: expiryTimestamp }));
  }
  broadcastAdminMetrics();
}

wss.on('connection', (ws) => {
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
        }
        savePersistedData();
        broadcastAdminMetrics();
        const target = clients.get(targetUpper);
        if (target && target.readyState === 1) {
          target.send(JSON.stringify({ type: 'tier-updated', tier: data.tier, expiresAt: clientExpirations.get(targetUpper) || null }));
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
        broadcastAdminMetrics();
        return;
      }

      if (data.type === 'register') {
        currentKey = data.key.toUpperCase();
        clients.set(currentKey, ws);
        
        if (!clientTiers.has(currentKey)) {
          clientTiers.set(currentKey, data.claimedTier || 'FREE');
        }

        const currentTier = clientTiers.get(currentKey);
        const expiry = clientExpirations.get(currentKey) || null;

        ws.send(JSON.stringify({ type: 'registered', tier: currentTier, expiresAt: expiry }));
        broadcastAdminMetrics();
      } else if (data.targetKey) {
        const targetKeyUpper = data.targetKey.toUpperCase();
        const targetAddress = customHandles.get(targetKeyUpper) || targetKeyUpper;
        
        if (clients.has(targetAddress)) {
          const targetWs = clients.get(targetAddress);
          if (targetWs && targetWs.readyState === 1) {
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
  const activePeers = [];
  const dormantPeers = [];

  clients.forEach((ws, key) => {
    if (key !== 'ADMIN-ROOT') {
      const tier = clientTiers.get(key) || 'FREE';
      const expiresAt = clientExpirations.get(key) || null;
      activePeers.push({ key, tier, status: 'ONLINE', expiresAt });
    }
  });

  clientTiers.forEach((tier, key) => {
    if (!clients.has(key)) {
      const expiresAt = clientExpirations.get(key) || null;
      dormantPeers.push({ key, tier, status: 'DORMANT', expiresAt });
    }
  });

  adminWs.send(JSON.stringify({
    type: 'admin-telemetry',
    metrics: { 
      totalConnections: clients.size - 1, 
      activePeers, 
      dormantPeers, 
      pricing: planPricing 
    }
  }));
}

app.use(express.json());
app.get('/api/payment-info', (req, res) => res.json({ pricing: planPricing }));
const PORT = process.env.PORT || 8158;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🛡️ Sovereign Mesh live on port ${PORT}`);
});