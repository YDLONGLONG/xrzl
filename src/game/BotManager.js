// 简单AI机器人管理器 - 用于测试和补位
const { isEffectivelyDead } = require('../utils/helpers');

class BotManager {
  constructor(engine) {
    this.engine = engine;
    this._lastPhase = null;
    this._lastNominationCount = 0;
  }

  addBot(botName) {
    const room = this.engine.room;
    if (!room) return null;
    if (room.gameState.gameStarted) return null;
    if (room.players.size >= 15) return null;

    // 找一个空座位
    let seatNum = -1;
    for (let i = 0; i < 15; i++) {
      if (room.seats[i] === null) {
        seatNum = i;
        break;
      }
    }
    if (seatNum === -1) return null;

    const botId = 'bot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const bot = {
      id: botId,
      name: botName,
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
      deathNight: -1,
      deathCause: null,
      votedBy: [],
      privateInfo: null,
      _botTimer: null,
      _botVoted: false,
      _botNominated: false,
      _botConfirmed: false,
      _botDefensed: false
    };

    room.players.set(botId, bot);
    room.seats[seatNum] = bot;

    this.engine.broadcastState();
    return bot;
  }

  // 清除bot的所有待执行定时器
  _clearBotTimer(bot) {
    if (bot._botTimer) {
      clearTimeout(bot._botTimer);
      bot._botTimer = null;
    }
  }

  // 真人重连：取消 AI 托管与已排队的机器人动作，交还操作权
  releaseAiControl(player) {
    if (!player) return;
    player.aiTakeover = false;
    this._clearBotTimer(player);
    player._botVoted = false;
    player._botNominated = false;
    player._botConfirmed = false;
    player._botDefensed = false;
  }

  // 该玩家当前是否由 AI 操作：机器人，或掉线超过重连窗口后被托管的真人
  _isAiControlled(player) {
    return !!(player && (player.isBot || (player.aiTakeover && !player.isConnected)));
  }

  // 调度bot行动（带防抖）
  _scheduleBot(botId, delay, callback) {
    const bot = this.engine.room.players.get(botId);
    if (!bot) return;
    this._clearBotTimer(bot);
    bot._botTimer = setTimeout(() => {
      bot._botTimer = null;
      if (!this.engine.room || !this.engine.room.gameState) return;
      const b = this.engine.room.players.get(botId);
      if (!b) return;
      // 真人已重连 / 尚未托管：取消本次 AI 操作
      if (!this._isAiControlled(b)) return;
      callback(b);
    }, delay);
  }

  // 当游戏状态变化时通知bot/断线玩家
  notifyAllBots() {
    const room = this.engine.room;
    if (!room) return;
    const gs = room.gameState;

    // 阶段变化时重置bot状态标记
    if (this._lastPhase !== gs.phase) {
      room.players.forEach(p => {
        if (this._isAiControlled(p)) {
          p._botVoted = false;
          p._botNominated = false;
          p._botConfirmed = false;
          p._botDefensed = false;
          this._clearBotTimer(p);
        }
      });
      this._lastPhase = gs.phase;
      this._lastNominationIndex = gs.currentNominationIndex !== undefined ? gs.currentNominationIndex : -1;
    }

    // 提名变化时（同一阶段内的新提名）重置投票状态
    if (gs.phase === 'VOTING' && gs.currentNominationIndex !== this._lastNominationIndex) {
      room.players.forEach(p => {
        if (this._isAiControlled(p)) {
          p._botVoted = false;
          this._clearBotTimer(p);
        }
      });
      this._lastNominationIndex = gs.currentNominationIndex;
    }

    room.players.forEach((p, pid) => {
      if (this._isAiControlled(p)) {
        this._processBot(pid);
      }
    });
  }

  _processBot(botId) {
    const room = this.engine.room;
    if (!room) return;
    const bot = room.players.get(botId);
    if (!bot) return;
    // 未托管（重连窗口内）的真人玩家保持手动操作
    if (!this._isAiControlled(bot)) return;

    const gs = room.gameState;
    if (!room.gameStarted) return;
    if (gs.phase === 'GAME_OVER') {
      this._clearBotTimer(bot);
      return;
    }

    // 夜晚唤醒 - 执行夜晚行动
    if (gs.phase === 'NIGHT_WAKE' && gs.currentWakePlayerId === botId) {
      if (bot._botTimer) return; // 已调度
      const delay = 800 + Math.random() * 1200;
      this._scheduleBot(botId, delay, (b) => {
        if (room.gameState.phase !== 'NIGHT_WAKE' || room.gameState.currentWakePlayerId !== botId) return;
        this._doBotNightAction(b);
      });
      return;
    }

    // 辩护阶段 - bot被提名时自动结束辩护
    if (gs.phase === 'DEFENSE' && gs.currentDefensePlayerId === botId && !bot._botDefensed) {
      if (bot._botTimer) return;
      bot._botDefensed = true;
      this._scheduleBot(botId, 2000 + Math.random() * 2000, (b) => {
        if (room.gameState.phase === 'DEFENSE') {
          this.engine.endDefense(botId);
        }
      });
      return;
    }

    // 投票阶段 - 自动投票
    if (gs.phase === 'VOTING' && this._canBotVote(bot)) {
      const nomination = gs.nominations[gs.currentNominationIndex];
      if (!nomination || nomination.resolved) return;
      
      const hasVoted = nomination.currentVotes[botId] !== undefined;
      
      if (!hasVoted && !bot._botVoted) {
        if (bot._botTimer) return;
        bot._botVoted = true;
        const delay = 400 + Math.random() * 1200;
        this._scheduleBot(botId, delay, (b) => {
          if (room.gameState.phase !== 'VOTING') {
            b._botVoted = false;
            return;
          }
          const vote = this._isAiControlled(b) ? this._getBotVoteDecision(b) : false;
          const result = this.engine.processVote(botId, vote);
          if (!result || !result.success) {
            b._botVoted = false;
            this._retryBotVote(botId);
          }
        });
        return;
      }
    }

    // 白天（讨论与提名已合并）—— bot 有概率提名，断线真实玩家不提名
    if (gs.phase === 'DAY_DISCUSSION' && bot.isBot && !isEffectivelyDead(bot) && !bot.hasNominated && !bot._botNominated) {
      if (bot._botTimer) return;
      if (Math.random() < this.engine.prob('bot_nominate')) {
        bot._botNominated = true;
        this._scheduleBot(botId, 1500 + Math.random() * 2500, (b) => {
          if (room.gameState.phase !== 'DAY_DISCUSSION') return;
          if (b.hasNominated || !b.isAlive) return;
          this._doBotNominate(b);
        });
        return;
      } else {
        bot._botNominated = true;
      }
    }

    // 确认阶段 - 自动确认（讨论/提名）—— 天亮已改为自动推进，不再需要确认
    // 机器人，以及房主手动交由 AI 托管的断线真人，都由 AI 代为确认
    if (['DAY_DISCUSSION'].includes(gs.phase)) {
      if (this._isAiControlled(bot) && !room.confirmations.has(botId) && !bot._botConfirmed) {
        if (bot._botTimer) return;
        bot._botConfirmed = true;
        this._scheduleBot(botId, 600 + Math.random() * 2000, (b) => {
          if (!room.confirmations.has(botId)) {
            this.engine.processConfirmation(botId);
          }
        });
      }
      return;
    }
  }

  _canBotVote(bot) {
    if (!isEffectivelyDead(bot)) return true;
    if (bot.voteToken > 0) return true;
    return false;
  }

  // bot投票失败后重试（如管家限制等）
  _retryBotVote(botId) {
    const room = this.engine.room;
    if (!room) return;
    const bot = room.players.get(botId);
    if (!bot) return;
    
    this._scheduleBot(botId, 800 + Math.random() * 800, (b) => {
      if (room.gameState.phase !== 'VOTING') {
        b._botVoted = false;
        return;
      }
      const nomination = room.gameState.nominations[room.gameState.currentNominationIndex];
      if (!nomination || nomination.resolved) {
        b._botVoted = false;
        return;
      }
      const hasVoted = nomination.currentVotes[botId] !== undefined;
      if (hasVoted) {
        b._botVoted = true;
        return;
      }
      const vote = this._isAiControlled(b) ? this._getBotVoteDecision(b) : false;
      const result = this.engine.processVote(botId, vote);
      if (!result || !result.success) {
        b._botVoted = false;
        this._retryBotVote(botId);
      }
    });
  }

  _doBotNightAction(bot) {
    const gs = this.engine.room.gameState;
    const alive = Array.from(this.engine.room.players.values()).filter(p => p.isAlive && p.seat !== -1);

    const role = bot.role;
    if (!role) return;

    // 本夜的唤醒信息以角色自身为准（可选人数 / 是否只能选死者 / 是否允许跳过），
    // 否则 bot 会按默认规则乱选，被服务端拒绝后整夜卡在「等待其他玩家行动」。
    let wakeInfo = null;
    try {
      wakeInfo = typeof role.getNightWakeInfo === 'function'
        ? role.getNightWakeInfo(gs, bot, this.engine, gs.nightCount === 0)
        : null;
    } catch (e) {
      wakeInfo = null;
    }

    // 当前实际唤醒面板（含理发师交换、哲学家复制能力等动态参数）优先，
    // 否则 bot 可能按角色默认人数行动而被服务端拒绝
    if (gs.currentWakePlayerId === bot.id && gs.currentWakeInfo) {
      wakeInfo = gs.currentWakeInfo;
    }

    const selectType = (wakeInfo && wakeInfo.selectType) || role.selectType || 'player';
    const canSkip = (wakeInfo && wakeInfo.canSkip !== undefined)
      ? !!wakeInfo.canSkip
      : !!role.canSkip;
    const selectCount = (wakeInfo && typeof wakeInfo.canSelectCount === 'number')
      ? wakeInfo.canSelectCount
      : (role.selectCount || 0);

    // ========== 跳过逻辑（canSkip=true时，侍臣等技能有概率今晚不使用） ==========
    // 小恶魔的「空刀」虽合法，但 bot 不随机空刀（会明显削弱邪恶方），保持每晚杀人
    const isImpBot = role.id === 'imp';
    if (canSkip && !isImpBot && Math.random() < 0.25) {
      this._sendBotNightAction(bot, { skip: true });
      return;
    }

    // ========== 选择角色（侍臣等） ==========
    if (selectType === 'role') {
      const { getScriptConfig } = require('../config/game-config');
      const scriptConfig = getScriptConfig(this.engine.room.script || 'tb');
      // 优先使用本夜面板给出的可选角色（如哲学家不能选自己）
      const roleIds = (wakeInfo && Array.isArray(wakeInfo.selectRoles) && wakeInfo.selectRoles.length > 0)
        ? wakeInfo.selectRoles.map(r => (typeof r === 'string' ? r : r.id))
        : scriptConfig.allRoles;
      if (!roleIds || roleIds.length === 0) {
        this._fallbackBotNightAction(bot, { message: '没有可选角色' });
        return;
      }
      // 侍臣作为善良阵营：优先选择邪恶阵营角色（恶魔/爪牙）概率高些
      let roleId;
      const evilIds = roleIds.filter(rid => {
        const ri = this.engine.roleAllocator.createRoleInstance(rid);
        return ri && ri.team === 'EVIL';
      });
      if (evilIds.length > 0 && Math.random() < 0.65) {
        roleId = evilIds[Math.floor(Math.random() * evilIds.length)];
      } else {
        roleId = roleIds[Math.floor(Math.random() * roleIds.length)];
      }
      const result = this._sendBotNightAction(bot, { roleId });
      if (!result.success) this._fallbackBotNightAction(bot, result);
      return;
    }

    // ========== 选择玩家+角色（赌徒） ==========
    if (selectType === 'playerAndRole') {
      const { getScriptConfig } = require('../config/game-config');
      const scriptConfig = getScriptConfig(this.engine.room.script || 'tb');
      // 面板给出的可选角色优先（洗脑师只能选善良角色、坑巫只能选不在场角色）
      const roleIds = (wakeInfo && Array.isArray(wakeInfo.selectRoles) && wakeInfo.selectRoles.length > 0)
        ? wakeInfo.selectRoles.map(r => (typeof r === 'string' ? r : r.id))
        : scriptConfig.allRoles;
      // 赌徒允许选自己，所以从所有存活里选（包括自己）
      const allAliveSelectable = alive.slice();
      const target = allAliveSelectable[Math.floor(Math.random() * allAliveSelectable.length)];
      const guessRoleId = roleIds && roleIds.length > 0
        ? roleIds[Math.floor(Math.random() * roleIds.length)]
        : null;
      if (!target || !guessRoleId) {
        this._fallbackBotNightAction(bot, { message: '没有可选目标' });
        return;
      }
      const result = this._sendBotNightAction(bot, { targets: [target.id], roleId: guessRoleId });
      if (!result.success) this._fallbackBotNightAction(bot, result);
      return;
    }

    // ========== 默认：选择玩家 ==========
    // 被拒绝时换一批目标重试，全部失败才走跳过兜底，避免夜晚永久卡住
    let lastResult = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const targets = this._pickBotNightTargets(bot, wakeInfo, selectCount);
      lastResult = this._sendBotNightAction(bot, { targets });
      if (lastResult.success) return;
      if (this.engine.room.gameState.currentWakePlayerId !== bot.id) return; // 已不再等待该玩家
    }
    this._fallbackBotNightAction(bot, lastResult);
  }

  // 依据唤醒信息为 bot 挑选合法目标
  _pickBotNightTargets(bot, wakeInfo, selectCount) {
    const room = this.engine.room;
    const all = Array.from(room.players.values()).filter(p => p.seat !== -1);
    const selectDead = !!(wakeInfo && wakeInfo.selectDead);
    const pool = all.filter(p => (selectDead ? !p.isAlive : p.isAlive));

    let candidates = pool.filter(p => p.id !== bot.id);

    // 驱魔人 / 魔鬼代言人：不能与上一夜选择相同，否则行动会被拒绝
    const lastTargetId = bot.abilityState && bot.abilityState.lastTargetId;
    if (lastTargetId && (bot.role.id === 'exorcist' || bot.role.id === 'devilsadvocate')) {
      const filtered = candidates.filter(p => p.id !== lastTargetId);
      if (filtered.length > 0) candidates = filtered;
    }

    // 恶魔优先杀好人（目标不足时退化为全部候选）
    if (!selectDead && bot.role.category === 'DEMON') {
      const goodTargets = candidates.filter(p => p.role && p.role.team !== 'EVIL');
      if (goodTargets.length >= selectCount) candidates = goodTargets;
    }

    candidates = candidates.slice();
    // 可选目标不足时允许包含自己（如旅店老板只剩一名其他玩家可选）
    if (candidates.length < selectCount && pool.some(p => p.id === bot.id)) {
      candidates.push(bot);
    }

    const targets = [];
    const limit = Math.min(selectCount, candidates.length);
    for (let i = 0; i < limit; i++) {
      const idx = Math.floor(Math.random() * candidates.length);
      targets.push(candidates[idx].id);
      candidates.splice(idx, 1);
    }
    return targets;
  }

  // 提交一次 bot 夜间行动（不做兜底，便于调用方重试）
  _sendBotNightAction(bot, action) {
    return this.engine.processNightAction(bot.id, action) || { success: false, message: '行动未生效' };
  }

  // 行动被拒绝后的兜底：能跳过就跳过，否则强制跳过本次唤醒
  _fallbackBotNightAction(bot, result) {
    const gs = this.engine.room.gameState;
    if (gs.currentWakePlayerId !== bot.id) return true; // 已经不再等待该玩家

    const role = bot.role;
    const canSkip = !!role.canSkip || !!(bot.fakeRole && bot.fakeRole.canSkip === true);
    if (canSkip) {
      const skipped = this.engine.processNightAction(bot.id, { skip: true });
      if (skipped && skipped.success) return true;
    }

    // 兜底：跳过本次唤醒并继续下一位，避免整局停在「等待其他玩家行动」
    this.engine.logAction('NIGHT_WAKE', `${bot.seat + 1}号 ${bot.name}（${role.name}）无法给出合法行动，自动跳过（${(result && result.message) || '无可用目标'}）`, {
      playerId: bot.id, autoSkipped: true
    });
    this.engine.nightResolver.forceSkipCurrentWake(bot.id);
    return false;
  }

  _doBotNominate(bot) {
    const gs = this.engine.room.gameState;
    if (gs.phase !== 'DAY_DISCUSSION') return;
    if (bot.hasNominated || isEffectivelyDead(bot)) return;

    const others = Array.from(this.engine.room.players.values())
      .filter(p => !isEffectivelyDead(p) && p.seat !== -1 && p.id !== bot.id && !p.wasNominatedToday);
    
    if (others.length === 0) return;

    let target;
    if (bot.role && bot.role.team === 'EVIL') {
      const goodTargets = others.filter(p => p.role && p.role.team === 'GOOD');
      target = goodTargets.length > 0 ? goodTargets[Math.floor(Math.random() * goodTargets.length)] : others[Math.floor(Math.random() * others.length)];
    } else {
      target = others[Math.floor(Math.random() * others.length)];
    }

    this.engine.nominatePlayer(bot.id, target.id);
  }

  _getBotVoteDecision(bot) {
    const gs = this.engine.room.gameState;
    const currentNom = gs.nominations[gs.nominations.length - 1];
    if (!currentNom) return false;

    const nominee = this.engine.room.players.get(currentNom.nomineeId);
    if (!nominee) return false;
    if (nominee.id === bot.id) return false;

    if (bot.role && bot.role.team === 'EVIL') {
      if (nominee.role && nominee.role.team === 'EVIL') return false;
      return Math.random() < this.engine.prob('bot_evil_vote_yes');
    }
    return Math.random() < this.engine.prob('bot_good_vote_yes');
  }

  triggerDayChat() {
    const gs = this.engine.room.gameState;
    const bots = Array.from(this.engine.room.players.values())
      .filter(p => p.isBot && p.isAlive && p.seat !== -1);
    
    bots.forEach((bot, idx) => {
      const msg = this._generateBotSpeech(bot);
      if (msg) {
        setImmediate(() => {
          if (this.engine.room.gameState.phase === 'DAY_DISCUSSION') {
            this.engine.sendChat(bot.id, msg, 'public');
          }
        });
      }
    });
  }

  _getPlayerBySeat(seat) {
    return Array.from(this.engine.room.players.values()).find(p => p.seat === seat);
  }

  _seatToName(seat) {
    const p = this._getPlayerBySeat(seat);
    return p ? `${p.name}(${seat+1}号)` : `${seat+1}号`;
  }

  _extractTargetInfo(info) {
    if (!info) return null;
    let targets = [];
    if (info.targets && Array.isArray(info.targets)) {
      targets = info.targets.map(t => {
        if (t.seat !== undefined) return `${this._seatToName(t.seat)}`;
        if (t.name) return t.name;
        return '?';
      });
    } else if (info.players && Array.isArray(info.players)) {
      targets = info.players.map(t => {
        if (t.seat !== undefined) return `${this._seatToName(t.seat)}`;
        if (t.name) return t.name;
        return '?';
      });
    } else if (info.targetId) {
      const p = this.engine.room.players.get(info.targetId);
      if (p) targets = [`${this._seatToName(p.seat)}`];
    } else if (info.protectedId) {
      const p = this.engine.room.players.get(info.protectedId);
      if (p) targets = [`${this._seatToName(p.seat)}`];
    }
    return targets.length > 0 ? targets.join('和') : null;
  }

  // 当前剧本的村民角色名池（邪恶 Bot 用于伪装身份）
  _getFakeRolePool(scriptId) {
    const fallback = ['洗衣妇','图书管理员','调查员','厨师','共情者','占卜师','守鸦人','圣女','市长','僧侣','士兵','送葬者'];
    try {
      const { getScriptConfig } = require('../config/game-config');
      const cfg = getScriptConfig(scriptId);
      const ids = (cfg && cfg.townsfolkRoles) || [];
      const names = ids
        .map(id => {
          const role = this.engine.roleAllocator && this.engine.roleAllocator.createRoleInstance(id);
          return role ? role.name : null;
        })
        .filter(Boolean);
      return names.length ? names : fallback;
    } catch (e) {
      return fallback;
    }
  }

  // 邪恶 Bot 的伪装身份：整局固定，避免每个白天声称的角色都不一样
  _getEvilClaimRole(bot, pool) {
    if (bot.botClaimRole && pool.indexOf(bot.botClaimRole) !== -1) return bot.botClaimRole;
    const others = Array.from(this.engine.room.players.values()).filter(p => p !== bot);
    // 其他邪恶 Bot 已占用的伪装身份不重复
    const usedByOthers = new Set(others.filter(p => p.botClaimRole).map(p => p.botClaimRole));
    // 优先挑本局没有真正出场的村民角色，减少与真人身份撞车
    const inPlayGood = new Set(
      others.filter(p => p.role && p.role.team === 'GOOD').map(p => p.role.name)
    );
    const free = pool.filter(n => !usedByOthers.has(n));
    const notInPlay = free.filter(n => !inPlayGood.has(n));
    const candidates = notInPlay.length > 0 ? notInPlay : (free.length > 0 ? free : pool);
    bot.botClaimRole = candidates[Math.floor(Math.random() * candidates.length)];
    return bot.botClaimRole;
  }

  // 从候选文案中随机挑一条，并尽量避开上一次用过的（避免同一个 Bot 每天说一模一样的话）
  _pickVaried(bot, key, candidates) {
    if (!candidates || candidates.length === 0) return '';
    if (!bot.botSpeechMemo) bot.botSpeechMemo = {};
    const last = bot.botSpeechMemo[key];
    const pool = candidates.length > 1 ? candidates.filter(c => c !== last) : candidates;
    const picked = pool[Math.floor(Math.random() * pool.length)];
    bot.botSpeechMemo[key] = picked;
    return picked;
  }

  // 只在首夜拿到一次性信息的角色：伪装身份是这些时，假信息不能每天变
  _isFirstNightInfoRole(roleName) {
    return ['洗衣妇', '图书管理员', '调查员', '厨师'].indexOf(roleName) !== -1;
  }

  // 生成首夜一次性信息（整局只生成一次并缓存）
  _buildFirstNightInfo(bot, fakeRole, goodPlayers, goodRoleNames) {
    if ((fakeRole === '洗衣妇' || fakeRole === '图书管理员') && goodPlayers.length >= 2) {
      // 被“查到”的角色不能是自己声称的身份，否则等于自相矛盾
      const rnPool = goodRoleNames.filter(n => n !== fakeRole);
      const rnList = rnPool.length ? rnPool : goodRoleNames;
      const shuffled = goodPlayers.slice().sort(() => Math.random() - 0.5);
      const t1 = shuffled[0], t2 = shuffled[1];
      const rn = rnList[Math.floor(Math.random() * rnList.length)];
      return `我查到${this._seatToName(t1.seat)}和${this._seatToName(t2.seat)}之中有一个是${rn}。`;
    }
    if (fakeRole === '调查员' && goodPlayers.length >= 2) {
      const shuffled = goodPlayers.slice().sort(() => Math.random() - 0.5);
      const t1 = shuffled[0], t2 = shuffled[1];
      return `我查到${this._seatToName(t1.seat)}和${this._seatToName(t2.seat)}之中有一个是爪牙，大家注意！`;
    }
    if (fakeRole === '厨师') {
      return Math.random() < 0.5
        ? `我得到的信息是邪恶阵营没有相邻坐的。`
        : `我得到的信息是有1对邪恶玩家是邻座。`;
    }
    return '';
  }

  // 非信息位角色每天只有固定台词时会重复，这里给每个角色准备多套说法轮流说
  _fixedClaimVariants(roleName) {
    const map = {
      '圣女': [
        '如果提名我的玩家会立刻死亡，大家提名需谨慎。',
        '别提名我，提名我的人会立刻死，好人会亏一张牌。'
      ],
      '士兵': [
        '恶魔杀不死我。',
        '我是士兵，恶魔昨晚就算选我也是白杀，大家放心。',
        '昨晚恶魔要是动了我，那它这刀就浪费了。'
      ],
      '市长': [
        '平票时由我决定处决谁，只剩三人无人处决则好人胜利。',
        '我这张市长牌，后期平票由我拍板，别急着出我。',
        '如果只剩三个人又没人被处决，好人就直接赢了，所以我要活到最后。'
      ],
      '守鸦人': [
        '我死后可以查看一名玩家的身份。',
        '我死了之后能验一个人的身份，所以别轻易浪费我。',
        '留着我，我死后可以帮大家确认一个关键身份。'
      ],
      '僧侣': [
        '每晚可以保护一名玩家不被恶魔杀害。',
        '我是僧侣，昨晚已经护过人了，暂时没有需要报的信息。',
        '我会挑关键位置保护，大家不用管我。'
      ],
      '圣徒': [
        '如果我被处决好人直接失败，大家千万别出我！',
        '我是圣徒，处决我等于是送邪恶胜利，务必相信这一点。',
        '别把票打在我身上，出了我好人直接输。'
      ],
      '隐士': [
        '我可能会被信息位误登记为邪恶阵营，大家看到关于我的信息注意分辨。',
        '我是隐士，被查成邪恶很正常，别因为这个就定我。',
        '关于我的邪恶信息可能是隐士身份造成的，别直接下结论。'
      ]
    };
    return map[roleName] || null;
  }

  _generateBotSpeech(bot) {
    if (!bot.role) return null;
    const role = bot.role;
    const info = bot.privateInfo;
    const seat = bot.seat + 1;
    const name = bot.name;

    // 邪恶 Bot 的伪装身份池按当前剧本取，避免在紫罗兰教派里声称自己是市长
    const scriptId = this.engine.room.script || 'tb';
    const goodRoleNames = this._getFakeRolePool(scriptId);

    let roleName = role.name;
    let team = role.team;
    let category = role.category;

    if (info && info.isDrunk && info.role && info.role.name) {
      roleName = info.role.name;
      team = info.role.team || 'GOOD';
      category = info.role.category || 'TOWNSFOLK';
    }
    if (bot.fakeRole && role.id === 'drunk') {
      roleName = bot.fakeRole.name;
      team = 'GOOD';
      category = 'TOWNSFOLK';
    }

    let intro;
    let infoMsg = '';

    if (team === 'GOOD') {
      const templates = [
        `我是${roleName}，坐在${seat}号，好人阵营。`,
        `各位好，${seat}号${name}，身份${roleName}，好人。`,
        `${seat}号${name}报到，${roleName}，好人一枚。`
      ];
      intro = this._pickVaried(bot, 'intro', templates);

      if (info && info.message && info.type !== 'role_info') {
        const msg = info.message;
        if (roleName === '洗衣妇' || roleName === '图书管理员' || roleName === '调查员') {
          infoMsg = msg;
        } else if (roleName === '厨师') {
          infoMsg = msg;
        } else if (roleName === '共情者') {
          infoMsg = msg;
        } else if (roleName === '占卜师') {
          const targetInfo = this._extractTargetInfo(info);
          // 以信息条目中的 result 布尔值为准。不能用 msg.includes('有恶魔') 判断：
          // “没有恶魔”同样包含“有恶魔”子串，会把结果说反，导致发言与上帝视角中的
          // 实际信息不一致（尤其是中毒后拿到假信息时）。
          const hasDemon = (typeof info.result === 'boolean')
            ? info.result
            : (msg.includes('有恶魔') && !msg.includes('没有恶魔'));
          const resultText = hasDemon ? '结果显示有恶魔嫌疑' : '结果显示没有恶魔';
          infoMsg = targetInfo ? `昨晚我查了${targetInfo}，${resultText}` : msg;
        } else if (roleName === '送葬者') {
          infoMsg = msg;
        } else if (roleName === '僧侣') {
          infoMsg = msg;
        } else if (roleName === '守鸦人') {
          infoMsg = msg;
        } else if (roleName === '圣女' || roleName === '士兵' || roleName === '市长' ||
                   roleName === '隐士' || roleName === '圣徒') {
          infoMsg = this._pickVaried(bot, 'info', this._fixedClaimVariants(roleName));
        } else {
          const targetInfo = this._extractTargetInfo(info);
          infoMsg = targetInfo ? `昨晚我选择了${targetInfo}，${msg}` : msg;
        }
      } else if (category === 'TOWNSFOLK') {
        const variants = this._fixedClaimVariants(roleName);
        if (variants) infoMsg = this._pickVaried(bot, 'info', variants);
      }
    } else {
      // 伪装身份整局固定：同一个邪恶 Bot 每个白天声称的角色保持一致
      const fakeRole = this._getEvilClaimRole(bot, goodRoleNames);
      const evilTemplates = [
        `我是${fakeRole}，${seat}号，铁好人一个，大家可以信任我。`,
        `${seat}号${name}报到，${fakeRole}，好人阵营，绝不撒谎。`,
        `各位好，${seat}号${name}，${fakeRole}，站好人这边。`
      ];
      intro = this._pickVaried(bot, 'intro', evilTemplates);

      const alivePlayers = Array.from(this.engine.room.players.values())
        .filter(p => p.isAlive && p.seat !== -1 && p.id !== bot.id);
      const goodPlayers = alivePlayers.filter(p => p.role && p.role.team === 'GOOD');

      if (this._isFirstNightInfoRole(fakeRole)) {
        // 只在首夜获得一次性信息：整局固定，之后每天都报同一段内容，
        // 每天变反而露馅（真实玩家首夜之后就拿不到新信息了）
        if (!bot.botFixedInfo || bot.botFixedInfo.claim !== fakeRole || !bot.botFixedInfo.text) {
          const text = this._buildFirstNightInfo(bot, fakeRole, goodPlayers, goodRoleNames);
          if (text) bot.botFixedInfo = { claim: fakeRole, text };
          infoMsg = text;
        } else {
          infoMsg = bot.botFixedInfo.text;
        }
      } else if (fakeRole === '共情者') {
        // 每晚都有新数字：每天换一种说法
        infoMsg = this._pickVaried(bot, 'info', [
          `我的邻居都是好人，可以信任。`,
          `我的邻居里有一个是邪恶的。`,
          `我的邻居都是邪恶的，这轮一定要从他们里面出！`
        ]);
      } else if (fakeRole === '占卜师' && goodPlayers.length > 0) {
        // 每晚查验不同目标：每天都要变
        const cands = [];
        for (let i = 0; i < 8 && cands.length < 4; i++) {
          const target = goodPlayers[Math.floor(Math.random() * goodPlayers.length)];
          const line = `我昨晚查了${this._seatToName(target.seat)}，结果显示有恶魔嫌疑，大家重点关注！`;
          if (cands.indexOf(line) === -1) cands.push(line);
        }
        infoMsg = this._pickVaried(bot, 'info', cands);
      } else if (this._fixedClaimVariants(fakeRole)) {
        infoMsg = this._pickVaried(bot, 'info', this._fixedClaimVariants(fakeRole));
      } else if (fakeRole === '送葬者' || fakeRole === '掘墓人') {
        infoMsg = this._pickVaried(bot, 'info', [
          `今晚我会关注被处决的人身份。`,
          `等有人被处决，我就能知道他是什么身份了。`,
          `处决之后我的信息会更有价值，大家先留着我。`
        ]);
      }
    }

    return intro + (infoMsg ? ' ' + infoMsg : '');
  }
}

module.exports = BotManager;
