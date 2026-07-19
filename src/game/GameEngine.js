// 游戏引擎 - 状态机核心
const { PHASES } = require('../config/game-config');
const { getSeatedPlayers, getAlivePlayers } = require('../utils/helpers');
const RoleAllocator = require('./RoleAllocator');
const NightResolver = require('./NightResolver');
const VoteManager = require('./VoteManager');
const DeathManager = require('./DeathManager');
const VictoryChecker = require('./VictoryChecker');
const BalanceSystem = require('./BalanceSystem');
const BotManager = require('./BotManager');

class GameEngine {
  constructor(room, io) {
    this.room = room;
    this.io = io;
    
    // 初始化游戏状态
    this.room.gameState = {
      phase: PHASES.LOBBY,
      dayCount: 0,
      nightCount: 0,
      nominations: [],
      currentNominationIndex: -1,
      pendingExecution: null,
      todaysDeaths: [],
      nightQueue: [],
      currentNightIndex: -1,
      currentWakePlayerId: null,
      currentDefensePlayerId: null,
      nightActions: {},
      deathsToAnnounce: [],
      rolesInPlay: [],
      rolesNotInPlay: [],
      winner: null,
      winReason: '',
      chatLog: [],
      confirmedPlayers: [],
      currentVotes: {},
      actionLog: [] // 行动日志（上帝视角可见）
    };

    // 上帝视角玩家集合
    this.godViewPlayers = new Set();

    // 私聊系统消息节流：记录每对玩家上次发送系统消息的时间
    this.whisperSystemMessageTimestamps = {};
    this.roleAllocator = new RoleAllocator(this);
    this.nightResolver = new NightResolver(this);
    this.voteManager = new VoteManager(this);
    this.deathManager = new DeathManager(this);
    this.victoryChecker = new VictoryChecker(this);
    this.balanceSystem = BalanceSystem;
    this.botManager = new BotManager(this);
  }

  // 添加行动日志
  logAction(type, message, data = {}) {
    const gs = this.room.gameState;
    const entry = {
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      phase: gs.phase,
      day: gs.dayCount,
      night: gs.nightCount,
      type,
      message,
      data
    };
    gs.actionLog.push(entry);
    // 只保留最近200条
    if (gs.actionLog.length > 200) {
      gs.actionLog.shift();
    }
    // 通知上帝视角玩家
    for (const pid of this.godViewPlayers) {
      this.io.to(pid).emit('god:actionLog', entry);
    }
  }

  // 启用/禁用上帝视角
  setGodView(playerId, enabled) {
    if (enabled) {
      this.godViewPlayers.add(playerId);
    } else {
      this.godViewPlayers.delete(playerId);
    }
  }

  // 获取上帝视角完整状态
  getGodViewState() {
    const gs = this.room.gameState;
    const allPlayers = Array.from(this.room.players.values())
      .filter(p => p.seat !== -1)
      .map(p => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        isAlive: p.isAlive,
        isDead: p.isDead,
        isBot: !!p.isBot,
        isConnected: p.isConnected,
        isPoisoned: p.isPoisoned,
        isProtected: p.isProtected,
        isDrunk: p.isDrunk,
        roleId: p.role ? p.role.id : null,
        roleName: p.role ? p.role.name : '未分配',
        team: p.role ? p.role.team : null,
        category: p.role ? p.role.category : null,
        voteToken: p.voteToken,
        privateInfo: p.privateInfo
      }));

    return {
      phase: gs.phase,
      dayCount: gs.dayCount,
      nightCount: gs.nightCount,
      currentWakePlayerId: gs.currentWakePlayerId,
      currentDefensePlayerId: gs.currentDefensePlayerId,
      nightActions: gs.nightActions,
      nominations: gs.nominations.map(n => ({
        nominatorId: n.nominatorId,
        nomineeId: n.nomineeId,
        nominatorName: this.room.players.get(n.nominatorId)?.name,
        nomineeName: this.room.players.get(n.nomineeId)?.name,
        nominatorSeat: this.room.players.get(n.nominatorId)?.seat,
        nomineeSeat: this.room.players.get(n.nomineeId)?.seat,
        voteCount: n.voteCount,
        votes: Array.from(n.votes),
        passed: n.passed,
        resolved: n.resolved,
        currentVotes: n.currentVotes ? Object.assign({}, n.currentVotes) : {}
      })),
      deathsToAnnounce: gs.deathsToAnnounce,
      todaysDeaths: gs.todaysDeaths,
      players: allPlayers,
      rolesNotInPlay: gs.rolesNotInPlay.slice(0, 3),
      winner: gs.winner,
      winReason: gs.winReason,
      actionLog: gs.actionLog
    };
  }

  // 设置玩家私密信息（自动记录真假信息和上帝视角日志）
  setPlayerPrivateInfo(player, info, isFalse = false, realInfo = null) {
    player.privateInfo = {
      ...info,
      isFalse: isFalse,
      realInfo: isFalse ? realInfo : null
    };
    // 通知该玩家
    this.io.to(player.id).emit('game:privateInfo', player.privateInfo);
    // 记录到行动日志
    const falseMark = isFalse ? ' ⚠️【假信息】' : '';
    this.logAction('PRIVATE_INFO', `${player.seat+1}号 ${player.name}（${player.role?.name || '?'}）收到信息：${info.message}${falseMark}`, {
      playerId: player.id,
      info: info.message,
      isFalse,
      realInfo: isFalse ? realInfo : null
    });
    // 通知上帝视角玩家更新该玩家信息
    const playerData = {
      id: player.id,
      name: player.name,
      seat: player.seat,
      isAlive: player.isAlive,
      isDead: player.isDead,
      isBot: !!player.isBot,
      isPoisoned: player.isPoisoned,
      isProtected: player.isProtected,
      isDrunk: player.isDrunk,
      roleId: player.role ? player.role.id : null,
      roleName: player.role ? player.role.name : '未分配',
      team: player.role ? player.role.team : null,
      category: player.role ? player.role.category : null,
      voteToken: player.voteToken,
      privateInfo: player.privateInfo
    };
    for (const pid of this.godViewPlayers) {
      this.io.to(pid).emit('god:playerUpdate', playerData);
    }
  }

  startGame(customRoles = {}) {
    const seatedPlayers = getSeatedPlayers(this.room);
    if (seatedPlayers.length < this.room.minPlayers) {
      return;
    }

    const hasCustom = Object.keys(customRoles).length > 0;
    if (hasCustom) {
      // 自定义角色分配
      this.roleAllocator.allocateCustom(seatedPlayers, customRoles);
    } else {
      // 随机分配身份
      this.roleAllocator.allocate(seatedPlayers);
    }

    // 先记录角色分配日志
    for (const p of seatedPlayers) {
      this.logAction('ROLE_ASSIGN', `${p.seat+1}号 ${p.name} 分配到【${p.role.name}】（${p.role.team === 'GOOD' ? '善良' : '邪恶'}阵营）${hasCustom ? ' [自定义]' : ''}`, {
        playerId: p.id, seat: p.seat, role: p.role.id, team: p.role.team
      });
    }

    // 再设置恶魔/爪牙/酒鬼信息（会产生PRIVATE_INFO日志）
    this.roleAllocator.setupEvilTeamInfo(seatedPlayers);

    this.logAction('GAME_START', `游戏开始！共${seatedPlayers.length}名玩家${hasCustom ? '（自定义角色）' : ''}`, { playerCount: seatedPlayers.length });

    // 重置确认集合
    this.room.confirmations.clear();

    // 开始第一夜
    this.transitionTo(PHASES.FIRST_NIGHT);
  }

  transitionTo(phase) {
    const gs = this.room.gameState;
    gs.phase = phase;
    this.room.confirmations.clear();

    // 重置每个阶段的临时状态
    switch (phase) {
      case PHASES.FIRST_NIGHT:
        this.nightResolver.beginFirstNight();
        return; // beginFirstNight内部会广播

      case PHASES.DAY_DAWN:
        this.handleDayDawn();
        break;

      case PHASES.DAY_DISCUSSION:
        gs.dayCount++;
        this.handleDayDiscussion();
        break;

      case PHASES.NOMINATION_PHASE:
        this.voteManager.openNominations();
        return;

      case PHASES.NIGHT:
        this.nightResolver.beginNight(gs.nightCount + 1);
        return; // beginNight内部会广播

      case PHASES.GAME_OVER:
        break;
    }

    this.broadcastState();
  }

  handleDayDawn() {
    const gs = this.room.gameState;
    const deaths = gs.deathsToAnnounce;

    // 公布死亡
    this.io.to(this.room.id).emit('game:dawnReport', {
      isFirstNight: gs.nightCount === 0,
      deaths: deaths.map(d => ({
        seat: d.seat,
        name: d.name,
        playerId: d.playerId
      }))
    });

    // 等待确认后进入白天讨论
    this.waitForConfirmation();
  }

  handleDayDiscussion() {
    // 进入自由讨论阶段，等待提名或全员确认结束讨论
    this.waitForConfirmation();
  }

  waitForConfirmation() {
    this.room.confirmations.clear();
    this.broadcastState();
  }

  onAllConfirmed() {
    const gs = this.room.gameState;

    switch (gs.phase) {
      case PHASES.DAY_DAWN:
        this.transitionTo(PHASES.DAY_DISCUSSION);
        break;

      case PHASES.DAY_DISCUSSION:
        this.transitionTo(PHASES.NOMINATION_PHASE);
        break;

      case PHASES.NOMINATION_PHASE:
        this.voteManager.closeNominations();
        break;

      case PHASES.EXECUTION:
        // 处决后检查胜负
        const victory = this.victoryChecker.checkVictory();
        if (victory) return;
        this.transitionTo(PHASES.NIGHT);
        break;

      case PHASES.NIGHT_WAKE:
      case PHASES.FIRST_NIGHT:
      case PHASES.NIGHT:
        // 夜晚结算完成后进入天亮（在NightResolver.resolveNight中处理）
        break;

      case PHASES.DEFENSE:
        this.voteManager.beginVoting();
        break;

      case PHASES.VOTING:
        this.voteManager.endVoting();
        break;
    }
  }

  // 处理确认
  processConfirmation(playerId) {
    const gs = this.room.gameState;
    const player = this.room.players.get(playerId);
    if (!player || player.seat === -1) return;

    if (this.room.confirmations.has(playerId)) return; // 已确认过
    this.room.confirmations.add(playerId);
    
    // 检查是否全员确认（bot视为始终在线，活人玩家需在线）
    const seatedPlayers = getSeatedPlayers(this.room).filter(p => p.isBot || p.isConnected);
    if (this.room.confirmations.size >= seatedPlayers.length) {
      this.onAllConfirmed();
    }

    this.broadcastState();
  }

  // 处理夜晚行动
  processNightAction(playerId, action) {
    const player = this.room.players.get(playerId);
    
    // 处理守鸦人特殊情况
    if (this.nightResolver.pendingRavenkeeper === playerId) {
      const targets = action.targets || [];
      if (targets.length === 1) {
        const target = this.room.players.get(targets[0]);
        this.logAction('NIGHT_ACTION', `${player.seat+1}号 ${player.name}（守鸦人）查看了 ${target ? target.seat+1+'号 '+target.name : '?'} 的身份`, {
          playerId, role: 'ravenkeeper', targetId: targets[0]
        });
        this.nightResolver.processRavenkeeperAction(playerId, targets[0]);
        this.nightResolver.pendingRavenkeeper = null;
        this.room.gameState.currentWakePlayerId = null;
        this.io.to(playerId).emit('night:actionAck', { success: true });
        // 继续完成夜晚结算
        this.nightResolver.finalizeNight();
        this.broadcastState();
        return { success: true };
      }
      return { success: false, message: '请选择一名玩家' };
    }
    
    // 先校验再记录行动日志（在setPlayerPrivateInfo产生PRIVATE_INFO日志之前）
    const targets = action.targets || [];
    // 酒鬼的selectCount是动态设置的，使用wakeInfo中的canSelectCount校验
    const isDrunk = player.role && player.role.id === 'drunk' && player.fakeRole;
    const effectiveSelectCount = isDrunk ? (player.role.selectCount || 0) : (player.role.selectCount || 0);
    if (effectiveSelectCount > 0 && targets.length !== effectiveSelectCount) {
      return { success: false, message: `请选择${effectiveSelectCount}名玩家` };
    }
    if (player && player.role) {
      const targetNames = targets.map(tid => {
        const t = this.room.players.get(tid);
        return t ? `${t.seat+1}号${t.name}` : tid;
      }).join('、');
      const roleName = isDrunk ? player.fakeRole.name : player.role.name;
      this.logAction('NIGHT_ACTION', `${player.seat+1}号 ${player.name}（${roleName}${isDrunk?'/酒鬼':''}）夜晚行动：选择了 ${targetNames || '无目标'}`, {
        playerId, role: isDrunk ? player.fakeRole.id : player.role.id, targets
      });
    }

    const result = this.nightResolver.processNightAction(playerId, action);
    return result;
  }

  // 处理提名
  nominatePlayer(nominatorId, nomineeId) {
    return this.voteManager.processNomination(nominatorId, nomineeId);
  }

  processNomination(nominatorId, nomineeId) {
    const gs = this.room.gameState;
    if (gs.phase !== PHASES.DAY_DISCUSSION && gs.phase !== PHASES.NOMINATION_PHASE) {
      return { success: false, message: '现在不是提名时间' };
    }
    return this.voteManager.processNomination(nominatorId, nomineeId);
  }

  // 添加机器人
  addBot(name) {
    return this.botManager.addBot(name);
  }

  // 处理投票
  processVote(playerId, vote) {
    return this.voteManager.processVote(playerId, vote);
  }

  // 处理白天技能
  processDayAbility(playerId, abilityName, targetId) {
    const player = this.room.players.get(playerId);
    if (!player || !player.isAlive) {
      return { success: false, message: '你已死亡' };
    }
    if (player.role && player.role.onDayAbility) {
      return player.role.onDayAbility(this.room.gameState, player, targetId, this);
    }
    return { success: false, message: '该角色无此技能' };
  }

  endDefense(playerId) {
    return this.voteManager.endDefense(playerId);
  }

  endVoting() {
    this.voteManager.endVoting();
  }

  setupRedHerring(fortuneteller) {
    this.roleAllocator.setupRedHerring(fortuneteller);
  }

  // 广播房间状态给所有玩家
  broadcastState() {
    for (const [pid, player] of this.room.players) {
      if (!player.isBot && !player.isConnected) continue; // 断线玩家不发送
      const state = this.getPlayerState(pid);
      this.io.to(pid).emit('game:stateUpdate', state);
    }
    // 通知bot和断线玩家（托管）
    this.botManager.notifyAllBots();
  }

  getPlayerState(viewerId) {
    const room = this.room;
    const gs = room.gameState;
    const viewer = room.players.get(viewerId);
    
    if (!viewer) return null;

    const players = Array.from(room.players.values())
      .filter(p => p.seat !== -1)
      .map(p => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        isAlive: p.isAlive,
        isDead: p.isDead,
        isHost: p.id === room.hostId,
        voteToken: p.voteToken,
        isConnected: p.isConnected,
        isBot: !!p.isBot
      }));

    const seatedCount = players.length;
    const neededConfirm = Array.from(room.players.values())
      .filter(p => p.seat !== -1 && (p.isBot || p.isConnected)).length;

    const state = {
      roomId: room.id,
      hostId: room.hostId,
      players,
      seats: room.seats.map(s => s ? s.id : null),
      gameStarted: room.gameStarted,
      phase: gs.phase,
      dayCount: gs.dayCount,
      nightCount: gs.nightCount,
      isNight: gs.phase === PHASES.FIRST_NIGHT || gs.phase === PHASES.NIGHT || gs.phase === PHASES.NIGHT_WAKE,
      currentWakePlayerId: gs.currentWakePlayerId,
      currentDefensePlayerId: gs.currentDefensePlayerId,
      isYourTurn: gs.currentWakePlayerId === viewerId || gs.currentDefensePlayerId === viewerId,
      nominations: gs.nominations.map(n => ({
        nominatorId: n.nominatorId,
        nomineeId: n.nomineeId,
        voteCount: n.voteCount,
        votes: Array.from(n.votes),
        passed: n.passed,
        resolved: n.resolved,
        currentVotes: n.currentVotes ? Object.assign({}, n.currentVotes) : {}
      })),
      deathsToAnnounce: gs.deathsToAnnounce,
      todaysDeaths: gs.todaysDeaths,
      winner: gs.winner,
      winReason: gs.winReason,
      confirmedCount: room.confirmations.size,
      confirmedIds: Array.from(room.confirmations),
      totalNeeded: neededConfirm,
      yourRole: viewer.role ? (() => {
        // 酒鬼看到的是假身份
        if (viewer.role.id === 'drunk' && viewer.fakeRole) {
          return {
            name: viewer.fakeRole.name,
            id: viewer.fakeRole.id,
            team: 'GOOD',
            category: 'TOWNSFOLK',
            abilityDesc: viewer.fakeRole.abilityDesc,
            isDrunk: true
          };
        }
        return {
          name: viewer.role.name,
          id: viewer.role.id,
          team: viewer.role.team,
          category: viewer.role.category,
          abilityDesc: viewer.role.abilityDesc
        };
      })() : null,
      evilTeam: viewer.role && viewer.role.team === 'EVIL' ?
        Array.from(room.players.values())
          .filter(p => p.role && p.role.team === 'EVIL' && p.seat !== -1)
          .map(p => ({ id: p.id, name: p.name, seat: p.seat, roleName: p.role.name })) : null,
      notInPlay: viewer.role && viewer.role.category === 'DEMON' ? gs.rolesNotInPlay.slice(0, 3).map(rid => {
        const role = this.roleAllocator.createRoleInstance(rid);
        return role ? role.name : rid;
      }) : null,
      privateInfo: viewer.privateInfo,
      allRoles: gs.winner ? Array.from(room.players.values())
        .filter(p => p.seat !== -1)
        .map(p => ({
          id: p.id,
          name: p.name,
          seat: p.seat,
          roleName: p.role.name,
          team: p.role.team,
          isAlive: p.isAlive
        })) : null
    };

    return state;
  }

  // 发送聊天消息
  sendChat(fromId, message, type, toId) {
    const gs = this.room.gameState;
    const from = this.room.players.get(fromId);
    if (!from) return;

    const chatMsg = {
      id: Date.now() + Math.random(),
      fromId,
      fromName: from.name,
      fromSeat: from.seat,
      isDead: from.isDead,
      content: message.substring(0, 500),
      timestamp: Date.now(),
      type: type // 'public', 'whisper', 'dead'
    };

    if (type === 'public') {
      // 夜晚禁言（死者频道和私聊不禁）
      if ((gs.phase === PHASES.FIRST_NIGHT || gs.phase === PHASES.NIGHT || gs.phase === PHASES.NIGHT_WAKE) 
          && !from.isDead) {
        this.io.to(fromId).emit('room:error', { message: '夜晚期间禁止公聊（可私聊）' });
        return;
      }
      chatMsg.channel = 'public';
      if (gs.chatLog) gs.chatLog.push(chatMsg);
      this.io.to(this.room.id).emit('chat:message', chatMsg);
    } else if (type === 'dead') {
      if (!from.isDead) {
        this.io.to(fromId).emit('room:error', { message: '只有死者可以使用死者频道' });
        return;
      }
      chatMsg.channel = 'dead';
      if (gs.chatLog) gs.chatLog.push(chatMsg);
      for (const [pid, player] of this.room.players) {
        if (player.isDead && player.isConnected) {
          this.io.to(pid).emit('chat:message', chatMsg);
        }
      }
    } else if (type === 'whisper' && toId) {
      const to = this.room.players.get(toId);
      if (!to) { this.io.to(fromId).emit('room:error', { message: '私聊对象不存在' }); return; }
      if (to.id === fromId) { this.io.to(fromId).emit('room:error', { message: '不能和自己私聊' }); return; }
      if (!to.isConnected && !to.isBot) { this.io.to(fromId).emit('room:error', { message: '该玩家已断线' }); return; }
      chatMsg.toId = toId;
      chatMsg.toName = to.name;
      chatMsg.toSeat = to.seat;
      chatMsg.channel = 'whisper';
      if (gs.chatLog) gs.chatLog.push(chatMsg);
      this.io.to(toId).emit('chat:message', chatMsg);
      this.io.to(fromId).emit('chat:message', chatMsg);

      // 私聊系统消息（3分钟节流）
      const pairKey = [fromId, toId].sort().join(':');
      const now = Date.now();
      const lastTime = this.whisperSystemMessageTimestamps[pairKey] || 0;
      if (now - lastTime > 3 * 60 * 1000) {
        this.whisperSystemMessageTimestamps[pairKey] = now;
        const sysMsg = {
          id: Date.now() + Math.random(),
          fromId: 'system',
          fromName: '系统',
          fromSeat: -1,
          isDead: false,
          content: `${from.name} 和 ${to.name} 正在私聊`,
          timestamp: now,
          type: 'public',
          channel: 'public'
        };
        if (gs.chatLog) gs.chatLog.push(sysMsg);
        this.io.to(this.room.id).emit('chat:message', sysMsg);
      }
    }
  }
}

module.exports = GameEngine;
