// 游戏引擎 - 状态机核心
const { PHASES } = require('../config/game-config');
const { getSeatedPlayers, getAlivePlayers } = require('../utils/helpers');
const { getStandardProbConfig, getProbConfigMeta, PROB_CONFIG_META } = require('../config/prob-config');
const RoleAllocator = require('./RoleAllocator');
const NightResolver = require('./NightResolver');
const VoteManager = require('./VoteManager');
const DeathManager = require('./DeathManager');
const VictoryChecker = require('./VictoryChecker');
const BalanceSystem = require('./BalanceSystem');
const BotManager = require('./BotManager');

class GameEngine {
  constructor(room, io, onSaveHistory = null) {
    this.room = room;
    this.io = io;
    this._onSaveHistory = onSaveHistory;
    
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

    // 概率配置（从room读取，房主可在大厅修改）
    this.probConfig = room.probConfig || getStandardProbConfig();
    room.probConfig = this.probConfig;
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

  // 读取概率配置（支持点号路径，如 'balance.baseFavor'）
  prob(keyPath) {
    const parts = keyPath.split('.');
    let val = this.probConfig;
    for (const p of parts) {
      if (val === undefined || val === null) return undefined;
      val = val[p];
    }
    return val;
  }

  // 获取概率配置（发给前端）
  getProbConfig() {
    return JSON.parse(JSON.stringify(this.probConfig));
  }

  // 设置概率配置（房主使用）
  setProbConfig(newConfig) {
    // 简单合并：只更新已有key，防止注入
    const meta = getProbConfigMeta(this.room.script || 'tb');
    const rangeMap = {};
    meta.forEach(cat => cat.items.forEach(item => {
      rangeMap[item.key] = { min: item.min, max: item.max };
    }));
    const getRange = (key) => {
      if (rangeMap[key]) return rangeMap[key];
      return { min: -2, max: 2 }; // 默认宽松范围
    };
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
    merge(this.probConfig, newConfig);
    this.broadcastState();
    return true;
  }

  // 重置概率配置为默认值
  resetProbConfig() {
    this.probConfig = getStandardProbConfig(this.room.script || 'tb');
    this.broadcastState();
    return true;
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
        privateInfo: p.privateInfo,
        privateInfoHistory: p.privateInfoHistory || []
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
    const gs = this.room.gameState;
    const infoEntry = {
      ...info,
      isFalse: isFalse,
      realInfo: isFalse ? realInfo : null,
      day: gs ? (gs.dayCount || 0) : 0,
      phase: gs ? gs.phase : '',
      id: 'info_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)
    };
    player.privateInfo = infoEntry;
    if (!player.privateInfoHistory) player.privateInfoHistory = [];
    player.privateInfoHistory.push(infoEntry);
    // 通知该玩家
    this.io.to(player.id).emit('game:privateInfo', player.privateInfo);
    // 通知该玩家完整历史
    this.io.to(player.id).emit('game:privateInfoHistory', player.privateInfoHistory);
    // 记录到行动日志
    const falseMark = isFalse ? ' ⚠️【假信息】' : '';
    const probInfo = realInfo && realInfo.probInfo ? realInfo.probInfo : null;
    this.logAction('PRIVATE_INFO', `${player.seat+1}号 ${player.name}（${player.role?.name || '?'}）收到信息：${info.message}${falseMark}`, {
      playerId: player.id,
      info: info.message,
      isFalse,
      realInfo: isFalse ? realInfo : null,
      probInfo
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
      privateInfo: player.privateInfo,
      privateInfoHistory: player.privateInfoHistory
    };
    for (const pid of this.godViewPlayers) {
      this.io.to(pid).emit('god:playerUpdate', playerData);
    }
  }

  startGame(customRoles = {}) {
    this.room.startedAt = new Date();
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
    
    this.checkConfirmations();

    this.broadcastState();
  }

  // 主动检查确认进度（玩家断线等情况导致需要确认人数变化时调用）
  checkConfirmations() {
    const gs = this.room.gameState;
    const needConfirmPhases = ['DAY_DAWN', 'DAY_DISCUSSION', 'NOMINATION_PHASE', 'EXECUTION'];
    if (!needConfirmPhases.includes(gs.phase)) return;

    const seatedPlayers = getSeatedPlayers(this.room).filter(p => p.isBot || p.isConnected);
    if (this.room.confirmations.size >= seatedPlayers.length && seatedPlayers.length > 0) {
      this.onAllConfirmed();
    }
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
        this.nightResolver.finalizeNight();
        this.broadcastState();
        return { success: true };
      }
      return { success: false, message: '请选择一名玩家' };
    }

    // 处理月之子特殊情况
    if (this.nightResolver.pendingMoonchild === playerId) {
      const targets = action.targets || [];
      if (targets.length === 1) {
        const target = this.room.players.get(targets[0]);
        this.logAction('NIGHT_ACTION', `${player.seat+1}号 ${player.name}（月之子）选择了 ${target ? target.seat+1+'号 '+target.name : '?'}`, {
          playerId, role: 'moonchild', targetId: targets[0]
        });
        this.nightResolver.processMoonchildAction(playerId, targets[0]);
        this.room.gameState.currentWakePlayerId = null;
        this.io.to(playerId).emit('night:actionAck', { success: true });
        this.nightResolver.finalizeNight();
        this.broadcastState();
        return { success: true };
      }
      return { success: false, message: '请选择一名玩家' };
    }
    
    const targets = action.targets || [];
    const isDrunk = player.role && player.role.id === 'drunk' && player.fakeRole;
    const effectiveSelectCount = player.role.selectCount || 0;
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

  // 撤回投票
  revokeVote(playerId) {
    return this.voteManager.revokeVote(playerId);
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
      script: room.script || 'tb',
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
      mastermindExtraRound: !!gs.mastermindExtraRound,
      confirmedCount: room.confirmations.size,
      confirmedIds: Array.from(room.confirmations),
      totalNeeded: neededConfirm,
      yourRole: viewer.role ? (() => {
        // 酒鬼/疯子/莽夫看到的是假身份
        const fakeRoleIds = ['drunk', 'madman', 'lunatic'];
        if (fakeRoleIds.includes(viewer.role.id) && viewer.fakeRole) {
          const isOutsiderFake = viewer.role.id === 'drunk';
          return {
            name: viewer.fakeRole.name,
            id: viewer.fakeRole.id,
            team: isOutsiderFake ? 'GOOD' : viewer.fakeRole.team,
            category: isOutsiderFake ? 'TOWNSFOLK' : viewer.fakeRole.category,
            abilityDesc: viewer.fakeRole.abilityDesc,
            isDrunk: isOutsiderFake
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
      evilTeam: (() => {
        const isFakeDemon = viewer.fakeRole && viewer.fakeRole.category === 'DEMON';
        const seesEvilTeam = (viewer.role && viewer.role.team === 'EVIL') || isFakeDemon;
        if (!seesEvilTeam) return null;
        return Array.from(room.players.values())
          .filter(p => {
            if (!p.role || p.seat === -1) return false;
            if (isFakeDemon) {
              // 假恶魔只能看到爪牙（看不到真恶魔和自己）
              return p.role.category === 'MINION';
            }
            return p.role.team === 'EVIL';
          })
          .map(p => ({ id: p.id, name: p.name, seat: p.seat, roleName: p.role.name }));
      })(),
      notInPlay: (() => {
        const isFakeDemon = viewer.fakeRole && viewer.fakeRole.category === 'DEMON';
        const seesNotInPlay = (viewer.role && viewer.role.category === 'DEMON') || isFakeDemon;
        if (!seesNotInPlay) return null;
        return gs.rolesNotInPlay.slice(0, 3).map(rid => {
          const role = this.roleAllocator.createRoleInstance(rid);
          return role ? role.name : rid;
        });
      })(),
      privateInfo: viewer.privateInfo,
      privateInfoHistory: viewer.privateInfoHistory || [],
      isHost: viewerId === room.hostId,
      probConfig: viewerId === room.hostId ? this.getProbConfig() : null,
      probConfigMeta: viewerId === room.hostId ? getProbConfigMeta(room.script || 'tb') : null,
      probMode: viewerId === room.hostId ? room.probMode : null,
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
