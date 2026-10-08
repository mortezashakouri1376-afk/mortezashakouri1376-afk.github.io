const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  let reqPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(PUBLIC_DIR, reqPath);
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
    } else {
      const ext = path.extname(filePath);
      const mime = ext === '.html' ? 'text/html' : 'text/javascript';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    }
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

wss.on('connection', (ws) => {
  let clientData = { id: Math.random().toString(36).substring(7), ws };

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.action === 'create_room') {
      const code = Math.random().toString(36).substring(2, 6).toUpperCase();
      const room = { code, host: clientData.id, players: [clientData], secret: '', prefix: '', clue: null };
      rooms.set(code, room);
      ws.send(JSON.stringify({ type: 'ROOM_CREATED', code, myId: clientData.id }));
    } else if (msg.action === 'set_secret') {
      const room = Array.from(rooms.values()).find(r => r.host === clientData.id);
      if (room) {
        room.secret = msg.secret;
        room.prefix = msg.secret[0];
        room.players.forEach(p => p.ws.send(JSON.stringify({ type: 'GAME_START', prefix: room.prefix })));
      }
    }
  });
});

server.listen(PORT, () => console.log(`Server on ${PORT}`));
