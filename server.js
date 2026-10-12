const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const AVATARS = ['😀','😎','🥳','🤠','🦊','🐼','🐸','🐯','🦉','🐙','🦄','🐝'];
const COLORS = ['#6366f1','#ec4899','#22c55e','#f59e0b','#06b6d4','#a855f7','#ef4444','#84cc16'];
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(PUBLIC_DIR)) {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

const indexPath = path.join(__dirname, 'index.html');
const publicIndexPath = path.join(PUBLIC_DIR, 'index.html');
if (fs.existsSync(indexPath) && !fs.existsSync(publicIndexPath)) {
  fs.copyFileSync(indexPath, publicIndexPath);
}

function normalizeText(text) {
  if (!text) return '';
  return String(text)
    .trim()
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '')
    .replace(/\u200C/g, '')
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\u064A/g, '\u06CC')
    .replace(/\u0643/g, '\u06A9')
    .replace(/[\u0623\u0625\u0622]/g, '\u0627')
    .replace(/\u0629/g, '\u0647')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/\u0640/g, '')
    .toLowerCase()
    .trim();
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
  
  if (!safePath.startsWith(PUBLIC_DIR + path.sep) || 
      path.basename(safePath).startsWith('.') ||
      safePath.includes('..')) {
    res.writeHead(403); 
    res.end('Forbidden'); 
    return;
  }
  
  fs.readFile(safePath, (err, data) => {
    if (err) { 
      res.writeHead(404, {'Content-Type':'text/plain;charset=utf-8'}); 
      res.end('یافت نشد'); 
      return; 
    }
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, {'Content-Type': MIME_TYPES[ext] || 'application/octet-stream'});
    res.end(data);
  });
});

const wss = new WebSocketServer({ 
  server,
  maxPayload: 16 * 1024
});

const rooms   = new Map(); // code -> room
const clients = new Map(); // ws -> me

function pickAvatar(msg, room = null) {
  const usedAvatars = new Set((room?.players || []).map(p => p.avatar).filter(Boolean));
  const usedColors = new Set((room?.players || []).map(p => p.color).filter(Boolean));
  const choose = (value, choices, used) => {
    if (typeof value === 'string' && choices.includes(value)) return value;
    const unused = choices.filter(item => !used.has(item));
    const pool = unused.length ? unused : choices;
    return pool[Math.floor(Math.random() * pool.length)];
  };
  return { avatar: choose(msg?.avatar, AVATARS, usedAvatars), color: choose(msg?.color, COLORS, usedColors) };
}

function generateRoomCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    if (!rooms.has(code)) return code;
  }
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function sendTo(player, data) {
  if (player?.ws?.readyState === WebSocket.OPEN) {
    try {
      player.ws.send(JSON.stringify(data));
    } catch (e) {
      console.error('send error:', e);
    }
  }
}

function broadcastRoom(room) {
  room.players.forEach(p => {
    if (!p.disconnected) {
      sendTo(p, { type: 'state', state: buildState(room, p.id) });
    }
  });
}

function addHistory(room, author, text) {
  const safeText = String(text).slice(0, 200);
  const safeAuthor = String(author).slice(0, 30);
  room.history.push({ author: safeAuthor, text: safeText });
  if (room.history.length > 60) room.history.shift();
}

function buildState(room, viewerId) {
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
    players:           room.players.map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      color: p.color,
      disconnected: !!p.disconnected
    })),
    history:           room.history,
    chatLog:           room.chatLog,
    voice:             Array.from(room.voice || []),
    serverNow:         Date.now()
  };
}

function clearTimer(room) {
  if (room.timer) { 
    clearTimeout(room.timer); 
    room.timer = null; 
  }
  if (room.submitTimer) {
    clearTimeout(room.submitTimer);
    room.submitTimer = null;
  }
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
    
    room.submitTimer = setTimeout(() => {
      if (room.phase === 'submit' && room.currentClue) {
        addHistory(room, '⏰ سیستم', 'مهلت ثبت کلمه تمام شد! سرنخ لغو شد.');
        room.currentClue = null;
        room.phase = 'clue';
        room.countdownEndsAt = null;
        room.submitTimer = null;
        broadcastRoom(room);
      }
    }, 30000);
  }, 5000);
}

function removePlayerCompletely(room, playerId) {
  const index = room.players.findIndex(p => p.id === playerId);
  if (index === -1) return;
  const player = room.players[index];
  if (player.graceTimer) clearTimeout(player.graceTimer);

  if (room.currentClue && (room.currentClue.authorId === playerId || room.currentClue.connectorId === playerId)) {
    clearTimer(room);
    room.currentClue = null;
    room.phase = 'clue';
    room.countdownEndsAt = null;
    addHistory(room, '⚠️ سیستم', `طرف سرنخ (${player.name}) خارج شد؛ سرنخ لغو شد.`);
  }

  room.players.splice(index, 1);
  if (room.voice) room.voice.delete(playerId);

  if (room.players.length === 0) {
    clearTimer(room);
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === playerId) {
    const activePlayer = room.players.find(p => !p.disconnected) || room.players[0];
    room.hostId = activePlayer.id;
    room.secretWord = '';
    room.revealedLength = 0;
    room.phase = 'setup';
    clearTimer(room);
    room.currentClue = null;
    addHistory(room, '👑 سیستم', `${activePlayer.name} میزبان جدید شد. کلمه مخفی پاک شد.`);
  }

  addHistory(room, '👋 سیستم', `${player.name} اتاق را ترک کرد.`);
  broadcastRoom(room);
}

function leaveCurrentRoom(me, connectionLost = false) {
  if (!me.roomCode || !rooms.has(me.roomCode)) return;
  const room = rooms.get(me.roomCode);
  const player = room.players.find(p => p.id === me.id);
  if (!player) return;

  if (connectionLost) {
    player.disconnected = true;
    player.ws = null;
    if (room.voice) room.voice.delete(me.id);

    if (player.graceTimer) clearTimeout(player.graceTimer);
    player.graceTimer = setTimeout(() => {
      removePlayerCompletely(room, me.id);
    }, 60000);

    addHistory(room, '📡 سیستم', `ارتباط ${player.name} قطع شد (مهلت بازگشت: ۱ دقیقه).`);
    broadcastRoom(room);
  } else {
    removePlayerCompletely(room, me.id);
  }
  me.roomCode = null;
}

function handleMessage(me, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    return sendTo(me, { type: 'error', message: 'پیام نامعتبر.' });
  }

  // ── ساخت اتاق ──────────────────────────────────────────────
  if (msg.type === 'create_room') {
    leaveCurrentRoom(me);
    
    const name = String(msg.name ?? '').trim().slice(0, 15) || 'میزبان';
    me.name = name;
    
    const code = generateRoomCode();
    me.roomCode = code;
    const sessionToken = crypto.randomBytes(16).toString('hex');
    me.sessionToken = sessionToken;
    const appearance = pickAvatar(msg);
    
    const room = {
      code, 
      hostId: me.id,
      secretWord: '', 
      revealedLength: 0,
      phase: 'setup',
      currentClue: null, 
      countdownEndsAt: null,
      timer: null, 
      submitTimer: null,
      winnerMessage: '',
      history: [],
      chatLog: [],
      voice: new Set(),
      players: [{ id: me.id, name: me.name, ws: me.ws, sessionToken, disconnected: false, ...appearance }]
    };
    
    rooms.set(code, room);
    sendTo(me, { type: 'room_created', playerId: me.id, sessionToken, roomCode: code });
    broadcastRoom(room);
    return;
  }

  // ── ورود به اتاق ────────────────────────────────────────────
  if (msg.type === 'join_room') {
    const code = String(msg.roomCode ?? '').trim().toUpperCase().slice(0, 4);
    const name = String(msg.name ?? '').trim().slice(0, 15) || 'بازیکن';
    
    const room = rooms.get(code);
    if (!room) {
      return sendTo(me, { type: 'error', message: 'اتاقی با این کد یافت نشد.' });
    }
    
    leaveCurrentRoom(me);
    
    me.name = name; 
    me.roomCode = code;
    const sessionToken = crypto.randomBytes(16).toString('hex');
    me.sessionToken = sessionToken;
    const appearance = pickAvatar(msg, room);
    room.players.push({ id: me.id, name: me.name, ws: me.ws, sessionToken, disconnected: false, ...appearance });
    
    addHistory(room, '🔔 سیستم', `${me.name} وارد اتاق شد.`);
    sendTo(me, { type: 'joined', playerId: me.id, sessionToken, roomCode: code });
    broadcastRoom(room);
    return;
  }

  // ── بازگشت به اتاق (Rejoin) ──────────────────────────────────
  if (msg.type === 'rejoin') {
    const code = String(msg.roomCode ?? '').trim().toUpperCase();
    const oldId = String(msg.oldPlayerId ?? '');
    const token = String(msg.sessionToken ?? '');
    
    const room = rooms.get(code);
    if (!room) {
      return sendTo(me, { type: 'error', message: 'اتاق یافت نشد.' });
    }
    
    const oldPlayer = room.players.find(p => p.id === oldId);
    if (!oldPlayer) {
      return sendTo(me, { type: 'error', message: 'بازیکن در اتاق یافت نشد.' });
    }

    if (oldPlayer.sessionToken && oldPlayer.sessionToken !== token) {
      return sendTo(me, { type: 'error', message: 'اعتبارسنجی نشست ناموفق بود.' });
    }
    
    if (oldPlayer.graceTimer) {
      clearTimeout(oldPlayer.graceTimer);
      oldPlayer.graceTimer = null;
    }

    oldPlayer.ws = me.ws;
    oldPlayer.disconnected = false;
    me.id = oldId;
    me.name = oldPlayer.name;
    me.roomCode = code;
    me.sessionToken = oldPlayer.sessionToken;
    
    sendTo(me, { type: 'rejoined', playerId: me.id, sessionToken: me.sessionToken, roomCode: code });
    addHistory(room, '🔄 سیستم', `${me.name} مجدداً متصل شد.`);
    broadcastRoom(room);
    return;
  }

  if (msg.type === 'leave') {
    leaveCurrentRoom(me);
    return;
  }

  if (msg.type === 'voice_state') {
    if (!me.roomCode) return;
    const room = rooms.get(me.roomCode);
    if (!room) return;
    if (msg.on === true) room.voice.add(me.id);
    else room.voice.delete(me.id);
    broadcastRoom(room);
    return;
  }

  if (msg.type === 'voice_signal') {
    if (!me.roomCode) return;
    const room = rooms.get(me.roomCode);
    if (!room) return;
    const target = room.players.find(p => p.id === msg.to);
    if (!target || target.disconnected) return;
    sendTo(target, { type: 'voice_signal', from: me.id, signal: msg.signal });
    return;
  }

  const room = rooms.get(me.roomCode);
  if (!room) {
    return sendTo(me, { type: 'error', message: 'شما در هیچ اتاقی نیستید.' });
  }
  
  const isHost = room.hostId === me.id;

  // ── گفت‌وگو ────────────────────────────────────────────────
  if (msg.type === 'chat') {
    const text = String(msg.text || '').trim();
    if (!text) return sendTo(me, { type: 'error', message: 'پیام نمی‌تواند خالی باشد.' });
    if (text.length > 200) return sendTo(me, { type: 'error', message: 'پیام خیلی طولانی است.' });
    const now = Date.now();
    if (now - (me.lastChatAt || 0) < 600) return;
    me.lastChatAt = now;
    const player = room.players.find(p => p.id === me.id);
    room.chatLog.push({
      id: crypto.randomBytes(6).toString('hex'),
      playerId: me.id,
      name: me.name,
      avatar: player?.avatar,
      color: player?.color,
      text,
      at: now
    });
    if (room.chatLog.length > 60) room.chatLog.shift();
    broadcastRoom(room);
    return;
  }

  // ── ثبت کلمه مخفی ──────────────────────────────────────────
  if (msg.type === 'set_secret') {
    if (!isHost) return sendTo(me, { type: 'error', message: 'فقط میزبان می‌تواند کلمه تعیین کند.' });
    if (room.phase !== 'setup') return sendTo(me, { type: 'error', message: 'فقط در فاز setup می‌توانید کلمه تعیین کنید.' });
    
    const word = String(msg.secret ?? '').trim().slice(0, 50);
    if (!word || word.length < 2) return sendTo(me, { type: 'error', message: 'کلمه باید حداقل ۲ حرف باشد.' });
    
    room.secretWord = word;
    room.revealedLength = 1;
    broadcastRoom(room);
    return;
  }

  // ── شروع بازی ──────────────────────────────────────────────
  if (msg.type === 'start_game') {
    if (!isHost) return sendTo(me, { type: 'error', message: 'فقط میزبان می‌تواند بازی را شروع کند.' });
    if (!room.secretWord) return sendTo(me, { type: 'error', message: 'ابتدا کلمه مخفی را ثبت کنید.' });
    
    room.phase = 'clue';
    room.currentClue = null;
    addHistory(room, '🏁 سیستم', `بازی شروع شد! حرف اول: «${room.secretWord[0]}»`);
    broadcastRoom(room);
    return;
  }

  // ── ارسال سرنخ ─────────────────────────────────────────────
  if (msg.type === 'post_clue') {
    if (isHost) return sendTo(me, { type: 'error', message: 'میزبان نمی‌تواند سرنخ بفرستد.' });
    if (room.phase !== 'clue') return sendTo(me, { type: 'error', message: 'اکنون زمان مناسبی برای ارسال سرنخ نیست.' });
    if (room.currentClue) return sendTo(me, { type: 'error', message: 'یک سرنخ فعال وجود دارد.' });
    
    const clueText = String(msg.clue ?? '').trim().slice(0, 200);
    const underlyingWord = String(msg.word ?? '').trim().slice(0, 50);
    
    if (!clueText || !underlyingWord) {
      return sendTo(me, { type: 'error', message: 'راهنمایی و کلمه هر دو الزامی‌اند.' });
    }
    
    const prefix = normalizeText(room.secretWord.slice(0, room.revealedLength));
    if (!normalizeText(underlyingWord).startsWith(prefix)) {
      return sendTo(me, { type: 'error', message: `کلمه باید با «${room.secretWord.slice(0, room.revealedLength)}» شروع شود.` });
    }
    
    clearTimer(room);
    room.currentClue = {
      authorId: me.id, 
      authorName: me.name,
      clueText, 
      underlyingWord,
      connectorId: null, 
      connectorName: null,
      submittedBy: null
    };
    
    addHistory(room, me.name, `سرنخ: «${clueText}»`);
    broadcastRoom(room);
    return;
  }

  // ── کانتکت ─────────────────────────────────────────────────
  if (msg.type === 'connect_clue') {
    if (isHost) return sendTo(me, { type: 'error', message: 'میزبان نمی‌تواند کانتکت بزند.' });
    if (room.phase !== 'clue') return sendTo(me, { type: 'error', message: 'اکنون زمان مناسبی برای کانتکت نیست.' });
    if (!room.currentClue) return sendTo(me, { type: 'error', message: 'سرنخی برای کانتکت وجود ندارد.' });
    if (room.currentClue.authorId === me.id) return sendTo(me, { type: 'error', message: 'طراح سرنخ نمی‌تواند خودش کانتکت بزند.' });
    
    room.currentClue.connectorId = me.id;
    room.currentClue.connectorName = me.name;
    startCountdown(room);
    return;
  }

  // ── دیس‌کانکت میزبان ────────────────────────────────────────
  if (msg.type === 'disconnect_guess') {
    if (!isHost) return sendTo(me, { type: 'error', message: 'فقط میزبان می‌تواند دیس‌کانکت کند.' });
    if (!['clue', 'countdown'].includes(room.phase) || !room.currentClue) {
      return sendTo(me, { type: 'error', message: 'اکنون زمان مناسبی برای حدس میزبان نیست.' });
    }
    
    const guess = String(msg.guess ?? '').trim().slice(0, 50);
    const normGuess = normalizeText(guess);
    const normTarget = normalizeText(room.currentClue.underlyingWord);
    
    if (normGuess === normalizeText(room.secretWord)) {
      clearTimer(room);
      room.countdownEndsAt = null;
      room.revealedLength = room.secretWord.length;
      room.currentClue = null;
      room.phase = 'ended';
      room.winnerMessage = `🏆 کلمه «${room.secretWord}» کشف شد! میزبان برنده شد.`;
      addHistory(room, '🏆 سیستم', room.winnerMessage);
      broadcastRoom(room);
    } else if (normGuess === normTarget) {
      clearTimer(room);
      room.countdownEndsAt = null;
      addHistory(room, '🚫 سیستم', `میزبان «${guess}» را درست حدس زد — سرنخ دیس‌کانکت شد!`);
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
  if (msg.type === 'submit_word') {
    if (room.phase !== 'submit' || !room.currentClue) {
      return sendTo(me, { type: 'error', message: 'اکنون زمان ارسال کلمه نهایی نیست.' });
    }
    
    const clue = room.currentClue;
    if (me.id !== clue.authorId && me.id !== clue.connectorId) {
      return sendTo(me, { type: 'error', message: 'شما مجاز به ثبت این کلمه نیستید.' });
    }
    
    const word = String(msg.secret ?? '').trim().slice(0, 50);
    if (!word) return sendTo(me, { type: 'error', message: 'کلمه را وارد کنید.' });
    
    const prefix = normalizeText(room.secretWord.slice(0, room.revealedLength));
    if (!normalizeText(word).startsWith(prefix)) {
      return sendTo(me, { type: 'error', message: `کلمه باید با «${room.secretWord.slice(0, room.revealedLength)}» شروع شود.` });
    }
    
    if (me.id === clue.authorId && normalizeText(word) !== normalizeText(clue.underlyingWord)) {
      return sendTo(me, { type: 'error', message: 'باید همان کلمه‌ای که در سرنخ مشخص کرده بودید را بفرستید.' });
    }
    
    if (!clue.submittedBy) clue.submittedBy = new Map();
    clue.submittedBy.set(me.id, word);

    const authorWord = clue.submittedBy.get(clue.authorId);
    const connectorWord = clue.submittedBy.get(clue.connectorId);

    if (authorWord && connectorWord) {
      clearTimer(room);
      
      if (normalizeText(authorWord) === normalizeText(connectorWord)) {
        const exactWord = normalizeText(authorWord) === normalizeText(room.secretWord);
        if (exactWord) room.revealedLength = room.secretWord.length;
        else room.revealedLength = Math.min(room.revealedLength + 1, room.secretWord.length);
        const won = exactWord;
        room.countdownEndsAt = null;
        
        addHistory(room, '🎉 سیستم',
          `ارتباط برقرار شد! هر دو گفتند «${authorWord}». حروف فاش‌شده: «${room.secretWord.slice(0, room.revealedLength)}»`);
        
        if (won) {
          room.phase = 'ended';
          room.winnerMessage = `🏆 کلمه «${room.secretWord}» کشف شد! بازیکنان برنده شدند.`;
          addHistory(room, '🏆 سیستم', room.winnerMessage);
        } else {
          room.phase = 'clue';
        }
      } else {
        addHistory(room, '❌ سیستم',
          `کلمات همخوانی نداشت! (${clue.authorName}: ${authorWord} | ${clue.connectorName}: ${connectorWord})`);
        room.phase = 'clue';
      }
      
      room.currentClue = null;
      broadcastRoom(room);
    } else {
      sendTo(me, { type: 'info', message: 'کلمه شما ثبت شد. در انتظار تایید بازیکن مقابل...' });
    }
    return;
  }

  // ── دست جدید ───────────────────────────────────────────────
  if (msg.type === 'restart_round') {
    if (!isHost) return sendTo(me, { type: 'error', message: 'فقط میزبان می‌تواند دست جدید شروع کند.' });
    
    clearTimer(room);
    room.phase = 'setup';
    room.secretWord = '';
    room.revealedLength = 0;
    room.currentClue = null;
    room.countdownEndsAt = null;
    room.winnerMessage = '';
    addHistory(room, '🔄 سیستم', 'دست جدید آغاز شد.');
    broadcastRoom(room);
    return;
  }

  // ── پایان بازی ─────────────────────────────────────────────
  if (msg.type === 'end_game') {
    if (!isHost) return sendTo(me, { type: 'error', message: 'فقط میزبان می‌تواند بازی را پایان دهد.' });
    
    clearTimer(room);
    room.phase = 'ended';
    room.countdownEndsAt = null;
    room.currentClue = null;
    room.winnerMessage = 'بازی توسط میزبان پایان یافت.';
    addHistory(room, '🛑 سیستم', room.winnerMessage);
    broadcastRoom(room);
    return;
  }

  sendTo(me, { type: 'error', message: 'پیام نامشخص.' });
}

wss.on('connection', (ws) => {
  const clientId = crypto.randomBytes(6).toString('hex');
  const me = { id: clientId, ws, roomCode: null, name: '' };
  clients.set(ws, me);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    try {
      let msg;
      try { 
        msg = JSON.parse(raw); 
      } catch { 
        return sendTo(me, { type: 'error', message: 'قالب JSON نامعتبر است.' });
      }
      handleMessage(me, msg);
    } catch (err) {
      console.error('Message handler error:', err);
      sendTo(me, { type: 'error', message: 'خطای داخلی سرور.' });
    }
  });

  ws.on('close', () => {
    leaveCurrentRoom(me, true);
    clients.delete(ws);
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      const me = clients.get(ws);
      if (me) leaveCurrentRoom(me, true);
      clients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
