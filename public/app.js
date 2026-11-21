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

  async function sendSecure(addr, header, bytes, wake) {
    const payload = await e2e.encrypt(addr, header, bytes);
    // `wake` marks a deliberate message/file: if the person is offline the server may send them a content-free alert.
    safeSend({ type: 'e2e-msg', targetKey: addr, payload, ...(wake ? { wake } : {}) });
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
    return div;
  }

  const SAFE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  function logFileReceived(senderKey, fileName, bytes, mime) {
    return logFileBubble({ mine: false, from: senderKey, name: fileName, bytes, mime });
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
    probeEnabled = true;
    renderContacts();
    updatePresenceUI();
    return ck;
  }

  // ------------------------------------------------------------ presence, typing, delivery ticks, file preview
  const TYPING_SEND_EVERY = 3000, TYPING_STOP_AFTER = 5000, TYPING_SHOW_FOR = 6000;
  const HEARTBEAT_EVERY = 25000, ONLINE_WINDOW = 70000;
  const presence = new Map();     // contact key -> { online, lastSeen, typingUntil, probed, lastProbeAt }
  const outgoing = new Map();     // message id -> { el, target, at, done }  (for delivery ticks)
  const lastDecryptWarn = new Map();
  let typingTarget = '', typingSentAt = 0, typingStopTimer = null;
  let probeEnabled = true;
  let uiSig = '';
  const randomHex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
  const isMsgId = v => typeof v === 'string' && /^[a-f0-9]{8}$/.test(v);
  const socketOpen = () => !!socket && socket.readyState === WebSocket.OPEN;
  const fmtSize = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  function agoText(ts) {
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (sec < 60) return 'just now';
    const m = Math.round(sec / 60);
    return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  }

  const featStyle = document.createElement('style');
  featStyle.textContent = `
    .peer-bar{display:none;align-items:center;flex-wrap:wrap;gap:8px;padding:8px 12px;border:1px solid var(--line);border-radius:12px;background:var(--bg-soft);font-size:12px;color:var(--muted)}
    .peer-bar .pname{color:var(--gold-hi);font-weight:600}
    .pdot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#4a524f;flex:none;margin-right:6px}
    .pdot.on{background:#3ddc84;box-shadow:0 0 0 3px rgba(61,220,132,.15)}
    .ptyping{font-size:10px;color:var(--gold-hi);font-style:italic;margin-left:6px}
    .typing{display:none;padding:2px 14px 6px;font-size:11px;color:var(--gold-hi);font-style:italic}
    .typing i{display:inline-block;width:4px;height:4px;margin-left:3px;border-radius:50%;background:var(--gold-hi);animation:gtb 1.2s infinite}
    .typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}
    @keyframes gtb{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
    .tick{float:right;margin:4px 0 0 10px;font-size:10px;opacity:.65;font-style:normal;white-space:nowrap}
    .tick.ok{opacity:1}.tick.bad{color:#ff6b6b;opacity:1}
    .msg .fileimg{max-width:240px;max-height:240px;object-fit:cover;cursor:zoom-in}
    .msg .cap{font-size:11px;opacity:.7;margin-top:4px;word-break:break-all}
    .filecard{display:flex;align-items:center;gap:10px}
    .filecard .ic{font-size:24px}
    .filecard .fn{font-weight:600;word-break:break-all}
    .gt-overlay{position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.9);display:flex;align-items:center;justify-content:center;z-index:200;padding:16px}
    .gt-sheet{background:var(--card-hi,#161b19);border:1px solid var(--line);border-radius:16px;padding:18px;max-width:420px;width:100%;display:flex;flex-direction:column;gap:12px;color:var(--text)}
    .gt-sheet h4{font-family:var(--serif);font-weight:normal;font-size:16px;color:var(--gold-hi);margin:0}
    .gt-preview{display:flex;align-items:center;justify-content:center;gap:10px;background:var(--bg-soft);border:1px solid var(--line);border-radius:12px;min-height:110px;max-height:300px;overflow:hidden;padding:8px}
    .gt-preview img{max-width:100%;max-height:280px;display:block;border-radius:8px}
    .gt-info{font-size:12px;color:var(--muted);word-break:break-all}
    .gt-err{font-size:12px;color:#ff6b6b;min-height:14px}
    .gt-row{display:flex;gap:10px}.gt-row button{flex:1}
    .gt-lightbox img{max-width:96vw;max-height:80vh;border-radius:10px;display:block}
  `;
  document.head.appendChild(featStyle);

  const peerBar = document.createElement('div');
  peerBar.id = 'peer-bar'; peerBar.className = 'peer-bar';
  const typingEl = document.createElement('div');
  typingEl.id = 'typing-indicator'; typingEl.className = 'typing';
  {
    const shell = chatBox.parentElement;
    if (shell && shell.parentElement) shell.parentElement.insertBefore(peerBar, shell);
    if (shell) shell.insertBefore(typingEl, chatBox.nextSibling);
  }

  function getP(ck) {
    let p = presence.get(ck);
    if (!p) { p = { online: false, lastSeen: 0, typingUntil: 0, probed: false, lastProbeAt: 0 }; presence.set(ck, p); }
    return p;
  }
  const isOnline = ck => { const p = presence.get(ck); return !!p && p.online && Date.now() - p.lastSeen < ONLINE_WINDOW; };
  const isTyping = ck => { const p = presence.get(ck); return !!p && p.typingUntil > Date.now(); };
  function markSeen(from) {
    const ck = contactKeyFor(from);
    if (!ck) return null;
    const p = getP(ck);
    p.online = true; p.lastSeen = Date.now(); p.probed = true;
    updatePresenceUI();
    return ck;
  }
  function markOffline(ck) {
    if (!ck) return;
    const p = getP(ck);
    p.online = false; p.probed = true; p.typingUntil = 0;
    updatePresenceUI();
  }

  function updatePresenceUI() {
    const ck = activeCallTarget && isValidContact(activeCallTarget) ? activeCallTarget : '';
    const sig = ramContacts.map(c => `${c.key}:${isOnline(c.key) ? 1 : 0}:${isTyping(c.key) ? 1 : 0}`).join('|') + '#' + ck;
    if (sig !== uiSig) { uiSig = sig; renderContacts(); }
    if (!ck) { peerBar.style.display = 'none'; typingEl.style.display = 'none'; return; }

    const c = ramContacts.find(x => x.key === ck);
    const p = presence.get(ck);
    const online = isOnline(ck);
    peerBar.innerHTML = '';
    const dot = document.createElement('span'); dot.className = 'pdot' + (online ? ' on' : '');
    const nm = document.createElement('span'); nm.className = 'pname'; nm.textContent = c ? c.name : shortName(ck);
    const st = document.createElement('span');
    st.textContent = online ? 'Online'
      : (p && p.lastSeen ? `Offline · last seen ${agoText(p.lastSeen)}` : (p && p.probed ? 'Offline' : 'Checking…'));
    peerBar.append(dot, nm, st);
    if (e2e.hasSession(ck)) { const lock = document.createElement('span'); lock.textContent = '🔒 End-to-end encrypted'; peerBar.appendChild(lock); }
    peerBar.style.display = 'flex';

    if (isTyping(ck)) {
      typingEl.textContent = `${c ? c.name : 'Contact'} is typing`;
      for (let i = 0; i < 3; i++) typingEl.appendChild(document.createElement('i'));
      typingEl.style.display = 'block';
    } else typingEl.style.display = 'none';
  }
  setInterval(updatePresenceUI, 5000);

  // --- presence: tiny encrypted heartbeats, only between contacts that already share a secure session
  async function pingPeer(addr, isReply) {
    if (!socketOpen() || !e2e.hasSession(addr)) return;
    try { await sendSecure(addr, { t: 'hb', r: isReply ? 1 : 0 }); } catch (e) { /* ignore */ }
  }
  async function probeContact(ck) {
    if (!ck || !isValidContact(ck) || !probeEnabled) return;
    if (e2e.hasSession(ck)) { pingPeer(ck, false); return; }
    const p = getP(ck);
    if (Date.now() - p.lastProbeAt < 15000) return;
    p.lastProbeAt = Date.now();
    let ok = false;
    try { ok = await e2e.ensure(ck, 7000); } catch (e) { ok = false; }   // a handshake doubles as an "is online?" check
    if (ok) { markSeen(ck); pingPeer(ck, false); } else markOffline(ck);
  }
  setInterval(() => {
    ramContacts.slice(0, 20).forEach(c => { if (e2e.hasSession(c.key)) pingPeer(c.key, false); });
    if (probeEnabled && activeCallTarget && isValidContact(activeCallTarget) && !e2e.hasSession(activeCallTarget)) probeContact(activeCallTarget);
  }, HEARTBEAT_EVERY);

  function selectContact(key) {
    if (typingTarget && typingTarget !== key) stopTyping();
    activeCallTarget = key;
    unread.delete(key);
    probeEnabled = true;
    renderContacts();
    updatePresenceUI();
    probeContact(key);
  }

  // --- typing indicator (sent over the encrypted channel, so the server cannot see it)
  function sendTyping(target, on) {
    if (!target || !socketOpen() || !e2e.hasSession(target)) return;
    sendSecure(target, { t: 'typing', on: on ? 1 : 0 }).catch(() => {});
  }
  function stopTyping() {
    clearTimeout(typingStopTimer); typingStopTimer = null;
    if (typingTarget) sendTyping(typingTarget, false);
    typingTarget = ''; typingSentAt = 0;
  }
  chatInput.addEventListener('input', () => {
    const target = activeCallTarget;
    if (!target || !isValidContact(target)) return;
    if (!chatInput.value.trim()) { stopTyping(); return; }
    if (typingTarget && typingTarget !== target) stopTyping();
    typingTarget = target;
    const now = Date.now();
    if (now - typingSentAt > TYPING_SEND_EVERY) { typingSentAt = now; sendTyping(target, true); }
    clearTimeout(typingStopTimer);
    typingStopTimer = setTimeout(stopTyping, TYPING_STOP_AFTER);
  });

  // --- delivery ticks: one tick = sent, two = the other person's app received it
  function addTick(div, id, target, payload, waiting) {
    const t = document.createElement('span');
    t.className = 'tick'; t.textContent = '✓'; t.title = 'Sent';
    div.appendChild(t);
    const o = { el: t, target, at: Date.now(), done: false, payload: payload || null, waiting: false, until: 0 };
    outgoing.set(id, o);
    if (waiting && o.payload) { o.waiting = true; o.until = Date.now() + WAIT_MS; setTick(t, '⏳ alert sent', 'wait', 'Waiting for them to open the app'); }
    setTimeout(() => outgoing.delete(id), 10 * 60 * 1000);
  }
  function setTick(el, text, cls, title) { el.textContent = text; el.className = 'tick ' + cls; el.title = title; }
  function failPendingTo(ck) {
    let n = 0; const now = Date.now();
    outgoing.forEach(o => {
      if (!o.done && !o.waiting && o.target === ck && now - o.at < 8000) { o.done = true; o.payload = null; setTick(o.el, '⚠ not delivered', 'bad', 'The contact was offline'); n++; }
    });
    return n;
  }

  // --- files and images: bubbles with real previews, a full-screen viewer and a confirm-before-send sheet
  function logFileBubble({ mine, from, name, bytes, mime, id, target, payload, waiting }) {
    const div = document.createElement('div');
    div.className = mine ? 'msg me' : 'msg them';
    if (!mine) { const who = document.createElement('span'); who.className = 'who'; who.textContent = nameFor(from); div.appendChild(who); }
    const safeName = String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100);
    const isImg = SAFE_IMAGE_MIME.has(mime);
    // Always rebuilt from decrypted bytes with a type we choose, so remote content can never run as code.
    const url = URL.createObjectURL(new Blob([bytes], { type: isImg ? mime : 'application/octet-stream' }));
    objectUrls.push(url);
    if (isImg) {
      const img = document.createElement('img');
      img.className = 'fileimg'; img.src = url; img.alt = safeName;
      img.onclick = () => openLightbox(url, safeName);
      div.appendChild(img);
      const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = `${safeName} · ${fmtSize(bytes.length)}`;
      div.appendChild(cap);
    } else {
      const card = document.createElement('div'); card.className = 'filecard';
      const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = '📄';
      const info = document.createElement('div');
      const fn = document.createElement('div'); fn.className = 'fn'; fn.textContent = safeName;
      const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = fmtSize(bytes.length) + ' · ';
      const a = document.createElement('a'); a.href = url; a.download = safeName; a.textContent = 'Save';
      cap.appendChild(a);
      info.append(fn, cap);
      card.append(ic, info);
      div.appendChild(card);
    }
    if (mine && id) addTick(div, id, target, payload, waiting);
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
    return div;
  }

  function openLightbox(url, name) {
    const ov = document.createElement('div'); ov.className = 'gt-overlay gt-lightbox';
    const box = document.createElement('div'); box.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:12px;';
    const img = document.createElement('img'); img.src = url; img.alt = name;
    const row = document.createElement('div'); row.className = 'gt-row'; row.style.cssText = 'width:100%;max-width:320px;';
    const save = document.createElement('button'); save.className = 'btn-secondary'; save.textContent = 'Save';
    const close = document.createElement('button'); close.className = 'btn-green'; close.textContent = 'Close';
    const onKey = e => { if (e.key === 'Escape') done(); };
    const done = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    save.onclick = () => { const a = document.createElement('a'); a.href = url; a.download = name; a.click(); };
    close.onclick = done;
    ov.onclick = e => { if (e.target === ov) done(); };
    document.addEventListener('keydown', onKey);
    row.append(save, close); box.append(img, row); ov.appendChild(box);
    document.body.appendChild(ov);
  }

  function showAttachPreview(file, bytes, target) {
    const mime = String(file.type || 'application/octet-stream').slice(0, 100);
    const isImg = SAFE_IMAGE_MIME.has(mime);
    const name = String(file.name || 'file').slice(0, 200);
    const previewUrl = URL.createObjectURL(new Blob([bytes], { type: isImg ? mime : 'application/octet-stream' }));

    const ov = document.createElement('div'); ov.className = 'gt-overlay';
    const sheet = document.createElement('div'); sheet.className = 'gt-sheet';
    const h = document.createElement('h4'); h.textContent = isImg ? 'Send this photo?' : 'Send this file?';
    const pv = document.createElement('div'); pv.className = 'gt-preview';
    if (isImg) { const im = document.createElement('img'); im.src = previewUrl; im.alt = name; pv.appendChild(im); }
    else { const ic = document.createElement('span'); ic.style.fontSize = '34px'; ic.textContent = '📄'; const nm = document.createElement('div'); nm.className = 'fn'; nm.textContent = name; pv.append(ic, nm); }
    const info = document.createElement('div'); info.className = 'gt-info';
    info.textContent = `${name} · ${fmtSize(bytes.length)}  →  to ${nameFor(target)} · 🔒 end-to-end encrypted`;
    const err = document.createElement('div'); err.className = 'gt-err';
    const row = document.createElement('div'); row.className = 'gt-row';
    const cancel = document.createElement('button'); cancel.className = 'btn-secondary'; cancel.textContent = 'Cancel';
    const send = document.createElement('button'); send.className = 'btn-green'; send.textContent = 'Send';
    let busy = false;
    const onKey = e => { if (e.key === 'Escape' && !busy) close(); };
    const close = () => { ov.remove(); URL.revokeObjectURL(previewUrl); document.removeEventListener('keydown', onKey); };
    cancel.onclick = () => { if (!busy) close(); };
    ov.onclick = e => { if (e.target === ov && !busy) close(); };
    send.onclick = async () => {
      if (busy) return;
      busy = true; send.disabled = true; cancel.disabled = true; send.textContent = 'Sending…'; err.textContent = '';
      try {
        const id = randomHex(4);
        const header = { t: 'file', name, mime, id };
        if (!(await e2e.ensure(target, 8000, { wake: 'msg' }))) {
          if (isWaiting(target)) {          // they were sent a silent alert: keep the file here and deliver when they open the app
            close();
            logFileBubble({ mine: true, from: 'Me', name, bytes, mime, id, target, payload: { header, bytes }, waiting: true });
            noteAlertSent(target, 1);
            return;
          }
          throw new Error('offline');
        }
        await sendSecure(target, header, bytes, 'msg');
        close();
        logFileBubble({ mine: true, from: 'Me', name, bytes, mime, id, target, payload: { header, bytes } });
      } catch (e) {
        busy = false; send.disabled = false; cancel.disabled = false; send.textContent = 'Try again';
        err.textContent = 'Could not send. Is your contact online?';
      }
    };
    document.addEventListener('keydown', onKey);
    row.append(cancel, send);
    sheet.append(h, pv, info, err, row);
    ov.appendChild(sheet);
    document.body.appendChild(ov);
  }

  function handlePickedFile(file) {
    if (!file) return;
    if (!isPremiumUser) { openPaymentModal('Encrypted file sharing is a Premium feature.'); return; }
    const target = activeCallTarget;
    if (!target || !isValidContact(target)) { alert('Select a contact first.'); return; }
    if (file.size > 5 * 1024 * 1024) { alert('File size exceeds the 5MB limit.'); return; }
    if (!file.size) { alert('That file is empty.'); return; }
    const reader = new FileReader();
    reader.onload = evt => showAttachPreview(file, new Uint8Array(evt.target.result), target);
    reader.onerror = () => alert('Could not read that file.');
    reader.readAsArrayBuffer(file);
  }

  // ------------------------------------------------------------ alerts, ringing, waiting for people to come back
  const WAIT_MS = 120000;                       // matches the server: it remembers who tried to reach you for 2 minutes (RAM only)
  const waitingFor = new Map();                 // contact -> time until which a silent alert is "in flight"
  const alertNoted = new Map();
  let pendingCall = null;                       // { target, video, until }
  let callWantVideo = false;
  const delivering = new Set();
  const isNative = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  const pushPlugin = isNative && window.Capacitor.Plugins ? window.Capacitor.Plugins.PushNotifications : null;
  // No Firebase: the app raises its own system notifications (LocalNotifications plugin) and keeps
  // its encrypted connection alive with a small Android foreground service (GhostAlerts plugin).
  const localNotifications = isNative && window.Capacitor.Plugins ? window.Capacitor.Plugins.LocalNotifications : null;
  const ghostAlerts = isNative && window.Capacitor.Plugins ? window.Capacitor.Plugins.GhostAlerts : null;
  let serverPush = false;                       // the server has phone alerts configured
  let alertsServerOn = false;                   // this device's token is registered on the server
  let alertsOn = localStorage.getItem('ghost_alerts') === '1';
  let alertsSynced = false;
  let pushListening = false;

  const isWaiting = target => (waitingFor.get(contactKeyFor(target) || target) || 0) > Date.now();
  function noteAlertSent(ck, n) {
    if ((alertNoted.get(ck) || 0) > Date.now()) return;
    alertNoted.set(ck, Date.now() + WAIT_MS);
    logChat(`System: ${nameFor(ck)} is offline. A silent alert was sent (it contains no names or text). If they open Ghost Talk within 2 minutes, your ${n === 1 ? 'message is' : 'messages are'} delivered automatically.`);
  }
  function queueWaiting(ck) {
    let n = 0; const now = Date.now();
    outgoing.forEach(o => {
      if (!o.done && !o.waiting && o.target === ck && o.payload && now - o.at < 8000) {
        o.waiting = true; o.until = now + WAIT_MS;
        setTick(o.el, '⏳ alert sent', 'wait', 'Waiting for them to open the app');
        n++;
      }
    });
    return n;
  }
  async function deliverWaiting(ck) {
    if (delivering.has(ck)) return;
    const items = [];
    outgoing.forEach(o => { if (o.waiting && !o.done && o.target === ck && o.until > Date.now() && o.payload) items.push(o); });
    waitingFor.delete(ck); alertNoted.delete(ck);
    if (!items.length) return;
    delivering.add(ck);
    try {
      e2e.drop(ck);                                              // they restarted the app: the old keys are gone
      const ok = await e2e.ensure(ck, 12000);
      if (!ok) { items.forEach(o => { o.waiting = false; o.done = true; o.payload = null; setTick(o.el, '⚠ not delivered', 'bad', 'Could not reach them'); }); return; }
      for (const o of items) {
        try {
          await sendSecure(ck, o.payload.header, o.payload.bytes, undefined);
          o.waiting = false; setTick(o.el, '✓', '', 'Sent');
        } catch (e) { o.waiting = false; o.done = true; setTick(o.el, '⚠ not delivered', 'bad', 'Send failed'); }
      }
      logChat(`System: ${nameFor(ck)} opened the app. Your ${items.length === 1 ? 'message was' : 'messages were'} delivered.`);
    } finally { delivering.delete(ck); }
  }
  function startWaitingCall(target, video) {
    pendingCall = { target, video: !!video, until: Date.now() + WAIT_MS };
    logChat(`System: ${nameFor(target)} is not in the app. A silent ring alert was sent. If they open Ghost Talk within 2 minutes, the call starts automatically. Press End to cancel.`);
  }
  function resumePendingCall(ck) {
    const pc = pendingCall;
    if (!pc || pc.target !== ck || pc.until < Date.now() || callState !== 'IDLE') return;
    pendingCall = null;
    e2e.drop(ck);
    activeCallTarget = ck;
    logChat(`System: ${nameFor(ck)} is online. Calling now...`);
    startCall(pc.video);
  }
  setInterval(() => {                           // anything still waiting after 2 minutes: say so honestly
    const now = Date.now();
    outgoing.forEach(o => {
      if (o.waiting && !o.done && o.until < now) { o.waiting = false; o.done = true; o.payload = null; setTick(o.el, '⚠ not delivered', 'bad', 'They did not open the app in time'); }
    });
    if (pendingCall && pendingCall.until < now) { logChat(`System: ${nameFor(pendingCall.target)} did not open the app, so the call was cancelled.`); pendingCall = null; }
  }, 5000);

  // --- sounds: an in-app ringtone for calls and a soft tone for messages (generated on the device, no audio files)
  let audioCtx = null, ringTimer = null;
  function ensureAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = audioCtx || new AC();
      if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
      return audioCtx;
    } catch (e) { return null; }
  }
  function tone(freq, start, dur, vol) {
    const ctx = ensureAudio();
    if (!ctx) return;
    try {
      const o = ctx.createOscillator(), g = ctx.createGain(), t0 = ctx.currentTime + start;
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + 0.02); g.gain.linearRampToValueAtTime(0, t0 + dur);
      o.connect(g); g.connect(ctx.destination); o.start(t0); o.stop(t0 + dur + 0.05);
    } catch (e) { /* audio is optional */ }
  }
  function startRing() {
    stopRing();
    const cycle = () => {
      tone(880, 0, 0.35, 0.2); tone(660, 0.4, 0.35, 0.2); tone(880, 1.2, 0.35, 0.2); tone(660, 1.6, 0.35, 0.2);
      try { if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]); } catch (e) { /* not supported */ }
    };
    cycle();
    ringTimer = setInterval(cycle, 3000);
  }
  function stopRing() {
    if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
    try { if (navigator.vibrate) navigator.vibrate(0); } catch (e) { /* not supported */ }
  }
  document.addEventListener('click', () => ensureAudio(), { once: true });   // browsers only allow sound after a tap

  // --- local notifications while the page is open but in the background (generic text only, never names or content)
  const away = () => document.visibilityState === 'hidden' || (typeof document.hasFocus === 'function' && !document.hasFocus());
  const baseTitle = document.title;
  // Android identifies a notification by its id: sending the same id again REPLACES the previous
  // alert. The old id was the time in whole seconds, so two alerts inside the same second (a call
  // right after a message) overwrote each other. Each alert now gets its own id: a random starting
  // point plus a counter, kept inside the positive 32-bit range Java accepts (1 .. 2147483647).
  let notificationSeq = 1 + Math.floor(Math.random() * 1000000000);
  function nextNotificationId() {
    notificationSeq = (notificationSeq % 2000000000) + 1;   // 1 .. 2000000000, never 0 or negative
    return notificationSeq;
  }
  async function notifyLocal(body, channelId) {
    if (isNative) {
      // A real phone notification, raised by the app itself. Text stays generic: never names, never content.
      if (!alertsOn || !away() || !localNotifications) return;
      try {
        await localNotifications.schedule({
          notifications: [{
            id: nextNotificationId(),
            title: 'Ghost Talk',
            body,
            channelId: channelId || 'ghost_msgs'
          }]
        });
      } catch (e) { /* if Android refuses, the in-app tone and title change still happen */ }
      return;
    }
    if (!away() || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try { new Notification('Ghost Talk', { body, tag: 'gt-local', renotify: true }); } catch (e) { /* e.g. Android Chrome needs a service worker */ }
  }
  function announceIncoming() {
    if (!away()) return;
    tone(1046, 0, 0.12, 0.12); tone(1318, 0.14, 0.18, 0.12);
    notifyLocal('New secure message');
    document.title = '● New secure message';
  }
  const restoreTitle = () => { if (document.title !== baseTitle) document.title = baseTitle; };
  window.addEventListener('focus', restoreTitle);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') restoreTitle(); });

  // --- phone alerts (Android app): a silent, content-free wake-up. The message itself is never sent through the push service.
  async function enableAlerts(silent) {
    if (!isNative) return false;
    try {
      if (localNotifications) {
        let perm = await localNotifications.checkPermissions();
        if (perm.display !== 'granted') perm = await localNotifications.requestPermissions();
        if (perm.display !== 'granted') {
          if (!silent) alert('Notifications are blocked. Allow them for Ghost Talk in your phone settings, then try again.');
          return false;
        }
        try {
          await localNotifications.createChannel({ id: 'ghost_calls', name: 'Incoming calls', description: 'Someone is calling you', importance: 5, visibility: 1, vibration: true });
          await localNotifications.createChannel({ id: 'ghost_msgs', name: 'New messages', description: 'Someone sent you a message', importance: 4, visibility: 1, vibration: true });
        } catch (e) { /* channels already exist */ }
      } else if (!pushPlugin) {
        return false;                            // this APK was built without the notification module
      }
      if (ghostAlerts) {
        try { await ghostAlerts.start(); } catch (e) { /* keep-alive is best effort */ }
      }
      if (pushPlugin) {                          // only active in a Firebase build; harmless otherwise
        try {
          if (!pushListening) {
            pushListening = true;
            pushPlugin.addListener('registration', t => { if (t && t.value) safeSend({ type: 'push-register', token: t.value }); });
            pushPlugin.addListener('pushNotificationActionPerformed', () => {
              if (!socketOpen()) { reconnectAttempts = 0; initWebSocket(); }
            });
          }
          await pushPlugin.register();
        } catch (e) { /* no Google services in this build: expected */ }
      }
      alertsOn = true;
      localStorage.setItem('ghost_alerts', '1');
      updateAlertsUI();
      logChat('System: Alerts on. Ghost Talk will keep a private connection open so you are notified while the app is in the background. No Google services are used.');
      return true;
    } catch (e) {
      if (!silent) alert('Could not turn on alerts: ' + (e && e.message ? e.message : 'unknown error'));
      return false;
    }
  }
  async function disableAlerts() {
    alertsOn = false;
    localStorage.removeItem('ghost_alerts');
    safeSend({ type: 'push-unregister' });        // clears any leftover token on our server
    try { if (ghostAlerts) await ghostAlerts.stop(); } catch (e) { /* ignore */ }
    try { if (pushPlugin && pushPlugin.unregister) await pushPlugin.unregister(); } catch (e) { /* ignore */ }
    updateAlertsUI();
  }

  const btnAlerts = document.createElement('button');
  btnAlerts.id = 'btn-alerts'; btnAlerts.className = 'tier-badge'; btnAlerts.title = 'Alerts & privacy';
  if (tierBadge && tierBadge.parentElement) tierBadge.parentElement.insertBefore(btnAlerts, tierBadge);
  else document.body.appendChild(btnAlerts);
  let alertsSheet = null;
  function alertsStatusText() {
    if (isNative) {
      if (!localNotifications && !pushPlugin) return 'This APK was built without the notification module, so alerts cannot be switched on. Install the newest Ghost Talk APK from the download link, then try again.';
      if (!alertsOn) return 'Alerts are OFF. You only receive messages and calls while the app is open.';
      return 'Alerts are ON. Ghost Talk keeps a private connection open so you are told about messages and calls while the app is in the background. Android may still stop the app after long idle periods or on very aggressive battery savers.';
    }
    return 'Background alerts work in the Android app. In this browser you get a sound, a vibration and (if you allow it) a notification while the page is open.';
  }
  function updateAlertsUI() {
    btnAlerts.textContent = (isNative ? alertsOn : (typeof Notification !== 'undefined' && Notification.permission === 'granted')) ? '🔔' : '🔕';
    if (alertsSheet) alertsSheet.render();
  }
  function openAlertsSheet() {
    const ov = document.createElement('div'); ov.className = 'gt-overlay';
    const sheet = document.createElement('div'); sheet.className = 'gt-sheet';
    const close = () => { ov.remove(); alertsSheet = null; document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    ov.onclick = e => { if (e.target === ov) close(); };
    document.addEventListener('keydown', onKey);
    alertsSheet = {
      render() {
        sheet.innerHTML = '';
        const h = document.createElement('h4'); h.textContent = 'Alerts & privacy';
        const st = document.createElement('div'); st.className = 'gt-info'; st.textContent = alertsStatusText();
        sheet.append(h, st);
        const row = document.createElement('div'); row.className = 'gt-row';
        if (isNative) {
          const b = document.createElement('button');
          b.className = alertsOn ? 'btn-secondary' : 'btn-green';
          b.textContent = alertsOn ? 'Turn off alerts' : 'Turn on alerts';
          b.onclick = () => (alertsOn ? disableAlerts() : enableAlerts(false));
          row.appendChild(b);
        } else if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
          const b = document.createElement('button'); b.className = 'btn-green'; b.textContent = 'Allow notifications on this page';
          b.onclick = async () => { try { await Notification.requestPermission(); } catch (e) { /* ignore */ } updateAlertsUI(); };
          row.appendChild(b);
        }
        sheet.appendChild(row);
        const facts = document.createElement('ul'); facts.className = 'gt-facts';
        [
          'Messages, calls and files are end-to-end encrypted. Not even we can read them.',
          'An alert only says “Incoming secure call” or “New secure message”. It never contains a name, text or key.',
          'Your phone\'s push service can see that an alert reached your phone, but not who sent it or what it was.',
          'Nothing is queued on our servers. The sender\'s app re-sends when you open the app (within 2 minutes), otherwise it is dropped.',
          'Block anyone from the ⋮ menu on their contact: they can no longer message, call or alert you.',
          'Turn alerts off any time. Your device token is then deleted from our server.'
        ].forEach(t => { const li = document.createElement('li'); li.textContent = t; facts.appendChild(li); });
        sheet.appendChild(facts);
        const row2 = document.createElement('div'); row2.className = 'gt-row';
        const ub = document.createElement('button'); ub.className = 'btn-secondary'; ub.textContent = 'Unblock everyone';
        ub.onclick = () => { if (confirm('Allow everyone you blocked to contact you again?')) safeSend({ type: 'unblock-all' }); };
        const cb = document.createElement('button'); cb.className = 'btn-green'; cb.textContent = 'Close'; cb.onclick = close;
        row2.append(ub, cb);
        sheet.appendChild(row2);
      }
    };
    alertsSheet.render();
    ov.appendChild(sheet);
    document.body.appendChild(ov);
  }
  btnAlerts.onclick = openAlertsSheet;
  {
    const st = document.createElement('style');
    st.textContent = `.tick.wait{opacity:1;color:var(--gold-hi)} .gt-facts{margin:0;padding-left:18px;font-size:12px;line-height:1.7;color:var(--text)} #btn-alerts{background:transparent;margin-right:6px}`;
    document.head.appendChild(st);
  }
  updateAlertsUI();

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
        serverPush = !!msg.push;
        if (alertsOn && pushPlugin && serverPush && !alertsSynced) { alertsSynced = true; enableAlerts(true); }
        updateAlertsUI();
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
      case 'peer-offline': {
        if (typeof msg.forType === 'string' && msg.forType.indexOf('group-') === 0) {
          groupPeerOffline(msg.targetKey);
          break;
        }
        const ck = contactKeyFor(msg.targetKey) || msg.targetKey;
        if (msg.notified) waitingFor.set(ck, Date.now() + WAIT_MS);       // a silent alert went out: they may open the app soon
        if (msg.forType === 'e2e-key') e2e.peerOffline(msg.targetKey);
        markOffline(ck);
        if (msg.notified) {
          const n = queueWaiting(ck);
          if (n) noteAlertSent(ck, n);
        } else {
          const failed = failPendingTo(ck);
          if (failed) logChat(`System: ${nameFor(ck)} is offline, so ${failed === 1 ? 'that message was' : 'those messages were'} not delivered. Nothing is stored on the server, so send it again when they are back.`);
        }
        // Only the call offer itself decides what happens to a call. The earlier setup messages (secure-channel
        // handshake, SDP check) also come back as "offline"; reacting to them would end the call before the
        // offer's reply could start the "ringing their phone" wait.
        if (callState === 'CALLING' && peerMatches(msg.targetKey) && msg.forType === 'offer') {
          const t = callPeer, video = callWantVideo;
          endCall(false);
          if (msg.notified) startWaitingCall(t, video);
          else logChat(`System: ${nameFor(t)} is offline right now.`);
        }
        break;
      }
      case 'peer-online': {              // someone we tried to reach just opened the app
        const ck = contactKeyFor(msg.senderKey);
        if (!ck) break;
        markSeen(ck);
        deliverWaiting(ck);
        resumePendingCall(ck);
        break;
      }
      case 'push-registered':
        alertsServerOn = !!msg.enabled;
        updateAlertsUI();
        break;
      case 'blocked':
        logChat(msg.count ? 'System: Blocked. They can no longer reach or alert you.' : 'System: Everyone is unblocked.');
        break;
      case 'text-notify':
        noteIncoming(msg.senderKey, 'Peer');
        break;

      case 'offer': {
        if (!msg.senderKey || !msg.offer) return;
        if (callState !== 'IDLE' || peerConnection || group.active) {
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
        startRing();
        notifyLocal('Incoming secure call', 'ghost_calls');
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
          const nowW = Date.now();
          if (nowW - (lastDecryptWarn.get(msg.senderKey) || 0) > 30000) {
            lastDecryptWarn.set(msg.senderKey, nowW);
            logChat(`System: A message from ${nameFor(msg.senderKey)} could not be verified and was discarded. Re-establishing the secure channel...`);
          }
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

      // ---- group calls: separate message types, so the 1:1 call path above is untouched
      case 'group-invite': groupOnInvite(msg); break;
      case 'group-accept': groupOnAccept(msg); break;
      case 'group-decline': groupOnDecline(msg); break;
      case 'group-roster': groupOnRoster(msg); break;
      case 'group-offer': await groupOnOffer(msg); break;
      case 'group-answer': await groupOnAnswer(msg); break;
      case 'group-ice': await groupOnIce(msg); break;
      case 'group-end': groupOnEnd(msg); break;
    }
  }

  function handleSecureContent(from, header, bytes) {
    switch (header.t) {
      case 'chat': {
        if (typeof header.text !== 'string') return;
        noteIncoming(from, 'Peer');
        markSeen(from);
        { const ck = contactKeyFor(from); if (ck) getP(ck).typingUntil = 0; }
        logChat(`${nameFor(from)}: ${header.text.slice(0, 4000)}`);
        announceIncoming();
        if (isMsgId(header.id)) sendSecure(from, { t: 'ack', id: header.id }).catch(() => {});   // tells the sender it arrived
        updatePresenceUI();
        break;
      }
      case 'file': {
        if (bytes.length > 5 * 1024 * 1024) return;
        noteIncoming(from, 'Peer');
        markSeen(from);
        { const ck = contactKeyFor(from); if (ck) getP(ck).typingUntil = 0; }
        logFileBubble({ mine: false, from, name: header.name, bytes, mime: typeof header.mime === 'string' ? header.mime : '' });
        announceIncoming();
        if (isMsgId(header.id)) sendSecure(from, { t: 'ack', id: header.id }).catch(() => {});
        updatePresenceUI();
        break;
      }
      case 'ack': {
        if (!isMsgId(header.id)) return;
        const ck = markSeen(from);
        const o = outgoing.get(header.id);
        if (o && !o.done && ck && o.target === ck) { o.done = true; o.waiting = false; o.payload = null; setTick(o.el, '✓✓', 'ok', 'Delivered'); }
        break;
      }
      case 'typing': {
        const ck = markSeen(from);
        if (!ck) return;
        getP(ck).typingUntil = header.on ? Date.now() + TYPING_SHOW_FOR : 0;
        updatePresenceUI();
        if (header.on) setTimeout(updatePresenceUI, TYPING_SHOW_FOR + 300);
        break;
      }
      case 'hb':
        if (!markSeen(from)) return;            // only answer people in your contact list
        if (!header.r) pingPeer(from, true);
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
    if (group.active) { alert('End the group call first.'); return; }
    if (!activeCallTarget || !isValidContact(activeCallTarget)) { alert('Select a valid contact first.'); return; }
    if (wantVideo && !isPremiumUser) { openPaymentModal('Video calls are a Premium feature.'); return; }

    callState = 'CALLING';                 // claim the slot before any await
    callPeer = activeCallTarget;
    callPeerAlias = '';
    pendingIceCandidates = [];

    callWantVideo = wantVideo;
    logChat('System: Securing the call...');
    if (!(await e2e.ensure(callPeer, 8000, { wake: 'call' }))) {
      const t = callPeer;
      resetCallState();
      if (isWaiting(t)) { startWaitingCall(t, wantVideo); return; }
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
    stopRing();
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
    stopRing();
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
      if (peer) { e2e.drop(peer); presence.delete(contactKeyFor(peer) || peer); }   // forget this conversation's keys
      stopTyping(); outgoing.clear(); waitingFor.clear(); probeEnabled = false;   // no background re-connecting after you end a session
    pendingCall = null;
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

  // ------------------------------------------------------------ group calls (mesh, Premium host)
  // Every participant connects directly to every other participant; the server only relays small
  // signalling messages, exactly as for a 1:1 call. Media never touches the server and is encrypted
  // by WebRTC (DTLS-SRTP) between the phones. A Premium account is required to START a group call;
  // anyone can be invited and join. Free members join with audio only.
  const GROUP_MAX = 4;                       // 1 host + 3 guests, the practical limit for a phone mesh
  const group = {
    active: false, id: '', host: '', members: [], wantVideo: false,
    localStream: null, peers: new Map(), invite: null, ui: null
  };
  const myGroupKey = () => accountKey;
  // Identity is always the permanent Ghost ID, never the display name, so tie-breaks agree on
  // every device even when somebody uses a custom handle.
  const groupIdOf = msg => (typeof msg.me === 'string' && /^GHOST-[A-Z0-9]{3,16}$/.test(msg.me)) ? msg.me : String(msg.senderKey || '');
  // Exactly one side of each pair opens the connection: the one whose ID sorts first.
  const groupInitiate = other => String(myGroupKey()).toUpperCase() < String(other).toUpperCase();
  const groupHasVideo = () => !!(group.localStream && group.localStream.getVideoTracks().length);

  function groupUi() {
    if (group.ui) return group.ui;
    const root = document.createElement('div');
    root.id = 'gt-group-call';
    root.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147482000;background:#0b0f0e;display:none;flex-direction:column;padding:14px;box-sizing:border-box;';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;';
    const title = document.createElement('div');
    title.style.cssText = 'font-family:monospace;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#c5a059;';
    const leave = document.createElement('button');
    leave.textContent = 'Leave';
    leave.style.cssText = 'background:#7f1d1d;color:#fff;border:0;border-radius:6px;padding:8px 14px;font-size:13px;';
    leave.onclick = () => endGroupCall(true);
    head.append(title, leave);
    const grid = document.createElement('div');
    grid.style.cssText = 'flex:1;display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;align-content:start;overflow:auto;';
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:8px;justify-content:center;margin-top:10px;';
    const mic = document.createElement('button');
    mic.textContent = '🎙️ Mic On';
    const cam = document.createElement('button');
    cam.textContent = '📹 Cam On';
    [mic, cam].forEach(b => { b.style.cssText = 'background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:6px;padding:9px 12px;font-size:12px;'; });
    mic.onclick = () => {
      if (!group.localStream) return;
      const on = group.localStream.getAudioTracks().some(t => t.enabled);
      group.localStream.getAudioTracks().forEach(t => { t.enabled = !on; });
      mic.textContent = on ? '🎙️ Mic Off' : '🎙️ Mic On';
    };
    cam.onclick = () => {
      if (!group.localStream) return;
      const vids = group.localStream.getVideoTracks();
      if (!vids.length) { cam.textContent = '📹 No camera'; return; }
      const on = vids.some(t => t.enabled);
      vids.forEach(t => { t.enabled = !on; });
      cam.textContent = on ? '📹 Cam Off' : '📹 Cam On';
    };
    controls.append(mic, cam);
    root.append(head, grid, controls);
    document.body.appendChild(root);
    group.ui = { root, grid, title, mic, cam, tiles: new Map() };
    return group.ui;
  }

  function groupTile(key) {
    const ui = groupUi();
    let t = ui.tiles.get(key);
    if (t) return t;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;background:#111827;border:1px solid #1f2937;border-radius:8px;overflow:hidden;min-height:120px;display:flex;align-items:center;justify-content:center;';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.style.cssText = 'width:100%;height:100%;object-fit:cover;background:#000;display:none;';
    const label = document.createElement('div');
    label.style.cssText = 'position:absolute;left:6px;bottom:5px;font-family:monospace;font-size:10px;background:rgba(0,0,0,.6);color:#e5e7eb;padding:2px 6px;border-radius:4px;';
    label.textContent = key === myGroupKey() ? 'You' : nameFor(key);
    wrap.append(video, label);
    ui.grid.appendChild(wrap);
    t = { wrap, video, label };
    ui.tiles.set(key, t);
    return t;
  }

  function groupRefreshUi() {
    const ui = group.ui;
    if (!ui) return;
    ui.title.textContent = `Group call · ${group.members.length || 1}/${GROUP_MAX}`;
    ui.root.style.display = group.active ? 'flex' : 'none';
  }

  function groupPeer(key) {
    let p = group.peers.get(key);
    if (!p) { p = { key, pc: null, pendingIce: [] }; group.peers.set(key, p); }
    return p;
  }

  function groupDropPeer(key) {
    const p = group.peers.get(key);
    if (p && p.pc) { try { p.pc.onconnectionstatechange = null; p.pc.close(); } catch (e) { /* already gone */ } }
    group.peers.delete(key);
    const ui = group.ui;
    if (ui && ui.tiles.has(key)) {
      const t = ui.tiles.get(key);
      t.video.srcObject = null;
      t.wrap.remove();
      ui.tiles.delete(key);
    }
    groupRefreshUi();
  }

  function groupWirePeer(key, pc, p) {
    group.localStream.getTracks().forEach(track => pc.addTrack(track, group.localStream));
    pc.onicecandidate = e => {
      if (e.candidate) safeSend({ type: 'group-ice', groupId: group.id, targetKey: key, candidate: e.candidate, me: accountKey });
    };
    pc.ontrack = e => {
      if (!e.streams || !e.streams[0]) return;
      const t = groupTile(key);
      t.video.srcObject = e.streams[0];
      t.video.style.display = 'block';
      t.video.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (p.pc !== pc) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        logChat(`System: ${nameFor(key)} dropped out of the group call (network).`);
        groupDropPeer(key);
      }
    };
  }

  async function groupConnect(key) {
    if (!group.active || !group.localStream) return;
    const existing = group.peers.get(key);
    if (existing && existing.pc) return;
    const p = groupPeer(key);
    const pc = new RTCPeerConnection(await getRtcConfig());
    p.pc = pc;
    groupWirePeer(key, pc, p);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      safeSend({ type: 'group-offer', groupId: group.id, targetKey: key, offer: { type: 'offer', sdp: offer.sdp }, hasVideo: groupHasVideo(), me: accountKey });
    } catch (e) { groupDropPeer(key); }
  }

  async function groupAnswerOffer(key, offerSdp) {
    const p = groupPeer(key);
    if (p.pc) return;
    const pc = new RTCPeerConnection(await getRtcConfig());
    p.pc = pc;
    groupWirePeer(key, pc, p);
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
    for (const c of p.pendingIce.splice(0)) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { /* stale */ } }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    safeSend({ type: 'group-answer', groupId: group.id, targetKey: key, answer: { type: 'answer', sdp: answer.sdp }, me: accountKey });
  }

  function groupOnInvite(msg) {
    if (!msg.groupId || !Array.isArray(msg.members)) return;
    const hostKey = groupIdOf(msg);
    if (!hostKey || callState !== 'IDLE' || group.active) {
      if (hostKey) safeSend({ type: 'group-decline', groupId: msg.groupId, targetKey: hostKey, me: accountKey });
      return;
    }
    group.invite = { id: msg.groupId, host: hostKey, hasVideo: !!msg.hasVideo, members: msg.members.filter(m => typeof m === 'string').slice(0, GROUP_MAX) };
    groupShowInvite();
    notifyLocal('Incoming group call', 'ghost_calls');
    startRing();
    setTimeout(() => { if (group.invite && group.invite.id === msg.groupId) declineGroupInvite(); }, 45000);
  }

  function groupOnAccept(msg) {
    if (!group.active || msg.groupId !== group.id) return;
    const key = groupIdOf(msg);
    if (key && !group.members.some(m => m.toUpperCase() === key.toUpperCase()) && group.members.length < GROUP_MAX) group.members.push(key);
    groupBroadcastRoster();
    groupTile(key);
    groupRefreshUi();
    logChat(`System: ${nameFor(key)} joined the group call.`);
    if (groupInitiate(key)) groupConnect(key);
  }

  function groupOnDecline(msg) {
    if (!group.active || msg.groupId !== group.id) return;
    const key = groupIdOf(msg);
    group.members = group.members.filter(m => m.toUpperCase() !== key.toUpperCase());
    groupBroadcastRoster();
    groupRefreshUi();
    logChat(`System: ${nameFor(key)} declined the group call.`);
  }

  function groupBroadcastRoster() {
    const members = group.members.slice(0, GROUP_MAX);
    for (const m of members) {
      if (m.toUpperCase() === String(myGroupKey()).toUpperCase()) continue;
      safeSend({ type: 'group-roster', groupId: group.id, targetKey: m, members, me: accountKey });
    }
  }

  function groupOnRoster(msg) {
    if (!group.active || msg.groupId !== group.id || !Array.isArray(msg.members)) return;
    group.members = msg.members.filter(m => typeof m === 'string').slice(0, GROUP_MAX);
    groupRefreshUi();
    for (const m of group.members) {
      if (m.toUpperCase() === String(myGroupKey()).toUpperCase()) continue;
      if (!group.peers.has(m) && groupInitiate(m)) groupConnect(m);
    }
  }

  async function groupOnOffer(msg) {
    if (!group.active || msg.groupId !== group.id || !msg.offer || typeof msg.offer.sdp !== 'string') return;
    const key = groupIdOf(msg);
    if (!key) return;
    const p = group.peers.get(key);
    if (p && p.pc) return;                       // already connected; ignore a duplicate offer
    groupTile(key);
    groupRefreshUi();
    try { await groupAnswerOffer(key, msg.offer.sdp); }
    catch (e) { groupDropPeer(key); }
  }

  async function groupOnAnswer(msg) {
    if (!group.active || msg.groupId !== group.id || !msg.answer || typeof msg.answer.sdp !== 'string') return;
    const p = group.peers.get(groupIdOf(msg));
    if (!p || !p.pc || p.pc.remoteDescription) return;
    try {
      await p.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.answer.sdp }));
      for (const c of p.pendingIce.splice(0)) { try { await p.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { /* stale */ } }
    } catch (e) { groupDropPeer(p.key); }
  }

  async function groupOnIce(msg) {
    if (!group.active || msg.groupId !== group.id || !msg.candidate) return;
    const p = group.peers.get(groupIdOf(msg));
    if (!p) return;
    if (p.pc && p.pc.remoteDescription) { try { await p.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch (e) { /* stale */ } }
    else p.pendingIce.push(msg.candidate);
  }

  function groupOnEnd(msg) {
    if (group.invite && msg.groupId === group.invite.id) { group.invite = null; groupHideInvite(); stopRing(); return; }
    if (!group.active || msg.groupId !== group.id) return;
    const key = groupIdOf(msg);
    if (key.toUpperCase() === String(group.host).toUpperCase()) {
      logChat('System: The host ended the group call.');
      endGroupCall(false);
      return;
    }
    groupDropPeer(key);
    group.members = group.members.filter(m => m.toUpperCase() !== key.toUpperCase());
    groupRefreshUi();
    logChat(`System: ${nameFor(key)} left the group call.`);
  }

  function groupPeerOffline(targetKey) {
    if (!group.active) return;
    const key = String(targetKey || '').toUpperCase();
    const member = group.members.find(m => m.toUpperCase() === key || (contactKeyFor(m) || '').toUpperCase() === key);
    if (member) groupDropPeer(member);
  }

  let groupInviteBox = null;
  function groupShowInvite() {
    if (!group.invite) return;
    if (!groupInviteBox) {
      const box = document.createElement('div');
      box.id = 'gt-group-invite';
      box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147482500;background:#0f172a;border:1px solid #c5a059;border-radius:10px;padding:18px;width:min(86vw,320px);text-align:center;font-family:system-ui,sans-serif;color:#e5e7eb;box-shadow:0 10px 40px rgba(0,0,0,.6);display:none;';
      const text = document.createElement('div');
      text.id = 'gt-group-invite-text';
      text.style.cssText = 'font-size:14px;line-height:1.5;margin-bottom:14px;';
      const yes = document.createElement('button');
      yes.textContent = 'Join';
      yes.style.cssText = 'background:#065f46;color:#fff;border:0;border-radius:6px;padding:10px 18px;margin-right:8px;font-size:14px;';
      yes.onclick = joinGroupCall;
      const no = document.createElement('button');
      no.textContent = 'Decline';
      no.style.cssText = 'background:#374151;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:14px;';
      no.onclick = declineGroupInvite;
      box.append(text, yes, no);
      document.body.appendChild(box);
      groupInviteBox = box;
    }
    const inv = group.invite;
    groupInviteBox.querySelector('#gt-group-invite-text').textContent =
      `${nameFor(inv.host)} is starting a ${inv.hasVideo ? 'video' : 'audio'} group call (${inv.members.length} people).`;
    groupInviteBox.style.display = 'block';
  }
  function groupHideInvite() { if (groupInviteBox) groupInviteBox.style.display = 'none'; }

  function declineGroupInvite() {
    const inv = group.invite;
    group.invite = null;
    groupHideInvite();
    stopRing();
    if (inv) safeSend({ type: 'group-decline', groupId: inv.id, targetKey: inv.host, me: accountKey });
  }

  async function joinGroupCall() {
    const inv = group.invite;
    if (!inv) return;
    if (callState !== 'IDLE') { declineGroupInvite(); return; }
    group.invite = null;
    groupHideInvite();
    stopRing();
    const withVideo = inv.hasVideo && isPremiumUser;   // free members join with audio only
    try {
      group.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: withVideo ? { width: { ideal: 640 }, height: { ideal: 480 } } : false
      });
    } catch (e) {
      safeSend({ type: 'group-decline', groupId: inv.id, targetKey: inv.host, me: accountKey });
      alert('Microphone/Camera access required.');
      return;
    }
    group.active = true;
    group.id = inv.id;
    group.host = inv.host;
    group.wantVideo = withVideo;
    // Only the host and me for now; the host sends the full roster of people who actually joined.
    // (Connecting to invitees who never accepted would just produce failed peer connections.)
    group.members = [inv.host, myGroupKey()];
    groupTile(myGroupKey()).video.srcObject = group.localStream;
    if (withVideo) groupTile(myGroupKey()).video.style.display = 'block';
    groupRefreshUi();
    safeSend({ type: 'group-accept', groupId: inv.id, targetKey: inv.host, me: accountKey });
    logChat('System: Joined the group call.');
  }

  async function startGroupCall(keys, wantVideo) {
    if (!isPremiumUser) { openPaymentModal('Group calls are a Premium feature.'); return; }
    if (callState !== 'IDLE' || group.active) { alert('Another call is already in progress.'); return; }
    const invitees = (keys || []).slice(0, GROUP_MAX - 1);
    if (!invitees.length) { alert('Choose at least one contact.'); return; }
    try {
      group.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: wantVideo ? { width: { ideal: 640 }, height: { ideal: 480 } } : false
      });
    } catch (e) {
      alert('Microphone/Camera access required.');
      return;
    }
    group.active = true;
    group.id = randomHex(8);
    group.host = myGroupKey();
    group.wantVideo = !!wantVideo;
    group.members = [myGroupKey()];        // grows as each person accepts
    groupTile(myGroupKey()).video.srcObject = group.localStream;
    if (wantVideo) groupTile(myGroupKey()).video.style.display = 'block';
    groupRefreshUi();
    // The invite carries the intended line-up so the person sees who they would be joining.
    const lineUp = [myGroupKey(), ...invitees];
    for (const key of invitees) {
      safeSend({ type: 'group-invite', groupId: group.id, targetKey: key, members: lineUp, hasVideo: !!wantVideo, me: accountKey });
    }
    logChat('System: Group call started — waiting for people to join.');
  }

  function endGroupCall(notify = true) {
    if (!group.active) return;
    if (notify) {
      for (const key of group.peers.keys()) safeSend({ type: 'group-end', groupId: group.id, targetKey: key, me: accountKey });
    }
    for (const key of [...group.peers.keys()]) groupDropPeer(key);
    if (group.localStream) { group.localStream.getTracks().forEach(t => t.stop()); group.localStream = null; }
    group.active = false;
    group.id = '';
    group.host = '';
    group.members = [];
    group.wantVideo = false;
    const ui = group.ui;
    if (ui) { ui.grid.innerHTML = ''; ui.tiles.clear(); ui.root.style.display = 'none'; }
    logChat('System: Group call ended.');
  }

  function openGroupPicker() {
    if (!isPremiumUser) { openPaymentModal('Group calls are a Premium feature.'); return; }
    if (callState !== 'IDLE' || group.active) { alert('Another call is already in progress.'); return; }
    if (!ramContacts.length) { alert('Add a contact first.'); return; }
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147482500;background:#0f172a;border:1px solid #374151;border-radius:10px;padding:16px;width:min(90vw,340px);max-height:80vh;overflow:auto;font-family:system-ui,sans-serif;color:#e5e7eb;box-shadow:0 10px 40px rgba(0,0,0,.6);';
    const head = document.createElement('div');
    head.textContent = 'Start a group call';
    head.style.cssText = 'font-family:monospace;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#c5a059;margin-bottom:8px;';
    const hint = document.createElement('div');
    hint.textContent = `Choose up to ${GROUP_MAX - 1} contacts. You are the host.`;
    hint.style.cssText = 'font-size:11px;color:#9ca3af;margin-bottom:10px;';
    box.append(head, hint);
    const chosen = new Set();
    ramContacts.forEach(c => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 0;font-size:13px;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.onchange = () => {
        if (cb.checked) { if (chosen.size >= GROUP_MAX - 1) { cb.checked = false; return; } chosen.add(c.key); }
        else chosen.delete(c.key);
      };
      const name = document.createElement('span');
      name.textContent = c.name;
      row.append(cb, name);
      box.appendChild(row);
    });
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-top:14px;';
    const audio = document.createElement('button');
    audio.textContent = '🎙️ Audio';
    const video = document.createElement('button');
    video.textContent = '📹 Video';
    [audio, video].forEach(b => { b.style.cssText = 'flex:1;background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:6px;padding:10px;font-size:13px;'; });
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'background:#374151;color:#fff;border:0;border-radius:6px;padding:10px 14px;font-size:13px;';
    cancel.onclick = () => box.remove();
    const go = wantVideo => {
      if (!chosen.size) { alert('Choose at least one contact.'); return; }
      box.remove();
      startGroupCall([...chosen], wantVideo);
    };
    audio.onclick = () => go(false);
    video.onclick = () => go(true);
    actions.append(audio, video, cancel);
    box.appendChild(actions);
    document.body.appendChild(box);
  }

  {
    const btnGroupCall = document.createElement('button');
    btnGroupCall.id = 'btn-group-call';
    btnGroupCall.className = 'tier-badge';
    btnGroupCall.title = 'Group call (Premium)';
    btnGroupCall.textContent = '👥 Group';
    const row = (btnCallVideo && btnCallVideo.parentElement) || (btnCallAudio && btnCallAudio.parentElement);
    if (row) row.appendChild(btnGroupCall);
    else {
      btnGroupCall.style.cssText = 'position:fixed;right:12px;bottom:78px;z-index:9998;background:#111827;color:#c5a059;border:1px solid #374151;border-radius:999px;padding:9px 14px;font-size:12px;';
      document.body.appendChild(btnGroupCall);
    }
    btnGroupCall.onclick = openGroupPicker;
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
    stopTyping();
    probeEnabled = true;
    btnSend.disabled = true;
    try {
      const id = randomHex(4);
      const header = { t: 'chat', text, id };
      if (!(await e2e.ensure(target, 8000, { wake: 'msg' }))) {
        if (isWaiting(target)) {            // silent alert sent: keep the message here and deliver it when they open the app
          addTick(logChat(`Me: ${text}`), id, target, { header }, true);
          noteAlertSent(target, 1);
          return;
        }
        logChat('System: Could not open a secure channel. Is the contact online?');
        chatInput.value = text;
        markOffline(target);
        return;
      }
      await sendSecure(target, header, undefined, 'msg');
      addTick(logChat(`Me: ${text}`), id, target, { header });
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
    // Choosing a file only opens a preview; nothing is sent until you press Send.
    fileInput.onchange = e => {
      const file = e.target.files && e.target.files[0];
      handlePickedFile(file);
      fileInput.value = '';
    };
  }
  chatInput.addEventListener('paste', e => {
    const f = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0];
    if (f && f.type && f.type.startsWith('image/')) { e.preventDefault(); handlePickedFile(f); }
  });
  {
    const dropZone = chatBox.parentElement || chatBox;
    dropZone.addEventListener('dragover', e => e.preventDefault());
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handlePickedFile(f);
    });
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
    probeEnabled = true;
    renderContacts();
    probeContact(key);          // finds out right away whether they are online
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
      const typingTxt = isTyping(c.key) ? ' <span class="ptyping">typing…</span>' : '';
      infoDiv.innerHTML = `<div class="name"><span class="pdot${isOnline(c.key) ? ' on' : ''}"></span>${escapeHTML(c.name)}${typingTxt}${badge}</div><div class="key">${escapeHTML(c.key)}</div>`;
      infoDiv.onclick = () => selectContact(c.key);

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
          presence.delete(c.key);
          ramContacts.splice(idx, 1);
          if (activeCallTarget === c.key) { stopTyping(); activeCallTarget = ''; }
          renderContacts();
          updatePresenceUI();
        }
      };
      dotBtn.onclick = e => {
        e.stopPropagation();
        document.querySelectorAll('.dropdown-menu').forEach(m => { if (m !== dropdownMenu) m.classList.remove('show'); });
        dropdownMenu.classList.toggle('show');
      };

      const blockItem = document.createElement('button');
      blockItem.className = 'dropdown-item';
      blockItem.textContent = '🚫 Block';
      blockItem.onclick = e => {
        e.stopPropagation();
        dropdownMenu.classList.remove('show');
        if (!confirm(`Block ${c.name}? They will no longer be able to message, call or alert you.`)) return;
        safeSend({ type: 'block', targetKey: c.key });
        e2e.drop(c.key);
        unread.delete(c.key);
        presence.delete(c.key);
        const i = ramContacts.findIndex(x => x.key === c.key);
        if (i >= 0) ramContacts.splice(i, 1);
        if (activeCallTarget === c.key) { stopTyping(); activeCallTarget = ''; }
        renderContacts();
        updatePresenceUI();
      };
      dropdownMenu.append(renameItem, blockItem, deleteItem);
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
    presence.clear(); outgoing.clear(); lastDecryptWarn.clear(); waitingFor.clear(); pendingCall = null; stopRing();
    renderContacts();
    updatePresenceUI();
    logChat('System: Contacts, chat and encryption keys erased from memory.');
  };

  renderContacts();
  updatePresenceUI();
  initWebSocket();
});