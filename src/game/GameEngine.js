// 游戏引擎 - 状态机核心
const { PHASES, ROLE_IDS } = require('../config/game-config');
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
      currentWakeInfo: null, // 当前唤醒玩家的行动面板数据（掉线重连后补发用）
      currentDefensePlayerId: null,
      nightActions: {},
      deathsToAnnounce: [],
      rolesInPlay: [],
      rolesNotInPlay: [],
      // 本局实际配比（含方古/亡灵法师等设置修正），公开信息
      composition: null,
      winner: null,
      winReason: '',
      winEffect: null, // 专属胜利特效（如杀手公开击杀恶魔），游戏结束时由 VictoryChecker 写入
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
    // 行动者的醉酒/中毒状态在此刻快照：日志是历史数据，事后无法再还原当时状态。
    // 上帝视角与历史记录据此在行动行上标注（酒鬼角色本身视为醉酒）。
    const actorId = data.playerId || data.nominatorId || data.acterId;
    const actor = (actorId && this.room.players) ? this.room.players.get(actorId) : null;
    let actorStatus = null;
    if (actor) {
      const drunk = actor.isDrunk === true || !!(actor.role && actor.role.id === ROLE_IDS.DRUNK);
      const poisoned = actor.isPoisoned === true;
      if (drunk || poisoned) actorStatus = { drunk, poisoned };
    }
    const entry = {
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      phase: gs.phase,
      day: gs.dayCount,
      night: gs.nightCount,
      type,
      message,
      data: actorStatus ? { ...data, actorStatus } : data
    };
    // 玩家状态快照：日志是历史数据，显示时应使用当时的角色与生死状态，
    // 不能用对局结束后的最终状态（否则早期日志里会出现「已死亡」或换过的角色）。
    const playerStates = this.snapshotPlayerStates(entry.data);
    if (playerStates) entry.playerStates = playerStates;
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

  // 收集日志 data 中引用到的玩家，并快照其「当时」的座位/昵称/角色/阵营/存活状态
  snapshotPlayerStates(data) {
    const players = this.room.players;
    if (!players || players.size === 0 || !data || typeof data !== 'object') return null;
    const ids = new Set();
    const visit = (v, depth) => {
      if (v == null || depth > 4) return;
      if (typeof v === 'string') {
        if (players.has(v)) ids.add(v);
        return;
      }
      if (Array.isArray(v)) {
        v.forEach(x => visit(x, depth + 1));
        return;
      }
      if (typeof v === 'object') {
        Object.keys(v).forEach(k => visit(v[k], depth + 1));
      }
    };
    visit(data, 0);
    ['playerId', 'nominatorId', 'acterId', 'nomineeId'].forEach(k => {
      if (typeof data[k] === 'string' && players.has(data[k])) ids.add(data[k]);
    });
    if (ids.size === 0) return null;
    const states = {};
    ids.forEach(id => {
      const p = players.get(id);
      if (!p) return;
      states[id] = {
        seat: p.seat,
        name: p.name,
        roleName: p.role ? p.role.name : '',
        team: p.role ? p.role.team : null,
        category: p.role ? p.role.category : null,
        alive: p.isAlive === true
      };
    });
    return Object.keys(states).length > 0 ? states : null;
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
      nightQueue: gs.nightQueue || [],
      currentNightIndex: gs.currentNightIndex ?? -1,
      pendingRavenkeeper: this.nightResolver.pendingRavenkeeper || null,
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
      composition: gs.composition || null,
      rolesNotInPlay: gs.rolesNotInPlay.slice(0, 3),
      winner: gs.winner,
      winReason: gs.winReason,
      actionLog: gs.actionLog,
      // 角色 id → 中文名（上帝视角把 nightActions / 夜晚队列里的 id 翻成人话）
      roleNames: this.getRoleNameMap()
    };
  }

  // 全部角色的中文名映射（缓存，跨剧本合并）
  getRoleNameMap() {
    if (!this._roleNameMap) {
      const map = {};
      try {
        const { SCRIPTS } = require('../config/game-config');
        Object.keys(SCRIPTS).forEach(sid => {
          ((SCRIPTS[sid] && SCRIPTS[sid].allRoles) || []).forEach(id => {
            if (!map[id]) {
              const role = this.roleAllocator.createRoleInstance(id);
              if (role && role.name) map[id] = role.name;
            }
          });
        });
      } catch (e) {
        // 取名字失败不影响上帝视角其它内容
      }
      this._roleNameMap = map;
    }
    return this._roleNameMap;
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

  startGame(customRoles = {}, options = {}) {
    this.room.startedAt = new Date();
    // 清理上一局可能残留的自动推进定时器
    if (this._executionEndTimer) {
      clearTimeout(this._executionEndTimer);
      this._executionEndTimer = null;
    }
    if (this._dawnEndTimer) {
      clearTimeout(this._dawnEndTimer);
      this._dawnEndTimer = null;
    }
    const seatedPlayers = getSeatedPlayers(this.room);
    if (seatedPlayers.length < this.room.minPlayers) {
      return;
    }

    const hasCustom = Object.keys(customRoles).length > 0;
    if (hasCustom) {
      // 自定义角色分配
      this.roleAllocator.allocateCustom(seatedPlayers, customRoles, options);
    } else {
      // 随机分配身份
      this.roleAllocator.allocate(seatedPlayers);
    }

    // 记录本局实际配比（含方古/亡灵法师的设置修正），供前端展示
    this.room.gameState.composition = {
      townsfolk: seatedPlayers.filter(p => p.role && p.role.category === 'TOWNSFOLK').length,
      outsider: seatedPlayers.filter(p => p.role && p.role.category === 'OUTSIDER').length,
      minion: seatedPlayers.filter(p => p.role && p.role.category === 'MINION').length,
      demon: seatedPlayers.filter(p => p.role && p.role.category === 'DEMON').length
    };

    // 先记录角色分配日志
    for (const p of seatedPlayers) {
      this.logAction('ROLE_ASSIGN', `${p.seat+1}号 ${p.name} 分配到【${p.role.name}】（${p.role.team === 'GOOD' ? '善良' : '邪恶'}阵营）${hasCustom ? ' [自定义]' : ''}`, {
        playerId: p.id, seat: p.seat, role: p.role.id, team: p.role.team
      });
    }

    // 这些信息属于首夜：先把阶段切到首夜，避免私密信息日志被记录成「开局/白天」
    this.room.gameState.phase = PHASES.FIRST_NIGHT;

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
        // 讨论与提名合并：进入白天即重置今日提名，玩家可边聊边提名
        gs.dayCount++;
        this.voteManager.openNominations();
        this.handleDayDiscussion();
        break;

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

    // 夜晚死亡的月之子 / 傻瓜：天亮时激活待选择状态
    for (const [, player] of this.room.players) {
      if (player.role && player.role.id === 'moonchild' && player.abilityState && player.abilityState.pendingSelectNextDay) {
        player.abilityState.pendingSelectNextDay = false;
        player.abilityState.pendingSelect = true;
        this.logAction('ABILITY', `${player.seat+1}号 ${player.name}（月之子）夜晚死亡，今日白天需公开选择目标`, {
          playerId: player.id, role: 'moonchild'
        });
      }
      if (player.role && player.role.id === 'klutz' && player.abilityState && player.abilityState.pendingKlutzSelectNextDay) {
        player.abilityState.pendingKlutzSelectNextDay = false;
        player.abilityState.pendingKlutzSelect = true;
        this.logAction('ABILITY', `${player.seat+1}号 ${player.name}（傻瓜）夜晚死亡，今日白天需公开选择一名玩家`, {
          playerId: player.id, role: 'klutz'
        });
      }
    }

    // 公布死亡
    this.io.to(this.room.id).emit('game:dawnReport', {
      isFirstNight: gs.nightCount === 0,
      deaths: deaths.map(d => ({
        seat: d.seat,
        name: d.name,
        playerId: d.playerId
      }))
    });

    // 天亮不再需要全员确认：公布死亡后短暂停留，自动进入白天讨论
    this.room.confirmations.clear();
    this.broadcastState();
    if (this._dawnEndTimer) {
      clearTimeout(this._dawnEndTimer);
      this._dawnEndTimer = null;
    }
    // 留出「昼夜转场动画 + 结束后停留观看结果」的时间（前端动画约 4.1s）
    this._dawnEndTimer = setTimeout(() => {
      this._dawnEndTimer = null;
      const cur = this.room.gameState;
      if (!cur || cur.phase !== PHASES.DAY_DAWN) return;
      this.transitionTo(PHASES.DAY_DISCUSSION);
    }, 4200);
  }

  handleDayDiscussion() {
    // 进入自由讨论阶段，等待提名或全员确认结束讨论
    if (this.botManager) {
      this.botManager.triggerDayChat();
    }
    this.waitForConfirmation();
  }

  waitForConfirmation() {
    this.room.confirmations.clear();
    this.broadcastState();
  }

  // 处决阶段自动结束：保留一小段时间给前端播放处决动画，随后自动进入夜晚。
  // 处决不需要全员确认，也不再作为独立可确认阶段。
  scheduleExecutionEnd(delayMs = 3600) {
    const gs = this.room.gameState;
    if (!gs) return;
    if (this._executionEndTimer) {
      clearTimeout(this._executionEndTimer);
      this._executionEndTimer = null;
    }
    this.broadcastState();
    this._executionEndTimer = setTimeout(() => {
      this._executionEndTimer = null;
      const cur = this.room.gameState;
      if (!cur || cur.phase !== PHASES.EXECUTION) return;
      // 处决后先检查胜负，无人获胜才进入夜晚
      const victory = this.victoryChecker.checkVictory();
      if (victory) return;
      this.transitionTo(PHASES.NIGHT);
    }, Math.max(0, delayMs));
  }

  onAllConfirmed() {
    const gs = this.room.gameState;

    switch (gs.phase) {
      case PHASES.DAY_DAWN:
        this.transitionTo(PHASES.DAY_DISCUSSION);
        break;

      case PHASES.DAY_DISCUSSION:
        // 讨论/提名合并阶段结束：立即结算处决（处决阶段自动进入夜晚，无需确认）
        this.voteManager.closeNominations();
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
    // 只有「讨论+提名」阶段需要确认；天亮与处决阶段均自动推进
    const needConfirmPhases = ['DAY_DISCUSSION'];
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

    const targets = action.targets || [];
    const isDrunk = player.role && player.role.id === 'drunk' && player.fakeRole;
    // 酒鬼/疯子按假身份行动时，跳过权限也跟随假身份（如假小恶魔的「空刀」）
    const canSkip = player.role.canSkip === true
      || !!(player.fakeRole && player.fakeRole.canSkip === true);
    // 「跳过行动」由 NightResolver 处理。这里不能再按 selectCount 校验目标数量，
    // 否则像珀这样 selectCount>0 且 canSkip=true 的角色永远无法跳过，
    // 其「上次未选择→今晚选三人」的机制也就无法触发。
    // SNV 理发师：恶魔被额外唤醒一次，需要选择两名玩家交换角色
    const gsNow = this.room.gameState;
    const currentEntry = (gsNow.nightQueue || [])[gsNow.currentNightIndex] || {};
    const isBarberSwap = currentEntry.barberSwap === true;
    // 选角色类技能（哲学家/坑巫/洗脑师等）不按玩家数量校验
    const isRoleSelect = (player.role.selectType || 'player') !== 'player';
    // 唤醒信息可能动态调整可选人数（如哲学家获得三人技能、理发师交换需两人）
    const wakeCount = gsNow.currentWakeInfo && typeof gsNow.currentWakeInfo.canSelectCount === 'number'
      ? gsNow.currentWakeInfo.canSelectCount
      : null;

    if (!(action.skip === true && canSkip) && !isRoleSelect && !isBarberSwap) {
      const effectiveSelectCount = wakeCount !== null ? wakeCount : (player.role.selectCount || 0);
      if (effectiveSelectCount > 0 && targets.length !== effectiveSelectCount) {
        return { success: false, message: `请选择${effectiveSelectCount}名玩家` };
      }
    }
    if (player && player.role) {
      const targetNames = targets.map(tid => {
        const t = this.room.players.get(tid);
        return t ? `${t.seat+1}号${t.name}` : tid;
      }).join('、');
      const roleName = isBarberSwap ? '理发师' : (isDrunk ? player.fakeRole.name : player.role.name);

      // 描述本次行动实际做了什么：跳过 / 选角色 / 选玩家 / 无目标
      let actionText = '';
      if (action.skip === true) {
        // 小恶魔（含以为自己是小恶魔的酒鬼/疯子）的跳过是「空刀」：规则上允许，日志需明确本夜不杀人
        const actsAsImp = player.role.id === ROLE_IDS.IMP
          || !!(player.fakeRole && player.fakeRole.id === ROLE_IDS.IMP);
        actionText = actsAsImp ? '选择空刀（本夜不杀人）' : '跳过了本夜行动';
      } else if (action.roleId) {
        let pickedName = action.roleId;
        try {
          const picked = this.roleAllocator.createRoleInstance(action.roleId);
          if (picked) pickedName = picked.name;
        } catch (e) { /* 角色 id 无法解析时退化为原始 id */ }
        actionText = `选择了角色【${pickedName}】`;
      } else if (isBarberSwap && targets.length > 0) {
        actionText = `通过理发师交换 ${targetNames} 的角色`;
      } else if (targets.length > 0) {
        actionText = `选择了 ${targetNames}`;
      }

      // 无目标的被动角色（如间谍查看魔典、教父首夜得知外来者）只在「唤醒」与
      // 「私密信息」里记录，这里不再生成「选择了无目标」这种误导性行动日志
      if (actionText) {
        this.logAction('NIGHT_ACTION', `${player.seat+1}号 ${player.name}（${roleName}${isDrunk?'/酒鬼':''}）夜晚行动：${actionText}`, {
          playerId, role: isDrunk ? player.fakeRole.id : player.role.id, targets
        });
      }
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
  processDayAbility(playerId, abilityName, targetId, extra) {
    const player = this.room.players.get(playerId);
    if (!player) {
      return { success: false, message: '玩家不存在' };
    }
    // 月之子 / 傻瓜是死亡后触发选择，所以不检查isAlive
    const isMoonchild = player.role && player.role.id === 'moonchild';
    const isKlutz = player.role && player.role.id === 'klutz';
    if (!isMoonchild && !isKlutz && !player.isAlive) {
      return { success: false, message: '你已死亡' };
    }
    if (abilityName === 'gossip') {
      return player.role.onDayAbility(this.room.gameState, player, extra, this);
    }
    if (abilityName === 'moonchild') {
      if (!player.role || player.role.id !== 'moonchild') {
        return { success: false, message: '你不是月之子' };
      }
      return player.role.onDayAbility(this.room.gameState, player, targetId, this);
    }
    // SNV 洗脑师：被洗脑的玩家公开声称指定角色，避免当天被处决
    if (abilityName === 'cerenovus_claim') {
      const gs = this.room.gameState;
      const curse = gs.cerenovusCurse;
      if (!curse || curse.targetId !== playerId || curse.day !== gs.dayCount) {
        return { success: false, message: '你没有需要宣告的角色' };
      }
      if (curse.claimed) {
        return { success: false, message: '你今天已经宣告过了' };
      }
      curse.claimed = true;
      this.logAction('ABILITY', `${player.seat + 1}号 ${player.name} 公开声称自己是【${curse.roleName}】（洗脑宣告）`, {
        playerId, role: 'cerenovus_claim', claimedRoleId: curse.roleId
      });
      return { success: true, roleName: curse.roleName };
    }
    if (player.role && player.role.onDayAbility) {
      let payload = targetId;
      if (abilityName === 'artist' || abilityName === 'savant' || abilityName === 'mutant') {
        payload = extra;
      } else if (abilityName === 'juggler') {
        payload = { targetId, roleId: extra && extra.roleId };
      }
      return player.role.onDayAbility(this.room.gameState, player, payload, this, extra);
    }
    return { success: false, message: '该角色无此技能' };
  }

  // 白天技能在异步（裁判 AI）判定请求成功后的确认（目前仅造谣者需要）
  confirmDayAbility(playerId) {
    const player = this.room.players.get(playerId);
    if (!player || !player.role || typeof player.role.confirmDayAbility !== 'function') return;
    player.role.confirmDayAbility(this.room.gameState, player, this);
  }

  // 白天技能在异步（裁判 AI）判定请求失败后的回滚，回滚后玩家可重新发动
  cancelDayAbility(playerId) {
    const player = this.room.players.get(playerId);
    if (!player || !player.role || typeof player.role.cancelDayAbility !== 'function') return;
    player.role.cancelDayAbility(this.room.gameState, player, this);
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
      }))
      // 固定按座位号排序：players 的 Map 顺序会受加入/重连/加机器人时机影响，
      // 前端多处按此数组顺序渲染（选人、投票、会话列表等），不排序会出现“座位号没变但顺序变了”
      .sort((a, b) => a.seat - b.seat);

    const seatedCount = players.length;
    const neededConfirm = Array.from(room.players.values())
      .filter(p => p.seat !== -1 && (p.isBot || p.isConnected)).length;

    // 管家限制：主人存活且尚未投赞成时，本人不能投赞成（中毒者不受限）
    // 判定口径与 VoteManager.castVote 保持一致，供前端禁用「赞成」按钮
    let butlerYesBlocked = false;
    if (viewer.role && viewer.role.id === 'butler' && !viewer.isPoisoned) {
      const masterId = viewer.abilityState && viewer.abilityState.masterId;
      const master = masterId ? room.players.get(masterId) : null;
      if (master && master.isAlive) {
        const nom = gs.nominations && gs.nominations[gs.currentNominationIndex];
        const masterVotedYes = !!(nom && nom.currentVotes && nom.currentVotes[master.id] === true);
        butlerYesBlocked = !masterVotedYes;
      }
    }

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
      // 实际配比（含设置修正），公开信息
      composition: gs.composition || null,
      isNight: gs.phase === PHASES.FIRST_NIGHT || gs.phase === PHASES.NIGHT || gs.phase === PHASES.NIGHT_WAKE,
      currentWakePlayerId: gs.currentWakePlayerId,
      currentDefensePlayerId: gs.currentDefensePlayerId,
      // 本夜唤醒面板数据：玩家刷新/掉线重连后据此补出行动界面
      nightWake: gs.currentWakePlayerId === viewerId ? (gs.currentWakeInfo || null) : null,
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
      winEffect: gs.winEffect || null,
      mastermindExtraRound: !!gs.mastermindExtraRound,
      confirmedCount: room.confirmations.size,
      confirmedIds: Array.from(room.confirmations),
      totalNeeded: neededConfirm,
      yourRole: viewer.role ? (() => {
        // 酒鬼/疯子看到的是假身份（莽夫没有假身份）
        const fakeRoleIds = ['drunk', 'madman'];
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
        })) : null,
      myAbilityState: {
        pendingMoonchildSelect: !!(viewer.abilityState && viewer.abilityState.pendingSelect),
        pendingKlutzSelect: !!(viewer.abilityState && viewer.abilityState.pendingKlutzSelect),
        // 洗脑师：今天必须公开宣告的角色名（未宣告时为 null）
        cerenovusClaimRole: (() => {
          const c = gs.cerenovusCurse;
          if (!c || c.targetId !== viewerId || c.day !== gs.dayCount || c.claimed) return null;
          return c.roleName;
        })(),
        // 白天技能是否已使用（杀手按钮据此显示「已使用」并禁用）
        usedDayAbility: !!viewer.hasUsedDayAbility,
        artistUsed: !!(viewer.abilityState && viewer.abilityState.artistUsed),
        savantAskedToday: !!(viewer.abilityState && viewer.abilityState.savantDay === gs.dayCount),
        jugglerGuesses: (viewer.abilityState && viewer.abilityState.jugglerGuesses || []).length,
        // 管家：主人未投赞成时为 true，前端据此禁用「赞成」按钮
        butlerYesBlocked
      }
    };

    return state;
  }

  // 广播系统聊天消息（游戏中流程结果统一走这里，在聊天区显示为居中提示且有记录）
  sendSystemChat(content) {
    const gs = this.room.gameState;
    if (!gs || !content) return;
    const msg = {
      id: Date.now() + Math.random(),
      fromId: 'system',
      fromName: '系统',
      fromSeat: -1,
      isDead: false,
      isSystem: true,
      content: String(content).substring(0, 200),
      channel: 'public',
      timestamp: Date.now()
    };
    if (gs.chatLog) gs.chatLog.push(msg);
    this.io.to(this.room.id).emit('chat:message', msg);
  }

  // 发送聊天消息
  sendChat(fromId, message, type, toId, image) {
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
    // 图片消息：已由客户端压缩，服务端只做体积/格式兜底校验
    if (image && image.data) chatMsg.image = image;

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
          isSystem: true,
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
