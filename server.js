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
    .replace(/\u064A/g, '\u06CC')
    .replace(/\u0643/g, '\u06A9')
    .replace(/[\u0623\u0625\u0622]/g, '\u0627')
    .replace(/\u0629/g, '\u0647')
    .replace(/[\u064B-\u065F]/g, '')
    .replace(/\u0640/g, '')
    .toLowerCase();
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const safePath = path.resolve(PUBLIC_DIR, '.' + urlPath);
  if (!safePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(safePath, (err, data) => {
    if (err) { res.writeHead(404, {'Content-Type':'text/plain;charset=utf-8'}); res.end('یافت نشد'); return; }
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, {'Content-Type': MIME_TYPES[ext] || 'application/octet-stream'});
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms   = new Map(); // code -> room
const clients = new Map(); // ws   -> me

function generateRoomCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? generateRoomCode() : code;
}

function sendTo(player, data) {
  if (player?.ws?.readyState === WebSocket.OPEN)
    player.ws.send(JSON.stringify(data));
}

function broadcastRoom(room) {
  room.players.forEach(p => sendTo(p, { type: 'state', state: buildState(room, p.id) }));
}

function addHistory(room, author, text) {
  room.history.push({ author, text });
  if (room.history.length > 60) room.history.shift();
}

function buildState(room, viewerId) {
  const isHost = room.hostId === viewerId;
  return {
    hostId:            room.hostId,
    phase:             room.phase,
    hasSecret:         !!room.secretWord,
    wordLength:        room.secretWord ? room.secretWord.length : 0,
    revealedPrefix:    room.secretWord ? room.secretWord.slice(0, room.revealedLength) : '',
    currentClue:       room.currentClue ? {
      playerId:      room.currentClue.authorId,
      clueText:      room.currentClue.clueText,
    } : null,
    connectedPlayerId: room.currentClue?.connectorId || null,
    countdownEndsAt:   room.countdownEndsAt || null,
    winnerMessage:     room.winnerMessage || '',
    players:           room.players.map(p => ({ id: p.id, name: p.name })),
    history:           room.history,
  };
}

function clearTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
}

function startCountdown(room) {
  clearTimer(room);
  room.phase = 'countdown';
  room.countdownEndsAt = Date.now() + 5000;
  const connName = room.currentClue.connectorName;
  addHistory(room, '⚡ سیستم', `${connName} کانتکت زد! ۵ ثانیه مهلت میزبان.`);
  broadcastRoom(room);

  room.timer = setTimeout(() => {
    if (room.phase !== 'countdown') return;
    room.phase = 'submit';
    room.countdownEndsAt = null;
    room.currentClue.submittedBy = new Map();
    addHistory(room, '⏰ سیستم', 'مهلت تمام شد! بازیکنان کلمه خود را ارسال کنند.');
    broadcastRoom(room);
  }, 5000);
}

wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).slice(2, 10);
  const me = { id: clientId, ws, roomCode: null, name: '' };
  clients.set(ws, me);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── ساخت اتاق ──────────────────────────────────────────────
    if (msg.type === 'create_room') {
      me.name = (msg.name || 'میزبان').trim().slice(0, 15);
      const code = generateRoomCode();
      me.roomCode = code;
      const room = {
        code, hostId: me.id,
        secretWord: '', revealedLength: 0,
        phase: 'setup',
        currentClue: null, countdownEndsAt: null,
        timer: null, winnerMessage: '',
        history: [],
        players: [{ id: me.id, name: me.name, ws }]
      };
      rooms.set(code, room);
      sendTo(me, { type: 'room_created', playerId: me.id, roomCode: code });
      broadcastRoom(room);
      return;
    }

    // ── ورود به اتاق ────────────────────────────────────────────
    if (msg.type === 'join_room') {
      const code = (msg.roomCode || '').trim().toUpperCase();
      const name = (msg.name || 'بازیکن').trim().slice(0, 15);
      const room = rooms.get(code);
      if (!room) return sendTo(me, { type: 'error', message: 'اتاقی با این کد یافت نشد.' });
      me.name = name; me.roomCode = code;
      room.players.push({ id: me.id, name: me.name, ws });
      addHistory(room, '🔔 سیستم', `${me.name} وارد اتاق شد.`);
      sendTo(me, { type: 'joined', playerId: me.id, roomCode: code });
      broadcastRoom(room);
      return;
    }

    const room = rooms.get(me.roomCode);
    if (!room) return;
    const isHost = room.hostId === me.id;

    // ── ثبت کلمه مخفی ──────────────────────────────────────────
    if (msg.type === 'set_secret' && isHost) {
      const word = (msg.secret || '').trim();
      if (!word || word.length < 2)
        return sendTo(me, { type: 'error', message: 'کلمه باید حداقل ۲ حرف باشد.' });
      room.secretWord    = word;
      room.revealedLength = 1;
      room.phase         = 'setup';
      broadcastRoom(room);
      return;
    }

    // ── شروع بازی ──────────────────────────────────────────────
    if (msg.type === 'start_game' && isHost) {
      if (!room.secretWord)
        return sendTo(me, { type: 'error', message: 'ابتدا کلمه مخفی را ثبت کنید.' });
      room.phase = 'clue';
      room.currentClue = null;
      addHistory(room, '🏁 سیستم', `بازی شروع شد! حرف اول: «${room.secretWord[0]}»`);
      broadcastRoom(room);
      return;
    }

    // ── ارسال سرنخ ─────────────────────────────────────────────
    if (msg.type === 'post_clue' && !isHost && room.phase === 'clue' && !room.currentClue) {
      const clueText      = (msg.clue || '').trim();
      const underlyingWord = (msg.word || '').trim();
      if (!clueText || !underlyingWord)
        return sendTo(me, { type: 'error', message: 'راهنمایی و کلمه هر دو الزامی‌اند.' });
      const prefix = normalizeText(room.secretWord.slice(0, room.revealedLength));
      if (!normalizeText(underlyingWord).startsWith(prefix))
        return sendTo(me, { type: 'error', message: `کلمه باید با «${room.secretWord.slice(0, room.revealedLength)}» شروع شود.` });
      clearTimer(room);
      room.currentClue = {
        authorId: me.id, authorName: me.name,
        clueText, underlyingWord,
        connectorId: null, connectorName: null,
        submittedBy: null
      };
      room.phase = 'clue';
      addHistory(room, me.name, `سرنخ: «${clueText}»`);
      broadcastRoom(room);
      return;
    }

    // ── کانتکت ─────────────────────────────────────────────────
    if (msg.type === 'connect_clue' && !isHost && room.phase === 'clue') {
      if (!room.currentClue || room.currentClue.authorId === me.id) return;
      room.currentClue.connectorId   = me.id;
      room.currentClue.connectorName = me.name;
      startCountdown(room);
      return;
    }

    // ── دیس‌کانکت میزبان ────────────────────────────────────────
    if (msg.type === 'disconnect_guess' && isHost &&
        (room.phase === 'clue' || room.phase === 'countdown') && room.currentClue) {
      const guess      = (msg.guess || '').trim();
      const normGuess  = normalizeText(guess);
      const normTarget = normalizeText(room.currentClue.underlyingWord);
      if (normGuess === normTarget) {
        clearTimer(room);
        addHistory(room, '🚫 سیستم', `میزبان «${guess}» را حدس زد — سرنخ دیس‌کانکت شد!`);
        room.currentClue = null;
        room.phase = 'clue';
        broadcastRoom(room);
      } else {
        addHistory(room, '❌ سیستم', `حدس میزبان («${guess}») اشتباه بود.`);
        broadcastRoom(room);
      }
      return;
    }

    // ── ثبت کلمه نهایی ─────────────────────────────────────────
    if (msg.type === 'submit_word' && room.phase === 'submit' && room.currentClue) {
      const clue = room.currentClue;
      if (me.id !== clue.authorId && me.id !== clue.connectorId) return;
      const word = (msg.secret || '').trim();
      if (!word) return;
      if (!clue.submittedBy) clue.submittedBy = new Map();
      clue.submittedBy.set(me.id, word);

      const authorWord    = clue.submittedBy.get(clue.authorId);
      const connectorWord = clue.submittedBy.get(clue.connectorId);

      if (authorWord && connectorWord) {
        if (normalizeText(authorWord) === normalizeText(connectorWord)) {
          room.revealedLength += 1;
          const won = room.revealedLength >= room.secretWord.length;
          addHistory(room, '🎉 سیستم',
            `ارتباط برقرار شد! هر دو گفتند «${authorWord}». حروف فاش: «${room.secretWord.slice(0, room.revealedLength)}»`);
          if (won) {
            room.phase = 'ended';
            room.winnerMessage = `🏆 کلمه «${room.secretWord}» کشف شد! بازیکنان برنده شدند.`;
            addHistory(room, '🏆 سیستم', room.winnerMessage);
          } else {
            room.phase = 'clue';
          }
        } else {
          addHistory(room, '❌ سیستم',
            `کلمات متفاوت بود! (${clue.authorName}: ${authorWord} | ${clue.connectorName}: ${connectorWord})`);
          room.phase = 'clue';
        }
        room.currentClue = null;
        broadcastRoom(room);
      } else {
        sendTo(me, { type: 'error', message: 'کلمه شما ثبت شد. در انتظار طرف مقابل...' });
      }
      return;
    }

    // ── دست جدید ───────────────────────────────────────────────
    if (msg.type === 'restart_round' && isHost) {
      clearTimer(room);
      room.phase       = 'setup';
      room.secretWord  = '';
      room.revealedLength = 0;
      room.currentClue = null;
      room.countdownEndsAt = null;
      room.winnerMessage = '';
      addHistory(room, '🔄 سیستم', 'دست جدید شروع شد.');
      broadcastRoom(room);
      return;
    }

    // ── پایان بازی ─────────────────────────────────────────────
    if (msg.type === 'end_game' && isHost) {
      clearTimer(room);
      room.phase = 'ended';
      room.winnerMessage = 'بازی توسط میزبان پایان یافت.';
      addHistory(room, '🛑 سیستم', room.winnerMessage);
      broadcastRoom(room);
      return;
    }
  });

  ws.on('close', () => {
    if (me.roomCode && rooms.has(me.roomCode)) {
      const room = rooms.get(me.roomCode);
      room.players = room.players.filter(p => p.id !== me.id);
      if (room.players.length === 0) {
        clearTimer(room);
        rooms.delete(me.roomCode);
      } else {
        // اگر میزبان رفت، اول نفر را میزبان کن
        if (room.hostId === me.id) {
          room.hostId = room.players[0].id;
          addHistory(room, '👑 سیستم', `${room.players[0].name} میزبان جدید شد.`);
        }
        addHistory(room, '👋 سیستم', `${me.name} اتاق را ترک کرد.`);
        broadcastRoom(room);
      }
    }
    clients.delete(ws);
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
