const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Track users globally by their Secret Key: key -> ws
const activeUsers = new Map();
// Track active rooms: roomKey -> Set of ws clients
const rooms = new Map();

wss.on('connection', (ws) => {
  let userKey = null;
  let currentRoom = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // Register device on network so others can ring it
      if (data.type === 'register') {
        userKey = data.myKey;
        activeUsers.set(userKey, ws);
      }

      // Enter specific room
      else if (data.type === 'join') {
        currentRoom = data.roomKey;
        if (!rooms.has(currentRoom)) {
          rooms.set(currentRoom, new Set());
        }
        rooms.get(currentRoom).add(ws);

        const clients = rooms.get(currentRoom);
        if (clients.size >= 2) {
          clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'peer_joined' }));
            }
          });
        }
      }

      // Send direct call notification to recipient
      else if (data.type === 'ring_peer') {
        const targetWs = activeUsers.get(data.targetKey);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify({
            type: 'incoming_call',
            callerName: data.callerName,
            roomKey: data.roomKey
          }));
        } else {
          // Peer offline or not registered
          ws.send(JSON.stringify({ type: 'peer_offline' }));
        }
      }

      // Handle call rejection
      else if (data.type === 'reject_call') {
        const targetWs = activeUsers.get(data.targetKey);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify({ type: 'call_rejected' }));
        }
      }

      // Standard in-room messaging / WebRTC signaling
      else if (currentRoom && rooms.has(currentRoom)) {
        const clients = rooms.get(currentRoom);
        clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
          }
        });
      }
    } catch (e) {
      console.error('Server error:', e);
    }
  });

  ws.on('close', () => {
    if (userKey) activeUsers.delete(userKey);

    if (currentRoom && rooms.has(currentRoom)) {
      const clients = rooms.get(currentRoom);
      clients.delete(ws);
      
      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'peer_left' }));
        }
      });

      if (clients.size === 0) rooms.delete(currentRoom);
    }
  });
});

console.log(`Ghost Talk Server running on port ${PORT}`);
