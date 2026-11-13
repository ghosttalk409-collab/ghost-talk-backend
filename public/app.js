import { E2E, sha256Hex } from './e2e.js';
import { SecurityGuard } from './security.js';

document.addEventListener('DOMContentLoaded', () => {
  window.__ghostBooted = true;          // index.html shows a clear error if this never happens
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
  const btnStartCheckoutYearly = $('btn-start-checkout-yearly'); // optional element
  const btnClosePaymentModal = $('btn-close-payment-modal');
  const modalDisplayPrice = $('modal-display-price');
  const modalDisplayPriceYearly = $('modal-display-price-yearly'); // optional element
  const paymentTitle = $('payment-modal-title');   // optional elements (see index.html)
  const paymentDesc = $('payment-modal-desc');
  const yearlySave = $('yearly-save');
  const btnShare = $('btn-share');
  const upgradeCard = $('upgrade-card');
  const btnUpgrade = $('btn-upgrade');

  // ------------------------------------------------------------ state
  const KEY_RE = /^GHOST-[A-Z0-9]{3,16}$/;
  let socket = null;
  let accountKey = '';      // permanent identity (never changes)
  let mySecret = '';        // proves ownership of accountKey to the server
  let myHandle = '';        // optional premium custom handle
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

  let callState = 'IDLE';   // IDLE | RINGING | CALLING | CONNECTED
  let callPeer = '';        // who the current call is with (independent of the selected contact)
  let callPeerAlias = '';   // the name the peer's messages arrive under
  let incomingOffer = null;
  let ringTimeout = null;
  let rtcConfigCache = null;
  let rtcConfigAt = 0;

  const security = new SecurityGuard();

  // ---- End-to-end encryption: keys exist only in memory; the server only ever sees ciphertext.
  const shortName = n => String(n || 'Peer').substring(0, 10);
  const e2e = new E2E(obj => safeSend(obj), ({ id, fingerprint, changed }) => {
    if (changed) logChat(`System: ⚠️ ${nameFor(id)} started a NEW secure session. New security code: ${fingerprint}. Re-check it if you did not expect this.`);
    else logChat(`System: 🔒 End-to-end encrypted with ${nameFor(id)}. Security code: ${fingerprint}. Compare it with your contact (e.g. during a call) to be sure nobody is intercepting.`);
  });
  const sdpHashes = new Map();       // `${peer}|offer|answer` -> sha256 of the SDP, delivered over the encrypted channel
  const objectUrls = [];             // blob URLs for received files, revoked on wipe
  const lastResync = new Map();
  let iceSendReady = false;
  let localIceBuffer = [];

  async function sendSecure(addr, header, bytes) {
    const payload = await e2e.encrypt(addr, header, bytes);
    safeSend({ type: 'e2e-msg', targetKey: addr, payload });
  }
  function resync(from) {
    const now = Date.now();
    if (now - (lastResync.get(from) || 0) < 5000) return;
    lastResync.set(from, now);
    e2e.drop(from);
    e2e.ensure(from).catch(() => {});
  }
  async function verifySdp(from, kind, sdp) {
    const key = `${from}|${kind}`;
    for (let i = 0; i < 60 && !sdpHashes.has(key); i++) await new Promise(r => setTimeout(r, 100));
    const expected = sdpHashes.get(key);
    sdpHashes.delete(key);
    return !!expected && expected === await sha256Hex(sdp);
  }
  function flushLocalIce() {
    iceSendReady = true;
    const list = localIceBuffer; localIceBuffer = [];
    list.forEach(c => { if (callPeer) safeSend({ type: 'ice-candidate', targetKey: callPeer, candidate: c }); });
  }

  const DEFAULT_ICE = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }]
  };

  // This page is served by the backend itself (/app), so it talks to the host it was loaded from.
  // The Android app (Capacitor) loads from a local origin and uses the fixed backend address instead.
  const BACKEND_URL = 'https://ghost-talk-backend.onrender.com';
  const pageHost = window.location.hostname;
  const isLocalOrigin = pageHost === 'localhost' || pageHost === '127.0.0.1' || pageHost === '';
  const isDevServer = isLocalOrigin && window.location.port === '8158';
  const servedByBackend = isDevServer || (!isLocalOrigin && /^https?:$/.test(window.location.protocol));
  const apiBase = servedByBackend ? window.location.origin : BACKEND_URL;
  const socketUrl = apiBase.replace(/^http/, 'ws');   // https -> wss, http -> ws

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
    mySecret = randomId(48, 'abcdef0123456789'); // legacy identity without a secret
    localStorage.setItem('ghost_secret', mySecret);
  }
  myHandle = localStorage.getItem('ghost_handle') || '';
  refreshIdentityUI();

  // Affiliate attribution: remember ?ref=CODE from the first visit (only used when a new account is created).
  {
    const refParam = new URLSearchParams(window.location.search).get('ref');
    if (refParam && /^[A-Za-z0-9]{6,12}$/.test(refParam) && !localStorage.getItem('ghost_ref')) {
      localStorage.setItem('ghost_ref', refParam.toUpperCase());
    }
  }

  // ------------------------------------------------------------ tier UI
  // The server is the only source of truth; localStorage is just a startup hint for the UI.
  function applyUIPremiumState(premium, expiresAt = null) {
    isPremiumUser = premium;
    if (premium) {
      localStorage.setItem('ghost_tier', 'PREMIUM');
      if (expiresAt) localStorage.setItem('ghost_tier_expiry', expiresAt);
      const exp = parseInt(localStorage.getItem('ghost_tier_expiry') || '0', 10);
      const daysLeft = exp ? Math.max(0, Math.ceil((exp - Date.now()) / 86400000)) : null;
      if (tierBadge) {
        tierBadge.innerText = daysLeft !== null && daysLeft <= 7 ? `PREMIUM · ${daysLeft}d left` : 'PREMIUM TIER';
        tierBadge.classList.add('premium');
      }
      if (premiumCustomKeyBox) premiumCustomKeyBox.style.display = 'block';
      if (upgradeCard) upgradeCard.style.display = 'none';
    } else {
      localStorage.removeItem('ghost_tier');
      localStorage.removeItem('ghost_tier_expiry');
      if (tierBadge) { tierBadge.innerText = 'FREE TIER'; tierBadge.classList.remove('premium'); }
      if (premiumCustomKeyBox) premiumCustomKeyBox.style.display = 'none';
      if (upgradeCard) upgradeCard.style.display = 'block';
    }
  }
  {
    const exp = parseInt(localStorage.getItem('ghost_tier_expiry') || '0', 10);
    const hint = localStorage.getItem('ghost_tier') === 'PREMIUM' && (!exp || Date.now() < exp);
    applyUIPremiumState(hint, exp || null);
  }

  function applyHandle(handle) {
    myHandle = handle || '';
    if (myHandle) localStorage.setItem('ghost_handle', myHandle); else localStorage.removeItem('ghost_handle');
    refreshIdentityUI();
  }

  // ------------------------------------------------------------ chat log (DOM APIs only, no innerHTML with remote data)
  function logChat(msg) {
    if (!chatBox) return;
    const div = document.createElement('div');
    const text = String(msg);
    if (text.startsWith('System:')) {
      div.className = 'msg sys';
      div.textContent = text.slice(7).trim();
    } else if (text.startsWith('Me: ')) {
      div.className = 'msg me';
      div.textContent = text.slice(4);
    } else {
      div.className = 'msg them';
      const i = text.indexOf(': ');
      if (i > 0 && i <= 24) {
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = text.slice(0, i);
        div.appendChild(who);
        div.append(text.slice(i + 2));
      } else div.textContent = text;
    }
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  const SAFE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  function logFileReceived(senderKey, fileName, bytes, mime) {
    if (!chatBox) return;
    const div = document.createElement('div');
    div.style.margin = '6px 0';
    const safeName = String(fileName || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100);
    const isImg = SAFE_IMAGE_MIME.has(mime);

    const label = document.createElement('strong');
    label.textContent = `${senderKey === 'Me' ? 'Me' : nameFor(senderKey)} ${isImg ? '[Image]' : '[File]'}: `;
    div.appendChild(label);

    // Always rebuilt from decrypted bytes with a type we choose, so remote content can never run as code.
    const url = URL.createObjectURL(new Blob([bytes], { type: isImg ? mime : 'application/octet-stream' }));
    objectUrls.push(url);
    if (isImg) {
      div.append(safeName, document.createElement('br'));
      const img = document.createElement('img');
      img.src = url;
      img.style.cssText = 'max-width:150px;border-radius:4px;margin-top:4px;';
      div.appendChild(img);
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = safeName;
      a.style.cssText = 'color:#c5a059;text-decoration:underline;';
      a.textContent = `Download ${safeName}`;
      div.appendChild(a);
    }
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  // ------------------------------------------------------------ contacts
  function escapeHTML(str) {
    return String(str).replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
  }
  // A contact may be saved under a different address than the name its messages arrive under
  // (e.g. you saved their ID, they now use a custom handle). e2e.resolve() knows the mapping.
  const sameContact = (c, name) => c.key === name || e2e.resolve(c.key) === name;
  function contactKeyFor(name) {
    const c = ramContacts.find(x => sameContact(x, name));
    return c ? c.key : null;
  }
  function nameFor(from) {
    const c = ramContacts.find(x => sameContact(x, from));
    return c ? c.name : shortName(from);
  }
  function ensureContact(key, defaultName = 'Peer') {
    if (!key) return null;
    const upperKey = String(key).toUpperCase();
    const existing = contactKeyFor(upperKey);
    if (existing) return existing;
    ramContacts.push({ name: defaultName, key: upperKey });
    renderContacts();
    return upperKey;
  }
  const isValidContact = key => ramContacts.some(c => c.key === key);
  const unread = new Map();   // contact key -> count of messages received while another chat was open

  // An incoming message must NEVER change who your next message goes to (that could leak it to the wrong person):
  // only auto-select when nothing valid is selected, otherwise just mark the contact as unread.
  function noteIncoming(from, defaultName) {
    const ck = ensureContact(from, defaultName);
    if (!ck) return null;
    if (!activeCallTarget || !isValidContact(activeCallTarget)) activeCallTarget = ck;
    else if (activeCallTarget !== ck) unread.set(ck, (unread.get(ck) || 0) + 1);
    renderContacts();
    return ck;
  }

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

    let ws;
    try { ws = new WebSocket(socketUrl); }
    catch (e) { statusBar.innerText = 'Cannot open a secure connection'; statusBar.classList.add('offline'); scheduleReconnect(); return; }
    socket = ws;
    statusBar.innerText = 'Connecting…';

    // Render's free servers sleep when idle: say so instead of looking frozen, and never hang forever.
    const slowTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) statusBar.innerText = 'Waking the secure server… (can take up to a minute)';
    }, 4000);
    const stallTimer = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) { try { ws.close(); } catch {} }
    }, 20000);
    if (reconnectAttempts === 0) fetch(`${apiBase}/health`, { mode: 'no-cors', cache: 'no-store' }).catch(() => {}); // helps wake the server

    ws.onopen = () => {
      clearTimeout(slowTimer); clearTimeout(stallTimer);
      statusBar.innerText = '● Connected · End-to-end encrypted';
      statusBar.classList.remove('offline');
      reconnectAttempts = 0;
      ws.send(JSON.stringify({ type: 'register', key: accountKey, secret: mySecret, ref: localStorage.getItem('ghost_ref') || undefined }));
      flushSocketQueue();
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}'); }, 20000);
    };

    ws.onmessage = event => {
      try { handleSignalingMessage(JSON.parse(event.data)); }
      catch (e) { console.error('Bad incoming message', e); }
    };

    ws.onclose = () => {
      clearTimeout(slowTimer); clearTimeout(stallTimer);
      if (socket !== ws) return;
      clearInterval(pingTimer);
      statusBar.innerText = suppressReconnect ? 'Open on another device · tap to reconnect' : 'Reconnecting…';
      statusBar.classList.add('offline');
      scheduleReconnect();
    };

    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  // Tap your ID to copy it (the global copy-redaction in security.js would otherwise block this).
  if (myIdentityInput) {
    myIdentityInput.addEventListener('click', () => {
      myIdentityInput.select();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(displayIdentity()).then(() => logChat('System: Your ID was copied.')).catch(() => {});
      }
    });
  }

  // If this tab was displaced by another device, tapping the status bar takes the session back.
  statusBar.addEventListener('click', () => {
    if (suppressReconnect) { suppressReconnect = false; reconnectAttempts = 0; if (socket) { try { socket.close(); } catch {} } initWebSocket(); }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || suppressReconnect) return;
    if (!socket || socket.readyState === WebSocket.CLOSED) { reconnectAttempts = 0; initWebSocket(); }
    else safeSend({ type: 'get-status' }); // picks up a payment that completed while the tab was in the background
  });

  // ------------------------------------------------------------ signaling
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
          alert('This identity is already claimed by another device. A new identity has been created for you.');
          newIdentity(); refreshIdentityUI(); applyUIPremiumState(false);
          try { socket.close(); } catch {}
        } else {
          logChat(`System: ${msg.message || 'Registration failed.'}`);
        }
        break;
      case 'replaced':
        suppressReconnect = true;
        logChat('System: Opened on another tab/device. This one is now disconnected.');
        break;
      case 'tier-updated':
        applyUIPremiumState(msg.tier === 'PREMIUM', msg.expiresAt);
        applyHandle(msg.handle);
        logChat(`System: Tier updated to ${msg.tier}.${msg.message ? ' ' + msg.message : ''}`);
        if (msg.tier === 'PREMIUM' && payWatchTimer && (!payWatchBaseExpiry || Number(msg.expiresAt) > payWatchBaseExpiry)) {
          stopPaymentWatch();
          if (paymentModal) paymentModal.style.display = 'none';
          alert(`Premium is active until ${new Date(Number(msg.expiresAt)).toLocaleDateString()}. Thank you for your support!`);
        }
        break;
      case 'custom-key-success':
        applyHandle(msg.customKey === accountKey ? '' : msg.customKey);
        alert(`Custom handle set: ${displayIdentity()}`);
        if (customKeyInput) customKeyInput.value = '';
        break;
      case 'custom-key-error':
        alert(msg.message || 'Could not set handle.');
        break;
      case 'error':
        logChat(`System: ${msg.message}`);
        break;
      case 'peer-offline':
        if (msg.forType === 'e2e-key') e2e.peerOffline(msg.targetKey);
        logChat('System: That contact is offline right now.');
        if (callState === 'CALLING' && peerMatches(msg.targetKey)) endCall(false);
        break;
      case 'text-notify':
        noteIncoming(msg.senderKey, 'Peer');
        break;

      case 'offer': {
        if (!msg.senderKey || !msg.offer) return;
        if (callState !== 'IDLE' || peerConnection) {
          safeSend({ type: 'decline', targetKey: msg.senderKey });
          return;
        }
        callState = 'RINGING';
        callPeer = msg.senderKey;
        callPeerAlias = '';
        pendingIceCandidates = [];   // candidates for THIS call may arrive before Accept; keep them
        incomingOffer = msg;
        noteIncoming(msg.senderKey, 'Caller');
        if (callerIdText) callerIdText.textContent = `Secure ${msg.hasVideo ? 'video' : 'audio'} call from ${nameFor(msg.senderKey)}`;
        if (callModal) callModal.style.display = 'flex';
        clearTimeout(ringTimeout);
        ringTimeout = setTimeout(() => { if (callState === 'RINGING') declineIncoming(); }, 45000);
        break;
      }

      case 'answer':
        if (peerConnection && callState === 'CALLING' && msg.answer) {
          callPeerAlias = msg.senderKey || '';
          clearTimeout(ringTimeout);
          try {
            if (!(await verifySdp(msg.senderKey, 'answer', msg.answer.sdp))) {
              endCall(true);
              alert('Call security check failed (possible interception). The call was ended.');
              return;
            }
            if (callState !== 'CALLING' || !peerConnection) return;
            await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.answer));
            await processPendingIceCandidates();
            callState = 'CONNECTED';
            logChat('System: Secure stream established.');
          } catch (e) { console.error(e); endCall(true); }
        }
        break;

      case 'ice-candidate':
        if (!msg.candidate || !peerMatches(msg.senderKey)) break;
        if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
          try { await peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate)); }
          catch (e) { console.error('Error adding ICE candidate', e); }
        } else {
          pendingIceCandidates.push(msg.candidate);
        }
        break;

      case 'e2e-key':
        e2e.handleKey(msg.senderKey, msg);
        break;

      case 'e2e-msg': {
        if (!msg.senderKey || typeof msg.payload !== 'string') break;
        let dec;
        try { dec = await e2e.decrypt(msg.senderKey, msg.payload); }
        catch (e) {
          logChat(`System: A message from ${nameFor(msg.senderKey)} could not be verified and was discarded. Re-establishing the secure channel...`);
          resync(msg.senderKey);
          break;
        }
        handleSecureContent(msg.senderKey, dec.header, dec.bytes);
        break;
      }

      case 'decline':
        if (callState === 'CALLING' || peerMatches(msg.senderKey)) {
          alert('Call rejected.');
          endCall(false);
        }
        break;

      case 'end-session':
        // Server-originated kicks have no senderKey; peer-originated ones must match the current call.
        if (!msg.senderKey || peerMatches(msg.senderKey) ||
            (callState === 'IDLE' && activeCallTarget && (activeCallTarget === msg.senderKey || e2e.resolve(activeCallTarget) === msg.senderKey))) {
          logChat('System: Session terminated.');
          endCall(false, true);
        }
        break;
    }
  }

  function handleSecureContent(from, header, bytes) {
    switch (header.t) {
      case 'chat':
        if (typeof header.text !== 'string') return;
        noteIncoming(from, 'Peer');
        logChat(`${nameFor(from)}: ${header.text.slice(0, 4000)}`);
        break;
      case 'file':
        if (bytes.length > 5 * 1024 * 1024) return;
        noteIncoming(from, 'Peer');
        logFileReceived(from, header.name, bytes, typeof header.mime === 'string' ? header.mime : '');
        break;
      case 'sdp':
        if ((header.kind === 'offer' || header.kind === 'answer') && /^[a-f0-9]{64}$/.test(header.h || '')) {
          sdpHashes.set(`${from}|${header.kind}`, header.h);
        }
        break;
    }
  }

  // ------------------------------------------------------------ WebRTC
  async function getRtcConfig() {
    if (rtcConfigCache && Date.now() - rtcConfigAt < 10 * 60 * 1000) return rtcConfigCache;
    try {
      const res = await fetch(`${apiBase}/api/ice-servers`, { signal: AbortSignal.timeout(4000) });
      const data = await res.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length) {
        rtcConfigCache = { iceServers: data.iceServers, ...(data.iceTransportPolicy === 'relay' ? { iceTransportPolicy: 'relay' } : {}) };
        rtcConfigAt = Date.now();
        return rtcConfigCache;
      }
    } catch (e) { /* fall back to public STUN */ }
    return DEFAULT_ICE;
  }

  async function processPendingIceCandidates() {
    while (pendingIceCandidates.length > 0 && peerConnection && peerConnection.remoteDescription) {
      const candidate = pendingIceCandidates.shift();
      try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch (e) { console.error('Error adding queued ICE candidate', e); }
    }
  }

  async function setupWebRTC(wantVideo) {
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    // NOTE: pendingIceCandidates is intentionally NOT cleared here (it may hold early candidates).

    peerConnection = new RTCPeerConnection(await getRtcConfig());

    peerConnection.onicecandidate = e => {
      if (!e.candidate || !callPeer) return;
      if (!iceSendReady) localIceBuffer.push(e.candidate);   // hold until the offer/answer has been sent
      else safeSend({ type: 'ice-candidate', targetKey: callPeer, candidate: e.candidate });
    };

    peerConnection.onconnectionstatechange = () => {
      if (!peerConnection) return;
      if (peerConnection.connectionState === 'failed') {
        logChat('System: Connection failed (network may block direct calls).');
        endCall(true);
      }
    };

    peerConnection.ontrack = e => {
      if (!e.streams || !e.streams[0]) return;
      if (e.track.kind === 'video' && remoteVideo) {
        remoteVideo.srcObject = e.streams[0];
        remoteVideo.play().catch(() => {});
        videoContainer.style.display = 'block';
      } else if (e.track.kind === 'audio' && remoteAudio) {
        remoteAudio.srcObject = e.streams[0];
        remoteAudio.volume = 1.0;
        remoteAudio.muted = false;
        remoteAudio.play().catch(() => {});
      }
    };

    if (localStream) {
      localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
      if (wantVideo && localVideo) {
        localVideo.srcObject = localStream;
        localVideo.play().catch(() => {});
        videoContainer.style.display = 'block';
      }
      callControls.style.display = 'flex';
    }
  }

  async function startCall(wantVideo) {
    if (callState !== 'IDLE') { alert('Call already in progress.'); return; }
    if (!activeCallTarget || !isValidContact(activeCallTarget)) { alert('Select a valid contact first.'); return; }
    if (wantVideo && !isPremiumUser) { openPaymentModal('Video calls are a Premium feature.'); return; }

    callState = 'CALLING';                 // claim the slot before any await
    callPeer = activeCallTarget;
    callPeerAlias = '';
    pendingIceCandidates = [];

    logChat('System: Securing the call...');
    if (!(await e2e.ensure(callPeer))) {
      resetCallState();
      alert('Could not open a secure channel. Is the contact online?');
      return;
    }
    if (callState !== 'CALLING') return;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: wantVideo ? { width: { ideal: 640 }, height: { ideal: 480 } } : false
      });
    } catch (err) {
      resetCallState();
      alert('Microphone/Camera access required.');
      return;
    }
    if (callState !== 'CALLING') { stopLocalMedia(); return; }

    try {
      iceSendReady = false; localIceBuffer = [];
      await setupWebRTC(wantVideo);
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      // The server relays the SDP (which carries the DTLS fingerprint). Its hash travels over the
      // end-to-end channel so the callee can detect any tampering by the server.
      await sendSecure(callPeer, { t: 'sdp', kind: 'offer', h: await sha256Hex(offer.sdp) });
      safeSend({ type: 'offer', targetKey: callPeer, offer: { type: offer.type, sdp: offer.sdp }, hasVideo: wantVideo });
      flushLocalIce();
      logChat(`System: Calling ${callPeer} ...`);
      clearTimeout(ringTimeout);
      ringTimeout = setTimeout(() => {
        if (callState === 'CALLING') { logChat('System: No answer.'); endCall(true); }
      }, 45000);
    } catch (e) {
      console.error(e);
      endCall(false);
      alert('Could not start the call.');
    }
  }

  async function acceptIncoming() {
    const msg = incomingOffer;
    if (!msg || callState !== 'RINGING') return;
    clearTimeout(ringTimeout);
    if (callModal) callModal.style.display = 'none';

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: msg.hasVideo ? { width: { ideal: 640 }, height: { ideal: 480 } } : false
      });
    } catch (err) {
      alert('Media permission required.');
      safeSend({ type: 'decline', targetKey: callPeer });
      resetCallState();
      return;
    }
    if (callState !== 'RINGING') { stopLocalMedia(); return; } // caller hung up while we were asking permission

    // Check the offer against the hash the caller sent over the end-to-end channel.
    if (!(await verifySdp(msg.senderKey, 'offer', msg.offer.sdp))) {
      safeSend({ type: 'decline', targetKey: callPeer });
      endCall(false);
      alert('Call security check failed (possible interception). The call was refused.');
      return;
    }
    if (callState !== 'RINGING') { stopLocalMedia(); return; }

    try {
      iceSendReady = false; localIceBuffer = [];
      await setupWebRTC(msg.hasVideo);
      await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.offer));
      await processPendingIceCandidates();
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      await sendSecure(callPeer, { t: 'sdp', kind: 'answer', h: await sha256Hex(answer.sdp) });
      safeSend({ type: 'answer', targetKey: callPeer, answer: { type: answer.type, sdp: answer.sdp } });
      flushLocalIce();
      callPeerAlias = msg.senderKey;
      callState = 'CONNECTED';
      incomingOffer = null;
      logChat('System: Call connected.');
    } catch (e) {
      console.error(e);
      endCall(true);
    }
  }

  function declineIncoming() {
    clearTimeout(ringTimeout);
    if (callModal) callModal.style.display = 'none';
    if (callPeer) safeSend({ type: 'decline', targetKey: callPeer });
    resetCallState();
    renderContacts();
  }

  function stopLocalMedia() {
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  }
  function resetCallState() {
    clearTimeout(ringTimeout);
    stopLocalMedia();
    callState = 'IDLE';
    callPeer = '';
    callPeerAlias = '';
    incomingOffer = null;
    pendingIceCandidates = [];
    iceSendReady = false;
    localIceBuffer = [];
    sdpHashes.clear();
    micMuted = false;
    camOff = false;
  }

  function endCall(notifyPeer = true, clearChat = false) {
    const peer = callPeer || activeCallTarget;
    if (notifyPeer && peer) safeSend({ type: 'end-session', targetKey: peer });
    if (callModal) callModal.style.display = 'none';

    if (peerConnection) { peerConnection.onconnectionstatechange = null; peerConnection.close(); peerConnection = null; }
    resetCallState();
    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;
    if (remoteAudio) remoteAudio.srcObject = null;

    videoContainer.style.display = 'none';
    callControls.style.display = 'none';
    if (clearChat) {
      chatBox.innerHTML = ''; chatInput.value = '';
      if (peer) e2e.drop(peer);                       // forget this conversation's keys
      objectUrls.splice(0).forEach(u => URL.revokeObjectURL(u));
    }
    if (btnToggleMic) btnToggleMic.innerText = '🎙️ Mic On';
    if (btnToggleCam) btnToggleCam.innerText = '📹 Cam On';
    logChat(clearChat ? 'System: Session ended. Chat cleared.' : 'System: Call ended.');
  }

  btnAccept.onclick = acceptIncoming;
  btnDecline.onclick = declineIncoming;
  btnCallAudio.onclick = () => startCall(false);
  btnCallVideo.onclick = () => startCall(true);
  btnEndSession.onclick = () => endCall(true, true);

  if (btnToggleMic) {
    btnToggleMic.onclick = () => {
      if (localStream && localStream.getAudioTracks().length > 0) {
        micMuted = !micMuted;
        localStream.getAudioTracks()[0].enabled = !micMuted;
        btnToggleMic.innerText = micMuted ? '🎙️ Mic Off' : '🎙️ Mic On';
      }
    };
  }
  if (btnToggleCam) {
    btnToggleCam.onclick = () => {
      if (localStream && localStream.getVideoTracks().length > 0) {
        camOff = !camOff;
        localStream.getVideoTracks()[0].enabled = !camOff;
        btnToggleCam.innerText = camOff ? '📹 Cam Off' : '📹 Cam On';
      }
    };
  }

  // ------------------------------------------------------------ chat + files
  btnChat.onclick = () => {
    if (!activeCallTarget || !isValidContact(activeCallTarget)) { alert('Select a contact.'); return; }
    safeSend({ type: 'text-notify', targetKey: activeCallTarget });
    e2e.ensure(activeCallTarget).then(ok => { if (!ok) logChat('System: Could not open a secure channel. Is the contact online?'); });
  };

  btnSend.onclick = async () => {
    const text = chatInput.value.trim().slice(0, 4000);
    const target = activeCallTarget;
    if (!text || !target || !isValidContact(target)) return;
    chatInput.value = '';
    btnSend.disabled = true;
    try {
      if (!(await e2e.ensure(target))) {
        logChat('System: Could not open a secure channel. Is the contact online?');
        chatInput.value = text;
        return;
      }
      await sendSecure(target, { t: 'chat', text });
      logChat(`Me: ${text}`);
    } catch (e) {
      logChat('System: Message not sent (secure channel error).');
      chatInput.value = text;
    } finally {
      btnSend.disabled = false;
    }
  };
  chatInput.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); btnSend.click(); } };

  if (btnAttach && fileInput) {
    btnAttach.onclick = () => {
      if (!isPremiumUser) { openPaymentModal('Encrypted file sharing is a Premium feature.'); return; }
      if (!activeCallTarget || !isValidContact(activeCallTarget)) { alert('Select a contact first.'); return; }
      fileInput.click();
    };
    fileInput.onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { alert('File size exceeds the 5MB limit.'); fileInput.value = ''; return; }
      const target = activeCallTarget;
      const reader = new FileReader();
      reader.onload = async evt => {
        fileInput.value = '';
        try {
          if (!(await e2e.ensure(target))) { logChat('System: Could not open a secure channel. Is the contact online?'); return; }
          await sendSecure(target,
            { t: 'file', name: file.name.slice(0, 200), mime: (file.type || 'application/octet-stream').slice(0, 100) },
            new Uint8Array(evt.target.result));
          logChat(`Me [File]: ${file.name}`);
        } catch (e) {
          logChat('System: File not sent (secure channel error or file too large).');
        }
      };
      reader.readAsArrayBuffer(file);
    };
  }

  // ------------------------------------------------------------ contacts UI
  btnAddContact.onclick = () => {
    const name = contactNameInput.value.trim().slice(0, 16);
    let key = contactKeyInput.value.trim().toUpperCase();
    if (!name || !key) { alert('Enter name and key.'); return; }
    if (!key.startsWith('GHOST-')) key = 'GHOST-' + key;
    if (!KEY_RE.test(key)) { alert('Invalid key format.'); return; }
    if (key === accountKey || key === myHandle) { alert('That is your own key.'); return; }
    if (isValidContact(key)) { alert('Contact already added.'); return; }
    ramContacts.push({ name, key });
    contactNameInput.value = '';
    contactKeyInput.value = '';
    renderContacts();
  };

  function renderContacts() {
    contactsListContainer.innerHTML = '';
    if (ramContacts.length === 0) {
      contactsListContainer.innerHTML = '<div class="empty">No contacts yet. Paste a friend\'s Ghost ID above, or tap Scan to scan their QR code.</div>';
      return;
    }
    ramContacts.forEach((c, idx) => {
      const isSelected = activeCallTarget === c.key;
      const card = document.createElement('div');
      card.className = `contact-card ${isSelected ? 'selected' : ''}`;
      // layout and colours come from the stylesheet (.contact-card / .selected)

      const infoDiv = document.createElement('div');
      infoDiv.className = 'info';
      const badge = unread.get(c.key) ? ` <span class="unread">${unread.get(c.key)} new</span>` : '';
      infoDiv.innerHTML = `<div class="name">${escapeHTML(c.name)}${badge}</div><div class="key">${escapeHTML(c.key)}</div>`;
      infoDiv.onclick = () => { activeCallTarget = c.key; unread.delete(c.key); renderContacts(); };

      const menuContainer = document.createElement('div');
      menuContainer.className = 'menu-container';
      const dotBtn = document.createElement('button');
      dotBtn.className = 'dot-btn';
      dotBtn.textContent = '⋮';
      dotBtn.title = 'Options';
      const dropdownMenu = document.createElement('div');
      dropdownMenu.className = 'dropdown-menu';

      const renameItem = document.createElement('button');
      renameItem.className = 'dropdown-item';
      renameItem.textContent = '✏️ Rename';
      renameItem.onclick = e => {
        e.stopPropagation();
        dropdownMenu.classList.remove('show');
        const newName = prompt(`Rename contact ${c.key}:`, c.name);
        if (newName && newName.trim().length > 0) { ramContacts[idx].name = newName.trim().substring(0, 16); renderContacts(); }
      };
      const deleteItem = document.createElement('button');
      deleteItem.className = 'dropdown-item';
      deleteItem.textContent = '🗑️ Delete';
      deleteItem.onclick = e => {
        e.stopPropagation();
        dropdownMenu.classList.remove('show');
        if (confirm(`Delete contact ${c.name}?`)) {
          e2e.drop(c.key);
          unread.delete(c.key);
          ramContacts.splice(idx, 1);
          if (activeCallTarget === c.key) activeCallTarget = '';
          renderContacts();
        }
      };
      dotBtn.onclick = e => {
        e.stopPropagation();
        document.querySelectorAll('.dropdown-menu').forEach(m => { if (m !== dropdownMenu) m.classList.remove('show'); });
        dropdownMenu.classList.toggle('show');
      };

      dropdownMenu.append(renameItem, deleteItem);
      menuContainer.append(dotBtn, dropdownMenu);
      card.append(infoDiv, menuContainer);
      contactsListContainer.appendChild(card);
    });
  }
  document.addEventListener('click', () => {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
  });

  // ------------------------------------------------------------ payments
  let payWatchTimer = null;
  let payWatchUntil = 0;
  let payWatchBaseExpiry = 0;
  function startPaymentWatch() {
    stopPaymentWatch();
    payWatchBaseExpiry = parseInt(localStorage.getItem('ghost_tier_expiry') || '0', 10) || 0;
    payWatchUntil = Date.now() + 30 * 60 * 1000;      // crypto confirmations can take a while
    payWatchTimer = setInterval(() => {
      if (Date.now() > payWatchUntil) { stopPaymentWatch(); return; }
      safeSend({ type: 'get-status' });
    }, 8000);
  }
  function stopPaymentWatch() { if (payWatchTimer) clearInterval(payWatchTimer); payWatchTimer = null; }

  async function openPaymentModal(reason) {
    const renewing = isPremiumUser;
    if (paymentTitle) paymentTitle.textContent = renewing ? 'Extend your Premium' : 'Unlock Ghost Talk Premium';
    if (paymentDesc) {
      const exp = parseInt(localStorage.getItem('ghost_tier_expiry') || '0', 10);
      paymentDesc.textContent = (reason ? reason + ' ' : '') +
        (renewing && exp ? `Your Premium runs until ${new Date(exp).toLocaleDateString()}; extending adds time on top. ` : '') +
        'Includes encrypted video calls, encrypted file sharing (5 MB) and your own custom handle.';
    }
    try {
      const res = await fetch(`${apiBase}/api/payment-info`);
      const data = await res.json();
      const m = Number(data.pricing.monthly), y = Number(data.pricing.yearly);
      if (modalDisplayPrice) modalDisplayPrice.innerText = `$${m.toFixed(2)} / month`;
      if (modalDisplayPriceYearly) modalDisplayPriceYearly.innerText = `$${y.toFixed(2)} / year`;
      if (yearlySave) {
        const pct = Math.round((1 - y / (m * 12)) * 100);
        yearlySave.textContent = pct > 0 ? `Best value: save ${pct}% with the yearly plan` : '';
      }
    } catch (e) { /* show the modal anyway */ }
    if (paymentModal) paymentModal.style.display = 'flex';
  }
  tierBadge.onclick = () => openPaymentModal('');
  if (btnUpgrade) btnUpgrade.onclick = () => openPaymentModal('');
  if (btnClosePaymentModal) btnClosePaymentModal.onclick = () => { if (paymentModal) paymentModal.style.display = 'none'; };

  // Returning from the payment page (?paid=1): keep checking until the server confirms the payment.
  if (new URLSearchParams(window.location.search).get('paid') === '1') {
    logChat('System: Thank you! Waiting for the network to confirm your payment. This usually takes a few minutes; Premium switches on automatically.');
    startPaymentWatch();
  }

  // Invite friends: the easiest growth loop for a messenger.
  if (btnShare) {
    btnShare.onclick = async () => {
      const link = `${window.location.origin}/app`;
      const text = `Chat with me privately on Ghost Talk (end-to-end encrypted). My Ghost ID: ${displayIdentity()}`;
      try {
        if (navigator.share) await navigator.share({ title: 'Ghost Talk', text, url: link });
        else if (navigator.clipboard) { await navigator.clipboard.writeText(`${text}\n${link}`); logChat('System: Invite copied. Paste it to your friend.'); }
      } catch (e) { /* share dialog dismissed */ }
    };
  }

  async function startCheckout(planType, btn) {
    const original = btn.innerText;
    btn.innerText = 'Initializing...';
    btn.disabled = true;
    try {
      const response = await fetch(`${apiBase}/api/create-payment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userKey: accountKey, planType })
      });
      const data = await response.json();
      if (data.success && data.invoiceUrl) {
        if (paymentModal) paymentModal.style.display = 'none';
        const win = window.open(data.invoiceUrl, '_blank');
        if (!win) window.location.href = data.invoiceUrl; // popup blocked (common on mobile)
        logChat('System: Complete the payment in the new tab. Premium activates automatically once the network confirms it.');
        startPaymentWatch();
      } else {
        alert(data.error ? `Gateway error: ${data.error}` : 'Gateway error.');
      }
    } catch (err) {
      alert('Connection error.');
    } finally {
      btn.innerText = original;
      btn.disabled = false;
    }
  }
  if (btnStartCheckout) btnStartCheckout.onclick = () => startCheckout('monthly', btnStartCheckout);
  if (btnStartCheckoutYearly) btnStartCheckoutYearly.onclick = () => startCheckout('yearly', btnStartCheckoutYearly);

  if (btnSaveCustomKey) {
    btnSaveCustomKey.onclick = () => {
      if (!isPremiumUser) { openPaymentModal('Custom handles are a Premium feature.'); return; }
      const desiredKey = customKeyInput.value.trim().toUpperCase();
      if (!desiredKey || desiredKey.length < 3) { alert('Invalid key.'); return; }
      safeSend({ type: 'set-custom-key', customKey: desiredKey });
    };
  }

  // ------------------------------------------------------------ QR
  function acceptScannedKey(raw) {
    let scannedKey = String(raw || '').trim().toUpperCase();
    if (!scannedKey.startsWith('GHOST-')) scannedKey = 'GHOST-' + scannedKey;
    if (!KEY_RE.test(scannedKey)) return false;
    if (contactKeyInput) contactKeyInput.value = scannedKey;
    closeQrModal();
    alert(`Scanned key: ${scannedKey}`);
    return true;
  }

  if (btnShowQr) {
    btnShowQr.onclick = () => {
      if (qrModalTitle) qrModalTitle.innerText = 'My Identity QR';
      if (qrDisplayContainer) qrDisplayContainer.style.display = 'inline-block';
      if (qrScannerContainer) qrScannerContainer.style.display = 'none';
      if (qrcodeDiv) {
        qrcodeDiv.innerHTML = '';
        if (window.QRCode) {
          new QRCode(qrcodeDiv, { text: displayIdentity().toUpperCase(), width: 180, height: 180, colorDark: '#000', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.H });
        }
      }
      if (qrModal) qrModal.style.display = 'flex';
    };
  }

  if (btnScanQr) {
    btnScanQr.onclick = async () => {
      if (qrModalTitle) qrModalTitle.innerText = 'Scan Contact QR';
      if (qrDisplayContainer) qrDisplayContainer.style.display = 'none';
      if (qrScannerContainer) qrScannerContainer.style.display = 'block';
      if (qrModal) qrModal.style.display = 'flex';
      try {
        qrCameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
        if (qrVideo) {
          qrVideo.srcObject = qrCameraStream;
          qrVideo.setAttribute('playsinline', true);
          await qrVideo.play();
        }
        qrScanAnimation = requestAnimationFrame(scanQrFrame);
      } catch (err) {
        alert('Camera unavailable or permission denied.');
        closeQrModal();
      }
    };
  }

  function scanQrFrame() {
    if (!qrCameraStream || !qrVideo) return;
    if (qrVideo.readyState !== qrVideo.HAVE_ENOUGH_DATA || !qrCanvas) {
      qrScanAnimation = requestAnimationFrame(scanQrFrame);
      return;
    }
    const ctx = qrCanvas.getContext('2d', { willReadFrequently: true });
    qrCanvas.width = qrVideo.videoWidth;
    qrCanvas.height = qrVideo.videoHeight;
    ctx.drawImage(qrVideo, 0, 0, qrCanvas.width, qrCanvas.height);
    if (window.jsQR) {
      const imageData = ctx.getImageData(0, 0, qrCanvas.width, qrCanvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data && acceptScannedKey(code.data)) return;
    }
    qrScanAnimation = requestAnimationFrame(scanQrFrame);
  }

  if (btnUploadQrImg && qrFileInput) {
    btnUploadQrImg.onclick = () => qrFileInput.click();
    qrFileInput.onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = event => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          canvas.width = img.width;
          canvas.height = img.height;
          ctx.drawImage(img, 0, 0);
          if (!window.jsQR) return;
          const imageData = ctx.getImageData(0, 0, img.width, img.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
          if (!code || !code.data || !acceptScannedKey(code.data)) alert('No valid Ghost Talk QR code found in image.');
        };
        img.src = event.target.result;
      };
      reader.readAsDataURL(file);
      qrFileInput.value = '';
    };
  }

  function stopQrCamera() {
    if (qrScanAnimation) { cancelAnimationFrame(qrScanAnimation); qrScanAnimation = null; }
    if (qrCameraStream) { qrCameraStream.getTracks().forEach(t => t.stop()); qrCameraStream = null; }
  }
  function closeQrModal() {
    stopQrCamera();
    if (qrModal) qrModal.style.display = 'none';
  }
  if (btnCloseQr) btnCloseQr.onclick = closeQrModal;

  // ------------------------------------------------------------ wipe
  btnWipe.onclick = () => {
    endCall(true, true);
    e2e.wipe();
    ramContacts = [];
    activeCallTarget = '';
    renderContacts();
    logChat('System: Contacts, chat and encryption keys erased from memory.');
  };

  renderContacts();
  initWebSocket();
});
