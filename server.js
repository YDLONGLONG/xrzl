require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const GameEngine = require('./src/game/GameEngine');
const { getStandardProbConfig, getProbConfigMeta, PROB_CONFIG_META } = require('./src/config/prob-config');
const { SCRIPTS } = require('./src/config/game-config');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 历史记录内存存储
const gameHistory = [];
const MAX_HISTORY = 50;

function generateHistoryId() {
  return 'hist_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

function saveGameHistory(room, engine, allRoles) {
  const gs = room.gameState;
  if (!gs) return;
  
  const historyEntry = {
    id: generateHistoryId(),
    roomId: room.id,
    startedAt: room.startedAt || new Date(gs.dayCount === 0 ? Date.now() - 3600000 : Date.now()),
    endedAt: gs.endedAt || new Date(),
    winner: gs.winner,
    winReason: gs.winReason,
    playerCount: allRoles.length,
    players: allRoles,
    actionLog: gs.actionLog.slice(),
    chatLog: gs.chatLog ? gs.chatLog.slice() : []
  };
  
  gameHistory.unshift(historyEntry);
  if (gameHistory.length > MAX_HISTORY) {
    gameHistory.pop();
  }
  room.historyId = historyEntry.id;
}

// 历史记录 API
app.get('/api/history', (req, res) => {
  const list = gameHistory.map(h => ({
    id: h.id,
    startedAt: h.startedAt,
    endedAt: h.endedAt,
    winner: h.winner,
    winReason: h.winReason,
    playerCount: h.playerCount,
    players: h.players.map(p => ({
      name: p.name,
      seat: p.seat,
      roleName: p.roleName,
      team: p.team,
      isAlive: p.isAlive,
      isBot: p.isBot
    }))
  }));
  res.json({ success: true, history: list });
});

app.get('/api/history/:id', (req, res) => {
  const entry = gameHistory.find(h => h.id === req.params.id);
  if (!entry) {
    return res.status(404).json({ success: false, message: '历史记录不存在' });
  }
  res.json({ success: true, data: entry });
});

// 内存存储
const rooms = new Map();
const gameEngines = new Map();
const disconnectTimers = new Map(); // playerId -> timeout

const RECONNECT_TIMEOUT = 180000; // 3分钟重连窗口

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let id;
  do {
    id = '';
    for (let i = 0; i < 4; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(id));
  return id;
}

function getPlayerRoom(socketId) {
  for (const [roomId, room] of rooms) {
    if (room.players.has(socketId)) {
      return { roomId, room };
    }
  }
  return null;
}

// 根据昵称查找房间中的断线玩家
function findDisconnectedPlayer(room, name) {
  const targetName = name.trim().toLowerCase();
  for (const [, player] of room.players) {
    if (!player.isBot && !player.isConnected && player.name.toLowerCase() === targetName) {
      return player;
    }
  }
  return null;
}

function createPlayer(socketId, name) {
  return {
    id: socketId,
    name: name.trim().substring(0, 20),
    seat: -1,
    role: null,
    isAlive: true,
    isDead: false,
    isBot: false,
    deathNight: -1,
    deathDay: -1,
    hasNominated: false,
    wasNominatedToday: false,
    hasUsedDayAbility: false,
    isPoisoned: false,
    isProtected: false,
    abilityState: {},
    privateInfo: null,
    confirmed: false,
    voteToken: 0,
    isReady: false,
    isConnected: true,
    isDrunk: false,
    disconnectedAt: null
  };
}

// 更新所有对玩家ID的引用（重连时使用）
function replacePlayerId(room, engine, oldId, newId) {
  // 更新room.players Map
  const player = room.players.get(oldId);
  if (!player) return;
  room.players.delete(oldId);
  player.id = newId;
  room.players.set(newId, player);

  // 更新seats数组（引用的是对象本身，id已更新无需改动）

  // 更新hostId
  if (room.hostId === oldId) {
    room.hostId = newId;
  }

  // 更新confirmations Set
  if (room.confirmations && room.confirmations.has(oldId)) {
    room.confirmations.delete(oldId);
    room.confirmations.add(newId);
  }

  // 更新游戏状态中的引用
  if (engine && room.gameState) {
    const gs = room.gameState;
    if (gs.currentWakePlayerId === oldId) gs.currentWakePlayerId = newId;
    if (gs.currentDefensePlayerId === oldId) gs.currentDefensePlayerId = newId;

    // 更新nominations
    if (gs.nominations) {
      for (const nom of gs.nominations) {
        if (nom.nominatorId === oldId) nom.nominatorId = newId;
        if (nom.nomineeId === oldId) nom.nomineeId = newId;
        if (nom.votes && nom.votes instanceof Set) {
          if (nom.votes.has(oldId)) {
            nom.votes.delete(oldId);
            nom.votes.add(newId);
          }
        }
      }
    }

    // 更新currentVotes
    if (gs.currentVotes && gs.currentVotes[oldId] !== undefined) {
      gs.currentVotes[newId] = gs.currentVotes[oldId];
      delete gs.currentVotes[oldId];
    }

    // 更新deathsToAnnounce
    if (gs.deathsToAnnounce) {
      for (const d of gs.deathsToAnnounce) {
        if (d.playerId === oldId) d.playerId = newId;
      }
    }

    // 更新godViewPlayers
    if (engine.godViewPlayers && engine.godViewPlayers.has(oldId)) {
      engine.godViewPlayers.delete(oldId);
      engine.godViewPlayers.add(newId);
    }

    // 更新nightActions中的targetId
    if (gs.nightActions) {
      for (const [, action] of Object.entries(gs.nightActions)) {
        if (action && action.targetId === oldId) action.targetId = newId;
        if (action && action.targets) {
          action.targets = action.targets.map(tid => tid === oldId ? newId : tid);
        }
      }
    }

    // 更新red herring
    if (player.abilityState && player.abilityState.redHerring === oldId) {
      // red herring是其他玩家的abilityState，不需要改（引用的是其他玩家）
    }
  }

  // 更新disconnectTimers
  if (disconnectTimers.has(oldId)) {
    const timer = disconnectTimers.get(oldId);
    disconnectTimers.delete(oldId);
    disconnectTimers.set(newId, timer);
  }
}

function broadcastRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const engine = gameEngines.get(roomId);

  for (const [pid] of room.players) {
    if (!room.players.get(pid).isConnected) continue; // 不向断线玩家发送
    if (engine && room.gameStarted) {
      io.to(pid).emit('game:stateUpdate', engine.getPlayerState(pid));
    } else {
      const players = Array.from(room.players.values()).map(p => ({
        id: p.id, name: p.name, seat: p.seat, isAlive: p.isAlive, isDead: p.isDead,
        isHost: p.id === room.hostId, isReady: p.isReady, voteToken: p.voteToken,
        isConnected: p.isConnected, isBot: !!p.isBot
      }));
      io.to(pid).emit('room:stateUpdate', {
        roomId: room.id, hostId: room.hostId, players,
        seats: room.seats.map(s => s ? s.id : null),
        gameStarted: false, phase: 'LOBBY',
        isHost: pid === room.hostId,
        script: room.script || 'tb',
        scriptList: Object.values(SCRIPTS).map(s => ({ id: s.id, name: s.name })),
        probConfig: pid === room.hostId ? JSON.parse(JSON.stringify(room.probConfig)) : null,
        probConfigMeta: pid === room.hostId ? getProbConfigMeta(room.script || 'tb') : null,
        probMode: pid === room.hostId ? room.probMode : null
      });
    }
  }
}

function actuallyRemovePlayer(socketId) {
  const result = getPlayerRoom(socketId);
  if (!result) {
    // 可能已经重连（id变了），尝试从所有房间找
    for (const [rid, room] of rooms) {
      for (const [pid, p] of room.players) {
        if (p.id === socketId || pid === socketId) {
          removePlayerFromRoom(rid, pid);
          return;
        }
      }
    }
    return;
  }
  removePlayerFromRoom(result.roomId, socketId);
}

// 强制移除玩家（含机器人），供房主踢人使用
function forceRemovePlayer(roomId, playerId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const player = room.players.get(playerId);
  if (!player) return;

  // 清除重连计时器
  if (disconnectTimers.has(playerId)) {
    clearTimeout(disconnectTimers.get(playerId));
    disconnectTimers.delete(playerId);
  }

  // 清座位
  if (player.seat !== -1) {
    room.seats[player.seat] = null;
  }
  room.players.delete(playerId);

  // 更新房主
  if (room.hostId === playerId && room.players.size > 0) {
    const humanPlayers = Array.from(room.players.values()).filter(p => !p.isBot && p.isConnected);
    room.hostId = humanPlayers.length > 0 ? humanPlayers[0].id : room.players.keys().next().value;
  }

  // 房间空了则销毁
  const connectedHumans = Array.from(room.players.values()).filter(p => !p.isBot && p.isConnected);
  if (connectedHumans.length === 0) {
    rooms.delete(roomId);
    if (gameEngines.has(roomId)) {
      const engine = gameEngines.get(roomId);
      if (engine.botManager) {
        for (const [, p] of room.players) {
          if (p._botTimer) clearTimeout(p._botTimer);
        }
      }
      gameEngines.delete(roomId);
    }
    return;
  }

  broadcastRoomState(roomId);
}

function removePlayerFromRoom(roomId, playerId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const player = room.players.get(playerId);
  if (!player) return;
  if (player.isBot) return;

  // 清除重连计时器
  if (disconnectTimers.has(playerId)) {
    clearTimeout(disconnectTimers.get(playerId));
    disconnectTimers.delete(playerId);
  }

  // 清座位
  if (player.seat !== -1) {
    room.seats[player.seat] = null;
  }
  room.players.delete(playerId);

  // 更新房主
  if (room.hostId === playerId && room.players.size > 0) {
    const humanPlayers = Array.from(room.players.values()).filter(p => !p.isBot && p.isConnected);
    room.hostId = humanPlayers.length > 0 ? humanPlayers[0].id : room.players.keys().next().value;
  }

  // 房间空了则销毁
  const connectedHumans = Array.from(room.players.values()).filter(p => !p.isBot && p.isConnected);
  if (connectedHumans.length === 0) {
    rooms.delete(roomId);
    if (gameEngines.has(roomId)) {
      const engine = gameEngines.get(roomId);
      if (engine.botManager) {
        // 清除所有bot计时器
        for (const [, p] of room.players) {
          if (p._botTimer) clearTimeout(p._botTimer);
        }
      }
      gameEngines.delete(roomId);
    }
    return;
  }

  broadcastRoomState(roomId);
}

function handleDisconnect(socket) {
  const result = getPlayerRoom(socket.id);
  if (!result) return;
  const { roomId, room } = result;
  const player = room.players.get(socket.id);

  if (!player || player.isBot) return;

  // 清理语音频道
  removeUserFromVoiceChannel(roomId, socket.id);

  player.isConnected = false;
  player.disconnectedAt = Date.now();

  const engine = gameEngines.get(roomId);

  // 通知其他玩家该玩家断线
  io.to(roomId).emit('room:playerDisconnected', { playerId: socket.id, name: player.name });

  if (room.gameStarted) {
    // 游戏中断线：设置超时移除，并让BotManager托管
    const timer = setTimeout(() => {
      actuallyRemovePlayer(socket.id);
    }, RECONNECT_TIMEOUT);
    disconnectTimers.set(socket.id, timer);

    // 让BotManager托管该断线玩家
    if (engine && engine.botManager) {
      engine.botManager.notifyAllBots();
    }

    // 玩家断线后，检查确认进度是否已满足（防止最后一个未确认的人断线后卡住）
    if (engine && engine.checkConfirmations) {
      engine.checkConfirmations();
    }

    broadcastRoomState(roomId);
  } else {
    // 大厅中断线：立即移除（大厅重连意义不大，保留座位会导致座位被占）
    if (player.seat !== -1) {
      room.seats[player.seat] = null;
    }
    room.players.delete(socket.id);

    if (room.hostId === socket.id && room.players.size > 0) {
      const humanPlayers = Array.from(room.players.values()).filter(p => !p.isBot);
      room.hostId = humanPlayers.length > 0 ? humanPlayers[0].id : room.players.keys().next().value;
    }

    if (room.players.size === 0 || Array.from(room.players.values()).every(p => p.isBot)) {
      rooms.delete(roomId);
      gameEngines.delete(roomId);
      return;
    }
    broadcastRoomState(roomId);
  }

  socket.leave(roomId);
}

// ========== 房间语音（WebRTC信令） ==========
const voiceChannels = new Map(); // roomId -> Set<socketId>

function getVoiceChannel(roomId) {
  if (!voiceChannels.has(roomId)) {
    voiceChannels.set(roomId, new Set());
  }
  return voiceChannels.get(roomId);
}

function broadcastVoiceUsers(roomId) {
  const channel = voiceChannels.get(roomId);
  if (!channel) return;
  const room = rooms.get(roomId);
  const users = [];
  for (const sid of channel) {
    const player = room && room.players.get(sid);
    if (player) {
      users.push({ id: sid, name: player.name, seat: player.seat });
    }
  }
  io.to(roomId).emit('voice:users', { users });
}

function removeUserFromVoiceChannel(roomId, socketId) {
  const channel = voiceChannels.get(roomId);
  if (!channel || !channel.has(socketId)) return;
  channel.delete(socketId);
  for (const sid of channel) {
    io.to(sid).emit('voice:userLeft', { userId: socketId });
  }
  broadcastVoiceUsers(roomId);
}

// ========== Socket.IO 事件处理 ==========
io.on('connection', (socket) => {
  console.log('玩家连接:', socket.id);

  // 创建房间
  socket.on('room:create', ({ playerName }) => {
    if (!playerName || !playerName.trim()) {
      socket.emit('room:error', { message: '请输入昵称' });
      return;
    }
    const roomId = generateRoomId();
    const room = {
      id: roomId, players: new Map(), seats: new Array(15).fill(null),
      hostId: socket.id, gameStarted: false, gameState: null,
      maxPlayers: 15, minPlayers: 5, confirmations: new Set(), createdAt: new Date(),
      probConfig: getStandardProbConfig('tb'),
      probMode: 'standard',
      script: 'tb'
    };
    const player = createPlayer(socket.id, playerName);
    room.players.set(socket.id, player);
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.emit('room:created', { roomId, playerId: socket.id });
    // 保存到sessionStorage（客户端做）
    broadcastRoomState(roomId);
  });

  // 加入房间（支持重连）
  socket.on('room:join', ({ roomId, playerName, isReconnect }) => {
    roomId = (roomId || '').toUpperCase().trim();
    if (!playerName || !playerName.trim()) {
      socket.emit('room:error', { message: '请输入昵称' });
      return;
    }
    if (!roomId || roomId.length !== 4) {
      socket.emit('room:error', { message: '请输入4位房间码' });
      return;
    }
    const room = rooms.get(roomId);
    if (!room) { socket.emit('room:error', { message: '房间不存在' }); return; }

    // 检查是否是断线重连
    const disconnectedPlayer = findDisconnectedPlayer(room, playerName);
    if (disconnectedPlayer) {
      const oldId = disconnectedPlayer.id;
      const engine = gameEngines.get(roomId);

      // 清除重连计时器
      if (disconnectTimers.has(oldId)) {
        clearTimeout(disconnectTimers.get(oldId));
        disconnectTimers.delete(oldId);
      }

      // 更新所有ID引用
      replacePlayerId(room, engine, oldId, socket.id);

      disconnectedPlayer.isConnected = true;
      disconnectedPlayer.disconnectedAt = null;

      socket.join(roomId);
      socket.emit('room:reconnected', {
        roomId,
        playerId: socket.id,
        gameStarted: room.gameStarted
      });

      console.log(`玩家重连: ${disconnectedPlayer.name} (${oldId} -> ${socket.id})`);
      io.to(roomId).emit('room:playerReconnected', { playerId: socket.id, name: disconnectedPlayer.name });

      // 如果是上帝视角玩家，需要重新加入godView
      // （客户端会重新登录上帝视角）

      broadcastRoomState(roomId);
      return;
    }

    // 正常加入
    if (room.gameStarted) { socket.emit('room:error', { message: '游戏已开始，若你是断线玩家请使用相同昵称重连' }); return; }
    if (room.players.size >= room.maxPlayers) { socket.emit('room:error', { message: '房间已满' }); return; }

    const nameExists = Array.from(room.players.values()).some(
      p => p.name.toLowerCase() === playerName.trim().toLowerCase() && p.isConnected
    );
    if (nameExists) { socket.emit('room:error', { message: '昵称已被使用' }); return; }

    const player = createPlayer(socket.id, playerName);
    room.players.set(socket.id, player);
    socket.join(roomId);
    socket.emit('room:joined', { roomId, playerId: socket.id });
    broadcastRoomState(roomId);
  });

  // 选择座位
  socket.on('room:seat', ({ seatNumber }) => {
    const result = getPlayerRoom(socket.id);
    if (!result) { socket.emit('room:error', { message: '你不在房间中' }); return; }
    const { roomId, room } = result;
    if (room.gameStarted) { socket.emit('room:error', { message: '游戏已开始' }); return; }

    seatNumber = parseInt(seatNumber);
    if (isNaN(seatNumber) || seatNumber < 0 || seatNumber >= 15) {
      socket.emit('room:error', { message: '无效座位号' }); return;
    }

    const player = room.players.get(socket.id);
    if (player.seat === seatNumber) {
      room.seats[seatNumber] = null;
      player.seat = -1;
      player.isReady = false;
    } else if (room.seats[seatNumber] === null) {
      if (player.seat !== -1) room.seats[player.seat] = null;
      room.seats[seatNumber] = player;
      player.seat = seatNumber;
      player.isReady = false;
    } else {
      socket.emit('room:error', { message: '座位已被占用' }); return;
    }
    broadcastRoomState(roomId);
  });

  // 准备/取消准备
  socket.on('room:toggleReady', () => {
    const result = getPlayerRoom(socket.id);
    if (!result) return;
    const { roomId, room } = result;
    if (room.gameStarted) return;
    const player = room.players.get(socket.id);
    if (player.seat === -1) { socket.emit('room:error', { message: '请先选择座位' }); return; }
    player.isReady = !player.isReady;
    broadcastRoomState(roomId);
  });

  // 切换剧本（仅房主，游戏未开始时）
  socket.on('room:setScript', ({ scriptId }) => {
    const result = getPlayerRoom(socket.id);
    if (!result) return;
    const { roomId, room } = result;
    if (room.hostId !== socket.id) { socket.emit('room:error', { message: '只有房主可以切换剧本' }); return; }
    if (room.gameStarted) { socket.emit('room:error', { message: '游戏已开始，无法切换剧本' }); return; }
    if (!SCRIPTS[scriptId]) { socket.emit('room:error', { message: '无效的剧本' }); return; }
    if (room.script === scriptId) return;
    room.script = scriptId;
    // 切换剧本时重置概率配置为对应剧本的默认值
    room.probConfig = getStandardProbConfig(scriptId);
    room.probMode = 'standard';
    const engine = gameEngines.get(roomId);
    if (engine) engine.probConfig = room.probConfig;
    broadcastRoomState(roomId);
  });

  // 添加AI机器人（仅房主）
  socket.on('room:addBot', () => {
    const result = getPlayerRoom(socket.id);
    if (!result) return;
    const { roomId, room } = result;
    if (room.hostId !== socket.id) { socket.emit('room:error', { message: '只有房主可以添加机器人' }); return; }
    if (room.gameStarted) { socket.emit('room:error', { message: '游戏已开始' }); return; }
    if (room.players.size >= 15) { socket.emit('room:error', { message: '房间已满' }); return; }

    const botNames = ['豆包', '通义千问', '文心一言', '混元', 'MiMo', 'DeepSeek', 'GLM', 'Kimi', 'MiniMax', '科大讯飞', 'GPT', 'Claude', 'Gemini', 'Grok'];
    const usedNames = new Set(Array.from(room.players.values()).map(p => p.name));
    const available = botNames.filter(n => !usedNames.has(n));
    if (available.length === 0) { socket.emit('room:error', { message: '机器人名字用完了' }); return; }

    let seatNum = -1;
    for (let i = 0; i < 15; i++) {
      if (room.seats[i] === null) { seatNum = i; break; }
    }
    if (seatNum === -1) { socket.emit('room:error', { message: '没有空座位' }); return; }

    const botId = 'bot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const bot = {
      id: botId,
      name: available[0],
      seat: seatNum,
      isHost: false,
      isReady: true,
      isAlive: true,
      isDead: false,
      isBot: true,
      voteToken: 0,
      role: null,
      isPoisoned: false,
      isProtected: false,
      isDrunk: false,
      hasNominated: false,
      wasNominatedToday: false,
      hasUsedDayAbility: false,
      deathNight: -1,
      deathDay: -1,
      abilityState: {},
      privateInfo: null,
      confirmed: false,
      isConnected: true,
      disconnectedAt: null
    };
    room.players.set(botId, bot);
    room.seats[seatNum] = bot;
    broadcastRoomState(roomId);
  });

  // 房主踢出玩家/机器人
  socket.on('room:kick', ({ targetId }) => {
    const result = getPlayerRoom(socket.id);
    if (!result) return;
    const { roomId, room } = result;
    if (room.hostId !== socket.id) { socket.emit('room:error', { message: '只有房主可以踢人' }); return; }
    if (room.gameStarted) { socket.emit('room:error', { message: '游戏已开始，无法踢人' }); return; }
    const target = room.players.get(targetId);
    if (!target) { socket.emit('room:error', { message: '玩家不存在' }); return; }
    if (target.id === socket.id) { socket.emit('room:error', { message: '不能踢出自己' }); return; }
    if (target.isHost) { socket.emit('room:error', { message: '不能踢出房主' }); return; }

    if (target.isBot) {
      forceRemovePlayer(roomId, targetId);
    } else {
      // 踢出真实玩家：通知对方被踢，然后移除
      io.to(targetId).emit('room:kicked', { message: '你已被房主踢出房间' });
      // 清除重连计时器
      if (disconnectTimers.has(targetId)) {
        clearTimeout(disconnectTimers.get(targetId));
        disconnectTimers.delete(targetId);
      }
      const targetSocket = io.sockets.sockets.get(targetId);
      if (targetSocket) {
        targetSocket.leave(roomId);
      }
      forceRemovePlayer(roomId, targetId);
    }
  });

  // 离开房间
  socket.on('room:leave', () => {
    const result = getPlayerRoom(socket.id);
    if (!result) return;
    const { roomId, room } = result;
    const player = room.players.get(socket.id);
    if (!player || player.isBot) return;

    // 清理语音频道
    removeUserFromVoiceChannel(roomId, socket.id);

    if (player.isConnected === false) {
      // 已经是断线状态（可能正在等待重连超时），直接彻底移除
      removePlayerFromRoom(roomId, socket.id);
      socket.leave(roomId);
      return;
    }

    if (room.gameStarted) {
      const engine = gameEngines.get(roomId);
      const gs = engine ? engine.room.gameState : null;
      // 游戏结束时离开，直接移除（不需要重连）
      if (gs && gs.phase === 'GAME_OVER') {
        if (disconnectTimers.has(socket.id)) {
          clearTimeout(disconnectTimers.get(socket.id));
          disconnectTimers.delete(socket.id);
        }
        removePlayerFromRoom(roomId, socket.id);
        socket.leave(roomId);
        return;
      }
      // 游戏中主动离开：视同断线，保留数据允许重连
      player.isConnected = false;
      player.disconnectedAt = Date.now();

      io.to(roomId).emit('room:playerDisconnected', { playerId: socket.id, name: player.name });

      const timer = setTimeout(() => {
        actuallyRemovePlayer(socket.id);
      }, RECONNECT_TIMEOUT);
      disconnectTimers.set(socket.id, timer);

      if (engine && engine.botManager) {
        engine.botManager.notifyAllBots();
      }

      // 玩家离开后，检查确认进度是否已满足（防止最后一个未确认的人离开后卡住）
      if (engine && engine.checkConfirmations) {
        engine.checkConfirmations();
      }

      broadcastRoomState(roomId);
      socket.leave(roomId);
    } else {
      // 大厅阶段离开：立即移除
      if (disconnectTimers.has(socket.id)) {
        clearTimeout(disconnectTimers.get(socket.id));
        disconnectTimers.delete(socket.id);
      }
      removePlayerFromRoom(roomId, socket.id);
      socket.leave(roomId);
    }
  });

  // ========== 房间语音（WebRTC信令） ==========
  // 加入语音频道
  socket.on('voice:join', () => {
    const result = getPlayerRoom(socket.id);
    if (!result) return;
    const { roomId, room } = result;
    const player = room.players.get(socket.id);
    if (!player) return;

    const channel = getVoiceChannel(roomId);
    if (channel.has(socket.id)) return; // 已在频道中

    // 通知频道内已有用户：有新用户加入
    for (const sid of channel) {
      io.to(sid).emit('voice:userJoined', { userId: socket.id, name: player.name });
    }

    channel.add(socket.id);
    broadcastVoiceUsers(roomId);
  });

  // 离开语音频道
  socket.on('voice:leave', () => {
    const result = getPlayerRoom(socket.id);
    if (!result) return;
    const { roomId } = result;
    const channel = voiceChannels.get(roomId);
    if (!channel || !channel.has(socket.id)) return;

    channel.delete(socket.id);
    // 通知其他用户
    for (const sid of channel) {
      io.to(sid).emit('voice:userLeft', { userId: socket.id });
    }
    broadcastVoiceUsers(roomId);
  });

  // WebRTC信令转发（offer/answer/candidate）
  socket.on('voice:signal', ({ targetId, type, data }) => {
    // 转发给目标用户
    io.to(targetId).emit('voice:signal', { fromId: socket.id, type, data });
  });

  // 静音状态广播
  socket.on('voice:mute', ({ muted }) => {
    const result = getPlayerRoom(socket.id);
    if (!result) return;
    const { roomId } = result;
    io.to(roomId).emit('voice:muteState', { userId: socket.id, muted });
  });

  // 说话状态广播（语音活动检测）
  socket.on('voice:speaking', ({ speaking }) => {
    const result = getPlayerRoom(socket.id);
    if (!result) return;
    const { roomId } = result;
    io.to(roomId).emit('voice:speakingState', { userId: socket.id, speaking });
  });

  socket.on('disconnect', () => handleDisconnect(socket));

  // 开始游戏
  socket.on('game:start', (data = {}) => {
    const result = getPlayerRoom(socket.id);
    if (!result) return;
    const { roomId, room } = result;
    if (room.hostId !== socket.id) { socket.emit('room:error', { message: '只有房主可以开始' }); return; }
    if (room.gameStarted) { socket.emit('room:error', { message: '游戏已在进行中' }); return; }

    const seated = Array.from(room.players.values()).filter(p => p.seat !== -1);
    if (seated.length < room.minPlayers) {
      socket.emit('room:error', { message: `至少需要${room.minPlayers}人入座` }); return;
    }
    const notReady = seated.filter(p => !p.isReady && !p.isBot);
    if (notReady.length > 0) {
      socket.emit('room:error', { message: `还有${notReady.length}人未准备` }); return;
    }

    const customRoles = data.customRoles || {};
    const engine = new GameEngine(room, io, (allRoles) => {
      saveGameHistory(room, engine, allRoles);
    });
    gameEngines.set(roomId, engine);
    room.gameStarted = true;
    engine.startGame(customRoles);
    broadcastRoomState(roomId);
  });

  // 确认进入下一阶段
  socket.on('game:confirm', () => {
    const result = getPlayerRoom(socket.id);
    if (!result || !result.room.gameStarted) return;
    const { roomId } = result;
    const engine = gameEngines.get(roomId);
    if (engine) {
      engine.processConfirmation(socket.id);
      broadcastRoomState(roomId);
    }
  });

  // 夜晚行动
  socket.on('night:action', (data = {}) => {
    const result = getPlayerRoom(socket.id);
    if (!result || !result.room.gameStarted) return;
    const { roomId } = result;
    const engine = gameEngines.get(roomId);
    if (engine) {
      const res = engine.processNightAction(socket.id, data);
      if (!res.success) {
        socket.emit('room:error', { message: res.message });
      } else {
        broadcastRoomState(roomId);
      }
    }
  });

  // 提名玩家
  socket.on('day:nominates', ({ targetId }) => {
    const result = getPlayerRoom(socket.id);
    if (!result || !result.room.gameStarted) return;
    const { roomId } = result;
    const engine = gameEngines.get(roomId);
    if (engine) {
      const res = engine.processNomination(socket.id, targetId);
      if (!res.success) {
        socket.emit('room:error', { message: res.message });
      } else {
        broadcastRoomState(roomId);
      }
    }
  });

  // 结束辩护
  socket.on('day:endDefense', () => {
    const result = getPlayerRoom(socket.id);
    if (!result || !result.room.gameStarted) return;
    const { roomId } = result;
    const engine = gameEngines.get(roomId);
    if (engine) {
      const res = engine.endDefense(socket.id);
      if (!res.success) {
        socket.emit('room:error', { message: res.message });
      } else {
        broadcastRoomState(roomId);
      }
    }
  });

  // 投票
  socket.on('day:vote', ({ vote }) => {
    const result = getPlayerRoom(socket.id);
    if (!result || !result.room.gameStarted) return;
    const { roomId } = result;
    const engine = gameEngines.get(roomId);
    if (engine) {
      const res = engine.processVote(socket.id, vote);
      if (!res.success) {
        socket.emit('room:error', { message: res.message });
      } else {
        broadcastRoomState(roomId);
      }
    }
  });

  // 撤回投票
  socket.on('day:revokeVote', () => {
    const result = getPlayerRoom(socket.id);
    if (!result || !result.room.gameStarted) return;
    const { roomId } = result;
    const engine = gameEngines.get(roomId);
    if (engine) {
      const res = engine.revokeVote(socket.id);
      if (!res.success) {
        socket.emit('room:error', { message: res.message });
      } else {
        broadcastRoomState(roomId);
      }
    }
  });

  // 结束投票
  socket.on('day:endVoting', () => {
    const result = getPlayerRoom(socket.id);
    if (!result || !result.room.gameStarted) return;
    const { roomId } = result;
    const engine = gameEngines.get(roomId);
    if (engine) {
      engine.endVoting();
      broadcastRoomState(roomId);
    }
  });

  // 使用白天技能
  socket.on('day:useAbility', ({ abilityName, targetId, extra, statement }) => {
    const result = getPlayerRoom(socket.id);
    if (!result || !result.room.gameStarted) return;
    const { roomId, room } = result;
    const engine = gameEngines.get(roomId);
    if (engine) {
      let param = extra;
      if (abilityName === 'gossip') {
        param = statement || extra;
      }
      const res = engine.processDayAbility(socket.id, abilityName, targetId, param);
      if (!res.success) {
        socket.emit('room:error', { message: res.message });
      } else {
        if (abilityName === 'gossip' && res.statement) {
          const player = room.players.get(socket.id);
          const gossipMsg = {
            id: Date.now() + Math.random(),
            fromId: socket.id,
            fromName: player ? player.name : '未知',
            fromSeat: player ? player.seat : -1,
            isDead: player ? !player.isAlive : false,
            content: `【造谣者声明】${res.statement}`,
            channel: 'public',
            timestamp: Date.now()
          };
          io.to(roomId).emit('chat:message', gossipMsg);
          if (room.gameState.chatLog) room.gameState.chatLog.push(gossipMsg);

          judgeGossipByAI(engine, roomId, socket.id, res.statement);

          socket.emit('game:abilityUsed', {
            fromId: socket.id,
            fromName: player ? player.name : '未知',
            abilityName, targetId, result: res
          });
        } else if (abilityName === 'moonchild' && res.targetId) {
          // 月之子公开选择：所有人都能看到
          const player = room.players.get(socket.id);
          const moonMsg = {
            id: Date.now() + Math.random(),
            fromId: socket.id,
            fromName: player ? player.name : '未知',
            fromSeat: player ? player.seat : -1,
            isDead: true,
            content: `【月之子选择】我选择 ${res.targetSeat + 1}号 ${res.targetName}`,
            channel: 'public',
            timestamp: Date.now()
          };
          io.to(roomId).emit('chat:message', moonMsg);
          if (room.gameState.chatLog) room.gameState.chatLog.push(moonMsg);

          io.to(roomId).emit('game:abilityUsed', {
            fromId: socket.id,
            fromName: room.players.get(socket.id).name,
            abilityName, targetId, result: res
          });
        } else {
          io.to(roomId).emit('game:abilityUsed', {
            fromId: socket.id,
            fromName: room.players.get(socket.id).name,
            abilityName, targetId, result: res
          });
        }
        broadcastRoomState(roomId);
      }
    }
  });

  // AI判断造谣者声明真伪
  async function judgeGossipByAI(engine, roomId, playerId, statement) {
    try {
      const room = engine.room;
      const gs = room.gameState;
      const players = Array.from(room.players.values()).filter(p => p.seat !== -1);
      const playerInfo = players.map(p => {
        const roleName = p.role ? p.role.name : '未知';
        return `${p.seat + 1}号 ${p.name}: ${p.isAlive ? '存活' : '死亡'}, 角色=${roleName}, 阵营=${p.role ? (p.role.team === 'GOOD' ? '善良' : '邪恶') : '未知'}`;
      }).join('\n');

      const deadInfo = players.filter(p => !p.isAlive).map(p => {
        let deathCause = '死亡';
        return `${p.seat + 1}号 ${p.name}（${p.role ? p.role.name : '未知'}）`;
      }).join('、') || '无';

      const systemPrompt = `你是血染钟楼游戏的严格裁判。你必须判断造谣者的声明是否为"客观事实"。

【当前游戏状态 - 这是你判断的唯一事实依据】
在场玩家及真实角色（你全知全能）：
${playerInfo}

已死亡玩家：${deadInfo}
当前是第${gs.dayCount}天，第${gs.nightCount}夜。

【严格判断规则 - 默认返回false，只有完全满足以下所有条件才返回true】
判定为true的必要条件（缺一不可）：
1. 声明是关于"已经发生的事实"或"当前确定的状态"，而非未来预测
2. 声明中的每一个细节都能被上述游戏状态100%证实，没有任何歧义
3. 声明不包含"可能""大概""也许""好像""应该"等推测性词语
4. 声明提到的角色确实存在于当前游戏中
5. 声明提到的玩家确实在场
6. 声明不是疑问句、感叹句或无意义内容

以下情况一律判定为false：
- 对未来的预测（如"今晚恶魔会死""明天3号会被提名"）
- 主观推测或猜测（如"我觉得5号是恶魔""2号可能是下毒者"）
- 模糊表述或信息不足（如"有人是邪恶的""场上有男爵"）
- 无意义的乱讲、玩笑、与游戏无关的内容
- 涉及不在当前剧本中的角色
- 涉及你无法从上述状态中确认的信息（如"3号昨晚被僧侣保护了"）
- 自指的元游戏陈述（如"我是造谣者""我说的是真话"）
- 多重陈述中有任何一部分为假，整体即为false

【输出要求】
你只能输出一个单词：true 或 false（全部小写，无标点，无其他内容）。
存疑时输出false。无法判断时输出false。`;

      const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer 8e7f57d3813947d9a96fa4e08804769a.xZAqoIHV2cev1hTw'
        },
        body: JSON.stringify({
          model: 'glm-4.7-flash',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `造谣者声明：${statement}\n\n这个声明是真的吗？请只回答true或false。` }
          ],
          temperature: 0.1,
          max_tokens: 10,
          stream: false
        })
      });

      if (!response.ok) {
        console.log('[Gossip AI] API请求失败:', response.status);
        const player = room.players.get(playerId);
        if (player) {
          player.abilityState.gossipResult = false;
          player.abilityState.gossipAIPending = false;
        }
        return;
      }

      const data = await response.json();
      const aiReply = (data.choices?.[0]?.message?.content || '').trim().toLowerCase();
      const isTrue = aiReply.startsWith('true');
      console.log(`[Gossip AI] 声明:"${statement}" AI判断:${aiReply} => ${isTrue}`);

      const player = room.players.get(playerId);
      if (player) {
        player.abilityState.gossipResult = isTrue;
        player.abilityState.gossipAIPending = false;
      }
    } catch(err) {
      console.error('[Gossip AI] 判断错误:', err.message);
      const room = engine.room;
      const player = room.players.get(playerId);
      if (player) {
        player.abilityState.gossipResult = false;
        player.abilityState.gossipAIPending = false;
      }
    }
  }

  // 聊天
  socket.on('chat:send', ({ content, channel, targetId }) => {
    const result = getPlayerRoom(socket.id);
    if (!result) return;
    const { roomId, room } = result;
    const engine = gameEngines.get(roomId);
    if (engine && room.gameStarted) {
      engine.sendChat(socket.id, content, channel, targetId);
    } else {
      // 大厅聊天
      const from = room.players.get(socket.id);
      if (!from) return;
      const baseMsg = {
        id: Date.now() + Math.random(),
        fromId: socket.id,
        fromName: from.name,
        fromSeat: from.seat,
        isDead: false,
        content: content.substring(0, 500),
        timestamp: Date.now()
      };
      if (channel === 'whisper' && targetId) {
        const to = room.players.get(targetId);
        if (!to) { socket.emit('room:error', { message: '私聊对象不存在' }); return; }
        if (to.id === socket.id) { socket.emit('room:error', { message: '不能和自己私聊' }); return; }
        io.to(targetId).emit('chat:message', { ...baseMsg, channel: 'whisper', toId: targetId });
        io.to(socket.id).emit('chat:message', { ...baseMsg, channel: 'whisper', toId: targetId });
      } else {
        io.to(roomId).emit('chat:message', { ...baseMsg, channel: 'public' });
      }
    }
  });

  // ========== AI 小助手 ==========
  // AI 对话系统提示词
  const AI_SYSTEM_PROMPT = `你是血染钟楼游戏的AI小助手，名叫"小染"。你可以帮助玩家：
1. 解答血染钟楼游戏规则问题（包括灾祸之酿TB和黯月初升BMR两个剧本）
2. 解释角色技能和互动方式
3. 提供游戏策略建议
4. 闲聊和回答通用问题

注意事项：
- 回答要简洁友好，避免过长
- 涉及游戏角色时，可适当给出建议但不要破坏游戏体验
- 使用中文回复
- 不要透露具体玩家的角色信息`;

  socket.on('ai:chat', async ({ message, history }) => {
    const result = getPlayerRoom(socket.id);
    if (!result) return;
    const { roomId } = result;
    const playerName = (result.room.players.get(socket.id) || {}).name || '玩家';

    try {
      const messages = [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        ...(Array.isArray(history) ? history.slice(-10).map(h => ({
          role: h.role === 'assistant' ? 'assistant' : 'user',
          content: h.content
        })) : []),
        { role: 'user', content: `[${playerName}]: ${message}` }
      ];

      const response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer 8e7f57d3813947d9a96fa4e08804769a.xZAqoIHV2cev1hTw'
        },
        body: JSON.stringify({
          model: 'glm-4.7-flash',
          messages: messages,
          stream: true
        })
      });

      if (!response.ok) {
        socket.emit('ai:error', { message: `AI请求失败: ${response.status}` });
        return;
      }

      const msgId = 'ai_' + Date.now() + '_' + Math.random();
      // 通知前端开始接收 AI 消息
      socket.emit('ai:start', { id: msgId, playerName });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;

          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              socket.emit('ai:chunk', { id: msgId, chunk: delta });
            }
          } catch(e) {
            // 忽略解析错误
          }
        }
      }

      socket.emit('ai:done', { id: msgId });
    } catch(err) {
      console.error('AI对话错误:', err.message);
      socket.emit('ai:error', { message: 'AI服务暂时不可用' });
    }
  });

  // ========== 上帝视角 ==========
  const GOD_PASSWORD = '0';
  socket.on('god:login', ({ password }) => {
    const result = getPlayerRoom(socket.id);
    if (!result) { socket.emit('room:error', { message: '你不在房间中' }); return; }
    const { roomId } = result;
    const engine = gameEngines.get(roomId);
    if (!engine) { socket.emit('room:error', { message: '游戏尚未开始' }); return; }
    if (password !== GOD_PASSWORD) {
      socket.emit('god:loginResult', { success: false });
      return;
    }
    engine.setGodView(socket.id, true);
    socket.emit('god:loginResult', { success: true });
    socket.emit('god:state', engine.getGodViewState());
  });

  socket.on('god:logout', () => {
    const result = getPlayerRoom(socket.id);
    if (!result) return;
    const { roomId } = result;
    const engine = gameEngines.get(roomId);
    if (engine) {
      engine.setGodView(socket.id, false);
    }
    socket.emit('god:logoutResult', { success: true });
  });

  // ========== 概率设置（仅房主） ==========
  socket.on('room:getProbConfig', () => {
    const result = getPlayerRoom(socket.id);
    if (!result) { socket.emit('room:error', { message: '你不在房间中' }); return; }
    const { roomId } = result;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.hostId !== socket.id) { socket.emit('room:error', { message: '只有房主可以修改设置' }); return; }
    socket.emit('room:probConfig', {
      config: JSON.parse(JSON.stringify(room.probConfig)),
      meta: getProbConfigMeta(room.script || 'tb'),
      mode: room.probMode
    });
  });

  socket.on('room:setProbConfig', ({ config, mode }) => {
    const result = getPlayerRoom(socket.id);
    if (!result) { socket.emit('room:error', { message: '你不在房间中' }); return; }
    const { roomId } = result;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.hostId !== socket.id) { socket.emit('room:error', { message: '只有房主可以修改设置' }); return; }
    if (room.gameStarted) { socket.emit('room:error', { message: '游戏已开始，无法修改设置' }); return; }

    // 保存模式
    if (mode === 'standard' || mode === 'advanced') {
      room.probMode = mode;
    }

    // 校验并合并（使用当前剧本的 META 限制范围）
    const scriptMeta = getProbConfigMeta(room.script || 'tb');
    const rangeMap = {};
    scriptMeta.forEach(cat => cat.items.forEach(item => {
      rangeMap[item.key] = { min: item.min, max: item.max };
    }));
    const getRange = (key) => rangeMap[key] || { min: -2, max: 2 };
    const merge = (target, source, prefix = '') => {
      for (const key of Object.keys(source)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (target[key] !== undefined && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          merge(target[key], source[key], fullKey);
        } else if (target[key] !== undefined) {
          const val = source[key];
          if (typeof val === 'number') {
            const { min, max } = getRange(fullKey);
            target[key] = Math.max(min, Math.min(max, val));
          } else if (typeof val === 'boolean') {
            target[key] = val;
          }
        }
      }
    };
    merge(room.probConfig, config || {});
    broadcastRoomState(roomId);
    socket.emit('room:probConfigSaved', { success: true });
  });

  socket.on('room:resetProbConfig', () => {
    const result = getPlayerRoom(socket.id);
    if (!result) { socket.emit('room:error', { message: '你不在房间中' }); return; }
    const { roomId } = result;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.hostId !== socket.id) { socket.emit('room:error', { message: '只有房主可以修改设置' }); return; }
    if (room.gameStarted) { socket.emit('room:error', { message: '游戏已开始，无法修改设置' }); return; }
    room.probConfig = getStandardProbConfig(room.script || 'tb');
    room.probMode = 'standard';
    // 同步给engine（如果已存在）
    const engine = gameEngines.get(roomId);
    if (engine) engine.probConfig = room.probConfig;
    broadcastRoomState(roomId);
    socket.emit('room:probConfigSaved', { success: true });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`血染钟楼服务器运行在 http://localhost:${PORT}`);
});
