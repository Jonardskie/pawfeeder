const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// Enable CORS for all origins (so web app and phones can access stream freely)
app.use(cors({ origin: '*' }));

// Accept raw binary JPEG images up to 5MB
app.use('/upload', express.raw({
  type: ['image/jpeg', 'application/octet-stream', '*/*'],
  limit: '5mb'
}));

let latestFrame = null;
let lastFrameTimestamp = 0;
const mjpegClients = new Set();

// ── 1. ESP32-CAM pushes frames here ─────────────────────────
app.post('/upload', (req, res) => {
  if (!req.body || req.body.length === 0) {
    return res.status(400).json({ error: 'No image data received' });
  }

  latestFrame = req.body;
  lastFrameTimestamp = Date.now();

  // Broadcast frame to all connected web viewers
  for (const client of mjpegClients) {
    try {
      client.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${req.body.length}\r\n\r\n`);
      client.write(req.body);
      client.write('\r\n');
    } catch (err) {
      mjpegClients.delete(client);
    }
  }

  // Tell ESP32 how many active viewers there are
  // (If viewers == 0, ESP32 can slow down to save bandwidth)
  res.json({
    ok: true,
    viewers: mjpegClients.size,
    bytes: req.body.length
  });
});

// ── 2. Web App connects here to watch live video ─────────────
app.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  mjpegClients.add(res);
  console.log(`[Stream] New viewer connected. Total active viewers: ${mjpegClients.size}`);

  // Send latest frame immediately so viewer doesn't see a blank screen
  if (latestFrame) {
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${latestFrame.length}\r\n\r\n`);
    res.write(latestFrame);
    res.write('\r\n');
  }

  req.on('close', () => {
    mjpegClients.delete(res);
    console.log(`[Stream] Viewer disconnected. Total active viewers: ${mjpegClients.size}`);
  });
});

// ── 3. Single JPEG snapshot endpoint ────────────────────────
app.get('/snapshot', (req, res) => {
  if (!latestFrame) {
    return res.status(503).send('No frame captured yet');
  }
  res.set({
    'Content-Type': 'image/jpeg',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  });
  res.send(latestFrame);
});

// ── 4. Health and Status check ──────────────────────────────
app.get('/', (req, res) => {
  const ageMs = lastFrameTimestamp ? Date.now() - lastFrameTimestamp : null;
  res.json({
    service: 'PawFeeder Cloud Video Relay',
    status: 'online',
    activeViewers: mjpegClients.size,
    lastFrameAgeMs: ageMs,
    cameraConnected: ageMs !== null && ageMs < 10000,
    endpoints: {
      stream: '/stream',
      snapshot: '/snapshot',
      upload: '/upload (POST)'
    }
  });
});

app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`  PawFeeder Cloud Video Relay is running!`);
  console.log(`  Local URL : http://localhost:${PORT}`);
  console.log(`  Stream    : http://localhost:${PORT}/stream`);
  console.log(`  Upload    : http://localhost:${PORT}/upload (POST)`);
  console.log(`==================================================\n`);
});
