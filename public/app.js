import { E2E, sha256Hex } from './e2e.js';
import { SecurityGuard } from './security.js';

console.log("[DEBUG] app.js loaded successfully.");

document.addEventListener('DOMContentLoaded', () => {
  console.log("[DEBUG] DOM fully loaded.");
  
  const $ = id => document.getElementById(id);
  const myIdentityInput = $('my-identity');
  const statusBar = $('status-bar');
  const tierBadge = $('tier-badge');
  const premiumCustomKeyBox = $('premium-custom-key-box');
  const customKeyInput = $('custom-key-input');
  const btnSaveCustomKey = $('btn-save-custom-key');

  const contactNameInput = $('contact-name');
  const contactKeyInput = $('contact-key');
  const btnAddContact = $('btn-add-contact');
  const contactsListContainer = $('contacts-list-container');

  const btnChat = $('btn-chat');
  const btnCallAudio = $('btn-call-audio');
  const btnCallVideo = $('btn-call-video');
  const btnEndSession = $('btn-end-session');

  const videoContainer = $('video-container');
  const localVideo = $('local-video');
  const remoteVideo = $('remote-video');
  const remoteAudio = $('remote-audio');

  const callControls = $('call-controls');
  const btnToggleMic = $('btn-toggle-mic');
  const btnToggleCam = $('btn-toggle-cam');

  const chatBox = $('chat-box');
  const chatInput = $('chat-input');
  const btnSend = $('btn-send');
  const btnAttach = $('btn-attach');
  const fileInput = $('file-input');
  const btnWipe = $('btn-wipe');

  const callModal = $('call-modal');
  const callerIdText = $('caller-id-text');
  const btnAccept = $('btn-accept');
  const btnDecline = $('btn-decline');

  const btnShowQr = $('btn-show-qr');
  const btnScanQr = $('btn-scan-qr');
  const qrModal = $('qr-modal');
  const qrModalTitle = $('qr-modal-title');
  const qrDisplayContainer = $('qr-display-container');
  const qrScannerContainer = $('qr-scanner-container');
  const btnCloseQr = $('btn-close-qr');
  const qrcodeDiv = $('qrcode');
  const qrVideo = $('qr-video');
  const qrCanvas = $('qr-canvas');
  const btnUploadQrImg = $('btn-upload-qr-img');
  const qrFileInput = $('qr-file-input');

  const paymentModal = $('payment-modal');
  const btnStartCheckout = $('btn-start-checkout');
  const btnStartCheckoutYearly = $('btn-start-checkout-yearly');
  const btnClosePaymentModal = $('btn-close-payment-modal');
  const modalDisplayPrice = $('modal-display-price');
  const modalDisplayPriceYearly = $('modal-display-price-yearly');

  // ------------------------------------------------------------ state
  const KEY_RE = /^GHOST-[A-Z0-9]{3,16}$/;
  let socket = null;
  let accountKey = '';      
  let mySecret = '';        
  let myHandle = '';        
  let activeCallTarget = '';
  let isPremiumUser = false;
  let peerConnection = null;
  let localStream = null;
  let micMuted = false;
  let camOff = false;
  let qrCameraStream = null;
  let qrScanAnimation = null;
  let ramContacts = [];
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  let suppressReconnect = false;
  let pendingIceCandidates = [];
  let pendingSocketQueue = [];

  let callState = 'IDLE';   
  let callPeer = '';        
  let callPeerAlias = '';   
  let incomingOffer = null;
  let ringTimeout = null;
  let rtcConfigCache = null;
  let rtcConfigAt = 0;

  const security = new SecurityGuard();

  const shortName = n => String(n || 'Peer').substring(0, 10);
  const e2e = new E2E(obj => safeSend(obj), ({ id, fingerprint, changed }) => {
    if (changed) logChat(`System: ⚠️ ${shortName(id)} started a NEW secure session. New security code: ${fingerprint}.`);
    else logChat(`System: 🔒 End-to-end encrypted with ${shortName(id)}. Security code: ${fingerprint}.`);
  });
  const sdpHashes = new Map();       
  const objectUrls = [];             
  const lastResync = new Map();
  let iceSendReady = false;
  let localIceBuffer = [];

  async function sendSecure(addr, header, bytes) {
    const payload = await e2e.encrypt(addr, header, bytes);
    safeSend({ type: 'e2e-msg', targetKey: addr, payload });
  }

  function flushLocalIce() {
    iceSendReady = true;
    const list = localIceBuffer; localIceBuffer = [];
    list.forEach(c => { if (callPeer) safeSend({ type: 'ice-candidate', targetKey: callPeer, candidate: c }); });
  }

  const DEFAULT_ICE = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]
  };

  const proto = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
  const apiBase = window.location.origin;
  const socketUrl = `${proto}${window.location.host}/`;

  // ------------------------------------------------------------ identity
  function randomId(len, alphabet) {
    const a = new Uint32Array(len);
    crypto.getRandomValues(a);
    return Array.from(a, n => alphabet[n % alphabet.length]).join('');
  }
  function newIdentity() {
    accountKey = 'GHOST-' + randomId(8, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
    mySecret = randomId(48, 'abcdef0123456789');
    myHandle = '';
    localStorage.setItem('ghost_identity', accountKey);
    localStorage.setItem('ghost_secret', mySecret);
    localStorage.removeItem('ghost_handle');
  }
  const displayIdentity = () => myHandle || accountKey;
  function refreshIdentityUI() { if (myIdentityInput) myIdentityInput.value = displayIdentity(); }

  accountKey = (localStorage.getItem('ghost_identity') || '').toUpperCase();
  mySecret = localStorage.getItem('ghost_secret') || '';
  if (!KEY_RE.test(accountKey)) {
    newIdentity();
  } else if (mySecret.length < 32) {
    mySecret = randomId(48, 'abcdef0123456789');
    localStorage.setItem('ghost_secret', mySecret);
  }
  myHandle = localStorage.getItem('ghost_handle') || '';
  refreshIdentityUI();

  {
    const refParam = new URLSearchParams(window.location.search).get('ref');
    if (refParam && /^[A-Za-z0-9]{6,12}$/.test(refParam) && !localStorage.getItem('ghost_ref')) {
      localStorage.setItem('ghost_ref', refParam.toUpperCase());
    }
  }

  function applyUIPremiumState(premium, expiresAt = null) {
    isPremiumUser = premium;
    if (premium) {
      localStorage.setItem('ghost_tier', 'PREMIUM');
      if (expiresAt) localStorage.setItem('ghost_tier_expiry', expiresAt);
      if (tierBadge) { tierBadge.innerText = 'PREMIUM TIER'; tierBadge.style.background = '#1a2220'; tierBadge.style.color = '#c5a059'; tierBadge.style.borderColor = '#c5a059'; }
      if (premiumCustomKeyBox) premiumCustomKeyBox.style.display = 'block';
    } else {
      localStorage.removeItem('ghost_tier');
      localStorage.removeItem('ghost_tier_expiry');
      if (tierBadge) { tierBadge.innerText = 'FREE TIER'; tierBadge.style.background = 'transparent'; tierBadge.style.color = '#8892b0'; tierBadge.style.borderColor = '#232d2a'; }
      if (premiumCustomKeyBox) premiumCustomKeyBox.style.display = 'none';
    }
  }
  {
    const exp = parseInt(localStorage.getItem('ghost_tier_expiry') || '0', 10);
    const hint = localStorage.getItem('ghost_tier'] === 'PREMIUM' && (!exp || Date.now() < exp);
    applyUIPremiumState(hint, exp || null);
  }

  function applyHandle(handle) {
    myHandle = handle || '';
    if (myHandle) localStorage.setItem('ghost_handle', myHandle); else localStorage.removeItem('ghost_handle');
    refreshIdentityUI();
  }

  function logChat(msg) {
    if (!chatBox) return;
    const div = document.createElement('div');
    div.textContent = msg;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function ensureContact(key, defaultName = 'Peer') {
    if (!key) return;
    const upperKey = String(key).toUpperCase();
    if (!ramContacts.some(c => c.key === upperKey)) {
      ramContacts.push({ name: defaultName, key: upperKey });
      renderContacts();
    }
  }
  const isValidContact = key => ramContacts.some(c => c.key === key);

  // ------------------------------------------------------------ websocket
  function safeSend(dataObj) {
    const jsonStr = JSON.stringify(dataObj);
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(jsonStr);
    else if (pendingSocketQueue.length < 100) pendingSocketQueue.push(jsonStr);
  }
  function flushSocketQueue() {
    while (pendingSocketQueue.length > 0 && socket && socket.readyState === WebSocket.OPEN) socket.send(pendingSocketQueue.shift());
  }
  function scheduleReconnect() {
    if (suppressReconnect || reconnectTimer) return;
    const timeout = Math.min(10000, 1000 * Math.pow(1.5, reconnectAttempts));
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; initWebSocket(); }, timeout);
  }

  function initWebSocket() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    logChat(`[DEBUG] Dialing WebSocket: ${socketUrl}`);
    let ws;
    try {
      ws = new WebSocket(socketUrl);
    } catch (err) {
      logChat(`[DEBUG] Instant Constructor Error: ${err.message}`);
      return;
    }
    socket = ws;

    ws.onopen = () => {
      logChat('[DEBUG] Handshake OK! Registering...');
      statusBar.innerText = 'STATUS: ONLINE | END-TO-END ENCRYPTED';
      statusBar.classList.remove('offline');
      reconnectAttempts = 0;
      ws.send(JSON.stringify({ type: 'register', key: accountKey, secret: mySecret, ref: localStorage.getItem('ghost_ref') || undefined }));
      flushSocketQueue();
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}'); }, 20000);
    };

    ws.onmessage = event => {
      try { handleSignalingMessage(JSON.parse(event.data)); }
      catch (e) { logChat(`[DEBUG] Bad message: ${e.message}`); }
    };

    ws.onclose = event => {
      if (socket !== ws) return;
      clearInterval(pingTimer);
      logChat(`[DEBUG] Closed -> Code: ${event.code} | Reason: "${event.reason || 'none'}"`);
      statusBar.innerText = suppressReconnect ? 'STATUS: OPEN IN ANOTHER TAB/DEVICE' : 'STATUS: OFFLINE | RECONNECTING...';
      statusBar.classList.add('offline');
      scheduleReconnect();
    };

    ws.onerror = () => {
      logChat('[DEBUG] WebSocket error event triggered.');
      try { ws.close(); } catch {}
    };
  }

  if (myIdentityInput) {
    myIdentityInput.addEventListener('click', () => {
      myIdentityInput.select();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(displayIdentity()).then(() => logChat('System: Your ID was copied.')).catch(() => {});
      }
    });
  }

  statusBar.addEventListener('click', () => {
    if (suppressReconnect) { suppressReconnect = false; reconnectAttempts = 0; if (socket) { try { socket.close(); } catch {} } initWebSocket(); }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || suppressReconnect) return;
    if (!socket || socket.readyState === WebSocket.CLOSED) { reconnectAttempts = 0; initWebSocket(); }
    else safeSend({ type: 'get-status' });
  });

  const peerMatches = sk => !!sk && (sk === callPeer || sk === callPeerAlias);

  async function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'pong': break;
      case 'registered':
        logChat('System: Registered on secure mesh.');
        applyUIPremiumState(msg.tier === 'PREMIUM', msg.expiresAt);
        applyHandle(msg.handle);
        break;
      case 'register-error':
        if (msg.reason === 'identity-taken') {
          alert('Identity claimed elsewhere. New identity created.');
          newIdentity(); refreshIdentityUI(); applyUIPremiumState(false);
          try { socket.close(); } catch {}
        } else {
          logChat(`System: ${msg.message || 'Registration failed.'}`);
        }
        break;
      case 'replaced':
        suppressReconnect = true;
        logChat('System: Opened on another tab/device.');
        break;
      case 'tier-updated':
        applyUIPremiumState(msg.tier === 'PREMIUM', msg.expiresAt);
        applyHandle(msg.handle);
        break;
      case 'error':
        logChat(`System: ${msg.message}`);
        break;
      case 'peer-offline':
        logChat('System: Contact offline.');
        break;
      case 'text-notify':
        ensureContact(msg.senderKey, 'Peer');
        activeCallTarget = msg.senderKey;
        renderContacts();
        break;
      case 'e2e-key':
        e2e.handleKey(msg.senderKey, msg);
        break;
      case 'e2e-msg':
        try {
          let dec = await e2e.decrypt(msg.senderKey, msg.payload);
          logChat(`${shortName(msg.senderKey)}: ${dec.header.text || '[Data]'}`);
        } catch {
          logChat('System: Failed to verify message payload.');
        }
        break;
    }
  }

  function renderContacts() {
    contactsListContainer.innerHTML = '';
    if (ramContacts.length === 0) {
      contactsListContainer.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:8px;text-align:center;">No active contacts.</div>';
      return;
    }
    ramContacts.forEach((c) => {
      const isSelected = activeCallTarget === c.key;
      const card = document.createElement('div');
      card.className = `contact-card ${isSelected ? 'selected' : ''}`;
      card.innerHTML = `<div style="font-weight:600;">${c.name}</div><div style="font-size:10px;color:#8892b0;">${c.key}</div>`;
      card.onclick = () => { activeCallTarget = c.key; renderContacts(); };
      contactsListContainer.appendChild(card);
    });
  }

  btnAddContact.onclick = () => {
    const name = contactNameInput.value.trim().slice(0, 16);
    let key = contactKeyInput.value.trim().toUpperCase();
    if (!name || !key) { alert('Enter name and key.'); return; }
    if (!key.startsWith('GHOST-')) key = 'GHOST-' + key;
    if (!KEY_RE.test(key)) { alert('Invalid key format.'); return; }
    ramContacts.push({ name, key });
    contactNameInput.value = '';
    contactKeyInput.value = '';
    renderContacts();
  };

  btnSend.onclick = async () => {
    const text = chatInput.value.trim().slice(0, 4000);
    const target = activeCallTarget;
    if (!text || !target || !isValidContact(target)) return;
    chatInput.value = '';
    try {
      if (!(await e2e.ensure(target))) { logChat('System: Contact offline.'); return; }
      await sendSecure(target, { t: 'chat', text });
      logChat(`Me: ${text}`);
    } catch {
      logChat('System: Send failed.');
    }
  };

  renderContacts();
  initWebSocket();
});