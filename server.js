// --- GHOST TALK VOLATILE SIGNALING SERVER ---
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  // Public Health Check Endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'online', ramOnly: true }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Ghost Talk Signaling Node Active');
});

const wss = new WebSocket.Server({ server });

// Active Ephemeral Rooms in Server RAM
// Format: { "ROOM_KEY": [ clientSocket1, clientSocket2 ] }
const rooms = new Map();

wss.on('connection', (ws) => {
  let currentRoom = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // 1. Join Ephemeral Room using Secret Key
      if (data.type === 'join') {
        currentRoom = data.roomKey;
        if (!rooms.has(currentRoom)) {
          rooms.set(currentRoom, []);
        }

        const clients = rooms.get(currentRoom);

        if (clients.length >= 2) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room is full (1-on-1 limit)' }));
          return;
        }

        clients.push(ws);

        // Alert first user when second user arrives
        if (clients.length === 2) {
          clients[0].send(JSON.stringify({ type: 'peer_joined' }));
          clients[1].send(JSON.stringify({ type: 'peer_joined' }));
        }
        return;
      }

      // 2. Relay WebRTC Signal Payload (Offer/Answer/ICE) directly to Peer
      if (currentRoom && rooms.has(currentRoom)) {
        const clients = rooms.get(currentRoom);
        clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
          }
        });
      }
    } catch (err) {
      console.error('Invalid message format');
    }
  });

  // Automatically clean up memory on disconnect
  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      let clients = rooms.get(currentRoom);
      clients = clients.filter((client) => client !== ws);

      if (clients.length === 0) {
        rooms.delete(currentRoom); // Wipe room completely from server RAM
      } else {
        rooms.set(currentRoom, clients);
        // Alert remaining peer that the connection dropped
        clients[0].send(JSON.stringify({ type: 'peer_left' }));
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Ghost Signaling active on port ${PORT}`);
});
