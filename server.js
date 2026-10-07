'use strict';
/* Contact — multiplayer word game server (HTTP static + WebSocket) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_PLAYERS = 12;

/* ---------- Persian-aware normalization ---------- */
const ARABIC_DIACRITICS = /[\u064B-\u0652\u0670\u0640]/g; // harakat, dagger alif, tatweel
function normalizeText(s) {
  if (typeof s !== 'string') return '';
  let t = s;
  t = t.replace(/\u200c|\u200f|\u200e|\ufeff/g, ''); // ZWNJ & marks (stripped)
  t = t.replace(/[\u064A\u06CC]/g, '\u06CC');         // ي -> ی
  t = t.replace(/[\u0643\u06A9]/g, '\u06A9');         // ك -> ک
  t = t.replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627'); // alef variants
  t = t.replace(/[\u0629]/g, '\u0647');               // ة -> ه
  t = t.replace(ARABIC_DIACRITICS, '');
  t = t.replace(/\u0640/g, '');
  t = t.replace(/[\t\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

/* ---------- State ---------- */
const rooms = new Map(); // code -> room
const clients = new Map(); // ws -> {roomCode, playerId}

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({length:4},()=>A[Math.floor(Math.random()*A.length)]).join(''); }
  while (rooms.has(c));
  return c;
}
function roomState(room, forWs) {
  const me = clients.get(forWs);
  const isHost = !!(me && room.hostId === me.playerId);
  const players = room.players.map(p => ({ id: p.id, name: p.name, isHost: p.id === room.hostId, connected: p.connected }));
  const st = {
    type: 'state', roomCode: room.code, players,
    phase: room.phase, // lobby | playing | clue | countdown | submit | ended
    revealed: room.revealed,
    hiddenDots: room.secretWord ? Array.from({length: [...room.secretWord].length - [...room.revealed].length}, ()=>'•').join('') : null,
    secretLength: room.secretWord ? [...room.secretWord].length : 0,
    currentClue: room.currentClue ? { id: room.currentClue.id, text: room.currentClue.text, authorId: room.currentClue.authorId, authorName: room.currentClue.authorName, connectorId: room.currentClue.connectorId, connectorName: room.currentClue.connectorName } : null,
    clueHistory: room.clueHistory,
    countdownEndsAt: room.countdownEndsAt || null,
    submitted: room.submittedBy ? [...room.submittedBy.keys()].filter(id => room.submittedBy.get(id)) : [],
    burnedLast: room.burnedLast || null,
    hasSecret: !!room.secretWord,
    youAreHost: isHost,
    serverTime: Date.now(),
    winner: room.winner || null,
  };
  return st;
}
function broadcast(room, msg, exceptWs) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p.ws && p.ws !== exceptWs && p.ws.readyState === 1) p.ws.send(data);
  }
}
function sendTo(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function sysToRoom(room, text) { broadcast(room, { type: 'system', text, ts: Date.now() }); }
function errTo(ws, text) { sendTo(ws, { type: 'error', text, ts: Date.now() }); }
function pushState(room) { for (const p of room.players) if (p.ws && p.ws.readyState === 1) sendTo(p.ws, roomState(room, p.ws)); }

function resetRound(room) {
  room.phase = 'clue';
  room.currentClue = null;
  room.submittedBy = null;
  room.countdownEndsAt = null;
  if (room.countdownTimer) { clearTimeout(room.countdownTimer); room.countdownTimer = null; }
}
function newSecretRound(room) {
  room.clueHistory = [];
  room.burnedLast = null;
  resetRound(room);
}

/* ---------- Game logic ---------- */
function handleStartGame(room, room2) {
  newSecretRound(room2 || room);
}
function checkWin(room) {
  if (room.revealed === room.secretWord) {
    room.winner = room.lastConnectorName || 'بازیکنان';
    room.phase = 'ended';
    return true;
  }
  return false;
}
function startCountdown(room, clue) {
  room.phase = 'countdown';
  room.countdownEndsAt = Date.now() + 5000;
  if (room.countdownTimer) clearTimeout(room.countdownTimer);
  room.countdownTimer = setTimeout(() => {
    if (room.phase === 'countdown' && room.currentClue && room.currentClue.id === clue.id) {
      room.phase = 'submit';
      room.submittedBy = new Map([[clue.authorId, false], [clue.connectorId, false]]);
      room.countdownEndsAt = null;
      sysToRoom(room, '⏳ زمان تمام شد؛ حالا نویسندهٔ سرنخ و وصل‌کننده کلمهٔ مخفی را وارد کنید.');
      pushState(room);
    }
  }, 5000);
}
function burnClue(room, clue) {
  clue.burned = true;
  room.clueHistory.push(clue);
  room.burnedLast = { clueId: clue.id, guessText: room.lastDisconnectGuess || '' };
  room.lastDisconnectGuess = null;
  if (room.countdownTimer) { clearTimeout(room.countdownTimer); room.countdownTimer = null; }
  resetRound(room);
}

/* ---------- Message handling ---------- */
function handleMessage(ws, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return errTo(ws, 'پیام نامعتبر است.'); }
  const type = m.type;
  const info = clients.get(ws);

  if (type === 'create_room') {
    if (info && info.roomCode && rooms.has(info.roomCode)) return errTo(ws, 'قبلاً در اتاقی هستید.');
    const code = makeCode();
    const room = { code, players: [], hostId: null, phase: 'lobby', secretWord: null, revealed: '', clueHistory: [], currentClue: null, submittedBy: null, countdownEndsAt: null, countdownTimer: null, burnedLast: null, winner: null };
    const id = 'p' + Math.random().toString(36).slice(2, 9);
    const name = normalizeText(m.name) || 'میزبان';
    const player = { id, name, ws, connected: true };
    room.players.push(player);
    room.hostId = id;
    rooms.set(code, room);
    clients.set(ws, { roomCode: code, playerId: id });
    sendTo(ws, { type: 'room_created', roomCode: code, playerId: id });
    pushState(room);
    return;
  }

  if (type === 'join_room') {
    const code = String(m.roomCode || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return errTo(ws, 'اتاق پیدا نشد.');
    if (info && info.roomCode) return errTo(ws, 'قبلاً در اتاقی هستید.');
    if (room.players.length >= MAX_PLAYERS) return errTo(ws, 'اتاق پر است (حداکثر ۱۲ نفر).');
    const id = 'p' + Math.random().toString(36).slice(2, 9);
    const name = normalizeText(m.name) || ('بازیکن ' + (room.players.length + 1));
    room.players.push({ id, name, ws, connected: true });
    clients.set(ws, { roomCode: code, playerId: id });
    sendTo(ws, { type: 'joined', roomCode: code, playerId: id });
    sysToRoom(room, `«${name}» به بازی پیوست.`);
    pushState(room);
    return;
  }

  const c = clients.get(ws);
  if (!c || !rooms.has(c.roomCode)) return errTo(ws, 'در اتاقی نیستید.');
  const room = rooms.get(c.roomCode);
  const me = room.players.find(p => p.id === c.playerId);
  if (!me) return errTo(ws, 'بازیکن یافت نشد.');
  const isHost = room.hostId === me.id;

  if (type === 'set_secret') {
    if (!isHost) return errTo(ws, 'فقط میزبان می‌تواند کلمه را تعیین کند.');
    if (room.phase !== 'lobby' && room.phase !== 'ended' && room.phase !== 'playing') return errTo(ws, 'در این فاز نمی‌توان کلمه را تغییر داد.');
    const s = normalizeText(m.secret);
    if (s.length < 2) return errTo(ws, 'کلمهٔ مخفی باید حداقل ۲ نویسه باشد.');
    room.secretWord = s;
    room.revealed = '';
    newSecretRound(room);
    room.phase = 'lobby';
    sysToRoom(room, 'کلمهٔ مخفی تعیین شد. آمادهٔ شروع!');
    return pushState(room);
  }

  if (type === 'start_game') {
    if (!isHost) return errTo(ws, 'فقط میزبان می‌تواند بازی را شروع کند.');
    if (!room.secretWord) return errTo(ws, 'اول کلمهٔ مخفی را تعیین کنید.');
    const chars = [...room.secretWord];
    room.revealed = chars.slice(0, 1).join('');
    newSecretRound(room);
    room.phase = 'clue';
    sysToRoom(room, `بازی شروع شد! حرف اول آشکار شد: «${room.revealed}....»`);
    return pushState(room);
  }

  if (type === 'post_clue') {
    if (room.phase !== 'clue' && room.phase !== 'playing') return errTo(ws, 'الان وقت سرنخ دادن نیست.');
    const text = normalizeText(m.text);
    if (!text) return errTo(ws, 'سرنخ نمی‌تواند خالی باشد.');
    if (room.currentClue) return errTo(ws, 'یک سرنخ فعال وجود دارد.');
    const clue = { id: 'c' + Math.random().toString(36).slice(2, 9), text, authorId: me.id, authorName: me.name, connectorId: null, connectorName: null, burned: false, ts: Date.now() };
    room.currentClue = clue;
    room.phase = 'clue';
    sysToRoom(room, `💡 سرنخ از «${me.name}»: ${text}`);
    return pushState(room);
  }

  if (type === 'connect') {
    if (room.phase !== 'clue' || !room.currentClue) return errTo(ws, 'سرنخ فعالی برای اتصال وجود ندارد.');
    if (room.currentClue.authorId === me.id) return errTo(ws, 'نویسندهٔ سرنخ نمی‌تواند خودش وصل شود.');
    if (room.currentClue.connectorId) return errTo(ws, 'کسی قبلاً وصل شده است.');
    room.currentClue.connectorId = me.id;
    room.currentClue.connectorName = me.name;
    startCountdown(room, room.currentClue);
    sysToRoom(room, `🔗 «${me.name}» وصل شد! شمارش معکوس ۵ ثانیه‌ای...`);
    return pushState(room);
  }

  if (type === 'disconnect_guess') {
    if (!isHost) return errTo(ws, 'فقط میزبان می‌تواند حدس قطع اتصال بزند.');
    if (room.phase !== 'countdown' && room.phase !== 'clue') return errTo(ws, 'در این فاز حدس مجاز نیست.');
    if (!room.currentClue) return errTo(ws, 'سرنخ فعالی وجود ندارد.');
    const guess = normalizeText(m.guess);
    if (!guess) return errTo(ws, 'حدس خالی است.');
    const target = normalizeText(room.currentClue.underlying || guess); // underlying unknown; host guesses intent
    room.lastDisconnectGuess = guess;
    // The server cannot know the true intent of the clue; correctness = matches secret word prefix-intent.
    // Rule: guess must equal the (normalized) secret word to count as "سرنخ لو رفت".
    if (guess === normalizeText(room.secretWord)) {
      burnClue(room, room.currentClue);
      sysToRoom(room, `🔥 حدس میزبان درست بود؛ سرنخ سوخت!`);
      room.currentClue = null;
      return pushState(room);
    }
    return errTo(ws, 'حدس درست نبود؛ بازی ادامه دارد.');
  }

  if (type === 'submit_word') {
    if (room.phase !== 'submit' || !room.submittedBy) return errTo(ws, 'فاز پاسخ کور فعال نیست.');
    if (!room.submittedBy.has(me.id)) return errTo(ws, 'شما در این دور مجاز به پاسخ نیستید.');
    if (room.submittedBy.get(me.id)) return errTo(ws, 'شما قبلاً پاسخ داده‌اید.');
    const w = normalizeText(m.word);
    if (!w) return errTo(ws, 'پاسخ خالی است.');
    room.submittedBy.set(me.id, w);
    const vals = [...room.submittedBy.values()];
    if (vals.some(v => v === false)) {
      sysToRoom(room, `«${me.name}» پاسخ داد؛ منتظر بازیکن دیگر...`);
      return pushState(room);
    }
    // both submitted
    const [a, b] = vals;
    const clue = room.currentClue;
    if (clue) { clue.connectorId = clue.connectorId; room.clueHistory.push(clue); }
    room.currentClue = null;
    room.submittedBy = null;
    room.countdownEndsAt = null;
    if (a === b) {
      const chars = [...room.secretWord];
      const revLen = [...room.revealed].length;
      room.revealed = chars.slice(0, Math.min(revLen + 1, chars.length)).join('');
      room.lastConnectorName = clue ? clue.connectorName : me.name;
      if (checkWin(room)) {
        sysToRoom(room, `🎉 هر دو پاسخ یکسان بود! کلمه کامل آشکار شد. برندگان: نویسنده و وصل‌کننده.`);
      } else {
        sysToRoom(room, `✅ پاسخ‌ها یکسان بود! یک حرف آشکار شد: «${room.revealed}....»`);
        resetRound(room);
      }
    } else {
      sysToRoom(room, `❌ پاسخ‌ها متفاوت بود («${a}» / «${b}»). دور ریست شد.`);
      resetRound(room);
    }
    return pushState(room);
  }

  if (type === 'restart_round') {
    if (!isHost) return errTo(ws, 'فقط میزبان می‌تواند دور را ریست کند.');
    if (!room.secretWord) return errTo(ws, 'کلمه‌ای تعیین نشده است.');
    room.revealed = [...room.secretWord].slice(0, 1).join('');
    newSecretRound(room);
    room.phase = 'clue';
    sysToRoom(room, '🔄 دور ریست شد. حرف اول آشکار است.');
    return pushState(room);
  }

  if (type === 'end_game') {
    if (!isHost) return errTo(ws, 'فقط میزبان می‌تواند بازی را تمام کند.');
    room.phase = 'ended';
    room.winner = room.winner || null;
    if (room.countdownTimer) { clearTimeout(room.countdownTimer); room.countdownTimer = null; }
    sysToRoom(room, 'بازی توسط میزبان تمام شد.');
    return pushState(room);
  }

  return errTo(ws, 'نوع پیام شناخته نشده: ' + type);
}

/* ---------- Disconnect & host reassignment ---------- */
function handleDisconnect(ws) {
  const c = clients.get(ws);
  clients.delete(ws);
  if (!c) return;
  const room = rooms.get(c.roomCode);
  if (!room) return;
  const p = room.players.find(x => x.id === c.playerId);
  if (!p) return;
  p.ws = null; p.connected = false;
  sysToRoom(room, `«${p.name}» قطع شد.`);
  // Cancel any active round involving a disconnected author/connector.
  if (room.currentClue && (room.currentClue.authorId === p.id || room.currentClue.connectorId === p.id)) {
    room.clueHistory.push(room.currentClue);
    room.currentClue = null;
    if (room.countdownTimer) { clearTimeout(room.countdownTimer); room.countdownTimer = null; }
    room.countdownEndsAt = null;
    room.submittedBy = null;
    room.phase = 'clue';
    sysToRoom(room, 'یکی از بازیکنان سرنخ قطع شد؛ دور ریست شد.');
  }
  if (room.submittedBy && room.submittedBy.has(p.id)) {
    if (room.currentClue) room.clueHistory.push(room.currentClue);
    room.currentClue = null; room.submittedBy = null;
    resetRound(room);
    sysToRoom(room, 'یکی از پاسخ‌دهندگان قطع شد؛ دور ریست شد.');
  }
  room.players = room.players.filter(x => x.id !== p.id);
  if (room.players.length === 0) { rooms.delete(room.code); return; }
  if (room.hostId === p.id) {
    const next = room.players.find(x => x.connected);
    if (next) {
      room.hostId = next.id;
      sysToRoom(room, `👑 میزبان جدید: «${next.name}»`);
      sendTo(next.ws, { type: 'host_assigned', ts: Date.now() });
    } else {
      rooms.delete(room.code);
      return;
    }
  }
  pushState(room);
}

/* ---------- HTTP static server ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + urlPath);
  const rel = path.relative(PUBLIC_DIR, file);
  if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('یافت نشد'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => { try { handleMessage(ws, raw.toString()); } catch (e) { errTo(ws, 'خطای سرور: ' + e.message); } });
  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => {});
});

server.listen(PORT, () => console.log(`Contact server: http://localhost:${PORT}`));
