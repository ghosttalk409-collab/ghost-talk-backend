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
  const modalHeading = document.getElementById('modal-heading');
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
  let ringtoneInterval = null;
  let qrCameraStream = null;
  let qrScanAnimation = null;
  let ramContacts = [];

  const security = new SecurityGuard();
  const frameCrypto = new FrameCrypto();

  const rtcConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  };

  // Identity Initialization
  let savedKey = localStorage.getItem('ghost_identity');
  if (!savedKey) {
    savedKey = 'GHOST-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    localStorage.setItem('ghost_identity', savedKey);
  }
  myIdentity = savedKey;
  if (myIdentityInput) myIdentityInput.value = myIdentity;

  // Immediate Local Cache Check
  const cachedTier = localStorage.getItem('ghost_tier');
  const cachedExpiry = localStorage.getItem('ghost_tier_expiry');
  if (cachedTier === 'PREMIUM') {
    if (cachedExpiry && Date.now() >= parseInt(cachedExpiry)) {
      isPremiumUser = false;
      localStorage.removeItem('ghost_tier');
      localStorage.removeItem('ghost_tier_expiry');
    } else {
      isPremiumUser = true;
      applyUIPremiumState(true);
    }
  }

  function applyUIPremiumState(premium) {
    isPremiumUser = premium;
    if (premium) {
      localStorage.setItem('ghost_tier', 'PREMIUM');
      if (tierBadge) {
        tierBadge.innerText = 'PREMIUM TIER';
        tierBadge.style.background = 'var(--accent-green)';
        tierBadge.style.color = '#000';
      }
      if (premiumCustomKeyBox) premiumCustomKeyBox.style.display = 'block';
    } else {
      localStorage.removeItem('ghost_tier');
      localStorage.removeItem('ghost_tier_expiry');
      if (tierBadge) {
        tierBadge.innerText = 'FREE TIER';
        tierBadge.style.background = 'transparent';
        tierBadge.style.color = 'var(--accent-green)';
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
      div.innerHTML = `<strong>${shortKey} [Image]:</strong> ${safeName}<br><img src="${fileData}" style="max-width: 150px; border-radius: 8px; margin-top: 4px;">`;
    } else {
      div.innerHTML = `<strong>${shortKey} [File]:</strong> <a href="${fileData}" download="${safeName}" style="color: var(--accent-green); text-decoration: underline;">📁 Download ${safeName}</a>`;
    }
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function playBeep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = 587.33;
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + 0.15);
    } catch (e) {}
  }

  function startRingtone() {
    stopRingtone();
    ringtoneInterval = setInterval(playBeep, 1000);
  }

  function stopRingtone() {
    if (ringtoneInterval) { clearInterval(ringtoneInterval); ringtoneInterval = null; }
  }

  function ensureContact(key, name = 'Peer') {
    if (!key) return;
    const upperKey = key.toUpperCase();
    if (!ramContacts.some(c => c.key === upperKey)) {
      ramContacts.push({ name: name.substring(0, 8), key: upperKey });
      renderContacts();
    }
  }

  function isValidContact(key) {
    return ramContacts.some(c => c.key === key);
  }

  function initWebSocket() {
    const isLocalBrowser = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') 
                           && window.location.port === '8158';

    const socketUrl = isLocalBrowser 
      ? 'ws://127.0.0.1:8158' 
      : 'wss://ghost-talk-backend.onrender.com';

    socket = new WebSocket(socketUrl);

    socket.onopen = () => {
      statusBar.innerText = 'STATUS: ONLINE | SECURED';
      statusBar.classList.remove('offline');
      
      // Send registration and claim cached tier so APK self-heals its server record
      const currentCachedTier = localStorage.getItem('ghost_tier') || 'FREE';
      socket.send(JSON.stringify({ 
        type: 'register', 
        key: myIdentity, 
        claimedTier: currentCachedTier 
      }));
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
      setTimeout(initWebSocket, 2000);
    };
  }

  async function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'registered':
        logChat('System: Registered on secure mesh.');
        if (msg.tier) {
          applyUIPremiumState(msg.tier === 'PREMIUM');
          if (msg.expiresAt) localStorage.setItem('ghost_tier_expiry', msg.expiresAt);
        }
        break;
      case 'tier-updated':
        applyUIPremiumState(msg.tier === 'PREMIUM');
        if (msg.expiresAt) localStorage.setItem('ghost_tier_expiry', msg.expiresAt);
        logChat(`System: Tier updated to ${msg.tier}.`);
        if (msg.tier === 'PREMIUM') {
          alert('🎉 Premium Tier Activated Successfully!');
        } else if (msg.message) {
          alert(msg.message);
        }
        break;
      case 'text-notify':
        ensureContact(msg.senderKey, 'Peer');
        activeCallTarget = msg.senderKey;
        renderContacts();
        logChat(`System: ${msg.senderKey} connected to chat.`);
        break;
      case 'offer':
        if (peerConnection) {
          socket.send(JSON.stringify({ type: 'decline', targetKey: msg.senderKey }));
          return;
        }
        ensureContact(msg.senderKey, 'Caller');
        activeCallTarget = msg.senderKey;
        renderContacts();
        startRingtone();
        if (callerIdText) callerIdText.innerText = `Call from ${msg.senderKey} (${msg.hasVideo ? 'Video' : 'Audio'})`;
        if (callModal) callModal.style.display = 'flex';

        btnAccept.onclick = async () => {
          stopRingtone();
          callModal.style.display = 'none';
          try {
            localStream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: msg.hasVideo
            });
          } catch (err) {
            alert('Media permission denied.');
            return;
          }

          await setupWebRTC(true, msg.hasVideo);
          await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.offer));
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);

          socket.send(JSON.stringify({ type: 'answer', targetKey: activeCallTarget, answer }));
          logChat('System: Call accepted & connected.');
        };

        btnDecline.onclick = () => {
          stopRingtone();
          callModal.style.display = 'none';
          socket.send(JSON.stringify({ type: 'decline', targetKey: msg.senderKey }));
          activeCallTarget = '';
          renderContacts();
        };
        break;
      case 'answer':
        if (peerConnection) {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.answer));
          logChat('System: Peer connected successfully.');
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
        stopRingtone();
        logChat('System: Session ended by peer.');
        endCall(false);
        break;
    }
  }

  async function startCall(wantVideo) {
    if (!activeCallTarget) {
      alert('Please select a contact from RAM contacts first!');
      return;
    }
    if (!isValidContact(activeCallTarget)) {
      alert('❌ Invalid or non-existent contact key selected.');
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
      alert('Microphone/Camera access required to make calls.');
      return;
    }

    await setupWebRTC(true, wantVideo);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.send(JSON.stringify({
      type: 'offer',
      targetKey: activeCallTarget,
      offer,
      hasVideo: wantVideo
    }));

    logChat(`System: Calling ${activeCallTarget} (${wantVideo ? 'Video' : 'Audio'}) ...`);
  }

  async function setupWebRTC(wantAudio, wantVideo) {
    if (peerConnection) {
      peerConnection.close();
    }

    peerConnection = new RTCPeerConnection(rtcConfig);

    peerConnection.onicecandidate = (e) => {
      if (e.candidate && activeCallTarget) {
        socket.send(JSON.stringify({ type: 'ice-candidate', targetKey: activeCallTarget, candidate: e.candidate }));
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
    if (notifyPeer && activeCallTarget && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'end-session', targetKey: activeCallTarget }));
    }
    stopRingtone();
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

    micMuted = false;
    camOff = false;
    if (btnToggleMic) btnToggleMic.innerText = '🎙️ Mic On';
    if (btnToggleCam) btnToggleCam.innerText = '📹 Cam On';
    logChat('System: Call ended. RAM erased.');
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
    if (!activeCallTarget) { alert('Select a contact first!'); return; }
    if (!isValidContact(activeCallTarget)) { alert('❌ Cannot chat with a non-existent contact key.'); return; }
    socket.send(JSON.stringify({ type: 'text-notify', targetKey: activeCallTarget }));
    logChat(`System: Chat session ready with ${activeCallTarget}.`);
  };

  btnSend.onclick = () => {
    const text = chatInput.value.trim();
    if (!text || !activeCallTarget) { alert('Select contact and type message.'); return; }
    if (!isValidContact(activeCallTarget)) { alert('❌ Invalid target contact.'); return; }
    socket.send(JSON.stringify({ type: 'chat', targetKey: activeCallTarget, text }));
    logChat(`Me: ${escapeHTML(text)}`);
    chatInput.value = '';
  };

  chatInput.onkeypress = (e) => { if (e.key === 'Enter') btnSend.click(); };

  if (btnAttach && fileInput) {
    btnAttach.onclick = () => {
      if (!isPremiumUser) { alert('🔒 Premium Feature: File transfers require Premium Tier.'); return; }
      if (!activeCallTarget) { alert('Select a contact first!'); return; }
      if (!isValidContact(activeCallTarget)) { alert('❌ Invalid target contact.'); return; }
      fileInput.click();
    };

    fileInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { alert('File size exceeds 10MB.'); fileInput.value = ''; return; }

      const reader = new FileReader();
      reader.onload = (evt) => {
        socket.send(JSON.stringify({
          type: 'file-transfer',
          targetKey: activeCallTarget,
          fileName: file.name,
          fileType: file.type,
          fileData: evt.target.result
        }));
        logChat(`Me [Shared File]: ${escapeHTML(file.name)}`);
        fileInput.value = '';
      };
      reader.readAsDataURL(file);
    };
  }

  btnAddContact.onclick = () => {
    const name = contactNameInput.value.trim();
    let key = contactKeyInput.value.trim().toUpperCase();
    if (!name || !key) { alert('Enter Name and Key.'); return; }

    if (!key.startsWith('GHOST-')) {
      key = 'GHOST-' + key;
    }

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
      
      card.innerHTML = `<div class="contact-info" style="flex-grow: 1;"><div class="name">${escapeHTML(c.name)}</div><div class="key">${escapeHTML(c.key)}</div></div>`;
      
      card.onclick = () => {
        activeCallTarget = c.key;
        renderContacts();
      };

      let pressTimer = null;
      card.onmousedown = card.ontouchstart = () => {
        pressTimer = setTimeout(() => {
          if (confirm(`⚠️ Delete RAM contact "${c.name}"?`)) {
            ramContacts.splice(idx, 1);
            if (activeCallTarget === c.key) activeCallTarget = '';
            renderContacts();
            logChat(`System: Contact ${c.name} wiped.`);
          }
        }, 1500);
      };
      card.onmouseup = card.onmouseleave = card.ontouchend = () => clearTimeout(pressTimer);

      contactsListContainer.appendChild(card);
    });
  }

  tierBadge.onclick = async () => {
    if (isPremiumUser) {
      alert('✨ You are already running Ghost Talk Premium!');
      return;
    }
    
    try {
      const res = await fetch('/api/payment-info');
      const data = await res.json();
      if (modalDisplayPrice) modalDisplayPrice.innerText = `$${data.pricing.monthly}`;
    } catch (e) {}

    if (paymentModal) paymentModal.style.display = 'flex';
  };

  if (btnClosePaymentModal) {
    btnClosePaymentModal.onclick = () => {
      if (paymentModal) paymentModal.style.display = 'none';
    };
  }

  if (btnStartCheckout) {
    btnStartCheckout.onclick = async () => {
      btnStartCheckout.innerText = 'Generating Secure Checkout...';
      btnStartCheckout.disabled = true;

      try {
        const response = await fetch('/api/create-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userKey: myIdentity, planType: 'monthly' })
        });

        const data = await response.json();

        if (data.success && data.invoiceUrl) {
          if (paymentModal) paymentModal.style.display = 'none';
          window.open(data.invoiceUrl, '_blank');
        } else {
          alert(`❌ Checkout Error: ${data.message}`);
        }
      } catch (err) {
        alert('❌ Error connecting to payment gateway server.');
      } finally {
        btnStartCheckout.innerText = 'Proceed to Secure Checkout';
        btnStartCheckout.disabled = false;
      }
    };
  }

  if (btnSaveCustomKey) {
    btnSaveCustomKey.onclick = () => {
      if (!isPremiumUser) return;
      const desiredKey = customKeyInput.value.trim().toUpperCase();
      if (!desiredKey || desiredKey.length < 3) { alert('Enter valid custom key.'); return; }
      myIdentity = desiredKey.startsWith('GHOST-') ? desiredKey : `GHOST-${desiredKey}`;
      localStorage.setItem('ghost_identity', myIdentity);
      if (myIdentityInput) myIdentityInput.value = myIdentity;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'register', key: myIdentity }));
      }
      alert(`Custom Key Set: ${myIdentity}`);
      customKeyInput.value = '';
    };
  }

  if (btnShowQr) {
    btnShowQr.onclick = () => {
      if (!myIdentity) return;
      if (qrModalTitle) qrModalTitle.innerText = 'My Identity Key QR';
      if (qrDisplayContainer) qrDisplayContainer.style.display = 'inline-block';
      if (qrScannerContainer) qrScannerContainer.style.display = 'none';
      if (qrcodeDiv) {
        qrcodeDiv.innerHTML = '';
        if (window.QRCode) {
          new QRCode(qrcodeDiv, { text: myIdentity.toUpperCase(), width: 180, height: 180, colorDark: '#000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.H });
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
        alert('❌ Camera unavailable. Ensure camera permissions are granted.');
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
              alert('❌ No valid QR code detected.');
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
    logChat('System: Complete RAM state cleared.');
  };

  function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
  }

  renderContacts();
  initWebSocket();
});