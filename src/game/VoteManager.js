// 投票/提名管理器
const { PHASES, ROLE_IDS } = require('../config/game-config');
const { getAlivePlayers } = require('../utils/helpers');
const { Bard } = require('../roles/Townsfolk2');

class VoteManager {
  constructor(engine) {
    this.engine = engine;
  }

  openNominations() {
    const gs = this.engine.room.gameState;
    gs.phase = PHASES.NOMINATION_PHASE;
    gs.nominations = [];
    gs.currentNominationIndex = -1;
    this.engine.broadcastState();
  }

  processNomination(nominatorId, nomineeId) {
    const gs = this.engine.room.gameState;
    const nominator = this.engine.room.players.get(nominatorId);
    const nominee = this.engine.room.players.get(nomineeId);

    if (!nominator || !nominee) {
      return { success: false, message: '玩家不存在' };
    }

    if (!nominator.isAlive) {
      if (nominator.voteToken <= 0) {
        return { success: false, message: '你已使用死后投票标记' };
      }
      nominator.voteToken--;
    }

    if (nominator.hasNominated) {
      return { success: false, message: '你今天已经提名过了' };
    }

    if (nominee.wasNominatedToday) {
      return { success: false, message: '该玩家今天已被提名过' };
    }

    if (!nominee.isAlive) {
      return { success: false, message: '不能提名死亡玩家' };
    }

    nominator.hasNominated = true;
    nominee.wasNominatedToday = true;

    // 检查圣女技能
    if (nominee.role && nominee.role.onNominated) {
      const result = nominee.role.onNominated(gs, nominee, nominator, this.engine);
      if (!result.continue) {
        this.engine.broadcastState();
        // 检查胜负
        this.engine.victoryChecker.checkVictory();
        return { success: true, immediateDeath: result.immediateDeath };
      }
    }

    // 记录提名
    const nomination = {
      nominatorId,
      nomineeId,
      votes: new Set(),
      voteCount: 0,
      passed: false,
      resolved: false,
      currentVotes: {}
    };
    gs.nominations.push(nomination);
    gs.currentNominationIndex = gs.nominations.length - 1;

    this.engine.logAction('NOMINATION', `${nominator.seat+1}号 ${nominator.name} 提名了 ${nominee.seat+1}号 ${nominee.name}`, {
      nominatorId, nomineeId
    });

    // 进入辩护阶段
    gs.phase = PHASES.DEFENSE;
    gs.currentDefensePlayerId = nomineeId;
    this.engine.room.confirmations.clear();

    this.engine.io.to(this.engine.room.id).emit('game:nominationStarted', {
      nominator: { id: nominator.id, name: nominator.name, seat: nominator.seat },
      nominee: { id: nominee.id, name: nominee.name, seat: nominee.seat }
    });

    this.engine.broadcastState();
    return { success: true };
  }

  endDefense(playerId) {
    const gs = this.engine.room.gameState;
    if (gs.currentDefensePlayerId !== playerId) {
      return { success: false, message: '不是你的辩护环节' };
    }
    this.beginVoting();
    return { success: true };
  }

  beginVoting() {
    const gs = this.engine.room.gameState;
    gs.phase = PHASES.VOTING;
    gs.currentDefensePlayerId = null;
    this.engine.room.confirmations.clear();

    const nomination = gs.nominations[gs.currentNominationIndex];
    nomination.votes = new Set();
    nomination.voteCount = 0;
    nomination.currentVotes = {};

    this.engine.io.to(this.engine.room.id).emit('game:votingStarted', {
      nomineeId: nomination.nomineeId
    });

    this.engine.broadcastState();
    // 确保bot管理器立即处理投票阶段
    this.engine.botManager.notifyAllBots();
  }

  processVote(playerId, vote) {
    const gs = this.engine.room.gameState;
    const player = this.engine.room.players.get(playerId);
    
    if (!player) return { success: false };
    if (gs.phase !== PHASES.VOTING) {
      return { success: false, message: '现在不是投票阶段' };
    }

    // 检查投票资格
    if (!player.isAlive && player.voteToken <= 0) {
      return { success: false, message: '你已使用死后投票标记' };
    }

    const nomination = gs.nominations[gs.currentNominationIndex];
    if (!nomination || nomination.resolved) {
      return { success: false };
    }

    // 管家限制：只能在主人投赞成票时投赞成
    if (vote && player.role && player.role.id === 'butler' && player.abilityState.masterId && !player.isPoisoned) {
      const master = this.engine.room.players.get(player.abilityState.masterId);
      if (master && master.isAlive) {
        const masterVotedYes = nomination.currentVotes[master.id] === true;
        if (!masterVotedYes) {
          return { success: false, message: '你是管家，只能在主人投赞成票时投赞成' };
        }
      }
    }

    // 记录投票（支持改票）
    const previousVote = nomination.currentVotes[playerId];
    if (vote) {
      nomination.votes.add(playerId);
      nomination.currentVotes[playerId] = true;
      // 第一次投赞成票时才消耗死者投票标记
      if (!player.isAlive && previousVote !== true) {
        player.voteToken--;
      }
    } else {
      nomination.votes.delete(playerId);
      nomination.currentVotes[playerId] = false;
      // 死者之前投过赞成现在改反对，退还投票标记
      if (!player.isAlive && previousVote === true) {
        player.voteToken++;
      }
    }
    nomination.voteCount = nomination.votes.size;

    // 实时广播投票
    this.engine.io.to(this.engine.room.id).emit('game:voteUpdate', {
      voterId: playerId,
      vote: vote,
      voteCount: nomination.voteCount
    });

    // 检查是否所有人都投了（自动结束投票）
    const eligibleVoters = Array.from(this.engine.room.players.values())
      .filter(p => p.seat !== -1 && (p.isAlive || (p.isDead && p.voteToken > 0)));

    const allEligibleVoted = eligibleVoters.every(p => nomination.currentVotes[p.id] !== undefined);

    if (allEligibleVoted) {
      setTimeout(() => {
        if (this.engine.room.gameState.phase === PHASES.VOTING) {
          this.endVoting();
        }
      }, 800);
    }

    this.engine.broadcastState();
    return { success: true };
  }

  revokeVote(playerId) {
    const gs = this.engine.room.gameState;
    const player = this.engine.room.players.get(playerId);

    if (!player) return { success: false };
    if (gs.phase !== PHASES.VOTING) {
      return { success: false, message: '现在不是投票阶段' };
    }

    const nomination = gs.nominations[gs.currentNominationIndex];
    if (!nomination || nomination.resolved) {
      return { success: false };
    }

    const previousVote = nomination.currentVotes[playerId];
    if (previousVote === undefined) {
      return { success: false, message: '你尚未投票' };
    }

    // 撤回投票
    delete nomination.currentVotes[playerId];
    if (previousVote === true) {
      nomination.votes.delete(playerId);
      // 死者撤回赞成票，退还投票标记
      if (!player.isAlive) {
        player.voteToken++;
      }
    }
    nomination.voteCount = nomination.votes.size;

    // 实时广播撤回
    this.engine.io.to(this.engine.room.id).emit('game:voteRevoked', {
      voterId: playerId,
      voteCount: nomination.voteCount
    });

    this.engine.broadcastState();
    return { success: true };
  }

  endVoting() {
    const gs = this.engine.room.gameState;
    const nomination = gs.nominations[gs.currentNominationIndex];
    if (!nomination) return;

    const aliveCount = getAlivePlayers(this.engine.room).length;
    // 处决需要「严格超过」半数存活玩家赞成（平票不通过）。
    // 注意：不能用 Math.ceil(aliveCount/2)，偶数存活人数时 ceil 正好等于一半，
    // 会把平票误判为通过并执行（例如 6 人需要 4 票，但 ceil(3)=3 会在 3 票平票时处决）。
    const threshold = Math.floor(aliveCount / 2) + 1;

    nomination.passed = nomination.voteCount >= threshold;
    nomination.resolved = true;

    const nominee = this.engine.room.players.get(nomination.nomineeId);
    this.engine.logAction('VOTE_RESULT', `${nominee ? nominee.seat+1+'号 '+nominee.name : '?'} 获得${nomination.voteCount}票（需要${threshold}票），${nomination.passed ? '通过' : '未通过'}`, {
      voteCount: nomination.voteCount, threshold, passed: nomination.passed
    });

    this.engine.io.to(this.engine.room.id).emit('game:voteResult', {
      nomineeId: nomination.nomineeId,
      yesVotes: nomination.voteCount,
      threshold,
      passed: nomination.passed
    });

    // 回到提名阶段，重置确认状态
    gs.phase = PHASES.NOMINATION_PHASE;
    this.engine.waitForConfirmation();
  }

  closeNominations() {
    this.resolveExecution();
  }

  resolveExecution() {
    const gs = this.engine.room.gameState;
    gs.phase = PHASES.EXECUTION;

    const passed = gs.nominations.filter(n => n.passed);

    if (passed.length === 0) {
      gs.todaysDeaths.push({ cause: 'NO_EXECUTION' });
      this.engine.logAction('EXECUTION', '今日无人被处决（平安日）', {});
      this.engine.io.to(this.engine.room.id).emit('game:executionResult', {
        executedId: null,
        message: '无人达到处决线，平安日'
      });
      // 主谋额外白天无人被处决：清除额外回合标记，让checkVictory正常结束游戏
      if (gs.mastermindExtraRound) {
        gs.mastermindExtraRound = false;
      }
      this.engine.waitForConfirmation();
      this.engine.broadcastState();
      return;
    }

    const maxVotes = Math.max(...passed.map(n => n.voteCount));
    const tied = passed.filter(n => n.voteCount === maxVotes);

    if (tied.length > 1) {
      gs.todaysDeaths.push({ cause: 'TIE' });
      this.engine.logAction('EXECUTION', '平票，无人被处决（平安日）', {});
      this.engine.io.to(this.engine.room.id).emit('game:executionResult', {
        executedId: null,
        message: '平票，平安日'
      });
      // 主谋额外白天平票：清除额外回合标记，让checkVictory正常结束游戏
      if (gs.mastermindExtraRound) {
        gs.mastermindExtraRound = false;
      }
      this.engine.waitForConfirmation();
      this.engine.broadcastState();
      return;
    }

    const toExecute = this.engine.room.players.get(tied[0].nomineeId);
    if (toExecute) {
      // 检查和平主义者拯救（处决前判断，拯救则不执行处决）
      let pacifistSaved = false;
      try {
        const Pacifist = require('../roles/Townsfolk2').Pacifist;
        pacifistSaved = Pacifist.checkPacifistSave(toExecute, this.engine);
      } catch (e) { /* BMR 角色未加载时忽略 */ }

      if (pacifistSaved) {
        // 和平主义者阻止了处决：玩家不死
        this.engine.logAction('EXECUTION', `${toExecute.seat+1}号 ${toExecute.name} 被和平主义者拯救，未被执行处决`, {
          playerId: toExecute.id, saved: true
        });
        this.engine.io.to(this.engine.room.id).emit('game:executionResult', {
          executedId: null,
          seat: toExecute.seat,
          name: toExecute.name,
          votes: maxVotes,
          message: `${toExecute.seat+1}号(${toExecute.name})被和平主义者拯救`
        });
      } else {
        this.engine.deathManager.killPlayer(toExecute.id, 'EXECUTION', gs.nightCount, gs.dayCount);
        gs.todaysDeaths.push({ playerId: toExecute.id, cause: 'EXECUTION' });

        // 吟游诗人：爪牙被处决则除自己外的所有玩家醉酒
        if (toExecute.role && toExecute.role.category === 'MINION') {
          const bard = getAlivePlayers(this.engine.room).find(p => p.role && p.role.id === 'bard');
          if (bard) {
            Bard.applyMinionExecutionEffect(gs, this.engine, bard);
          }
        }

        this.engine.logAction('EXECUTION', `${toExecute.seat+1}号 ${toExecute.name} 被处决，身份是【${toExecute.role.name}】`, {
          playerId: toExecute.id, role: toExecute.role.id
        });

        this.engine.io.to(this.engine.room.id).emit('game:executionResult', {
          executedId: toExecute.id,
          seat: toExecute.seat,
          name: toExecute.name,
          votes: maxVotes,
          message: `${toExecute.seat+1}号(${toExecute.name})被处决`
        });

        // 检查圣徒
        const saintResult = this.engine.victoryChecker.checkSaintExecution(toExecute.id);
        if (saintResult) {
          return;
        }

        // 检查主谋额外白天处决：被处决的玩家阵营落败
        const mastermindResult = this.engine.victoryChecker.checkMastermindExecution(toExecute);
        if (mastermindResult) {
          return;
        }
      }
    }

    this.engine.waitForConfirmation();
    this.engine.broadcastState();
  }
}

module.exports = VoteManager;
