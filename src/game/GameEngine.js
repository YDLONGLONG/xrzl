// 游戏引擎 - 状态机核心
const { PHASES, ROLE_IDS } = require('../config/game-config');
const { getSeatedPlayers, getPlayerEffectiveTeam } = require('../utils/helpers');
const { getStandardProbConfig, getProbConfigMeta } = require('../config/prob-config');
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
      wokenThisNight: [], // 本夜实际被唤醒的玩家（侍女等技能依赖）
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

    // 人工说书人：挂起的白天问答 Promise
    this._stQuestion = null;
  }

  // 是否为人工说书人模式
  isManualStoryteller() {
    return !!this.room.storytellerMode;
  }

  // 确保说书人状态存在（仅人工模式使用）
  _ensureStorytellerState() {
    const gs = this.room.gameState;
    if (!gs.storyteller) {
      gs.storyteller = {
        pendingWake: null,
        pendingInfos: [],
        nightReview: null,
        pendingQuestion: null,
        pendingChoices: []
      };
    }
    const st = gs.storyteller;
    if (!Array.isArray(st.pendingInfos)) st.pendingInfos = [];
    if (!Array.isArray(st.pendingChoices)) st.pendingChoices = [];
    return st;
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
    // 学者：把「哪一问是真话」注入上帝视角的私信副本（不会随玩家状态下发）
    const withSavantTruth = (p) => (info) => {
      if (!info || info.type !== 'savant') return info;
      const log = p.savantLog || [];
      if (!Array.isArray(info.questions) || log.length === 0) return info;
      const answers = info.answers || [];
      const rec = log.find(r => Array.isArray(r.questions) && Array.isArray(r.answers)
        && r.questions[0] === info.questions[0] && r.questions[1] === info.questions[1]
        && r.answers[0] === answers[0] && r.answers[1] === answers[1]);
      if (!rec) return info;
      return {
        ...info,
        // savantTruth[i] = 第 i 个答案是否为真话
        savantTruth: rec.answers.map((a, i) => (rec.vortox ? false : i !== rec.falseIndex)),
        savantVortox: !!rec.vortox
      };
    };

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
        team: p.role ? getPlayerEffectiveTeam(p) : null,
        category: p.role ? p.role.category : null,
        voteToken: p.voteToken,
        savantLog: p.savantLog || null,
        privateInfo: withSavantTruth(p)(p.privateInfo),
        privateInfoHistory: (p.privateInfoHistory || []).map(withSavantTruth(p))
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
      revivesToAnnounce: gs.revivesToAnnounce || [],
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
    // 人工说书人：夜晚所有玩家的信息先入待发队列（含机器人与托管玩家），由说书人编辑并确认后发送
    const nightPhase = gs && (gs.phase === PHASES.FIRST_NIGHT || gs.phase === PHASES.NIGHT || gs.phase === PHASES.NIGHT_WAKE);
    if (this.isManualStoryteller() && gs && gs.storytellerArmed && nightPhase
        && player && player.seat >= 0 && !this._stFlushing) {
      const st = this._ensureStorytellerState();
      st.pendingInfos.push({
        id: 'stinfo_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        playerId: player.id,
        playerName: player.name,
        seat: player.seat,
        roleName: player.role ? player.role.name : '未知',
        isBot: !!player.isBot,
        message: info && info.message != null ? String(info.message) : '',
        isFalse: !!isFalse,
        realInfo: isFalse ? realInfo : null,
        day: gs.dayCount || 0,
        phase: gs.phase
      });
      this.broadcastState();
      return;
    }
    this._deliverPrivateInfo(player, info, isFalse, realInfo);
  }

  // 实际发送私密信息（人工说书人确认后也走这里）
  _deliverPrivateInfo(player, info, isFalse = false, realInfo = null) {
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

  // 人工说书人：发送待发信息（可编辑文案）
  flushStorytellerInfos(edits = []) {
    const st = this.room.gameState.storyteller;
    if (!st || !Array.isArray(st.pendingInfos) || st.pendingInfos.length === 0) return 0;
    const editMap = {};
    (Array.isArray(edits) ? edits : []).forEach(e => {
      if (e && e.id) editMap[e.id] = e.message;
    });
    const queue = st.pendingInfos.slice();
    st.pendingInfos = [];
    this._stFlushing = true;
    try {
      for (const item of queue) {
        const player = this.room.players.get(item.playerId);
        if (!player) continue;
        const message = (editMap[item.id] !== undefined && editMap[item.id] !== null)
          ? String(editMap[item.id])
          : item.message;
        this._deliverPrivateInfo(player, { message }, item.isFalse, item.realInfo);
      }
    } finally {
      this._stFlushing = false;
    }
    return queue.length;
  }

  // 人工说书人：下发给房主的状态快照
  getStorytellerSnapshot() {
    const gs = this.room.gameState;
    const st = gs.storyteller || {};
    const review = st.nightReview || null;
    const choices = st.pendingChoices || [];
    // 本夜死亡以玩家实时状态为准（如赌徒猜错、月之子诅咒等在快照生成后发生的死亡）
    const diedTonightIds = new Set();
    if (review) {
      Array.from(this.room.players.values())
        .filter(p => p.seat !== -1 && p.isDead && p.deathNight === review.nightCount)
        .forEach(p => diedTonightIds.add(p.id));
    }
    const deathRows = review ? (review.deaths || []).map(d => ({
      id: d.id, seat: d.seat, name: d.name, roleName: d.roleName,
      checked: !!d.checked || diedTonightIds.has(d.id), locked: !!d.locked
    })) : [];
    if (review) {
      // 快照生成后才发生的本夜死亡，补进死亡名单并默认勾选
      const rowIds = new Set(deathRows.map(d => d.id));
      Array.from(this.room.players.values())
        .filter(p => p.seat !== -1 && diedTonightIds.has(p.id) && !rowIds.has(p.id))
        .forEach(p => deathRows.push({
          id: p.id, seat: p.seat, name: p.name,
          roleName: p.role ? p.role.name : '未知',
          checked: true, locked: false
        }));
      deathRows.sort((a, b) => a.seat - b.seat);
    }
    // 夜间阶段取当前夜的行动记录；白天取刚刚结束的一夜（beginNight 时已转存）
    const isNightPhase = gs.phase === PHASES.FIRST_NIGHT
      || gs.phase === PHASES.NIGHT
      || gs.phase === PHASES.NIGHT_WAKE;
    const nightActions = (isNightPhase ? gs.nightActionLog : gs.lastNightActionLog) || [];
    let awaiting = null;
    if (st.pendingWake) awaiting = 'wake';
    else if (review) awaiting = 'nightEnd';
    else if (st.pendingQuestion) awaiting = 'question';
    else if (choices.length > 0) awaiting = 'choice';

    return {
      awaiting,
      pendingWake: st.pendingWake || null,
      pendingChoices: choices.map(c => ({
        kind: c.kind,
        label: c.label,
        options: (c.options || []).map(o => ({ id: o.id, seat: o.seat, name: o.name })),
        chosenId: c.chosenId || null
      })),
      pendingInfos: (st.pendingInfos || []).map(info => ({
        id: info.id,
        playerId: info.playerId,
        playerName: info.playerName,
        seat: info.seat,
        roleName: info.roleName,
        message: info.message
      })),
      nightReview: review ? {
        nightCount: review.nightCount,
        deaths: deathRows,
        statuses: (review.statuses || []).map(s => ({
          playerId: s.playerId, seat: s.seat, name: s.name,
          drunk: !!s.drunk, poisoned: !!s.poisoned,
          foolImmune: s.foolImmune === true ? true : (s.foolImmune === false ? false : null)
        })),
        choices: (review.choices || []).map(c => ({
          kind: c.kind, label: c.label,
          options: (c.options || []).map(o => ({ id: o.id, seat: o.seat, name: o.name })),
          chosenId: c.chosenId || null
        })),
        infos: (review.infos || []).map(info => ({
          id: info.id, playerId: info.playerId, playerName: info.playerName,
          seat: info.seat, message: info.message
        }))
      } : null,
      pendingQuestion: st.pendingQuestion ? {
        id: st.pendingQuestion.id,
        kind: st.pendingQuestion.kind,
        playerId: st.pendingQuestion.playerId,
        playerName: st.pendingQuestion.playerName,
        questions: (st.pendingQuestion.questions || []).map(q => ({ text: q.text }))
      } : null,
      players: Array.from(this.room.players.values())
        .filter(p => p.seat !== -1)
        .sort((a, b) => a.seat - b.seat)
        .map(p => ({
          id: p.id,
          seat: p.seat,
          name: p.name,
          roleId: p.role ? p.role.id : null,
          roleName: p.role ? p.role.name : '未分配',
          abilityDesc: p.role && p.role.abilityDesc ? p.role.abilityDesc : '',
          fakeRoleName: p.fakeRole ? p.fakeRole.name : '',
          team: p.role ? p.role.team : null,
          // 弄臣：首次死亡免疫是否还可用（非弄臣为 null）
          foolImmune: p.role && p.role.id === 'fool' ? !(p.abilityState && p.abilityState.usedDeath) : null,
          isAlive: p.isAlive,
          isDead: p.isDead,
          isBot: !!p.isBot,
          aiTakeover: !!p.aiTakeover
        })),
      nightActions: nightActions.map(a => ({
        playerId: a.playerId,
        seat: a.seat,
        name: a.name,
        roleName: a.roleName || '',
        action: a.action,
        targets: (a.targets || []).map(t => ({ id: t.id, seat: t.seat, name: t.name })),
        roleId: a.roleId || null,
        note: a.note || '',
        at: a.at
      })),
      nightActionNight: gs.nightCount
    };
  }

  // 人工说书人：提出待回答的是非题，返回 Promise<{ok, answers}>
  askStorytellerQuestions(questions, meta = {}) {
    return new Promise((resolve) => {
      if (!this.isManualStoryteller()) {
        resolve({ ok: false, reason: 'notManual' });
        return;
      }
      // 同时只保留一个问题，旧问题按中断处理
      this._finishStorytellerQuestion({ ok: false, reason: 'superseded' });
      const st = this._ensureStorytellerState();
      const id = 'stq_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      const list = (Array.isArray(questions) ? questions : [questions])
        .map(q => ({ text: String(q == null ? '' : q) }));
      st.pendingQuestion = {
        id,
        kind: meta.kind || 'general',
        playerId: meta.playerId || null,
        playerName: meta.playerName || '',
        questions: list,
        answers: []
      };
      // 10 分钟未回答视为失败，避免对局永久卡住
      const timer = setTimeout(() => {
        this._finishStorytellerQuestion({ ok: false, reason: 'timeout' }, id);
        this.broadcastState();
      }, 10 * 60 * 1000);
      this._stQuestion = { id, resolve, timer };
      this.broadcastState();
    });
  }

  // 结束当前挂起的问题（可指定 id 防止旧定时器误伤新问题）
  _finishStorytellerQuestion(result, id = null) {
    const ctx = this._stQuestion;
    if (!ctx) return false;
    if (id && ctx.id !== id) return false;
    clearTimeout(ctx.timer);
    this._stQuestion = null;
    const st = this.room.gameState.storyteller;
    if (st && st.pendingQuestion && st.pendingQuestion.id === ctx.id) st.pendingQuestion = null;
    try { ctx.resolve(result); } catch (e) { /* 忽略重复 resolve */ }
    return true;
  }

  // 说书人回答问题
  answerStorytellerQuestion(id, answers) {
    const st = this.room.gameState.storyteller;
    if (!st || !st.pendingQuestion) return { success: false, message: '当前没有待回答的问题' };
    if (id && st.pendingQuestion.id !== id) return { success: false, message: '问题已失效' };
    const total = (st.pendingQuestion.questions || []).length;
    const arr = Array.isArray(answers) ? answers.map(a => !!a) : [];
    if (arr.length !== total) return { success: false, message: '回答数量不正确' };
    const ok = this._finishStorytellerQuestion({ ok: true, answers: arr }, st.pendingQuestion.id);
    if (!ok) return { success: false, message: '问题已失效' };
    this.broadcastState();
    return { success: true };
  }

  // 中断挂起问题（房主交接 / 对局结束）
  cancelStorytellerQuestion(reason = 'interrupted') {
    const had = this._finishStorytellerQuestion({ ok: false, reason });
    if (had) this.broadcastState();
  }

  // 说书人：唤醒 / 跳过
  handleStorytellerWake(action, message) {
    if (!this.isManualStoryteller()) return { success: false, message: '当前不是人工说书人模式' };
    return this.nightResolver.resumeWake(action, message);
  }

  // 说书人：确认夜晚审核
  handleStorytellerConfirmNight(payload = {}) {
    if (!this.isManualStoryteller()) return { success: false, message: '当前不是人工说书人模式' };
    return this.nightResolver.confirmNight(payload);
  }

  // 随机决策统一入口：自动模式立即执行，人工模式挂起等待说书人选择
  // 人工模式下白天同样挂起（不依赖 storytellerArmed），夜晚流程行为不变
  // revertFn：说书人改选时撤销上一次选择的效果（可选）
  requestStorytellerChoice(kind, label, options, applyFn, revertFn = null) {
    const list = (Array.isArray(options) ? options : []).filter(Boolean);
    if (list.length === 0) return false;
    if (!this.isManualStoryteller()) {
      applyFn(list[Math.floor(Math.random() * list.length)]);
      return true;
    }
    const st = this._ensureStorytellerState();
    st.pendingChoices.push({ kind, label, options: list, applyFn, revertFn, chosenId: null });
    this.broadcastState();
    return true;
  }

  // 应用说书人的随机决策（白天立即生效 / 夜晚审核时统一应用）
  applyStorytellerChoice(kind, chosenId) {
    const st = this._ensureStorytellerState();
    // 修补匠 / 隐士：点击名字只切换「夜晚死亡名单」里的勾选状态，不立即结算生死
    if (kind === 'night_death_candidate') {
      const choice = (st.pendingChoices || []).find(c =>
        c.kind === kind && (c.options || []).some(o => o.id === chosenId)
      );
      if (!choice) return false;
      choice.chosenId = choice.chosenId === chosenId ? null : chosenId;
      // 重建审核快照，使死亡名单的勾选与点击结果保持一致
      if (st.nightReview) this.nightResolver._buildNightReview();
      this.broadcastState();
      return true;
    }

    const idx = st.pendingChoices.findIndex(c => c.kind === kind);
    if (idx < 0) return false;
    const choice = st.pendingChoices[idx];
    const opt = (choice.options || []).find(o => o.id === chosenId);
    if (!opt) return false;
    const prevId = choice.chosenId || null;
    // 点击已选中的目标：保持选中，不重复生效
    if (prevId === chosenId) return true;
    // 改选：先撤销上一次选择的效果，再应用新选择；条目保留在待处理区
    if (prevId && typeof choice.revertFn === 'function') {
      choice.revertFn(prevId);
    }
    choice.chosenId = chosenId;
    if (typeof choice.applyFn === 'function') choice.applyFn(opt);
    // 重建审核快照：让死亡名单、醉酒/中毒标记、身份表等与点击结果保持一致
    if (st.nightReview) this.nightResolver._buildNightReview();
    this.broadcastState();
    return true;
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

    // 人工说书人：初始化状态。开局信息仍直接下发，后续夜晚进入审核流
    if (this.isManualStoryteller()) {
      this.room.gameState.storytellerArmed = false;
      this.room.gameState.storyteller = {
        pendingWake: null,
        pendingInfos: [],
        nightReview: null,
        pendingQuestion: null,
        pendingChoices: []
      };
    }

    this.logAction('GAME_START', `游戏开始！共${seatedPlayers.length}名玩家${hasCustom ? '（自定义角色）' : ''}`, { playerCount: seatedPlayers.length });

    // 重置确认集合
    this.room.confirmations.clear();

    // 开始第一夜
    this.transitionTo(PHASES.FIRST_NIGHT);
  }

  transitionTo(phase) {
    const gs = this.room.gameState;
    // 人工说书人：只有夜间阶段启用信息拦截
    if (gs.storyteller && phase !== PHASES.FIRST_NIGHT && phase !== PHASES.NIGHT && phase !== PHASES.NIGHT_WAKE) {
      gs.storytellerArmed = false;
      gs.storyteller.pendingWake = null;
    }
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
      })),
      revives: (gs.revivesToAnnounce || []).map(r => ({
        seat: r.seat,
        name: r.name,
        playerId: r.playerId
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
        Promise.resolve(this.voteManager.closeNominations()).catch(() => {});
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
        Promise.resolve(this.voteManager.endVoting()).catch(() => {});
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

    // 断线但尚未被托管的真人仍要计入：座位为他们保留，等重连或房主手动托管。
    // 只有已交由 AI 托管的断线玩家改由 AI 代确认，不再阻塞阶段推进。
    const seatedPlayers = getSeatedPlayers(this.room)
      .filter(p => p.isBot || p.isConnected || !p.aiTakeover);
    if (seatedPlayers.length === 0) return;

    // 必须按「名单内还有谁没确认」判断，不能用 confirmations.size：
    // 集合里可能残留名单外玩家（已托管/已断线）的确认记录，用 size 比较会让计数虚高，
    // 出现「房主还没确认，托管别人后阶段却被直接推进」的问题。
    const pending = seatedPlayers.filter(p => !this.room.confirmations.has(p.id));
    if (pending.length === 0) this.onAllConfirmed();
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
    // 理发师交换：白天死亡走队列项，夜晚死亡走结算时追加的额外唤醒
    const isBarberSwap = currentEntry.barberSwap === true
      || !!(gsNow.currentWakeInfo && gsNow.currentWakeInfo.barberSwap === true);
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
      if (abilityName === 'artist' || abilityName === 'savant' || abilityName === 'mutant'
        || abilityName === 'juggler') {
        // 杂耍艺人：一次提交整批猜测 { guesses: [{ targetId, roleId }] }
        payload = extra;
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

  async endVoting() {
    return await this.voteManager.endVoting();
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
        isBot: !!p.isBot,
        aiTakeover: !!p.aiTakeover
      }))
      // 固定按座位号排序：players 的 Map 顺序会受加入/重连/加机器人时机影响，
      // 前端多处按此数组顺序渲染（选人、投票、会话列表等），不排序会出现“座位号没变但顺序变了”
      .sort((a, b) => a.seat - b.seat);

    const seatedCount = players.length;
    // 未入座的旁观者（游戏进行中仍留在房间里的玩家）
    const spectators = Array.from(room.players.values())
      .filter(p => p.seat === -1)
      .map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.id === room.hostId,
        isConnected: p.isConnected,
        isBot: !!p.isBot
      }));
    // 与 checkConfirmations 口径一致：断线未托管的真人仍需要确认
    const needConfirmPlayers = Array.from(room.players.values())
      .filter(p => p.seat !== -1 && (p.isBot || p.isConnected || !p.aiTakeover));
    const neededConfirm = needConfirmPlayers.length;
    // 进度只统计名单内玩家的确认，避免把已被托管玩家的确认记录算进分子
    const confirmedNeeded = needConfirmPlayers.filter(p => room.confirmations.has(p.id)).length;

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
      spectators,
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
      revivesToAnnounce: gs.revivesToAnnounce || [],
      todaysDeaths: gs.todaysDeaths,
      winner: gs.winner,
      winReason: gs.winReason,
      winEffect: gs.winEffect || null,
      mastermindExtraRound: !!gs.mastermindExtraRound,
      confirmedCount: confirmedNeeded,
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
        .filter(p => p.seat !== -1 && p.role)
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
        // 艺术家：正在等待说书人回答（按钮禁用，防止重复提交）
        artistPendingAnswer: !!(viewer.abilityState && viewer.abilityState.artistPending),
        // 艺术家：当天裁判失败时的问题，当天重试自动回填（跨天不保留）
        artistLastQuestion: (viewer.abilityState
          && typeof viewer.abilityState.artistLastAttempt === 'string'
          && viewer.abilityState.artistLastAttemptDay === gs.dayCount)
          ? viewer.abilityState.artistLastAttempt
          : null,
        savantAskedToday: !!(viewer.abilityState && viewer.abilityState.savantDay === gs.dayCount),
        // 学者：正在等待说书人回答（按钮禁用，防止重复提交）
        savantPendingAnswer: !!(viewer.abilityState && Array.isArray(viewer.abilityState.savantPending)
          && viewer.abilityState.savantPending.length === 2),
        // 学者：当天裁判失败时的问题，当天重试自动回填（跨天不保留）
        savantLastQuestions: (viewer.abilityState
          && Array.isArray(viewer.abilityState.savantLastAttempt)
          && viewer.abilityState.savantLastAttempt.length === 2
          && viewer.abilityState.savantLastAttemptDay === gs.dayCount)
          ? viewer.abilityState.savantLastAttempt.slice(0, 2)
          : null,
        // 杂耍艺人：本局是否已一次性公开猜测（提交后按钮禁用）
        jugglerDone: !!(viewer.abilityState && viewer.abilityState.jugglerSubmitted),
        // 管家：主人未投赞成时为 true，前端据此禁用「赞成」按钮
        butlerYesBlocked
      }
    };

    // 人工说书人：仅房主可见的审核快照
    if (this.isManualStoryteller() && viewerId === room.hostId) {
      state.isStoryteller = true;
      state.storyteller = this.getStorytellerSnapshot();
    }

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
