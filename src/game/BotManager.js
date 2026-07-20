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
      this._lastNominationCount = gs.nominations ? gs.nominations.length : 0;
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
    if (gs.phase === 'VOTING' && !bot._botVoted && this._canBotVote(bot)) {
      if (bot._botTimer) return;
      bot._botVoted = true;
      this._scheduleBot(botId, 400 + Math.random() * 1200, (b) => {
        if (room.gameState.phase !== 'VOTING') return;
        // 断线真实玩家只投反对票，bot使用AI决策
        const vote = b.isBot ? this._getBotVoteDecision(b) : false;
        this.engine.processVote(botId, vote);
      });
      return;
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
      } else {
        bot._botNominated = true;
      }
      return;
    }

    // 确认阶段 - 自动确认（天亮/讨论/提名/处决）
    if (['DAY_DAWN', 'DAY_DISCUSSION', 'NOMINATION_PHASE', 'EXECUTION'].includes(gs.phase)) {
      if (!room.confirmations.has(botId) && !bot._botConfirmed) {
        if (bot._botTimer) return;
        bot._botConfirmed = true;
        this._scheduleBot(botId, 600 + Math.random() * 2000, (b) => {
          if (!room.confirmations.has(botId)) {
            this.engine.processConfirmation(botId);
          }
        });
      }
    }
  }

  _canBotVote(bot) {
    if (bot.isAlive) return true;
    if (bot.voteToken > 0) return true;
    return false;
  }

  _doBotNightAction(bot) {
    const gs = this.engine.room.gameState;
    const alive = Array.from(this.engine.room.players.values()).filter(p => p.isAlive && p.seat !== -1);
    
    let selectCount = 1;
    if (bot.role && bot.role.selectCount) selectCount = bot.role.selectCount;

    let candidates = alive.filter(p => p.id !== bot.id);
    
    if (bot.role && bot.role.category === 'DEMON') {
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
}

module.exports = BotManager;
