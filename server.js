const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Stores active rooms: roomKey -> Set of ws clients
const rooms = new Map();

wss.on('connection', (ws) => {
  let currentRoom = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'join') {
        currentRoom = data.roomKey;
        if (!rooms.has(currentRoom)) {
          rooms.set(currentRoom, new Set());
        }
        rooms.get(currentRoom).add(ws);

        const clients = rooms.get(currentRoom);
        // Only notify if there are at least 2 users in THIS specific room
        if (clients.size >= 2) {
          clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'peer_joined' }));
            }
          });
        }
      } 
      else if (currentRoom && rooms.has(currentRoom)) {
        // BroadCast ONLY to clients in the SAME room
        const clients = rooms.get(currentRoom);
        clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
          }
        });
      }
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const clients = rooms.get(currentRoom);
      clients.delete(ws);
      
      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'peer_left' }));
        }
      });

      if (clients.size === 0) {
        rooms.delete(currentRoom);
      }
    }
  });
});

console.log(`Ghost Talk Server running on port ${PORT}`);
