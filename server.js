const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
// اگر index.html در کنار server.js باشد یا در public، هر دو را پشتیبانی می‌کند
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;

const MAX_PLAYERS = 12;

function normalizeText(text) {
  if (!text) return '';
  return text
    .toString()
    .trim()
    .replace(/[\u200C\u200B\u200D\uFEFF]/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[\u064B-\u065F]/g, '')
    .replace(/ـ/g, '')
    .toLowerCase();
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') {
    urlPath = '/index.html';
  }

  const safePath = path.resolve(PUBLIC_DIR, '.' + urlPath);
  const rel = path.relative(PUBLIC_DIR, safePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('دسترسی غیرمجاز');
    return;
  }

  fs.readFile(safePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('یافت نشد');
      return;
    }
    const ext = path.extname(safePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();
const clients = new Map();

function generateRoomCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function broadcastToRoom(room, data) {
  const payload = JSON.stringify(data);
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(payload);
    }
  });
}

function sendToPlayer(player, data) {
  if (player && player.ws && player.ws.readyState === WebSocket.OPEN) {
    player.ws.send(JSON.stringify(data));
  }
}

function sanitizeRoomState(room, playerId) {
  const isHost = room.hostId === playerId;
  return {
    code: room.code,
    hostId: room.hostId,
    hostName: (room.players.find(p => p.id === room.hostId) || {}).name || 'میزبان',
    phase: room.phase,
    revealedLength: room.revealedLength,
    revealedLetters: room.secretWord.slice(0, room.revealedLength),
    hostSecret: isHost ? room.secretWord : undefined,
    currentClue: room.currentClue ? {
      authorId: room.currentClue.authorId,
      authorName: room.currentClue.authorName,
      clueText: room.currentClue.clueText,
      connectorId: room.currentClue.connectorId,
      connectorName: room.currentClue.connectorName,
      submittedBy: room.currentClue.submittedBy ? Object.fromEntries(room.currentClue.submittedBy) : null
    } : null,
    countdownEndsAt: room.countdownEndsAt,
    serverTime: Date.now(),
    winner: room.winner,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.id === room.hostId,
      connected: p.connected
    }))
  };
}

function broadcastRoom(room) {
  room.players.forEach(p => {
    sendToPlayer(p, {
      type: 'state',
      state: sanitizeRoomState(room, p.id)
    });
  });
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function startCountdown(room) {
  clearRoomTimer(room);
  room.phase = 'countdown';
  room.countdownEndsAt = Date.now() + 5000;
  broadcastRoom(room);

  room.timer = setTimeout(() => {
    if (room.phase === 'countdown') {
      room.phase = 'submit';
      room.countdownEndsAt = null;
      if (room.currentClue) {
        room.currentClue.submittedBy = new Map([
          [room.currentClue.authorId, false],
          [room.currentClue.connectorId, false]
        ]);
      }
      broadcastRoom(room);
    }
  }, 5000);
}

wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).substring(2, 10);
  const clientObj = { id: clientId, ws, roomCode: null, name: '' };
  clients.set(ws, clientObj);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const me = clients.get(ws);
    if (!me) return;

    if (msg.action === 'create_room') {
      const playerName = (msg.name || 'بازیکن ۱').toString().trim().slice(0, 15);
      me.name = playerName;
      const code = generateRoomCode();
      me.roomCode = code;

      const room = {
        code,
        hostId: me.id,
        secretWord: '',
        revealedLength: 0,
        phase: 'lobby',
        currentClue: null,
        countdownEndsAt: null,
        timer: null,
        winner: null,
        players: [{ id: me.id, name: me.name, ws, connected: true }]
      };

      rooms.set(code, room);
      sendToPlayer(me, { type: 'room_created', code, myId: me.id });
      broadcastRoom(room);
      return;
    }

    if (msg.action === 'join_room') {
      const code = (msg.code || '').toString().trim().toUpperCase();
      const playerName = (msg.name || 'بازیکن').toString().trim().slice(0, 15);
      const room = rooms.get(code);

      if (!room) {
        sendToPlayer(me, { type: 'error', message: 'اتاقی با این کد یافت نشد.' });
        return;
      }
      if (room.players.length >= MAX_PLAYERS) {
        sendToPlayer(me, { type: 'error', message: 'ظرفیت اتاق تکمیل است.' });
        return;
      }

      me.name = playerName;
      me.roomCode = code;

      const existing = room.players.find(p => p.id === me.id);
      if (!existing) {
        room.players.push({ id: me.id, name: me.name, ws, connected: true });
      } else {
        existing.ws = ws;
        existing.connected = true;
        existing.name = me.name;
      }

      sendToPlayer(me, { type: 'joined', code, myId: me.id });
      broadcastRoom(room);
      return;
    }

    const room = rooms.get(me.roomCode);
    if (!room) return;

    const isHost = room.hostId === me.id;

    if (msg.action === 'set_secret' && isHost) {
      const word = (msg.word || '').toString().trim();
      if (!word || word.length < 2) {
        sendToPlayer(me, { type: 'error', message: 'کلمه مخفی باید حداقل ۲ حرف باشد.' });
        return;
      }
      room.secretWord = word;
      room.revealedLength = 1;
      room.phase = 'lobby';
      broadcastRoom(room);
      return;
    }

    if (msg.action === 'start_game' && isHost) {
      if (!room.secretWord) {
        sendToPlayer(me, { type: 'error', message: 'ابتدا کلمه مخفی را وارد کنید.' });
        return;
      }
      room.revealedLength = 1;
      room.phase = 'clue';
      room.currentClue = null;
      room.winner = null;
      clearRoomTimer(room);
      broadcastRoom(room);
      return;
    }

    if (msg.action === 'post_clue' && !isHost && (room.phase === 'clue' || room.phase === 'playing')) {
      const clueText = (msg.clueText || '').toString().trim();
      const underlyingWord = (msg.underlyingWord || '').toString().trim();

      if (!clueText) {
        sendToPlayer(me, { type: 'error', message: 'متن راهنمایی نباید خالی باشد.' });
        return;
      }

      const currentPrefix = normalizeText(room.secretWord.slice(0, room.revealedLength));
      if (underlyingWord) {
        const normUnderlying = normalizeText(underlyingWord);
        if (!normUnderlying.startsWith(currentPrefix)) {
          sendToPlayer(me, { type: 'error', message: `کلمه موردنظر باید با حروف «${room.secretWord.slice(0, room.revealedLength)}» شروع شود.` });
          return;
        }
      }

      clearRoomTimer(room);
      room.currentClue = {
        authorId: me.id,
        authorName: me.name,
        clueText,
        underlyingWord: underlyingWord || '',
        connectorId: null,
        connectorName: null,
        submittedBy: null
      };
      room.phase = 'clue';
      broadcastRoom(room);
      return;
    }

    if (msg.action === 'connect' && !isHost && room.phase === 'clue') {
      if (!room.currentClue) return;
      if (room.currentClue.authorId === me.id) {
        sendToPlayer(me, { type: 'error', message: 'شما خودتان این راهنمایی را مطرح کرده‌اید.' });
        return;
      }

      room.currentClue.connectorId = me.id;
      room.currentClue.connectorName = me.name;
      startCountdown(room);
      return;
    }

    if (msg.action === 'disconnect_guess' && isHost && (room.phase === 'clue' || room.phase === 'countdown')) {
      if (!room.currentClue) return;
      const guess = (msg.guess || '').toString().trim();
      if (!guess) return;

      const normGuess = normalizeText(guess);
      const normUnderlying = normalizeText(room.currentClue.underlyingWord);

      if (normUnderlying && normGuess === normUnderlying) {
        clearRoomTimer(room);
        room.phase = 'clue';
        room.currentClue = null;
        broadcastToRoom(room, {
          type: 'system',
          message: `🚫 میزبان حدس زد: «${guess}» — ارتباط قطع (دیس‌کانتکت) شد!`
        });
        broadcastRoom(room);
      } else if (!normUnderlying) {
        clearRoomTimer(room);
        room.phase = 'clue';
        room.currentClue = null;
        broadcastToRoom(room, {
          type: 'system',
          message: `🚫 میزبان حدس زد: «${guess}» — نوبت سرنخ قبلی باطل شد.`
        });
        broadcastRoom(room);
      } else {
        sendToPlayer(me, { type: 'error', message: `حدس «${guess}» اشتباه بود!` });
      }
      return;
    }

    if (msg.action === 'submit_word' && room.phase === 'submit' && room.currentClue) {
      const clue = room.currentClue;
      if (me.id !== clue.authorId && me.id !== clue.connectorId) return;

      const word = (msg.word || '').toString().trim();
      if (!word) return;

      if (!clue.submittedBy) {
        clue.submittedBy = new Map();
      }
      clue.submittedBy.set(me.id, word);

      const authorWord = clue.submittedBy.get(clue.authorId);
      const connectorWord = clue.submittedBy.get(clue.connectorId);

      if (authorWord && connectorWord) {
        const normAuthor = normalizeText(authorWord);
        const normConnector = normalizeText(connectorWord);

        if (normAuthor === normConnector) {
          if (room.revealedLength < room.secretWord.length) {
            room.revealedLength += 1;
          }
          const won = room.revealedLength >= room.secretWord.length;

          broadcastToRoom(room, {
            type: 'system',
            message: `🎉 موفقیت! هر دو کلمه «${authorWord}» را گفتند. حرف جدید آزاد شد: «${room.secretWord.slice(0, room.revealedLength)}»`
          });

          if (won) {
            room.phase = 'ended';
            room.winner = 'بازیکنان';
            broadcastToRoom(room, {
              type: 'system',
              message: `🏆 تبریک! کلمه کامل کشف شد: «${room.secretWord}»`
            });
          } else {
            room.phase = 'clue';
          }
        } else {
          broadcastToRoom(room, {
            type: 'system',
            message: `❌ کلمات یکی نبودند: طراح گفت «${authorWord}» ولی متصل‌شونده گفت «${connectorWord}».`
          });
          room.phase = 'clue';
        }

        room.currentClue = null;
        broadcastRoom(room);
      } else {
        broadcastRoom(room);
      }
      return;
    }

    if (msg.action === 'restart_round' && isHost) {
      room.secretWord = '';
      room.revealedLength = 0;
      room.phase = 'lobby';
      room.currentClue = null;
      room.winner = null;
      clearRoomTimer(room);
      broadcastRoom(room);
      return;
    }

    if (msg.action === 'end_game' && isHost) {
      room.phase = 'ended';
      room.winner = 'میزبان';
      broadcastToRoom(room, {
        type: 'system',
        message: `🏁 بازی تمام شد. کلمه میزبان «${room.secretWord}» بود.`
      });
      broadcastRoom(room);
      return;
    }
  });

  ws.on('close', () => {
    const me = clients.get(ws);
    if (!me) return;

    if (me.roomCode && rooms.has(me.roomCode)) {
      const room = rooms.get(me.roomCode);
      room.players = room.players.filter(p => p.id !== me.id);

      if (room.players.length === 0) {
        clearRoomTimer(room);
        rooms.delete(me.roomCode);
      } else if (room.hostId === me.id) {
        const nextHost = room.players.find(p => p.connected) || room.players[0];
        if (nextHost) {
          room.hostId = nextHost.id;
          sendToPlayer(nextHost, { type: 'host_assigned' });
          broadcastRoom(room);
        }
      } else {
        broadcastRoom(room);
      }
    }
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
