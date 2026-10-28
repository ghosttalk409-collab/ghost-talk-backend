const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const app = express();

// --- SOVEREIGN SERVER ROUTING ---
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/landing.html'); // Elite Old Money Landing Page
});

app.get('/app', (req, res) => {
  res.sendFile(__dirname + '/public/index.html'); // WebRTC Chat App interface
});

// Direct APK download route: automatically serves the file from public folder or redirects to direct release asset
app.get('/download-apk', (req, res) => {
  const apkFilePath = __dirname + '/public/GhostTalk.apk';
  res.download(apkFilePath, 'GhostTalk.apk', (err) => {
    if (err) {
      // Fallback redirect if local apk file hasn't been copied to public folder yet
      res.redirect('https://github.com/ghosttalk409-collab/ghost-talk-backend/releases/latest/download/GhostTalk.apk');
    }
  });
});
// ----------------------------

app.use(express.static('public'));