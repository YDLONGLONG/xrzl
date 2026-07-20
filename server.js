const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const GameEngine = require('./src/game/GameEngine');
const { getStandardProbConfig, PROB_CONFIG_META } = require('./src/config/prob-config');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
        probConfig: pid === room.hostId ? JSON.parse(JSON.stringify(room.probConfig)) : null,
        probConfigMeta: pid === room.hostId ? PROB_CONFIG_META : null,
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
      probConfig: getStandardProbConfig(),
      probMode: 'standard'
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

  // 添加AI机器人（仅房主）
  socket.on('room:addBot', () => {
    const result = getPlayerRoom(socket.id);
    if (!result) return;
    const { roomId, room } = result;
    if (room.hostId !== socket.id) { socket.emit('room:error', { message: '只有房主可以添加机器人' }); return; }
    if (room.gameStarted) { socket.emit('room:error', { message: '游戏已开始' }); return; }
    if (room.players.size >= 15) { socket.emit('room:error', { message: '房间已满' }); return; }

    const botNames = ['小明', '小红', '小刚', '小丽', '阿强', '阿珍', '小王', '小李', '小张', '小陈', '小刘', '小赵', '小周', '小吴'];
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
    // 主动离开：立即移除（不走断线重连流程）
    const { roomId } = result;
    const player = result.room.players.get(socket.id);
    if (player && disconnectTimers.has(socket.id)) {
      clearTimeout(disconnectTimers.get(socket.id));
      disconnectTimers.delete(socket.id);
    }
    removePlayerFromRoom(roomId, socket.id);
    socket.leave(roomId);
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
    const engine = new GameEngine(room, io);
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
  socket.on('night:action', ({ targets }) => {
    const result = getPlayerRoom(socket.id);
    if (!result || !result.room.gameStarted) return;
    const { roomId } = result;
    const engine = gameEngines.get(roomId);
    if (engine) {
      const res = engine.processNightAction(socket.id, { targets });
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
  socket.on('day:useAbility', ({ abilityName, targetId }) => {
    const result = getPlayerRoom(socket.id);
    if (!result || !result.room.gameStarted) return;
    const { roomId, room } = result;
    const engine = gameEngines.get(roomId);
    if (engine) {
      const res = engine.processDayAbility(socket.id, abilityName, targetId);
      if (!res.success) {
        socket.emit('room:error', { message: res.message });
      } else {
        io.to(roomId).emit('game:abilityUsed', {
          fromId: socket.id,
          fromName: room.players.get(socket.id).name,
          abilityName, targetId, result: res
        });
        broadcastRoomState(roomId);
      }
    }
  });

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

  // ========== 上帝视角 ==========
  const GOD_PASSWORD = '123456';
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
      meta: PROB_CONFIG_META,
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

    // 校验并合并
    const rangeMap = {};
    PROB_CONFIG_META.forEach(cat => cat.items.forEach(item => {
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
    room.probConfig = getStandardProbConfig();
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
