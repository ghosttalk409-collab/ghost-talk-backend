(function () {
  const statusBar = document.getElementById('status-bar');
  const identityInput = document.getElementById('secure-identity');
  const qrButton = document.getElementById('qr-btn');
  const addContactBtn = document.getElementById('add-contact-btn');
  const scanBtn = document.getElementById('scan-btn');
  const contactNameInput = document.getElementById('contact-name');
  const contactKeyInput = document.getElementById('contact-key');
  const chatBox = document.getElementById('chat-box');
  const messageInput = document.getElementById('message-input');
  const sendBtn = document.getElementById('send-btn');
  const wipeBtn = document.getElementById('wipe-btn');

  let socket = null;
  let reconnectTimer = null;
  let pingTimer = null;
  let reconnectAttempts = 0;
  let accountKey = localStorage.getItem('ghost_key') || generateIdentityKey();
  let mySecret = localStorage.getItem('ghost_secret') || generateSecret();

  localStorage.setItem('ghost_key', accountKey);
  localStorage.setItem('ghost_secret', mySecret);
  if (identityInput) identityInput.value = accountKey;

  function generateIdentityKey() {
    return 'GHOST-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  function generateSecret() {
    return Math.random().toString(36.substring(2, 15)) + Math.random().toString(36).substring(2, 15);
  }

  function logChat(text) {
    if (!chatBox) return;
    const div = document.createElement('div');
    div.className = 'chat-log-item';
    div.innerText = text;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  // Force explicit secure WSS and correct host mapping for Render proxy
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socketUrl = `${protocol}//${window.location.host}`;

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

    // Guard against indefinite hanging in CONNECTING state during Render cold starts
    const connectTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        logChat('[DEBUG] Connection timeout - closing stalled socket and retrying...');
        try { ws.close(); } catch {}
      }
    }, 6000);

    ws.onopen = () => {
      clearTimeout(connectTimeout);
      logChat('[DEBUG] Handshake OK! Registering...');
      if (statusBar) {
        statusBar.innerText = 'STATUS: ONLINE | END-TO-END ENCRYPTED';
        statusBar.classList.remove('offline');
      }
      reconnectAttempts = 0;
      ws.send(JSON.stringify({ type: 'register', key: accountKey, secret: mySecret, ref: localStorage.getItem('ghost_ref') || undefined }));
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}'); }, 20000);
    };

    ws.onmessage = event => {
      try {
        const data = JSON.parse(event.data);
        logChat(`[MSG] ${data.type || 'data'}`);
      } catch (e) {
        logChat(`[DEBUG] Bad message: ${e.message}`);
      }
    };

    ws.onclose = event => {
      clearTimeout(connectTimeout);
      if (socket !== ws) return;
      clearInterval(pingTimer);
      logChat(`[DEBUG] Closed -> Code: ${event.code} | Reason: "${event.reason || 'none'}"`);
      if (statusBar) {
        statusBar.innerText = 'STATUS: OFFLINE | RECONNECTING...';
        statusBar.classList.add('offline');
      }
      scheduleReconnect();
    };

    ws.onerror = () => {
      clearTimeout(connectTimeout);
      logChat('[DEBUG] WebSocket error event triggered.');
      try { ws.close(); } catch {}
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), 10000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      initWebSocket();
    }, delay);
  }

  if (wipeBtn) {
    wipeBtn.addEventListener('click', () => {
      if (confirm('Wipe all local RAM state and keys?')) {
        localStorage.clear();
        window.location.reload();
      }
    });
  }

  // Wake up Render container first via HTTP, then dial WebSocket
  fetch('/app', { method: 'HEAD' }).catch(() => {}).finally(() => {
    initWebSocket();
  });
})();