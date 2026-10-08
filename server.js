const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html'))
  ? path.join(__dirname, 'public')
  : __dirname;

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
  '.json': 'application/json; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const safePath = path.resolve(PUBLIC_DIR, '.' + urlPath);
  fs.readFile(safePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('یافت نشد');
      return;
    }
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();
const clients = new Map();

function generateRoomCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return rooms.has(code) ? generateRoomCode() : code;
}

function broadcastToRoom(room, data) {
  const payload = JSON.stringify(data);
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(payload);
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
    phase: room.phase,
    revealedLength: room.revealedLength,
    revealedLetters: room.secretWord.slice(0, room.revealedLength),
    hostSecret: isHost ? room.secretWord : undefined,
    currentClue: room.currentClue ? {
      authorId: room.currentClue.authorId,
      authorName: room.currentClue.authorName,
      clueText: room.currentClue.clueText,
      connectorId: room.currentClue.connectorId,
      connectorName: room.currentClue.connectorName
    } : null,
    countdownEndsAt: room.countdownEndsAt,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.id === room.hostId
    }))
  };
}

function broadcastRoom(room) {
  room.players.forEach(p => {
    sendToPlayer(p, { type: 'state', state: sanitizeRoomState(room, p.id) });
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
  broadcastToRoom(room, {
    type: 'system',
    message: `⚡ ${room.currentClue.connectorName} کانتکت زد! ۵ ثانیه مهلت برای حدس میزبان.`
  });
  broadcastRoom(room);

  room.timer = setTimeout(() => {
    if (room.phase === 'countdown') {
      room.phase = 'submit';
      room.countdownEndsAt = null;
      if (room.currentClue) {
        room.currentClue.submittedBy = new Map();
      }
      broadcastToRoom(room, {
        type: 'system',
        message: '⏰ مهلت ۵ ثانیه‌ای میزبان تمام شد! بازیکنان کلمه مورد نظرشان را ارسال کنند.'
      });
      broadcastRoom(room);
    }
  }, 5000);
}

wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).substring(2, 10);
  const me = { id: clientId, ws, roomCode: null, name: '' };
  clients.set(ws, me);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.action === 'create_room') {
      me.name = (msg.name || 'میزبان').trim().slice(0, 15);
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
        players: [{ id: me.id, name: me.name, ws }]
      };

      rooms.set(code, room);
      sendToPlayer(me, { type: 'room_created', code, myId: me.id });
      broadcastRoom(room);
      return;
    }

    if (msg.action === 'join_room') {
      const code = (msg.code || '').trim().toUpperCase();
      const name = (msg.name || 'بازیکن').trim().slice(0, 15);
      const room = rooms.get(code);

      if (!room) return sendToPlayer(me, { type: 'error', message: 'اتاقی با این کد یافت نشد.' });

      me.name = name;
      me.roomCode = code;
      room.players.push({ id: me.id, name: me.name, ws });

      sendToPlayer(me, { type: 'joined', code, myId: me.id });
      broadcastRoom(room);
      return;
    }

    const room = rooms.get(me.roomCode);
    if (!room) return;
    const isHost = room.hostId === me.id;

    if (msg.action === 'set_secret' && isHost) {
      const word = (msg.word || '').trim();
      if (!word || word.length < 2) {
        return sendToPlayer(me, { type: 'error', message: 'کلمه باید حداقل ۲ حرف باشد.' });
      }
      room.secretWord = word;
      room.revealedLength = 1;
      room.phase = 'clue';
      broadcastToRoom(room, {
        type: 'system',
        message: `🏁 بازی شروع شد! حرف اول کلمه «${word[0]}» است.`
      });
      broadcastRoom(room);
      return;
    }

    if (msg.action === 'post_clue' && !isHost) {
      const clueText = (msg.clueText || '').trim();
      const underlyingWord = (msg.underlyingWord || '').trim();

      if (!clueText || !underlyingWord) {
        return sendToPlayer(me, { type: 'error', message: 'راهنمایی و کلمه الزامی است.' });
      }

      const prefix = normalizeText(room.secretWord.slice(0, room.revealedLength));
      if (!normalizeText(underlyingWord).startsWith(prefix)) {
        return sendToPlayer(me, {
          type: 'error',
          message: `کلمه باید با حروف «${room.secretWord.slice(0, room.revealedLength)}» شروع شود.`
        });
      }

      clearRoomTimer(room);
      room.currentClue = {
        authorId: me.id,
        authorName: me.name,
        clueText,
        underlyingWord,
        connectorId: null,
        connectorName: null,
        submittedBy: null
      };
      room.phase = 'clue';

      broadcastToRoom(room, {
        type: 'system',
        message: `💡 راهنمایی جدید توسط ${me.name}: «${clueText}»`
      });
      broadcastRoom(room);
      return;
    }

    if (msg.action === 'connect' && !isHost && room.phase === 'clue') {
      if (!room.currentClue || room.currentClue.authorId === me.id) return;
      room.currentClue.connectorId = me.id;
      room.currentClue.connectorName = me.name;
      startCountdown(room);
      return;
    }

    // دیس‌کانتکت کردن راهنمایی توسط میزبان
    if (msg.action === 'disconnect_guess' && isHost && (room.phase === 'clue' || room.phase === 'countdown')) {
      if (!room.currentClue) return;
      const guess = (msg.guess || '').trim();
      const normGuess = normalizeText(guess);
      const normTarget = normalizeText(room.currentClue.underlyingWord);

      if (normGuess === normTarget) {
        clearRoomTimer(room);
        room.phase = 'clue';
        broadcastToRoom(room, {
          type: 'system',
          message: `🚫 میزبان با موفقیت کلمه «${guess}» را حدس زد و راهنمایی دیس‌کانتکت شد!`
        });
        room.currentClue = null;
        broadcastRoom(room);
      } else {
        broadcastToRoom(room, {
          type: 'system',
          message: `❌ حدس میزبان («${guess}») اشتباه بود!`
        });
      }
      return;
    }

    // ثبت نهایی کلمات بعد از شمارش ۵ ثانیه‌ای
    if (msg.action === 'submit_word' && room.phase === 'submit' && room.currentClue) {
      const clue = room.currentClue;
      if (me.id !== clue.authorId && me.id !== clue.connectorId) return;

      const word = (msg.word || '').trim();
      if (!word) return;

      if (!clue.submittedBy) clue.submittedBy = new Map();
      clue.submittedBy.set(me.id, word);

      const authorWord = clue.submittedBy.get(clue.authorId);
      const connectorWord = clue.submittedBy.get(clue.connectorId);

      if (authorWord && connectorWord) {
        if (normalizeText(authorWord) === normalizeText(connectorWord)) {
          room.revealedLength += 1;
          const won = room.revealedLength >= room.secretWord.length;

          broadcastToRoom(room, {
            type: 'system',
            message: `🎉 ارتباط برقرار شد! هر دو گفتند: «${authorWord}». حرف جدید باز شد: «${room.secretWord.slice(0, room.revealedLength)}»`
          });

          if (won) {
            broadcastToRoom(room, {
              type: 'system',
              message: `🏆 تبریک! کلمه اصلی «${room.secretWord}» کشف شد!`
            });
            room.phase = 'lobby';
          } else {
            room.phase = 'clue';
          }
        } else {
          broadcastToRoom(room, {
            type: 'system',
            message: `❌ کلمات یکی نبودند! (${clue.authorName}: ${authorWord} | ${clue.connectorName}: ${connectorWord})`
          });
          room.phase = 'clue';
        }

        room.currentClue = null;
        broadcastRoom(room);
      } else {
        sendToPlayer(me, { type: 'system', message: 'کلمه شما ثبت شد. در انتظار طرف مقابل...' });
      }
      return;
    }
  });

  ws.on('close', () => {
    if (me.roomCode && rooms.has(me.roomCode)) {
      const room = rooms.get(me.roomCode);
      room.players = room.players.filter(p => p.id !== me.id);
      if (room.players.length === 0) {
        clearRoomTimer(room);
        rooms.delete(me.roomCode);
      } else {
        broadcastRoom(room);
      }
    }
    clients.delete(ws);
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
