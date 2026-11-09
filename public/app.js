import { FrameCrypto } from './e2ee.js';
import { SecurityGuard } from './security.js';

document.addEventListener('DOMContentLoaded', () => {
  const myIdentityInput = document.getElementById('my-identity');
  const statusBar = document.getElementById('status-bar');
  const tierBadge = document.getElementById('tier-badge');
  const premiumCustomKeyBox = document.getElementById('premium-custom-key-box');
  const customKeyInput = document.getElementById('custom-key-input');
  const btnSaveCustomKey = document.getElementById('btn-save-custom-key');

  const contactNameInput = document.getElementById('contact-name');
  const contactKeyInput = document.getElementById('contact-key');
  const btnAddContact = document.getElementById('btn-add-contact');
  const contactsListContainer = document.getElementById('contacts-list-container');
  
  const btnChat = document.getElementById('btn-chat');
  const btnCallAudio = document.getElementById('btn-call-audio');
  const btnCallVideo = document.getElementById('btn-call-video');
  const btnEndSession = document.getElementById('btn-end-session');
  
  const videoContainer = document.getElementById('video-container');
  const localVideo = document.getElementById('local-video');
  const remoteVideo = document.getElementById('remote-video');
  const remoteAudio = document.getElementById('remote-audio');
  
  const callControls = document.getElementById('call-controls');
  const btnToggleMic = document.getElementById('btn-toggle-mic');
  const btnToggleCam = document.getElementById('btn-toggle-cam');
  
  const chatBox = document.getElementById('chat-box');
  const chatInput = document.getElementById('chat-input');
  const btnSend = document.getElementById('btn-send');
  const btnAttach = document.getElementById('btn-attach');
  const fileInput = document.getElementById('file-input');
  const btnWipe = document.getElementById('btn-wipe');

  const callModal = document.getElementById('call-modal');
  const callerIdText = document.getElementById('caller-id-text');
  const btnAccept = document.getElementById('btn-accept');
  const btnDecline = document.getElementById('btn-decline');

  const btnShowQr = document.getElementById('btn-show-qr');
  const btnScanQr = document.getElementById('btn-scan-qr');
  const qrModal = document.getElementById('qr-modal');
  const qrModalTitle = document.getElementById('qr-modal-title');
  const qrDisplayContainer = document.getElementById('qr-display-container');
  const qrScannerContainer = document.getElementById('qr-scanner-container');
  const btnCloseQr = document.getElementById('btn-close-qr');
  const qrcodeDiv = document.getElementById('qrcode');
  const qrVideo = document.getElementById('qr-video');
  const qrCanvas = document.getElementById('qr-canvas');
  const btnUploadQrImg = document.getElementById('btn-upload-qr-img');
  const qrFileInput = document.getElementById('qr-file-input');

  const paymentModal = document.getElementById('payment-modal');
  const btnStartCheckout = document.getElementById('btn-start-checkout');
  const btnClosePaymentModal = document.getElementById('btn-close-payment-modal');
  const modalDisplayPrice = document.getElementById('modal-display-price');

  let socket = null;
  let myIdentity = '';
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
  
  let callState = 'IDLE';
  let pendingSocketQueue = [];

  const security = new SecurityGuard();
  const frameCrypto = new FrameCrypto();

  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  // --- DYNAMIC API BASE & WEBSOCKET CONFIG ---
  const isLocalBrowser = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port === '8158';
  const apiBase = isLocalBrowser ? 'http://127.0.0.1:8158' : 'https://ghost-talk-backend.onrender.com';
  const socketUrl = isLocalBrowser ? 'ws://127.0.0.1:8158' : 'wss://ghost-talk-backend.onrender.com';

  // --- OLD MONEY MATTE DARK & GOLD THEME ---
  const styleInject = document.createElement('style');
  styleInject.innerHTML = `
    :root {
      --bg-deep: #0e1110;
      --bg-card: #141817;
      --accent-gold: #c5a059;
      --accent-gold-hover: #d4af37;
      --text-main: #e2e8f0;
      --text-muted: #8892b0;
      --border-subtle: #232d2a;
    }
    body { background-color: var(--bg-deep) !important; color: var(--text-main) !important; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important; }
    .contact-card { transition: all 0.2s ease; position: relative; }
    .contact-card.selected { border-color: var(--accent-gold) !important; background: #1a2220 !important; box-shadow: inset 0 0 0 1px var(--accent-gold); }
    button, .btn { background: #1a2220 !important; color: var(--accent-gold) !important; border: 1px solid var(--accent-gold) !important; border-radius: 4px !important; transition: all 0.3s ease; }
    button:hover { background: var(--accent-gold) !important; color: #000 !important; }
    #tier-badge { background: #1a2220 !important; color: var(--accent-gold) !important; border: 1px solid var(--accent-gold) !important; font-weight: 600; letter-spacing: 1px; }
    input, select, textarea { background: #0b0e0d !important; color: var(--text-main) !important; border: 1px solid #232d2a !important; border-radius: 4px !important; }
    input:focus { border-color: var(--accent-gold) !important; outline: none !important; }
    
    .menu-container { position: relative; display: inline-block; }
    .dot-btn { background: transparent !important; border: none !important; color: var(--text-muted) !important; font-size: 16px; cursor: pointer; padding: 4px 8px; }
    .dot-btn:hover { color: var(--accent-gold) !important; background: transparent !important; }
    .dropdown-menu { display: none; position: absolute; right: 0; top: 24px; background: #141817; border: 1px solid var(--border-subtle); border-radius: 4px; z-index: 50; min-width: 100px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
    .dropdown-menu.show { display: block; }
    .dropdown-item { padding: 6px 12px; font-size: 12px; color: var(--text-main); cursor: pointer; text-align: left; width: 100%; background: transparent; border: none; }
    .dropdown-item:hover { background: #1a2220; color: var(--accent-gold); }
  `;
  document.head.appendChild(styleInject);

  let savedKey = localStorage.getItem('ghost_identity');
  if (!savedKey) {
    savedKey = 'GHOST-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    localStorage.setItem('ghost_identity', savedKey);
  }
  myIdentity = savedKey;
  if (myIdentityInput) myIdentityInput.value = myIdentity;

  let cachedTier = localStorage.getItem('ghost_tier');
  let cachedExpiry = localStorage.getItem('ghost_tier_expiry');

  if (cachedTier === 'PREMIUM') {
    if (cachedExpiry && Date.now() >= parseInt(cachedExpiry)) {
      isPremiumUser = false;
      applyUIPremiumState(false);
      localStorage.removeItem('ghost_tier');
      localStorage.removeItem('ghost_tier_expiry');
    } else {
      isPremiumUser = true;
      applyUIPremiumState(true);
    }
  } else {
    isPremiumUser = false;
    applyUIPremiumState(false);
  }

  function applyUIPremiumState(premium, expiresAt = null) {
    isPremiumUser = premium;
    if (premium) {
      localStorage.setItem('ghost_tier', 'PREMIUM');
      if (expiresAt) localStorage.setItem('ghost_tier_expiry', expiresAt);
      else if (!localStorage.getItem('ghost_tier_expiry')) {
        localStorage.setItem('ghost_tier_expiry', Date.now() + (30 * 24 * 60 * 60 * 1000));
      }
      if (tierBadge) {
        tierBadge.innerText = 'PREMIUM TIER';
        tierBadge.style.background = '#1a2220';
        tierBadge.style.color = '#c5a059';
        tierBadge.style.borderColor = '#c5a059';
      }
      if (premiumCustomKeyBox) premiumCustomKeyBox.style.display = 'block';
    } else {
      localStorage.removeItem('ghost_tier');
      localStorage.removeItem('ghost_tier_expiry');
      if (tierBadge) {
        tierBadge.innerText = 'FREE TIER';
        tierBadge.style.background = 'transparent';
        tierBadge.style.color = '#8892b0';
        tierBadge.style.borderColor = '#232d2a';
      }
      if (premiumCustomKeyBox) premiumCustomKeyBox.style.display = 'none';
    }
  }

  function logChat(msg) {
    if (!chatBox) return;
    const div = document.createElement('div');
    div.innerText = msg;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function logFileReceived(senderKey, fileName, fileData, fileType) {
    if (!chatBox) return;
    const div = document.createElement('div');
    div.style.margin = '6px 0';
    const shortKey = senderKey ? senderKey.substring(0, 8) : 'Peer';
    const safeName = escapeHTML(fileName);
    if (fileType && fileType.startsWith('image/')) {
      div.innerHTML = `<strong>${shortKey} [Image]:</strong> ${safeName}<br><img src="${fileData}" style="max-width: 150px; border-radius: 4px; margin-top: 4px;">`;
    } else {
      div.innerHTML = `<strong>${shortKey} [File]:</strong> <a href="${fileData}" download="${safeName}" style="color: #c5a059; text-decoration: underline;">📁 Download ${safeName}</a>`;
    }
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function ensureContact(key, defaultName = 'Peer') {
    if (!key) return;
    const upperKey = key.toUpperCase();
    if (!ramContacts.some(c => c.key === upperKey)) {
      ramContacts.push({ name: defaultName, key: upperKey });
      renderContacts();
    }
  }

  function isValidContact(key) {
    return ramContacts.some(c => c.key === key);
  }

  function safeSend(dataObj) {
    const jsonStr = JSON.stringify(dataObj);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(jsonStr);
    } else {
      pendingSocketQueue.push(jsonStr);
    }
  }

  function flushSocketQueue() {
    while (pendingSocketQueue.length > 0 && socket && socket.readyState === WebSocket.OPEN) {
      const msg = pendingSocketQueue.shift();
      socket.send(msg);
    }
  }

  function initWebSocket() {
    socket = new WebSocket(socketUrl);

    socket.onopen = () => {
      statusBar.innerText = 'STATUS: ONLINE | SECURED';
      statusBar.classList.remove('offline');
      reconnectAttempts = 0;
      
      const currentCachedTier = localStorage.getItem('ghost_tier') || 'FREE';
      const currentCachedExpiry = localStorage.getItem('ghost_tier_expiry') || '';

      socket.send(JSON.stringify({ 
        type: 'register', 
        key: myIdentity, 
        claimedTier: currentCachedTier,
        claimedExpiry: currentCachedExpiry
      }));

      flushSocketQueue();
    };

    socket.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleSignalingMessage(msg);
      } catch (e) {}
    };

    socket.onclose = () => {
      statusBar.innerText = 'STATUS: OFFLINE | RECONNECTING...';
      statusBar.classList.add('offline');
      const timeout = Math.min(10000, 1000 * Math.pow(1.5, reconnectAttempts));
      reconnectAttempts++;
      setTimeout(initWebSocket, timeout);
    };

    socket.onerror = () => { socket.close(); };
  }

  async function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'registered':
        logChat('System: Registered on secure mesh.');
        if (msg.tier === 'PREMIUM') applyUIPremiumState(true, msg.expiresAt);
        break;
      case 'tier-updated':
        applyUIPremiumState(msg.tier === 'PREMIUM', msg.expiresAt);
        logChat(`System: Tier updated to ${msg.tier}.`);
        break;
      case 'custom-key-success':
        myIdentity = msg.customKey.startsWith('GHOST-') ? msg.customKey : `GHOST-${msg.customKey}`;
        localStorage.setItem('ghost_identity', myIdentity);
        if (myIdentityInput) myIdentityInput.value = myIdentity;

        alert(`✅ Custom Handle Set: ${myIdentity}`);
        if (customKeyInput) customKeyInput.value = '';

        initWebSocket();
        break;
      case 'text-notify':
        ensureContact(msg.senderKey, 'Peer');
        activeCallTarget = msg.senderKey;
        renderContacts();
        break;
      case 'offer':
        if (peerConnection || callState !== 'IDLE') {
          safeSend({ type: 'decline', targetKey: msg.senderKey });
          return;
        }
        ensureContact(msg.senderKey, 'Caller');
        activeCallTarget = msg.senderKey;
        renderContacts();
        if (callerIdText) callerIdText.innerText = `Secure Call from ${msg.senderKey} (${msg.hasVideo ? 'Video' : 'Audio'})`;
        if (callModal) callModal.style.display = 'flex';

        btnAccept.onclick = async () => {
          callModal.style.display = 'none';
          try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: msg.hasVideo });
          } catch (err) {
            alert('Media permission required.');
            return;
          }
          await setupWebRTC(msg.hasVideo);
          await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.offer));
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          safeSend({ type: 'answer', targetKey: activeCallTarget, answer });
          callState = 'CONNECTED';
          logChat('System: Call connected.');
        };

        btnDecline.onclick = () => {
          callModal.style.display = 'none';
          safeSend({ type: 'decline', targetKey: msg.senderKey });
          activeCallTarget = '';
          callState = 'IDLE';
          renderContacts();
        };
        break;
      case 'answer':
        if (peerConnection) {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.answer));
          callState = 'CONNECTED';
          logChat('System: Secure stream established.');
        }
        break;
      case 'ice-candidate':
        if (peerConnection && msg.candidate) {
          try { await peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch (e) {}
        }
        break;
      case 'chat':
        ensureContact(msg.senderKey, 'Peer');
        activeCallTarget = msg.senderKey;
        renderContacts();
        logChat(`${msg.senderKey.substring(0, 8)}: ${escapeHTML(msg.text)}`);
        break;
      case 'file-transfer':
        ensureContact(msg.senderKey, 'Peer');
        activeCallTarget = msg.senderKey;
        renderContacts();
        logFileReceived(msg.senderKey, msg.fileName, msg.fileData, msg.fileType);
        break;
      case 'decline':
        alert('Call rejected.');
        endCall(false);
        break;
      case 'end-session':
        if (callModal) callModal.style.display = 'none';
        logChat('System: Session terminated.');
        endCall(false);
        break;
    }
  }

  async function startCall(wantVideo) {
    if (callState !== 'IDLE') {
      alert('Call already in progress.');
      return;
    }
    if (!activeCallTarget || !isValidContact(activeCallTarget)) {
      alert('Select a valid contact first.');
      return;
    }
    if (wantVideo && !isPremiumUser) {
      alert('Video calls require Premium Tier.');
      return;
    }

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: wantVideo ? { width: { ideal: 640 }, height: { ideal: 480 } } : false
      });
    } catch (err) {
      alert('Microphone/Camera access required.');
      return;
    }

    callState = 'CALLING';
    await setupWebRTC(wantVideo);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    safeSend({
      type: 'offer',
      targetKey: activeCallTarget,
      offer,
      hasVideo: wantVideo
    });

    logChat(`System: Calling ${activeCallTarget} ...`);
  }

  async function setupWebRTC(wantVideo) {
    if (peerConnection) peerConnection.close();

    peerConnection = new RTCPeerConnection(rtcConfig);

    peerConnection.onicecandidate = (e) => {
      if (e.candidate && activeCallTarget) {
        safeSend({ type: 'ice-candidate', targetKey: activeCallTarget, candidate: e.candidate });
      }
    };

    peerConnection.ontrack = (e) => {
      if (e.streams && e.streams[0]) {
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

  function endCall(notifyPeer = true) {
    if (notifyPeer && activeCallTarget) {
      safeSend({ type: 'end-session', targetKey: activeCallTarget });
    }
    if (callModal) callModal.style.display = 'none';

    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;
    if (remoteAudio) remoteAudio.srcObject = null;

    videoContainer.style.display = 'none';
    callControls.style.display = 'none';
    chatBox.innerHTML = '';
    chatInput.value = '';

    callState = 'IDLE';
    micMuted = false;
    camOff = false;
    if (btnToggleMic) btnToggleMic.innerText = '🎙️ Mic On';
    if (btnToggleCam) btnToggleCam.innerText = '📹 Cam On';
    logChat('System: Call ended. RAM cleared.');
  }

  btnCallAudio.onclick = () => startCall(false);
  btnCallVideo.onclick = () => startCall(true);
  btnEndSession.onclick = () => endCall(true);

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

  btnChat.onclick = () => {
    if (!activeCallTarget || !isValidContact(activeCallTarget)) { alert('Select a contact.'); return; }
    safeSend({ type: 'text-notify', targetKey: activeCallTarget });
    logChat(`System: Chat session ready.`);
  };

  btnSend.onclick = () => {
    const text = chatInput.value.trim();
    if (!text || !activeCallTarget || !isValidContact(activeCallTarget)) return;
    safeSend({ type: 'chat', targetKey: activeCallTarget, text });
    logChat(`Me: ${escapeHTML(text)}`);
    chatInput.value = '';
  };

  chatInput.onkeypress = (e) => { if (e.key === 'Enter') btnSend.click(); };

  if (btnAttach && fileInput) {
    btnAttach.onclick = () => {
      if (!isPremiumUser) { alert('Premium Feature required.'); return; }
      if (!activeCallTarget) { alert('Select contact first.'); return; }
      fileInput.click();
    };

    fileInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        alert('⚠️ File size exceeds 5MB RAM ceiling.');
        fileInput.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = (evt) => {
        safeSend({
          type: 'file-transfer', targetKey: activeCallTarget,
          fileName: file.name, fileType: file.type, fileData: evt.target.result
        });
        logChat(`Me [File]: ${escapeHTML(file.name)}`);
        fileInput.value = '';
      };
      reader.readAsDataURL(file);
    };
  }

  btnAddContact.onclick = () => {
    const name = contactNameInput.value.trim();
    let key = contactKeyInput.value.trim().toUpperCase();
    if (!name || !key) { alert('Enter Name and Key.'); return; }
    if (!key.startsWith('GHOST-')) key = 'GHOST-' + key;
    ramContacts.push({ name, key });
    contactNameInput.value = '';
    contactKeyInput.value = '';
    renderContacts();
  };

  function renderContacts() {
    contactsListContainer.innerHTML = '';
    if (ramContacts.length === 0) {
      contactsListContainer.innerHTML = '<div style="font-size: 11px; color: var(--text-muted); padding: 8px; text-align: center;">No active contacts.</div>';
      return;
    }

    ramContacts.forEach((c, idx) => {
      const isSelected = activeCallTarget === c.key;
      const card = document.createElement('div');
      card.className = `contact-card ${isSelected ? 'selected' : ''}`;
      card.style.display = 'flex';
      card.style.alignItems = 'center';
      card.style.justifyContent = 'space-between';
      card.style.padding = '8px';
      card.style.marginBottom = '6px';
      card.style.background = isSelected ? '#1a2220' : '#141817';
      card.style.borderRadius = '4px';
      card.style.border = isSelected ? '1px solid var(--accent-gold)' : '1px solid #232d2a';
      
      const infoDiv = document.createElement('div');
      infoDiv.style.flexGrow = '1';
      infoDiv.style.cursor = 'pointer';
      infoDiv.innerHTML = `<div style="font-weight:600; color:#e2e8f0;">${escapeHTML(c.name)}</div><div style="font-size:11px; color:#8892b0;">${escapeHTML(c.key)}</div>`;
      
      infoDiv.onclick = () => {
        activeCallTarget = c.key;
        renderContacts();
      };

      const menuContainer = document.createElement('div');
      menuContainer.className = 'menu-container';

      const dotBtn = document.createElement('button');
      dotBtn.className = 'dot-btn';
      dotBtn.innerText = '⋮';
      dotBtn.title = 'Options';

      const dropdownMenu = document.createElement('div');
      dropdownMenu.className = 'dropdown-menu';

      const renameItem = document.createElement('button');
      renameItem.className = 'dropdown-item';
      renameItem.innerText = '✏️ Rename';
      renameItem.onclick = (e) => {
        e.stopPropagation();
        dropdownMenu.classList.remove('show');
        const newName = prompt(`Rename contact ${c.key}:`, c.name);
        if (newName && newName.trim().length > 0) {
          ramContacts[idx].name = newName.trim().substring(0, 16);
          renderContacts();
        }
      };

      const deleteItem = document.createElement('button');
      deleteItem.className = 'dropdown-item';
      deleteItem.innerText = '🗑️ Delete';
      deleteItem.onclick = (e) => {
        e.stopPropagation();
        dropdownMenu.classList.remove('show');
        if (confirm(`Delete contact ${c.name}?`)) {
          ramContacts.splice(idx, 1);
          if (activeCallTarget === c.key) activeCallTarget = '';
          renderContacts();
        }
      };

      dotBtn.onclick = (e) => {
        e.stopPropagation();
        document.querySelectorAll('.dropdown-menu').forEach(m => { if (m !== dropdownMenu) m.classList.remove('show'); });
        dropdownMenu.classList.toggle('show');
      };

      dropdownMenu.appendChild(renameItem);
      dropdownMenu.appendChild(deleteItem);
      menuContainer.appendChild(dotBtn);
      menuContainer.appendChild(dropdownMenu);

      card.appendChild(infoDiv);
      card.appendChild(menuContainer);
      contactsListContainer.appendChild(card);
    });
  }

  document.addEventListener('click', () => {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
  });

  tierBadge.onclick = async () => {
    if (isPremiumUser) { alert('✨ Premium active.'); return; }
    try {
      const res = await fetch(`${apiBase}/api/payment-info`);
      const data = await res.json();
      if (modalDisplayPrice) modalDisplayPrice.innerText = `$${data.pricing.monthly}`;
    } catch (e) {}
    if (paymentModal) paymentModal.style.display = 'flex';
  };

  if (btnClosePaymentModal) btnClosePaymentModal.onclick = () => { if (paymentModal) paymentModal.style.display = 'none'; };

  if (btnStartCheckout) {
    btnStartCheckout.onclick = async () => {
      btnStartCheckout.innerText = 'Initializing...';
      btnStartCheckout.disabled = true;
      try {
        const response = await fetch(`${apiBase}/api/create-payment`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userKey: myIdentity, planType: 'monthly' })
        });
        const data = await response.json();
        if (data.success && data.invoiceUrl) {
          if (paymentModal) paymentModal.style.display = 'none';
          window.open(data.invoiceUrl, '_blank');
        } else { alert('Gateway Error.'); }
      } catch (err) { alert('Connection error.'); }
      finally { btnStartCheckout.innerText = 'Proceed to Secure Checkout'; btnStartCheckout.disabled = false; }
    };
  }

  if (btnSaveCustomKey) {
    btnSaveCustomKey.onclick = () => {
      if (!isPremiumUser) return;
      const desiredKey = customKeyInput.value.trim().toUpperCase();
      if (!desiredKey || desiredKey.length < 3) { alert('Invalid key.'); return; }
      safeSend({ type: 'set-custom-key', customKey: desiredKey });
    };
  }

  if (btnShowQr) {
    btnShowQr.onclick = () => {
      if (!myIdentity) return;
      if (qrModalTitle) qrModalTitle.innerText = 'My Identity QR';
      if (qrDisplayContainer) qrDisplayContainer.style.display = 'inline-block';
      if (qrScannerContainer) qrScannerContainer.style.display = 'none';
      if (qrcodeDiv) {
        qrcodeDiv.innerHTML = '';
        if (window.QRCode) {
          new QRCode(qrcodeDiv, { text: myIdentity.toUpperCase(), width: 180, height: 180, colorDark: '#000', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.H });
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
        qrCameraStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } }
        });
        if (qrVideo) {
          qrVideo.srcObject = qrCameraStream;
          qrVideo.setAttribute('playsinline', true);
          await qrVideo.play();
        }
        requestAnimationFrame(scanQrFrame);
      } catch (err) {
        alert('❌ Camera unavailable or permissions denied.');
        closeQrModal();
      }
    };
  }

  function scanQrFrame() {
    if (!qrCameraStream || !qrVideo || qrVideo.readyState !== qrVideo.HAVE_ENOUGH_DATA) {
      qrScanAnimation = requestAnimationFrame(scanQrFrame);
      return;
    }

    if (!qrCanvas) return;
    const ctx = qrCanvas.getContext('2d');
    qrCanvas.width = qrVideo.videoWidth;
    qrCanvas.height = qrVideo.videoHeight;
    ctx.drawImage(qrVideo, 0, 0, qrCanvas.width, qrCanvas.height);

    const imageData = ctx.getImageData(0, 0, qrCanvas.width, qrCanvas.height);
    if (window.jsQR) {
      const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        let scannedKey = code.data.trim().toUpperCase();
        if (!scannedKey.startsWith('GHOST-')) scannedKey = 'GHOST-' + scannedKey;
        if (contactKeyInput) contactKeyInput.value = scannedKey;
        closeQrModal();
        alert(`✅ Scanned Key: ${scannedKey}`);
        return;
      }
    }
    qrScanAnimation = requestAnimationFrame(scanQrFrame);
  }

  if (btnUploadQrImg && qrFileInput) {
    btnUploadQrImg.onclick = () => qrFileInput.click();
    qrFileInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          canvas.width = img.width;
          canvas.height = img.height;
          ctx.drawImage(img, 0, 0);
          const imageData = ctx.getImageData(0, 0, img.width, img.height);
          if (window.jsQR) {
            const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
            if (code && code.data) {
              let scannedKey = code.data.trim().toUpperCase();
              if (!scannedKey.startsWith('GHOST-')) scannedKey = 'GHOST-' + scannedKey;
              if (contactKeyInput) contactKeyInput.value = scannedKey;
              closeQrModal();
              alert(`✅ Scanned Key: ${scannedKey}`);
            } else {
              alert('❌ No valid QR code detected in image.');
            }
          }
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

  btnWipe.onclick = () => {
    endCall(true);
    ramContacts = [];
    activeCallTarget = '';
    renderContacts();
    logChat('System: Complete RAM state erased.');
  };

  function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
  }

  renderContacts();
  initWebSocket();
});