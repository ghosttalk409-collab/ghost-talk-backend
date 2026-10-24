const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Map(); // Identity Key -> WebSocket connection
const clientTiers = new Map(); // Identity Key -> 'FREE' | 'PREMIUM'
const clientExpirations = new Map(); // Identity Key -> Expiry Timestamp in ms
let adminWs = null;

// Pricing State & Payment Config
let planPricing = {
  monthly: 9.99,
  yearly: 89.99
};

// NOWPayments API Credentials
const NOWPAYMENTS_API_KEY = 'PWK9N5F-HBCME2K-JM7HY1F-CCG8KGQ';
const NOWPAYMENTS_IPN_KEY = 'etFGh8rCCnOtcK20TfsXbPPrbYXXkEk9';

// Helper function to grant Premium with an auto-expiry timer
function grantPremiumWithExpiry(userKey, durationDays = 30) {
  const expiryTimestamp = Date.now() + (durationDays * 24 * 60 * 60 * 1000);
  clientTiers.set(userKey, 'PREMIUM');
  clientExpirations.set(userKey, expiryTimestamp);

  if (clients.has(userKey)) {
    clients.get(userKey).send(JSON.stringify({ 
      type: 'tier-updated', 
      tier: 'PREMIUM',
      expiresAt: expiryTimestamp
    }));
  }
  broadcastAdminMetrics();
}

// Background Worker: Runs every 60 seconds to check and revert expired accounts
setInterval(() => {
  const now = Date.now();
  clientExpirations.forEach((expiresAt, userKey) => {
    if (now >= expiresAt) {
      clientTiers.set(userKey, 'FREE');
      clientExpirations.delete(userKey);

      if (clients.has(userKey)) {
        clients.get(userKey).send(JSON.stringify({ 
          type: 'tier-updated', 
          tier: 'FREE',
          message: '⌛ Premium pass expired. Reverted to Free Tier.'
        }));
      }
      broadcastAdminMetrics();
      console.log(`⏰ [Auto-Expiry] ${userKey} reverted to FREE tier.`);
    }
  });
}, 60000);

wss.on('connection', (ws, req) => {
  let currentKey = null;
  console.log('🌐 New peer connection established from IP.');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // --- ADMIN CHANNEL AUTHENTICATION & COMMANDS ---
      if (data.type === 'admin-auth') {
        if (data.secret === 'GHOST-ADMIN-PASS-2026') {
          adminWs = ws;
          currentKey = 'ADMIN-ROOT';
          clients.set(currentKey, ws);
          ws.send(JSON.stringify({ 
            type: 'admin-authenticated', 
            pricing: planPricing 
          }));
          broadcastAdminMetrics();
        } else {
          ws.send(JSON.stringify({ type: 'admin-error', message: 'Unauthorized Passphrase.' }));
        }
        return;
      }

      if (data.type === 'admin-set-tier') {
        if (ws === adminWs) {
          clientTiers.set(data.targetKey, data.tier);
          clientExpirations.delete(data.targetKey);
          broadcastAdminMetrics();
          if (clients.has(data.targetKey)) {
            clients.get(data.targetKey).send(JSON.stringify({ type: 'tier-updated', tier: data.tier }));
          }
        }
        return;
      }

      if (data.type === 'admin-update-pricing') {
        if (ws === adminWs && data.pricing) {
          planPricing = { ...data.pricing };
          broadcastAdminMetrics();
        }
        return;
      }

      if (data.type === 'admin-kick') {
        if (ws === adminWs && clients.has(data.targetKey)) {
          const target = clients.get(data.targetKey);
          target.send(JSON.stringify({ type: 'end-session' }));
          target.close();
          clients.delete(data.targetKey);
          clientTiers.delete(data.targetKey);
          clientExpirations.delete(data.targetKey);
          broadcastAdminMetrics();
        }
        return;
      }

      if (data.type === 'admin-wipe-ram') {
        if (ws === adminWs) {
          clients.forEach((clientWs, key) => {
            if (key !== 'ADMIN-ROOT') {
              clientWs.send(JSON.stringify({ type: 'end-session' }));
              clientWs.close();
            }
          });
          clients.clear();
          clientTiers.clear();
          clientExpirations.clear();
          clients.set('ADMIN-ROOT', adminWs);
          broadcastAdminMetrics();
        }
        return;
      }

      // --- GHOST TALK CORE ROUTING (FIXED FOR RENDER MESH) ---
      if (data.type === 'register') {
        currentKey = data.key;
        clients.set(currentKey, ws);
        if (!clientTiers.has(currentKey)) {
          clientTiers.set(currentKey, 'FREE');
        }
        ws.send(JSON.stringify({ type: 'registered' }));
        console.log(`✅ Peer Registered: ${currentKey}`);
        broadcastAdminMetrics();
      } else if (data.targetKey) {
        if (clients.has(data.targetKey)) {
          const targetWs = clients.get(data.targetKey);
          
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            if (currentKey === 'ADMIN-ROOT') {
              data.senderKey = 'ADMIN DASHBOARD';
            } else {
              data.senderKey = currentKey;
            }
            targetWs.send(JSON.stringify(data));
          } else {
            ws.send(JSON.stringify({ 
              type: 'error', 
              message: `Target ${data.targetKey} socket is closed.` 
            }));
          }
        } else {
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: `Target ${data.targetKey} is offline or unreachable.` 
          }));
        }
      }
    } catch (err) {
      console.error('Signaling error:', err);
    }
  });

  ws.on('close', () => {
    if (currentKey) {
      clients.delete(currentKey);
      clientTiers.delete(currentKey);
      clientExpirations.delete(currentKey);
      if (currentKey === 'ADMIN-ROOT') adminWs = null;
      console.log(`❌ Peer Disconnected: ${currentKey}`);
      broadcastAdminMetrics();
    }
  });
});

      // --- ADMIN CHANNEL AUTHENTICATION & COMMANDS ---
      if (data.type === 'admin-auth') {
        if (data.secret === 'GHOST-ADMIN-PASS-2026') {
          adminWs = ws;
          currentKey = 'ADMIN-ROOT';
          clients.set(currentKey, ws);
          ws.send(JSON.stringify({ 
            type: 'admin-authenticated', 
            pricing: planPricing 
          }));
          broadcastAdminMetrics();
        } else {
          ws.send(JSON.stringify({ type: 'admin-error', message: 'Unauthorized Passphrase.' }));
        }
        return;
      }

      if (data.type === 'admin-set-tier') {
        if (ws === adminWs) {
          clientTiers.set(data.targetKey, data.tier);
          clientExpirations.delete(data.targetKey);
          broadcastAdminMetrics();
          if (clients.has(data.targetKey)) {
            clients.get(data.targetKey).send(JSON.stringify({ type: 'tier-updated', tier: data.tier }));
          }
        }
        return;
      }

      if (data.type === 'admin-update-pricing') {
        if (ws === adminWs && data.pricing) {
          planPricing = { ...data.pricing };
          broadcastAdminMetrics();
        }
        return;
      }

      if (data.type === 'admin-kick') {
        if (ws === adminWs && clients.has(data.targetKey)) {
          const target = clients.get(data.targetKey);
          target.send(JSON.stringify({ type: 'end-session' }));
          target.close();
          clients.delete(data.targetKey);
          clientTiers.delete(data.targetKey);
          clientExpirations.delete(data.targetKey);
          broadcastAdminMetrics();
        }
        return;
      }

      if (data.type === 'admin-wipe-ram') {
        if (ws === adminWs) {
          clients.forEach((clientWs, key) => {
            if (key !== 'ADMIN-ROOT') {
              clientWs.send(JSON.stringify({ type: 'end-session' }));
              clientWs.close();
            }
          });
          clients.clear();
          clientTiers.clear();
          clientExpirations.clear();
          clients.set('ADMIN-ROOT', adminWs);
          broadcastAdminMetrics();
        }
        return;
      }

      // --- EXISTING GHOST TALK CORE ROUTING ---
      if (data.type === 'register') {
        currentKey = data.key;
        clients.set(currentKey, ws);
        if (!clientTiers.has(currentKey)) {
          clientTiers.set(currentKey, 'FREE');
        }
        ws.send(JSON.stringify({ type: 'registered' }));
        broadcastAdminMetrics();
      } else if (data.targetKey) {
        if (clients.has(data.targetKey)) {
          const targetWs = clients.get(data.targetKey);
          
          if (currentKey === 'ADMIN-ROOT') {
            data.senderKey = 'ADMIN DASHBOARD';
          } else {
            data.senderKey = currentKey;
          }
          
          targetWs.send(JSON.stringify(data));
        } else {
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: `Target ${data.targetKey} is offline or unreachable.` 
          }));
        }
      }
    } catch (err) {
      console.error('Signaling error:', err);
    }
  });

  ws.on('close', () => {
    if (currentKey) {
      clients.delete(currentKey);
      clientTiers.delete(currentKey);
      clientExpirations.delete(currentKey);
      if (currentKey === 'ADMIN-ROOT') adminWs = null;
      broadcastAdminMetrics();
    }
  });
});

function broadcastAdminMetrics() {
  if (!adminWs || adminWs.readyState !== 1) return;

  const totalConnections = Math.max(0, clients.size - (adminWs ? 1 : 0));
  let premiumCount = 0;
  const activePeers = [];

  clients.forEach((ws, key) => {
    if (key !== 'ADMIN-ROOT') {
      const tier = clientTiers.get(key) || 'FREE';
      if (tier === 'PREMIUM') premiumCount++;
      activePeers.push({ key, tier });
    }
  });

  const payload = {
    type: 'admin-telemetry',
    metrics: {
      totalConnections,
      premiumCount,
      freeCount: totalConnections - premiumCount,
      activePeers,
      pricing: planPricing,
      ramUsage: (process.memoryUsage().rss / 1024 / 1024).toFixed(2) + ' MB'
    }
  };

  adminWs.send(JSON.stringify(payload));
}

// --- AUTOMATED NOWPAYMENTS API ROUTES ---
app.use(express.json());

app.get('/api/payment-info', (req, res) => {
  res.json({
    pricing: planPricing
  });
});

app.post('/api/create-payment', async (req, res) => {
  try {
    const { userKey, planType } = req.body;
    if (!userKey) {
      return res.status(400).json({ success: false, message: 'User key is required.' });
    }

    const priceAmount = planType === 'yearly' ? planPricing.yearly : planPricing.monthly;

    const response = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: {
        'x-api-key': NOWPAYMENTS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        price_amount: priceAmount,
        price_currency: 'usd',
        order_id: userKey,
        order_description: `Ghost Talk Premium Pass (${planType || 'monthly'})`,
        ipn_callback_url: 'https://ghost-talk-backend.onrender.com/api/nowpayments-webhook',
        success_url: 'https://ghosttalk.app/success',
        cancel_url: 'https://ghosttalk.app/cancel'
      })
    });

    const data = await response.json();

    if (data.invoice_url) {
      return res.json({ success: true, invoiceUrl: data.invoice_url });
    } else {
      return res.status(400).json({ success: false, message: 'Failed to generate payment invoice from gateway.' });
    }
  } catch (err) {
    console.error('Invoice Creation Error:', err);
    return res.status(500).json({ success: false, message: 'Server error generating payment checkout.' });
  }
});

// Fixed raw buffer parser for precise HMAC signature matching
app.post('/api/nowpayments-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const nowpaymentsSig = req.headers['x-nowpayments-sig'];
    if (!nowpaymentsSig) {
      return res.status(400).send('Missing signature header.');
    }

    const hmac = crypto.createHmac('sha512', NOWPAYMENTS_IPN_KEY);
    hmac.update(req.body);
    const calculatedSig = hmac.digest('hex');

    if (calculatedSig !== nowpaymentsSig) {
      console.error('❌ Webhook Signature Verification Failed!');
      return res.status(400).send('Invalid signature.');
    }

    const bodyObj = JSON.parse(req.body.toString());
    const { payment_status, order_id } = bodyObj;

    if (payment_status === 'finished' || payment_status === 'confirmed') {
      const userKey = order_id;
      grantPremiumWithExpiry(userKey, 30);
      console.log(`✅ [NOWPayments] Payment verified via IPN for ${userKey}. Premium unlocked!`);
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook processing error:', err);
    return res.status(500).send('Internal Server Error');
  }
});

// --- SECURE TOKEN-PROTECTED HIDDEN ADMIN ROUTE ---
app.get('/admin-panel', (req, res) => {
  if (req.query.key === 'GHOST-USB-KEY-999') {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ghost Talk - Secure Admin Panel</title>
  <style>
    :root { --bg-dark: #0a0d12; --card-bg: #121824; --border-color: #1e293b; --accent-green: #00ff88; --accent-blue: #00bcd4; --accent-red: #ff4757; --text-main: #e2e8f0; --text-muted: #64748b; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', monospace, sans-serif; }
    body { background: var(--bg-dark); color: var(--text-main); padding: 16px; font-size: 13px; }
    .header-bar { display: flex; justify-content: space-between; align-items: center; padding-bottom: 12px; border-bottom: 1px solid var(--border-color); margin-bottom: 16px; }
    .status-badge { padding: 4px 10px; border-radius: 4px; font-weight: bold; font-size: 11px; background: rgba(0, 255, 136, 0.1); color: var(--accent-green); border: 1px solid var(--accent-green); }
    .grid-layout { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; }
    .card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .card-title { font-size: 12px; font-weight: bold; color: var(--text-muted); text-transform: uppercase; margin-bottom: 12px; display: flex; justify-content: space-between; }
    #metricsCanvas { width: 100%; height: 180px; background: #080a0f; border-radius: 6px; border: 1px solid var(--border-color); }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th, td { padding: 8px; border-bottom: 1px solid var(--border-color); font-size: 12px; }
    th { color: var(--text-muted); font-size: 10px; text-transform: uppercase; }
    .btn { background: var(--card-bg); border: 1px solid var(--border-color); color: var(--text-main); padding: 4px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: bold; }
    .btn:hover { border-color: var(--accent-green); color: var(--accent-green); }
    .btn-danger { border-color: var(--accent-red); color: var(--accent-red); }
    .btn-danger:hover { background: var(--accent-red); color: #000; }
  </style>
</head>
<body>
  <div class="header-bar">
    <div>
      <h2 style="color: var(--accent-green);">🛡️ GHOST TALK - SECURE ADMIN MESH</h2>
      <span style="font-size: 10px; color: var(--text-muted);">USB Air-Gapped Command Interface</span>
    </div>
    <div id="connectionStatus" class="status-badge">CONNECTING TO MESH...</div>
  </div>
  <div class="grid-layout">
    <div>
      <div class="card">
        <div class="card-title"><span>📈 Real-Time Mesh Telemetry</span><span id="ramUsageText">RAM: 0 MB</span></div>
        <canvas id="metricsCanvas"></canvas>
      </div>
      <div class="card">
        <div class="card-title"><span>👥 Connected Mesh Peers</span></div>
        <table>
          <thead><tr><th>Identity Key</th><th>Tier</th><th>Actions</th></tr></thead>
          <tbody id="peerTableBody"><tr><td colspan="3" style="text-align: center; color: var(--text-muted);">No active peers.</td></tr></tbody>
        </table>
      </div>
    </div>
    <div>
      <div class="card">
        <div class="card-title"><span>💰 Pricing Override Controls</span></div>
        <label style="font-size: 10px; color: var(--text-muted);">Monthly Plan ($)</label>
        <input type="number" id="monthlyPriceInput" step="0.01" style="width:100%; background:#080a0f; border:1px solid var(--border-color); color:#fff; padding:6px; margin:4px 0 12px 0; border-radius:4px;">
        <label style="font-size: 10px; color: var(--text-muted);">Yearly Plan ($)</label>
        <input type="number" id="yearlyPriceInput" step="0.01" style="width:100%; background:#080a0f; border:1px solid var(--border-color); color:#fff; padding:6px; margin:4px 0 12px 0; border-radius:4px;">
        <button class="btn" style="width: 100%; background: var(--accent-green); color: #000;" onclick="updatePricing()">Update Mesh Pricing</button>
      </div>
      <div class="card">
        <div class="card-title"><span>⚠️ Emergency Controls</span></div>
        <button class="btn btn-danger" style="width: 100%; padding: 8px;" onclick="wipeServerRAM()">🔥 Emergency Wipe Server RAM</button>
      </div>
    </div>
  </div>
  <script>
    let ws = null;
    let historyData = [];
    const canvas = document.getElementById('metricsCanvas');
    const ctx = canvas.getContext('2d');
    function initAdminSocket() {
      const proto = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
      ws = new WebSocket(proto + window.location.host);
      ws.onopen = () => {
        document.getElementById('connectionStatus').innerText = 'AUTHORIZED | ONLINE';
        ws.send(JSON.stringify({ type: 'admin-auth', secret: 'GHOST-ADMIN-PASS-2026' }));
      };
      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'admin-authenticated' && msg.pricing) {
          document.getElementById('monthlyPriceInput').value = msg.pricing.monthly;
          document.getElementById('yearlyPriceInput').value = msg.pricing.yearly;
        }
        if (msg.type === 'admin-telemetry') updateDashboardUI(msg.metrics);
      };
      ws.onclose = () => {
        document.getElementById('connectionStatus').innerText = 'OFFLINE | RECONNECTING...';
        setTimeout(initAdminSocket, 2000);
      };
    }
    function updateDashboardUI(m) {
      document.getElementById('ramUsageText').innerText = 'RAM: ' + m.ramUsage;
      const tbody = document.getElementById('peerTableBody');
      tbody.innerHTML = '';
      if (m.activePeers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">No active peers.</td></tr>';
      } else {
        m.activePeers.forEach(peer => {
          const tr = document.createElement('tr');
          const isPrem = peer.tier === 'PREMIUM';
          tr.innerHTML = '<td style="font-weight: bold; color: var(--accent-green);">' + peer.key + '</td><td><span class="status-badge" style="color: ' + (isPrem ? 'var(--accent-green)' : 'var(--text-muted)') + ';">' + peer.tier + '</span></td><td><button class="btn" onclick="toggleTier(\\'' + peer.key + '\\', \\'' + (isPrem ? 'FREE' : 'PREMIUM') + '\\')">' + (isPrem ? 'Downgrade' : 'Promote') + '</button><button class="btn btn-danger" onclick="kickPeer(\\'' + peer.key + '\\')">Kick</button></td>';
          tbody.appendChild(tr);
        });
      }
      historyData.push(m.totalConnections);
      if (historyData.length > 30) historyData.shift();
      drawChart();
    }
    function drawChart() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const step = canvas.width / 30;
      historyData.forEach((val, i) => {
        const y = canvas.height - (val * 15) - 20;
        if (i === 0) ctx.moveTo(0, y);
        else ctx.lineTo(i * step, y);
      });
      ctx.stroke();
    }
    function toggleTier(targetKey, tier) { ws.send(JSON.stringify({ type: 'admin-set-tier', targetKey, tier })); }
    function kickPeer(targetKey) { if (confirm('Kick target ' + targetKey + '?')) ws.send(JSON.stringify({ type: 'admin-kick', targetKey })); }
    function updatePricing() {
      const monthly = parseFloat(document.getElementById('monthlyPriceInput').value);
      const yearly = parseFloat(document.getElementById('yearlyPriceInput').value);
      ws.send(JSON.stringify({ type: 'admin-update-pricing', pricing: { monthly, yearly } }));
      alert('Pricing updated across mesh!');
    }
    function wipeServerRAM() { if (confirm('⚠️ Emergency Wipe Server RAM?')) ws.send(JSON.stringify({ type: 'admin-wipe-ram' })); }
    initAdminSocket();
  </script>
</body>
</html>`);
  } else {
    res.status(404).send('Not Found');
  }
});

const PORT = process.env.PORT || 8158;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log('--------------------------------------------------');
  console.log('🛡️ Ghost Talk Mesh is live and secured!');
  console.log(`> App running on port: ${PORT}`);
  console.log('--------------------------------------------------');
});