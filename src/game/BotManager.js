// 简单AI机器人管理器 - 用于测试和补位
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
      if (!b.isBot && b.isConnected) return;
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
        if (p.isBot || !p.isConnected) {
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
        if (p.isBot || !p.isConnected) {
          p._botVoted = false;
          this._clearBotTimer(p);
        }
      });
      this._lastNominationIndex = gs.currentNominationIndex;
    }

    room.players.forEach((p, pid) => {
      if (p.isBot || !p.isConnected) {
        this._processBot(pid);
      }
    });
  }

  _processBot(botId) {
    const room = this.engine.room;
    if (!room) return;
    const bot = room.players.get(botId);
    if (!bot) return;
    if (!bot.isBot && bot.isConnected) return;

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
          const vote = b.isBot ? this._getBotVoteDecision(b) : false;
          const result = this.engine.processVote(botId, vote);
          if (!result || !result.success) {
            b._botVoted = false;
            this._retryBotVote(botId);
          }
        });
        return;
      }
    }

    // 提名阶段 - 只有bot有概率提名，断线真实玩家不提名
    if (gs.phase === 'NOMINATION_PHASE' && bot.isBot && bot.isAlive && !bot.hasNominated && !bot._botNominated) {
      if (bot._botTimer) return;
      if (Math.random() < this.engine.prob('bot_nominate')) {
        bot._botNominated = true;
        this._scheduleBot(botId, 1500 + Math.random() * 2500, (b) => {
          if (room.gameState.phase !== 'NOMINATION_PHASE') return;
          if (b.hasNominated || !b.isAlive) return;
          this._doBotNominate(b);
        });
        return;
      } else {
        bot._botNominated = true;
      }
    }

    // 确认阶段 - 自动确认（天亮/讨论/提名/处决）—— 仅bot自动确认，断线真人不计入需要确认人数，不应自动确认
    if (['DAY_DAWN', 'DAY_DISCUSSION', 'NOMINATION_PHASE', 'EXECUTION'].includes(gs.phase)) {
      if (bot.isBot && !room.confirmations.has(botId) && !bot._botConfirmed) {
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
    if (bot.isAlive) return true;
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
      const vote = b.isBot ? this._getBotVoteDecision(b) : false;
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
    const selectType = role ? (role.selectType || 'player') : 'player';
    const canSkip = role ? !!role.canSkip : false;
    let selectCount = 1;
    if (role && role.selectCount) selectCount = role.selectCount;

    // ========== 跳过逻辑（canSkip=true时，侍臣等技能有概率今晚不使用） ==========
    if (canSkip && Math.random() < 0.25) {
      this.engine.processNightAction(bot.id, { skip: true });
      return;
    }

    // ========== 选择角色（侍臣等） ==========
    if (selectType === 'role') {
      const { getScriptConfig } = require('../config/game-config');
      const scriptConfig = getScriptConfig(this.engine.room.script || 'bmr');
      const roleIds = scriptConfig.allRoles;
      if (!roleIds || roleIds.length === 0) {
        this.engine.processNightAction(bot.id, { skip: true });
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
      this.engine.processNightAction(bot.id, { roleId });
      return;
    }

    // ========== 选择玩家+角色（赌徒） ==========
    if (selectType === 'playerAndRole') {
      const { getScriptConfig } = require('../config/game-config');
      const scriptConfig = getScriptConfig(this.engine.room.script || 'bmr');
      const roleIds = scriptConfig.allRoles;
      // 选目标玩家
      let candidates = alive.filter(p => p.id !== bot.id);
      if (role && role.team === 'EVIL') {
        // 赌徒是好人，倾向选疑似坏人，但bot不太准，选个随机的（允许选自己）
      }
      // 赌徒允许选自己，所以从所有存活里选（包括自己）
      const allAliveSelectable = alive.slice();
      const target = allAliveSelectable[Math.floor(Math.random() * allAliveSelectable.length)];
      const guessRoleId = roleIds && roleIds.length > 0
        ? roleIds[Math.floor(Math.random() * roleIds.length)]
        : null;
      if (!target || !guessRoleId) {
        this.engine.processNightAction(bot.id, { skip: true });
        return;
      }
      this.engine.processNightAction(bot.id, { targets: [target.id], roleId: guessRoleId });
      return;
    }

    // ========== 默认：选择玩家 ==========
    let candidates = alive.filter(p => p.id !== bot.id);

    if (role && role.category === 'DEMON') {
      // 恶魔优先杀好人
      const goodTargets = candidates.filter(p => p.role && p.role.team !== 'EVIL');
      if (goodTargets.length > 0) candidates = goodTargets;
    }

    const targets = [];
    for (let i = 0; i < selectCount; i++) {
      if (candidates.length === 0) break;
      const idx = Math.floor(Math.random() * candidates.length);
      targets.push(candidates[idx].id);
      if (selectCount > 1) candidates.splice(idx, 1);
    }

    this.engine.processNightAction(bot.id, { targets });
  }

  _doBotNominate(bot) {
    const gs = this.engine.room.gameState;
    if (gs.phase !== 'NOMINATION_PHASE') return;
    if (bot.hasNominated || !bot.isAlive) return;

    const others = Array.from(this.engine.room.players.values())
      .filter(p => p.isAlive && p.seat !== -1 && p.id !== bot.id && !p.wasNominatedToday);
    
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

  _generateBotSpeech(bot) {
    if (!bot.role) return null;
    const role = bot.role;
    const info = bot.privateInfo;
    const seat = bot.seat + 1;
    const name = bot.name;

    const goodRoleNames = ['洗衣妇','图书管理员','调查员','厨师','共情者','占卜师','守鸦人','圣女','市长','僧侣','士兵','送葬者'];

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
      intro = templates[Math.floor(Math.random() * templates.length)];

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
          const resultText = msg.includes('有恶魔') ? '结果显示有恶魔嫌疑' : '结果显示没有恶魔';
          infoMsg = targetInfo ? `昨晚我查了${targetInfo}，${resultText}` : msg;
        } else if (roleName === '送葬者') {
          infoMsg = msg;
        } else if (roleName === '僧侣') {
          infoMsg = msg;
        } else if (roleName === '守鸦人') {
          infoMsg = msg;
        } else if (roleName === '圣女') {
          infoMsg = `如果提名我的玩家会立刻死亡，大家提名需谨慎。`;
        } else if (roleName === '士兵') {
          infoMsg = `恶魔杀不死我。`;
        } else if (roleName === '市长') {
          infoMsg = `平票时由我决定处决谁，只剩三人无人处决则好人胜利。`;
        } else if (roleName === '隐士') {
          infoMsg = `我可能会被信息位误登记为邪恶阵营，大家看到关于我的信息注意分辨。`;
        } else if (roleName === '圣徒') {
          infoMsg = `如果我被处决好人直接失败，大家千万别出我！`;
        } else {
          const targetInfo = this._extractTargetInfo(info);
          infoMsg = targetInfo ? `昨晚我选择了${targetInfo}，${msg}` : msg;
        }
      } else if (category === 'TOWNSFOLK') {
        if (roleName === '圣女') infoMsg = `如果提名我的玩家会立刻死亡，大家提名需谨慎。`;
        else if (roleName === '士兵') infoMsg = `恶魔杀不死我。`;
        else if (roleName === '市长') infoMsg = `平票时由我决定处决谁。`;
        else if (roleName === '守鸦人') infoMsg = `我死后可以查看一名玩家的身份。`;
        else if (roleName === '僧侣') infoMsg = `每晚可以保护一名玩家不被恶魔杀害。`;
      }
    } else {
      const fakeRole = goodRoleNames[Math.floor(Math.random() * goodRoleNames.length)];
      const evilTemplates = [
        `我是${fakeRole}，${seat}号，铁好人一个，大家可以信任我。`,
        `${seat}号${name}报到，${fakeRole}，好人阵营，绝不撒谎。`,
        `各位好，${seat}号${name}，${fakeRole}，站好人这边。`
      ];
      intro = evilTemplates[Math.floor(Math.random() * evilTemplates.length)];

      const alivePlayers = Array.from(this.engine.room.players.values())
        .filter(p => p.isAlive && p.seat !== -1 && p.id !== bot.id);
      const goodPlayers = alivePlayers.filter(p => p.role && p.role.team === 'GOOD');

      if (fakeRole === '洗衣妇' || fakeRole === '图书管理员') {
        if (goodPlayers.length >= 2) {
          const shuffled = goodPlayers.slice().sort(() => Math.random() - 0.5);
          const t1 = shuffled[0], t2 = shuffled[1];
          const rn = goodRoleNames[Math.floor(Math.random() * 6)];
          infoMsg = `我查到${this._seatToName(t1.seat)}和${this._seatToName(t2.seat)}之中有一个是${rn}。`;
        }
      } else if (fakeRole === '调查员') {
        if (goodPlayers.length >= 2) {
          const shuffled = goodPlayers.slice().sort(() => Math.random() - 0.5);
          const t1 = shuffled[0], t2 = shuffled[1];
          infoMsg = `我查到${this._seatToName(t1.seat)}和${this._seatToName(t2.seat)}之中有一个是爪牙，大家注意！`;
        }
      } else if (fakeRole === '厨师') {
        const cnt = Math.floor(Math.random() * 2);
        infoMsg = cnt === 0 ? `我得到的信息是邪恶阵营没有相邻坐的。` : `我得到的信息是有${cnt}对邪恶玩家是邻座。`;
      } else if (fakeRole === '共情者') {
        const fake = Math.floor(Math.random() * 3);
        if (fake === 0) infoMsg = `我的邻居都是好人，可以信任。`;
        else if (fake === 1) infoMsg = `我的邻居里有一个是邪恶的。`;
        else infoMsg = `我的邻居都是邪恶的，这轮一定要从他们里面出！`;
      } else if (fakeRole === '占卜师' && goodPlayers.length > 0) {
        const target = goodPlayers[Math.floor(Math.random() * goodPlayers.length)];
        infoMsg = `我昨晚查了${this._seatToName(target.seat)}，结果显示有恶魔嫌疑，大家重点关注！`;
      } else if (fakeRole === '僧侣' || fakeRole === '士兵' || fakeRole === '守鸦人' || fakeRole === '圣女' || fakeRole === '市长') {
        infoMsg = `我这个身份好好发挥，大家听我归票。`;
      } else if (fakeRole === '送葬者') {
        infoMsg = `今晚我会关注被处决的人身份。`;
      }
    }

    return intro + (infoMsg ? ' ' + infoMsg : '');
  }
}

module.exports = BotManager;
