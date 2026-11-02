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
  
  const chatBox = document.getElementById('chat-box');
  const chatInput = document.getElementById('chat-input');
  const btnSend = document.getElementById('btn-send');
  const btnWipe = document.getElementById('btn-wipe');

  const callModal = document.getElementById('call-modal');
  const callerIdText = document.getElementById('caller-id-text');
  const btnAccept = document.getElementById('btn-accept');
  const btnDecline = document.getElementById('btn-decline');

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
  let ramContacts = [];
  let reconnectAttempts = 0;
  let callState = 'IDLE';
  let pendingSocketQueue = [];

  let savedKey = localStorage.getItem('ghost_identity');
  if (!savedKey) {
    savedKey = 'GHOST-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    localStorage.setItem('ghost_identity', savedKey);
  }
  myIdentity = savedKey;
  if (myIdentityInput) myIdentityInput.value = myIdentity;

  function applyUIPremiumState(premium, expiresAt = null) {
    isPremiumUser = premium;
    if (premium) {
      localStorage.setItem('ghost_tier', 'PREMIUM');
      if (expiresAt) localStorage.setItem('ghost_tier_expiry', expiresAt);
      if (tierBadge) tierBadge.innerText = 'PREMIUM TIER';
      if (premiumCustomKeyBox) premiumCustomKeyBox.style.display = 'block';
    } else {
      localStorage.removeItem('ghost_tier');
      localStorage.removeItem('ghost_tier_expiry');
      if (tierBadge) tierBadge.innerText = 'FREE TIER';
      if (premiumCustomKeyBox) premiumCustomKeyBox.style.display = 'none';
    }
  }

  const cachedTier = localStorage.getItem('ghost_tier');
  if (cachedTier === 'PREMIUM') applyUIPremiumState(true);

  function logChat(msg) {
    if (!chatBox) return;
    const div = document.createElement('div');
    div.innerText = msg;
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
    const hostname = window.location.hostname;
    const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '';
    const socketHost = isLocal ? '127.0.0.1:8158' : 'ghost-talk-backend.onrender.com';
    const socketUrl = `wss://${socketHost}`;

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
        applyUIPremiumState(msg.tier === 'PREMIUM', msg.expiresAt);
        break;
      case 'tier-updated':
        applyUIPremiumState(msg.tier === 'PREMIUM', msg.expiresAt);
        logChat(`System: Tier updated to ${msg.tier}.`);
        break;
      case 'custom-key-success':
        myIdentity = msg.customKey.startsWith('GHOST-') ? msg.customKey : `GHOST-${msg.customKey}`;
        localStorage.setItem('ghost_identity', myIdentity);
        if (myIdentityInput) myIdentityInput.value = myIdentity;
        
        safeSend({
          type: 'register',
          key: myIdentity,
          claimedTier: 'PREMIUM',
          claimedExpiry: localStorage.getItem('ghost_tier_expiry') || ''
        });

        alert(`✅ Custom Handle Set: ${myIdentity}`);
        if (customKeyInput) customKeyInput.value = '';
        break;
      case 'custom-key-error':
        alert(`❌ ${msg.message}`);
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
        if (callerIdText) callerIdText.innerText = `Secure Call from ${msg.senderKey}`;
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
    if (callState !== 'IDLE') return;
    if (!activeCallTarget || !isValidContact(activeCallTarget)) {
      alert('Select a valid contact first.');
      return;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: wantVideo ? { width: { ideal: 640 }, height: { ideal: 480 } } : false
      });
    } catch (err) {
      alert('Media access required.');
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
    chatBox.innerHTML = '';
    chatInput.value = '';

    callState = 'IDLE';
    logChat('System: Call ended.');
  }

  btnCallAudio.onclick = () => startCall(false);
  btnCallVideo.onclick = () => startCall(true);
  btnEndSession.onclick = () => endCall(true);

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
      const res = await fetch('/api/payment-info');
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
        const response = await fetch('/api/create-payment', {
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