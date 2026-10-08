// سرور بازی «کانتکت» — نسخه اصلاح‌شده و مقاوم (CommonJS)
// Robust Node.js server for Persian multiplayer Contact game.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

// ---------------------------------------------------------------------------
// تنظیمات / Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');
const MAX_ROOMS = 100;
const MAX_PLAYERS = 12;
const MIN_PLAYERS_TO_START = 3;
const NAME_MAX = 15;
const COUNTDOWN_MS = 5000;
const SUBMIT_MS = 20000;
const WS_MAX_PAYLOAD = 8192;
const HISTORY_MAX = 60;
const HEARTBEAT_INTERVAL = 30000;
// سطل توکن: 8 پیام آنی، بازیابی 4 پیام در ثانیه / token bucket
const RATE_CAPACITY = 8;
const RATE_REFILL_PER_SEC = 4;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// فازهای مجاز بازی / canonical phases
const PHASES = ['setup', 'clue', 'countdown', 'submit', 'ended'];
function isPhase(p) { return PHASES.includes(p); }

// ---------------------------------------------------------------------------
// نرمال‌سازی متن فارسی / Normalization
// ---------------------------------------------------------------------------
function normalizeText(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .normalize('NFC')
    // نویسه‌های عرض-صفر و ZWJ/ZWNJ/ZWSP
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
    // اعراب عربی، کشیده، حروف بی‌صدا extra
    .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED]/g, '')
    .replace(/\u0640/g, '') // tatweel ـ
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    // NOTE: فاصله‌های معمولی حذف نمی‌شوند / ordinary spaces preserved
    .toLowerCase();
}

// فقط حروف الفبایی یونیکد (بدون فاصله و نشانه‌گذاری) / alphabetic-looking letters only
function validateWord(text, min, max) {
  const s = normalizeText(text);
  const cps = Array.from(s);
  if (cps.length < min || cps.length > max) return false;
  // هیچ فاصله/نشانه/عدد مجاز نیست؛ فقط حروف
  for (const ch of cps) {
    const cat = /\p{L}/u.test(ch);
    if (!cat) return false;
    if (/\s/u.test(ch)) return false;
  }
  return cps.every((ch) => !/[\p{P}\p{S}\p{N}\p{Z}]/u.test(ch));
}

function validateGameWord(text) { return validateWord(text, 2, 32); }
function validateSecret(text) { return validateWord(text, 2, 24); }
function validClue(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  const cps = Array.from(t);
  return t.length > 0 && cps.length <= 180;
}

// کد ۴-حرفی امن و بدون نویسه‌های مبهم / 4-char secure unambiguous code
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateRoomCode() {
  let code;
  do {
    code = '';
    const buf = crypto.randomBytes(4);
    for (let i = 0; i < 4; i++) code += CODE_CHARS[buf[i] % CODE_CHARS.length];
  } while (rooms.has(code));
  return code;
}

function safeName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const cps = Array.from(normalizeText(trimmed));
  if (cps.length < 1 || cps.length > NAME_MAX) return null;
  return trimmed.normalize('NFC');
}

// ---------------------------------------------------------------------------
// HTTP سرور — فقط index.html و فایل‌های .js/.css امن
// ---------------------------------------------------------------------------
function trySendFile(res, filePath, method) {
  fs.realpath(filePath, (realErr, realPath) => {
    if (realErr || !(realPath === PUBLIC_DIR || realPath.startsWith(PUBLIC_DIR + path.sep))) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('یافت نشد');
      return;
    }
    fs.readFile(realPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('یافت نشد');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    if (method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
    } else {
      res.writeHead(200, headers);
      res.end(data);
    }
    });
  });
}

const httpServer = http.createServer((req, res) => {
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    res.end('متد مجاز نیست');
    return;
  }

  let urlPath;
  const rawPath = (req.url || '/').split('?')[0];
  try {
    urlPath = decodeURIComponent(rawPath);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('درخواست نامعتبر');
    return;
  }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  // /healthz
  if (urlPath === '/healthz') {
    const body = JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(method === 'HEAD' ? undefined : body);
    return;
  }

  // جلوگیری از path traversal (raw و encode شده)
  if (urlPath.includes('\0') || urlPath.includes('..') || urlPath.includes('\\') || urlPath.includes('%') || /%2e|%2f|%5c/i.test(rawPath)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('درخواست نامعتبر');
    return;
  }
  const ext = path.extname(urlPath).toLowerCase();
  if (urlPath !== '/index.html' && !MIME_TYPES[ext]) {
    // فقط index.html یا فایل‌های .js/.css داخل public مجازند
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('یافت نشد');
    return;
  }

  const target = path.resolve(PUBLIC_DIR, '.' + urlPath);
  // هیچ فایلی خارج از public سرو نمی‌شود (حتی اگر وجود داشته باشد)
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ممنوع');
    return;
  }

  if (urlPath === '/index.html' && !fs.existsSync(INDEX_HTML)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('یافت نشد');
    return;
  }
  trySendFile(res, target, method);
});

// ---------------------------------------------------------------------------
// WebSocket سرور
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server: httpServer, maxPayload: WS_MAX_PAYLOAD });

// rooms: Map<code, room>
const rooms = new Map();
// clients: Map<ws, client>
const clients = new Map();

function now() { return Date.now(); }

function sendTo(client, data) {
  if (client && client.ws && client.ws.readyState === WebSocket.OPEN) {
    try { client.ws.send(JSON.stringify(data)); } catch { /* ignore */ }
  }
}
function sendToPlayer(player, data) { sendTo(player, data); }

function broadcastRoom(room, data, exceptId) {
  const payload = JSON.stringify(data);
  for (const p of room.players.values()) {
    if (exceptId && p.id === exceptId) continue;
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      try { p.ws.send(payload); } catch { /* ignore */ }
    }
  }
}

// state ارسالی به هر بازیکن — بدون افشای secret/answer
function sanitizeRoomState(room, forId) {
  const isHost = room.hostId === forId;
  const clue = room.currentClue
    ? {
        id: room.currentClue.id,
        authorId: room.currentClue.authorId,
        authorName: room.currentClue.authorName,
        clueText: room.currentClue.clueText,
        connectorId: room.currentClue.connectorId,
        connectorName: room.currentClue.connectorName,
        submittedIds: room.currentClue.submitted ? Array.from(room.currentClue.submitted.keys()) : [],
      }
    : null;
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    hasSecret: room.secret !== null,
    revealedPrefix: room.secret ? Array.from(room.secret).slice(0, room.revealedLength).join('') : '',
    wordLength: room.secret ? Array.from(room.secret).length : null,
    currentClue: clue,
    countdownEndsAt: room.countdownEndsAt,
    submitEndsAt: room.submitEndsAt,
    serverNow: now(),
    players: Array.from(room.players.values()).map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.id === room.hostId,
    })),
    history: room.history.slice(-HISTORY_MAX),
    winnerMessage: room.winnerMessage || null,
    hostSecret: isHost ? room.secret : undefined,
    finalSecret: room.phase === 'ended' ? room.secret : undefined,
  };
}

function broadcastState(room) {
  for (const p of room.players.values()) {
    sendToPlayer(p, { type: 'state', state: sanitizeRoomState(room, p.id) });
  }
}

function clearTimers(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  room.countdownEndsAt = null;
  room.submitEndsAt = null;
}

function pushHistory(room, entry) {
  room.history.push({ ...entry, at: now() });
  if (room.history.length > HISTORY_MAX) room.history.shift();
}

// ---------------------------------------------------------------------------
// حلقه بازی / Game logic
// ---------------------------------------------------------------------------
function resetRound(room) {
  clearTimers(room);
  room.phase = 'setup';
  room.secret = null;
  room.revealedLength = 0;
  room.currentClue = null;
  room.winnerMessage = null;
}

function resetRoundFor(room) { resetRound(room); }

function startCountdown(room) {
  clearTimers(room);
  room.phase = 'countdown';
  room.countdownEndsAt = now() + COUNTDOWN_MS;
  const gen = ++room.timerGeneration;
  broadcastRoom(room, {
    type: 'system',
    message: `⚡ ${room.currentClue.connectorName} کانتکت زد! ${COUNTDOWN_MS / 1000} ثانیه مهلت میزبان برای حدس.`,
  });
  broadcastState(room);
  room.timer = setTimeout(() => {
    if (room.timerGeneration !== gen || room.phase !== 'countdown' || !room.currentClue) return;
    // اگر میزبان تا پایان مهلت حدس نزد، وارد فاز submit شویم
    room.phase = 'submit';
    room.countdownEndsAt = null;
    room.submitEndsAt = now() + SUBMIT_MS;
    const gen2 = ++room.timerGeneration;
    room.currentClue.submitted = new Map();
    broadcastRoom(room, {
      type: 'system',
      message: '⏰ مهلت میزبان تمام شد؛ بازیکنان باید کلمه مورد نظرشان را ارسال کنند.',
    });
    broadcastState(room);
    room.timer = setTimeout(() => {
      if (room.timerGeneration !== gen2 || room.phase !== 'submit' || !room.currentClue) return;
      // پایان زمان submit — clue بدون افشای پاسخ ریست می‌شود
      finishSubmitTimeout(room);
    }, SUBMIT_MS);
  }, COUNTDOWN_MS);
}

function finishSubmitTimeout(room) {
  const clue = room.currentClue;
  clearTimers(room);
  room.phase = 'clue';
  room.currentClue = null;
  broadcastRoom(room, { type: 'system', message: '⏰ مهلت ثبت کلمه تمام شد؛ راهنمایی باطل شد.' });
  broadcastState(room);
}

function revealLetter(room) {
  room.revealedLength += 1;
  const secretCps = Array.from(room.secret);
  const full = room.revealedLength >= secretCps.length;
  const revealed = secretCps.slice(0, room.revealedLength).join('');
  if (full) {
    room.phase = 'ended';
    room.winnerMessage = `🏆 تبریک! کلمه اصلی «${room.secret}» کشف شد!`;
    clearTimers(room);
    room.currentClue = null;
    pushHistory(room, { kind: 'win', by: 'players' });
    broadcastRoom(room, { type: 'system', message: room.winnerMessage });
    broadcastState(room);
    return true;
  }
  room.phase = 'clue';
  room.currentClue = null;
  pushHistory(room, { kind: 'reveal', prefix: revealed });
  broadcastRoom(room, {
    type: 'system',
    message: `🎉 ارتباط برقرار شد! حرف جدید باز شد. حروف فعلی: «${revealed}»`,
  });
  broadcastState(room);
  return false;
}

// ---------------------------------------------------------------------------
// پردازش پیام‌ها / message processing
// ---------------------------------------------------------------------------
function processMessage(client, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString('utf8'));
  } catch {
    sendTo(client, { type: 'error', message: 'پیام نامعتبر (JSON نامعتبر).' });
    return;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg === null) {
    sendTo(client, { type: 'error', message: 'پیام باید یک object باشد.' });
    return;
  }
  if (typeof msg.action !== 'string' || !msg.action) {
    sendTo(client, { type: 'error', message: 'action نامعتبر است.' });
    return;
  }
  const action = msg.action;
  const me = client;
  const handler = HANDLERS[action];
  if (!handler) {
    sendTo(me, { type: 'error', message: `اقدام ناشناخته: ${action}` });
    return;
  }
  try {
    handler(me, msg);
  } catch (e) {
    // خطای محدود شده — جزئیات داخلی لو نمی‌رود
    sendTo(me, { type: 'error', message: 'خطای داخلی در پردازش درخواست.' });
  }
}

const HANDLERS = {
  // -- ایجاد اتاق --
  create_room(me, msg) {
    if (me.roomCode && rooms.has(me.roomCode)) {
      sendTo(me, { type: 'error', message: 'شما در یک اتاق هستید؛ ابتدا آن را ترک کنید.' });
      return;
    }
    const name = safeName(msg.name);
    if (!name) {
      sendTo(me, { type: 'error', message: `نام باید بین ۱ تا ${NAME_MAX} نویسه باشد.` });
      return;
    }
    if (rooms.size >= MAX_ROOMS) {
      sendTo(me, { type: 'error', message: 'سرور پر است؛ بعداً تلاش کنید.' });
      return;
    }
    const code = generateRoomCode();
    const room = {
      code,
      hostId: me.id,
      phase: 'setup',
      secret: null,               // store as string; revealedPrefix by codepoints
      revealedLength: 0,
      currentClue: null,
      timer: null,
      timerGeneration: 0,
      countdownEndsAt: null,
      submitEndsAt: null,
      history: [],
      winnerMessage: null,
      players: new Map(),
    };
    room.players.set(me.id, { id: me.id, name, ws: me.ws });
    me.roomCode = code;
    me.name = name;
    rooms.set(code, room);
    sendTo(me, { type: 'room_created', code, myId: me.id });
    broadcastState(room);
  },

  // -- پیوستن به اتاق --
  join_room(me, msg) {
    if (me.roomCode && rooms.has(me.roomCode)) {
      sendTo(me, { type: 'error', message: 'شما در یک اتاق هستید؛ ابتدا آن را ترک کنید.' });
      return;
    }
    const name = safeName(msg.name);
    if (!name) {
      sendTo(me, { type: 'error', message: `نام باید بین ۱ تا ${NAME_MAX} نویسه باشد.` });
      return;
    }
    const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
    const room = rooms.get(code);
    if (!room) {
      sendTo(me, { type: 'error', message: 'اتاقی با این کد یافت نشد.' });
      return;
    }
    if (room.players.has(me.id)) {
      sendTo(me, { type: 'error', message: 'شما قبلاً به این اتاق پیوسته‌اید.' });
      return;
    }
    if (room.players.size >= MAX_PLAYERS) {
      sendTo(me, { type: 'error', message: 'اتاق پر است.' });
      return;
    }
    room.players.set(me.id, { id: me.id, name, ws: me.ws });
    me.roomCode = code;
    me.name = name;
    pushHistory(room, { kind: 'join', playerId: me.id, playerName: name });
    broadcastRoom(room, { type: 'system', message: `👋 ${name} به اتاق پیوست.` });
    sendTo(me, { type: 'joined', code, myId: me.id });
    broadcastState(room);
  },

  // -- میزبان کلمه را تنظیم می‌کند (شروع نمی‌کند) --
  set_secret(me, msg) {
    const room = getRoom(me);
    if (!room) return;
    if (room.hostId !== me.id) {
      sendTo(me, { type: 'error', message: 'فقط میزبان می‌تواند کلمه را تنظیم کند.' });
      return;
    }
    if (room.phase !== 'setup') {
      sendTo(me, { type: 'error', message: 'تنها در فاز setup می‌توان کلمه را تنظیم کرد.' });
      return;
    }
    const word = typeof msg.word === 'string' ? msg.word.trim() : '';
    if (!validateSecret(word)) {
      sendTo(me, { type: 'error', message: 'کلمه باید ۲ تا ۲۴ حرف الفبایی بدون فاصله باشد.' });
      return;
    }
    room.secret = normalizeText(word); // ذخیره خصوصی روی سرور
    room.revealedLength = 1;
    // phase stays 'setup' — start_game starts the game
    broadcastRoom(room, {
      type: 'system',
      message: `🔒 کلمه تنظیم شد. حرف اول: «${Array.from(room.secret)[0]}» — آماده شروع بازی.`,
    });
    broadcastState(room);
  },

  // -- شروع بازی (میزبان، >=۳ بازیکن، secret وجود دارد) --
  start_game(me) {
    const room = getRoom(me);
    if (!room) return;
    if (room.hostId !== me.id) {
      sendTo(me, { type: 'error', message: 'فقط میزبان می‌تواند بازی را شروع کند.' });
      return;
    }
    if (room.phase !== 'setup') {
      sendTo(me, { type: 'error', message: 'بازی در فاز setup نیست.' });
      return;
    }
    if (!room.secret) {
      sendTo(me, { type: 'error', message: 'ابتدا کلمه را تنظیم کنید.' });
      return;
    }
    if (room.players.size < MIN_PLAYERS_TO_START) {
      sendTo(me, { type: 'error', message: `حداقل ${MIN_PLAYERS_TO_START} بازیکن لازم است.` });
      return;
    }
    room.phase = 'clue';
    broadcastRoom(room, {
      type: 'system',
      message: `🏁 بازی شروع شد! حرف اول: «${Array.from(room.secret)[0]}»`,
    });
    broadcastState(room);
  },

  // -- ارائه راهنمایی توسط غیرمیزبان --
  post_clue(me, msg) {
    const room = getRoom(me);
    if (!room) return;
    if (room.hostId === me.id) {
      sendTo(me, { type: 'error', message: 'میزبان نمی‌تواند راهنمایی بدهد.' });
      return;
    }
    if (room.phase !== 'clue') {
      sendTo(me, { type: 'error', message: 'الان نمی‌توانید راهنمایی بدهید.' });
      return;
    }
    if (room.currentClue) {
      sendTo(me, { type: 'error', message: 'راهنمایی فعالی وجود دارد.' });
      return;
    }
    const clueText = typeof msg.clueText === 'string' ? msg.clueText.trim() : '';
    const underlying = typeof msg.underlyingWord === 'string' ? msg.underlyingWord.trim() : '';
    if (!validClue(clueText)) {
      sendTo(me, { type: 'error', message: 'متن راهنمایی باید بین ۱ تا ۱۸۰ نویسه باشد.' });
      return;
    }
    if (!validateGameWord(underlying)) {
      sendTo(me, { type: 'error', message: 'کلمه باید ۲ تا ۳۲ حرف الفبایی بدون فاصله/نشانه باشد.' });
      return;
    }
    const secretCps = Array.from(room.secret);
    const prefix = normalizeText(secretCps.slice(0, room.revealedLength).join(''));
    if (!normalizeText(underlying).startsWith(prefix)) {
      sendTo(me, {
        type: 'error',
        message: `کلمه باید با «${secretCps.slice(0, room.revealedLength).join('')}» شروع شود.`,
      });
      return;
    }
    // ذخیره نرمال‌شده به‌عنوان target منجمد؛ متن اصلی هم نگه داشته می‌شود
    const clue = {
      id: crypto.randomUUID(),
      authorId: me.id,
      authorName: me.name,
      clueText,
      underlyingWord: normalizeText(underlying),
      connectorId: null,
      connectorName: null,
      submitted: null,
    };
    room.currentClue = clue;
    clearTimers(room);
    pushHistory(room, { kind: 'clue', clueId: clue.id, by: me.id, clueText });
    broadcastRoom(room, { type: 'system', message: `💡 راهنمایی از ${me.name}: «${clueText}»` });
    broadcastState(room);
  },

  // -- اتصال بازیکن به راهنمایی --
  connect(me) {
    const room = getRoom(me);
    if (!room) return;
    if (room.hostId === me.id) {
      sendTo(me, { type: 'error', message: 'میزبان در connect نقش ندارد.' });
      return;
    }
    if (room.phase !== 'clue' || !room.currentClue) {
      sendTo(me, { type: 'error', message: 'راهنمایی فعالی وجود ندارد.' });
      return;
    }
    if (msg.clueId !== room.currentClue.id) {
      sendTo(me, { type: 'error', message: 'شناسه راهنمایی قدیمی یا نامعتبر است.' });
      return;
    }
    if (room.currentClue.connectorId) {
      sendTo(me, { type: 'error', message: 'یک بازیکن قبلاً متصل شده است.' });
      return;
    }
    if (room.currentClue.authorId === me.id) {
      sendTo(me, { type: 'error', message: 'نویسنده راهنمایی نمی‌تواند به آن متصل شود.' });
      return;
    }
    room.currentClue.connectorId = me.id;
    room.currentClue.connectorName = me.name;
    pushHistory(room, { kind: 'connect', clueId: room.currentClue.id, by: me.id });
    startCountdown(room);
  },

  // -- دیس‌کانتکت حدس میزبان (در فاز clue یا countdown) --
  disconnect_guess(me, msg) {
    const room = getRoom(me);
    if (!room) return;
    if (room.hostId !== me.id) {
      sendTo(me, { type: 'error', message: 'فقط میزبان می‌تواند حدس بزند.' });
      return;
    }
    if (room.phase !== 'clue' && room.phase !== 'countdown') {
      sendTo(me, { type: 'error', message: 'در این فاز امکان حدس وجود ندارد.' });
      return;
    }
    if (!room.currentClue) {
      sendTo(me, { type: 'error', message: 'راهنمایی فعالی وجود ندارد.' });
      return;
    }
    if (msg.clueId !== room.currentClue.id) {
      sendTo(me, { type: 'error', message: 'شناسه راهنمایی قدیمی یا نامعتبر است.' });
      return;
    }
    const guess = typeof msg.guess === 'string' ? msg.guess.trim() : '';
    if (!validateGameWord(guess)) {
      sendTo(me, { type: 'error', message: 'حدس باید ۲ تا ۳۲ حرف الفبایی باشد.' });
      return;
    }
    const normGuess = normalizeText(guess);
    const target = room.currentClue.underlyingWord; // مقدار خصوصی سرور
    if (normGuess === target) {
      clearTimers(room);
      room.phase = 'clue';
      room.currentClue = null;
      pushHistory(room, { kind: 'disconnect', by: me.id });
      broadcastRoom(room, { type: 'system', message: '🚫 میزبان حدس درست زد و راهنمایی دیس‌کانتکت شد!' });
      broadcastState(room);
    } else {
      broadcastRoom(room, { type: 'system', message: '❌ حدس میزبان اشتباه بود!' });
    }
  },

  // -- ارسال کلمه نهایی (فقط author و connector در فاز submit) --
  submit_word(me, msg) {
    const room = getRoom(me);
    if (!room) return;
    const clue = room.currentClue;
    if (room.phase !== 'submit' || !clue) {
      sendTo(me, { type: 'error', message: 'الان زمان ثبت کلمه نیست.' });
      return;
    }
    if (me.id !== clue.authorId && me.id !== clue.connectorId) {
      sendTo(me, { type: 'error', message: 'شما مجاز به ثبت کلمه نیستید.' });
      return;
    }
    if (msg.clueId !== clue.id) {
      sendTo(me, { type: 'error', message: 'شناسه راهنمایی قدیمی یا نامعتبر است.' });
      return;
    }
    if (room.submitEndsAt && now() >= room.submitEndsAt) {
      finishSubmitTimeout(room);
      return;
    }
    const word = typeof msg.word === 'string' ? msg.word.trim() : '';
    if (!validateGameWord(word)) {
      sendTo(me, { type: 'error', message: 'کلمه باید ۲ تا ۳۲ حرف الفبایی بدون فاصله/نشانه باشد.' });
      return;
    }
    if (clue.submitted && clue.submitted.has(me.id)) {
      sendTo(me, { type: 'error', message: 'شما قبلاً کلمه‌تان را ثبت کرده‌اید؛ قابل تغییر نیست.' });
      return;
    }
    if (!clue.submitted) clue.submitted = new Map();
    clue.submitted.set(me.id, normalizeText(word)); // immutable once set

    if (clue.submitted.has(clue.authorId) && clue.submitted.has(clue.connectorId)) {
      const a = clue.submitted.get(clue.authorId);
      const c = clue.submitted.get(clue.connectorId);
      const prefix = normalizeText(Array.from(room.secret).slice(0, room.revealedLength).join(''));
      const aOk = a === c && a === clue.underlyingWord && a.startsWith(prefix);
      clearTimers(room);
      room.currentClue = null;
      if (aOk) {
        revealLetter(room);
      } else {
        room.phase = 'clue';
        pushHistory(room, { kind: 'mismatch', clueId: clue.id });
        broadcastRoom(room, { type: 'system', message: '❌ کلمات یکی نبودند یا با حروف باز‌شده مطابقت نداشتند! راهنمایی باطل شد.' });
        broadcastState(room);
      }
    } else {
      sendTo(me, { type: 'system', message: 'کلمه شما ثبت شد؛ در انتظار طرف مقابل…' });
    }
  },

  // -- ریست راند توسط میزبان --
  restart_round(me) {
    const room = getRoom(me);
    if (!room) return;
    if (room.hostId !== me.id) {
      sendTo(me, { type: 'error', message: 'فقط میزبان می‌تواند راند را ریست کند.' });
      return;
    }
    resetRound(room);
    pushHistory(room, { kind: 'restart', by: me.id });
    broadcastRoom(room, { type: 'system', message: '🔄 راند ریست شد؛ میزبان باید کلمه جدید تنظیم کند.' });
    broadcastState(room);
  },

  // -- پایان بازی توسط میزبان (فاش‌سازی secret) --
  end_game(me) {
    const room = getRoom(me);
    if (!room) return;
    if (room.hostId !== me.id) {
      sendTo(me, { type: 'error', message: 'فقط میزبان می‌تواند بازی را پایان دهد.' });
      return;
    }
    clearTimers(room);
    room.phase = 'ended';
    room.currentClue = null;
    pushHistory(room, { kind: 'end', by: me.id });
    broadcastRoom(room, {
      type: 'system',
      message: `🏁 بازی پایان یافت. کلمه اصلی: «${room.secret || '—'}»`,
    });
    broadcastState(room);
  },

  // -- ترک اتاق --
  leave_room(me) {
    const room = getRoom(me);
    if (!room) return;
    removePlayer(room, me.id, 'leave');
    me.roomCode = null;
    me.name = '';
  },
};

function getRoom(client) {
  if (!client.roomCode) return null;
  const room = rooms.get(client.roomCode);
  if (!room || !room.players.has(client.id)) return null; // عضویت بررسی می‌شود
  return room;
}

// ---------------------------------------------------------------------------
// حذف بازیکن / leave & cleanup
// ---------------------------------------------------------------------------
function removePlayer(room, playerId, reason) {
  const player = room.players.get(playerId);
  if (!player) return;
  room.players.delete(playerId);
  const wasHost = room.hostId === playerId;
  clearTimers(room);
  room.currentClue = null; // لغو امن راهنمایی فعال
  if (room.players.size === 0) {
    rooms.delete(room.code); // آخرین اتاق حذف می‌شود
    return;
  }
  if (wasHost) {
    // ارتقای اولین بازیکن باقی‌مانده و ریست setup
    const next = room.players.values().next().value;
    room.hostId = next.id;
    room.secret = null;
    room.revealedLength = 0;
    room.phase = 'setup';
    room.winnerMessage = null;
    pushHistory(room, { kind: 'host_left', newHostId: next.id, newHostName: next.name });
    broadcastRoom(room, {
      type: 'system',
      message: `👑 میزبان اتاق را ترک کرد؛ ${next.name} میزبان جدید است. کلمه باید دوباره تنظیم شود.`,
    });
  } else {
    const wasActive = room.phase === 'countdown' || room.phase === 'submit';
    if (wasActive) room.phase = 'clue';
    pushHistory(room, { kind: 'leave', playerId, reason });
    broadcastRoom(room, {
      type: 'system',
      message: `👋 ${player.name} اتاق را ترک کرد.`,
    });
  }
  // اگر در فاز فعال هستیم و بازیکن کمتر از حداقل شده، ریست کنیم
  if (room.players.size < MIN_PLAYERS_TO_START && (room.phase === 'clue' || room.phase === 'countdown' || room.phase === 'submit')) {
    room.secret = null;
    room.revealedLength = 0;
    room.phase = 'setup';
    room.winnerMessage = null;
    clearTimers(room);
    broadcastRoom(room, { type: 'system', message: '⚠️ بازیکنان کمتر از حداقل شدند؛ بازی ریست شد.' });
  }
  broadcastState(room);
}

// ---------------------------------------------------------------------------
// اتصال WebSocket / connection lifecycle
// ---------------------------------------------------------------------------
wss.on('connection', (ws) => {
  const id = crypto.randomUUID();
  const me = { id, ws, roomCode: null, name: '', tokens: RATE_CAPACITY, lastRefill: now(), alive: true };
  clients.set(ws, me);
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    // rate limit / token bucket
    const t = now();
    const elapsed = (t - me.lastRefill) / 1000;
    me.tokens = Math.min(RATE_CAPACITY, me.tokens + elapsed * RATE_REFILL_PER_SEC);
    me.lastRefill = t;
    if (me.tokens < 1) {
      sendTo(me, { type: 'error', message: 'پیام‌های بیش از حد؛ کمی صبر کنید.' });
      return;
    }
    me.tokens -= 1;
    processMessage(me, raw);
  });

  ws.on('close', () => {
    const room = me.roomCode ? rooms.get(me.roomCode) : null;
    if (room) removePlayer(room, me.id, 'disconnect');
    clients.delete(ws);
  });

  ws.on('error', () => {
    try { ws.terminate(); } catch { /* ignore */ }
  });
});

// heartbeat / ping-pong cleanup
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch { /* ignore */ } continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, HEARTBEAT_INTERVAL);
heartbeat.unref();

wss.on('close', () => clearInterval(heartbeat));

// ---------------------------------------------------------------------------
// Export (برای تست) / exports
// ---------------------------------------------------------------------------
module.exports = {
  server: httpServer,
  wss,
  rooms,
  normalizeText,
  validateWord,
  resetRound: resetRoundFor,
  processMessage,
};

if (require.main === module) {
  httpServer.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
  });
}
