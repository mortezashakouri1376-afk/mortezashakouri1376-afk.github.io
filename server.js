const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// سرو کردن فایل‌های استاتیک از پوشه public
app.use(express.static(path.join(__dirname, 'public')));

// اتاق‌ها در حافظه سرور
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function broadcastState(room) {
  const state = {
    roomCode: room.code,
    hostId: room.hostId,
    phase: room.phase, // 'setup', 'clue', 'countdown', 'submit', 'ended'
    hasSecret: !!room.secretWord,
    wordLength: room.secretWord ? room.secretWord.length : 0,
    revealedPrefix: room.revealedPrefix || '',
    currentClue: room.currentClue,
    connectedPlayerId: room.connectedPlayerId,
    countdownEndsAt: room.countdownEndsAt,
    players: room.players.map(p => ({ id: p.id, name: p.name })),
    history: room.history || [],
    winnerMessage: room.winnerMessage || ''
  };

  const payload = JSON.stringify({ type: 'state', state });
  room.players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(payload);
    }
  });
}

function addHistory(room, author, text) {
  room.history.push({ author, text, time: Date.now() });
  if (room.history.length > 50) room.history.shift();
}

wss.on('connection', (ws) => {
  let currentPlayer = null;
  let currentRoom = null;

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return;
    }

    const { type } = data;

    // ۱. ساخت اتاق
    if (type === 'create_room') {
      const name = (data.name || 'کاربر').trim().slice(0, 15);
      let roomCode = generateRoomCode();
      while (rooms.has(roomCode)) {
        roomCode = generateRoomCode();
      }

      const playerId = 'p_' + Math.random().toString(36).substr(2, 9);
      currentPlayer = { id: playerId, name, ws };

      currentRoom = {
        code: roomCode,
        hostId: playerId,
        phase: 'setup',
        secretWord: '',
        revealedPrefix: '',
        currentClue: null,
        connectedPlayerId: null,
        countdownEndsAt: null,
        countdownTimer: null,
        players: [currentPlayer],
        history: [],
        winnerMessage: ''
      };

      rooms.set(roomCode, currentRoom);
      addHistory(currentRoom, 'سیستم', `اتاق توسط ${name} ساخته شد.`);

      ws.send(JSON.stringify({
        type: 'room_created',
        roomCode,
        playerId
      }));

      broadcastState(currentRoom);
      return;
    }

    // ۲. ورود به اتاق
    if (type === 'join_room') {
      const roomCode = (data.roomCode || '').toUpperCase().trim();
      const name = (data.name || 'کاربر').trim().slice(0, 15);
      const room = rooms.get(roomCode);

      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'اتاقی با این کد یافت نشد.' }));
        return;
      }

      const playerId = 'p_' + Math.random().toString(36).substr(2, 9);
      currentPlayer = { id: playerId, name, ws };
      currentRoom = room;

      room.players.push(currentPlayer);
      addHistory(room, 'سیستم', `${name} وارد اتاق شد.`);

      ws.send(JSON.stringify({
        type: 'joined',
        roomCode,
        playerId
      }));

      broadcastState(room);
      return;
    }

    // بررسی وجود اتاق برای سایر دستورات
    if (!currentRoom || !currentPlayer) return;

    // ۳. تعیین کلمه مخفی توسط میزبان
    if (type === 'set_secret' && currentPlayer.id === currentRoom.hostId) {
      const secret = (data.secret || '').trim();
      if (secret.length < 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'کلمه مخفی باید حداقل ۲ حرف باشد.' }));
        return;
      }
      currentRoom.secretWord = secret;
      currentRoom.revealedPrefix = secret.charAt(0);
      addHistory(currentRoom, 'سیستم', 'کلمه مخفی توسط میزبان ثبت شد.');
      broadcastState(currentRoom);
      return;
    }

    // ۴. شروع بازی
    if (type === 'start_game' && currentPlayer.id === currentRoom.hostId) {
      if (!currentRoom.secretWord) {
        ws.send(JSON.stringify({ type: 'error', message: 'ابتدا کلمه مخفی را وارد کنید.' }));
        return;
      }
      currentRoom.phase = 'clue';
      addHistory(currentRoom, 'سیستم', `بازی شروع شد! حرف اول: «${currentRoom.revealedPrefix}»`);
      broadcastState(currentRoom);
      return;
    }

    // ۵. ارسال راهنمایی (سرنخ)
    if (type === 'post_clue' && currentRoom.phase === 'clue') {
      if (currentPlayer.id === currentRoom.hostId) {
        ws.send(JSON.stringify({ type: 'error', message: 'میزبان نمی‌تواند راهنمایی بدهد!' }));
        return;
      }
      const clue = (data.clue || '').trim();
      if (!clue) return;

      currentRoom.currentClue = {
        playerId: currentPlayer.id,
        clueText: clue
      };
      addHistory(currentRoom, currentPlayer.name, `سرنخ: "${clue}"`);
      broadcastState(currentRoom);
      return;
    }

    // ۶. اعلام کانتکت توسط بازیکن دیگر
    if (type === 'connect' && currentRoom.phase === 'clue' && currentRoom.currentClue) {
      if (currentPlayer.id === currentRoom.hostId || currentPlayer.id === currentRoom.currentClue.playerId) {
        return;
      }

      currentRoom.connectedPlayerId = currentPlayer.id;
      currentRoom.phase = 'countdown';
      currentRoom.countdownEndsAt = Date.now() + 6000; // ۶ ثانیه زمان
      addHistory(currentRoom, 'سیستم', `⚡ ${currentPlayer.name} اعلام کانتکت کرد! تایمر معکوس شروع شد...`);
      broadcastState(currentRoom);

      if (currentRoom.countdownTimer) clearTimeout(currentRoom.countdownTimer);
      currentRoom.countdownTimer = setTimeout(() => {
        if (currentRoom.phase === 'countdown') {
          currentRoom.phase = 'submit';
          addHistory(currentRoom, 'سیستم', 'زمان تمام شد! دو بازیکن کلمات خود را تایپ کنند.');
          broadcastState(currentRoom);
        }
      }, 6000);
      return;
    }

    // ۷. حدس میزبان (دیس‌کانکت)
    if (type === 'disconnect_guess' && currentPlayer.id === currentRoom.hostId) {
      const guess = (data.guess || '').trim();
      addHistory(currentRoom, 'میزبان', `حدس میزبان: "${guess}"`);

      // لغو سرنخ و ریست
      if (currentRoom.countdownTimer) clearTimeout(currentRoom.countdownTimer);
      currentRoom.phase = 'clue';
      currentRoom.currentClue = null;
      currentRoom.connectedPlayerId = null;
      currentRoom.countdownEndsAt = null;
      addHistory(currentRoom, 'سیستم', 'میزبان مداخله کرد؛ دور این سرنخ پایان یافت.');
      broadcastState(currentRoom);
      return;
    }

    // ۸. ثبت کلمه نهایی توسط دو بازیکن کانتکت شده
    if (type === 'submit_word' && currentRoom.phase === 'submit') {
      const isClueGiver = currentRoom.currentClue && currentRoom.currentClue.playerId === currentPlayer.id;
      const isConnector = currentRoom.connectedPlayerId === currentPlayer.id;

      if (!isClueGiver && !isConnector) return;

      if (!currentRoom.submissions) currentRoom.submissions = {};
      currentRoom.submissions[currentPlayer.id] = (data.secret || '').trim().toLowerCase();

      // اگر هر دو نفر فرستادند
      const clueGiverId = currentRoom.currentClue.playerId;
      const connectorId = currentRoom.connectedPlayerId;

      if (currentRoom.submissions[clueGiverId] && currentRoom.submissions[connectorId]) {
        const word1 = currentRoom.submissions[clueGiverId];
        const word2 = currentRoom.submissions[connectorId];

        if (word1 === word2) {
          // کلمات یکی بودند -> فاش شدن یک حرف جدید از کلمه مخفی!
          const currentLen = currentRoom.revealedPrefix.length;
          if (currentLen < currentRoom.secretWord.length) {
            currentRoom.revealedPrefix = currentRoom.secretWord.slice(0, currentLen + 1);
          }

          addHistory(currentRoom, 'سیستم', `✅ کانتکت موفق! کلمه مشترک: "${word1}". یک حرف دیگر فاش شد.`);

          if (currentRoom.revealedPrefix.toLowerCase() === currentRoom.secretWord.toLowerCase()) {
            currentRoom.phase = 'ended';
            currentRoom.winnerMessage = `🎉 بازیکنان برنده شدند! کلمه مخفی: ${currentRoom.secretWord}`;
            addHistory(currentRoom, 'سیستم', currentRoom.winnerMessage);
          } else {
            currentRoom.phase = 'clue';
          }
        } else {
          addHistory(currentRoom, 'سیستم', `❌ کلمات یکسان نبودند! (${word1} در برابر ${word2})`);
          currentRoom.phase = 'clue';
        }

        currentRoom.currentClue = null;
        currentRoom.connectedPlayerId = null;
        currentRoom.submissions = {};
        broadcastState(currentRoom);
      }
      return;
    }

    // ۹. ریست یا شروع مجدد
    if (type === 'restart_round' && currentPlayer.id === currentRoom.hostId) {
      currentRoom.phase = 'setup';
      currentRoom.secretWord = '';
      currentRoom.revealedPrefix = '';
      currentRoom.currentClue = null;
      currentRoom.connectedPlayerId = null;
      currentRoom.submissions = {};
      addHistory(currentRoom, 'سیستم', 'بازی ریست شد. میزبان کلمه جدید انتخاب کند.');
      broadcastState(currentRoom);
    }
  });

  // هنگام قطع ارتباط بازیکن
  ws.on('close', () => {
    if (currentRoom && currentPlayer) {
      currentRoom.players = currentRoom.players.filter(p => p.id !== currentPlayer.id);
      addHistory(currentRoom, 'سیستم', `${currentPlayer.name} خارج شد.`);

      if (currentRoom.players.length === 0) {
        rooms.delete(currentRoom.code);
      } else if (currentRoom.hostId === currentPlayer.id) {
        // واگذاری میزبانی به نفر بعدی
        currentRoom.hostId = currentRoom.players[0].id;
        addHistory(currentRoom, 'سیستم', `${currentRoom.players[0].name} میزبان جدید شد.`);
        broadcastState(currentRoom);
      } else {
        broadcastState(currentRoom);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
