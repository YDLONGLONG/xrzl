// SNV 剧本（紫罗兰教派）外来者角色
const Role = require('./Role');
const { SNV_ROLE_IDS, PHASES } = require('../config/game-config');
const { applyDrunk, getAlivePlayers, getPlayerEffectiveTeam } = require('../utils/helpers');
const { pickRandom, isDayPhase } = require('./SnvUtils');

function seatedPlayers(engine) {
  return Array.from(engine.room.players.values()).filter(p => p.seat !== -1);
}

// ==================== 1. 变种人 ====================
// 「疯狂」表现为公开宣称自己是外来者。规则上是否处决由说书人决定，
// 这里交给平衡系统控制的概率，并在白天结算时执行。
class Mutant extends Role {
  constructor() {
    super();
    this.name = '变种人';
    this.id = SNV_ROLE_IDS.MUTANT;
    this.team = 'GOOD';
    this.category = 'OUTSIDER';
    this.firstNightOrder = -1;
    this.otherNightOrder = -1;
    this.selectCount = 0;
    this.abilityDesc = '如果你公开声称自己是外来者（疯狂），你可能被处决。';
  }

  onDayAbility(gameState, player, payload, engine) {
    if (!isDayPhase(gameState)) {
      return { success: false, message: '只能在白天公开声称' };
    }
    if (player.abilityState.mutantMadDay === gameState.dayCount) {
      return { success: false, message: '你今天已经公开声称过了' };
    }
    player.abilityState.mutantMadDay = gameState.dayCount;
    return {
      success: true,
      message: '你公开声称自己是外来者，可能因此被处决'
    };
  }

  // 白天结算时由 VoteManager 调用：返回 { player, probInfo } 表示本日因疯狂被处决
  static checkMadExecution(engine, gs) {
    const mutant = getAlivePlayers(engine.room).find(p => p.role && p.role.id === SNV_ROLE_IDS.MUTANT);
    if (!mutant) return null;
    if (mutant.abilityState.mutantMadDay !== gs.dayCount) return null;
    if (mutant.isPoisoned || mutant.isDrunk) return null;

    const probInfo = engine.balanceSystem.getMutantExecuteProbability(engine);
    if (Math.random() < probInfo.probability) {
      return { player: mutant, probInfo };
    }
    return null;
  }
}

// ==================== 2. 心上人 ====================
class Sweetheart extends Role {
  constructor() {
    super();
    this.name = '心上人';
    this.id = SNV_ROLE_IDS.SWEETHEART;
    this.team = 'GOOD';
    this.category = 'OUTSIDER';
    this.firstNightOrder = -1;
    this.otherNightOrder = -1;
    this.selectCount = 0;
    this.abilityDesc = '当你死亡时，一名玩家会永久醉酒。';
  }

  onDeath(gameState, player, cause, engine) {
    if (player.isPoisoned || player.isDrunk) {
      engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（心上人）死亡时中毒/醉酒，技能失效`, {
        playerId: player.id
      });
      return {};
    }

    const alive = getAlivePlayers(engine.room).filter(p => p.role);
    if (alive.length === 0) return {};

    // 平衡偏袒：好人弱势时让邪恶玩家醉酒（变相帮好人），否则让好人醉酒
    const favor = engine.balanceSystem.favorWeakSide(engine);
    const favorGood = favor.result === true;
    const pool = alive.filter(p => (favorGood
      ? getPlayerEffectiveTeam(p) === 'EVIL'
      : getPlayerEffectiveTeam(p) === 'GOOD'));
    const target = pickRandom(pool.length > 0 ? pool : alive);
    if (!target) return {};

    applyDrunk(target, 'sweetheart', 999);
    engine.setPlayerPrivateInfo(target, {
      type: 'sweetheart_drunk',
      message: '心上人死亡，你开始醉酒（持续到游戏结束）'
    });
    engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（心上人）死亡，${target.seat + 1}号 ${target.name} 永久醉酒`, {
      playerId: player.id, targetId: target.id, probInfo: { balanceScore: favor.balanceScore, scenario: favor.scenario }
    });

    return {};
  }
}

// ==================== 3. 理发师 ====================
class Barber extends Role {
  constructor() {
    super();
    this.name = '理发师';
    this.id = SNV_ROLE_IDS.BARBER;
    this.team = 'GOOD';
    this.category = 'OUTSIDER';
    this.firstNightOrder = -1;
    this.otherNightOrder = -1;
    this.selectCount = 0;
    this.abilityDesc = '如果你死亡，当晚恶魔可以选择两名玩家交换他们的角色。';
  }

  onDeath(gameState, player, cause, engine) {
    if (player.isPoisoned || player.isDrunk) return {};
    gameState.pendingBarberSwap = true;
    engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（理发师）死亡，当晚恶魔可以选择两名玩家交换角色`, {
      playerId: player.id
    });
    return {};
  }
}

// ==================== 4. 傻瓜 ====================
class Klutz extends Role {
  constructor() {
    super();
    this.name = '傻瓜';
    this.id = SNV_ROLE_IDS.KLUTZ;
    this.team = 'GOOD';
    this.category = 'OUTSIDER';
    this.firstNightOrder = -1;
    this.otherNightOrder = -1;
    this.selectCount = 0;
    this.abilityDesc = '当你得知你死亡时，你要公开选择一名存活玩家：如果他是邪恶的，你的阵营落败。';
  }

  onFirstNight(gameState, player, engine) {
    player.abilityState.pendingKlutzSelect = false;
    player.abilityState.pendingKlutzSelectNextDay = false;
    player.abilityState.klutzUsed = false;
  }

  onDeath(gameState, player, cause, engine) {
    if (player.abilityState.klutzUsed) return {};
    player.abilityState.klutzUsed = true;
    player.abilityState.deathPoisoned = player.isPoisoned;
    player.abilityState.deathDrunk = player.isDrunk;

    const gs = engine.room.gameState;
    const dayPhases = [PHASES.DAY_DAWN, PHASES.DAY_DISCUSSION, PHASES.NOMINATION_PHASE,
      PHASES.DEFENSE, PHASES.VOTING, PHASES.EXECUTION];
    if (dayPhases.includes(gs.phase)) {
      player.abilityState.pendingKlutzSelect = true;
      player.abilityState.pendingKlutzSelectNextDay = false;
    } else {
      player.abilityState.pendingKlutzSelect = false;
      player.abilityState.pendingKlutzSelectNextDay = true;
    }
    engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（傻瓜）死亡，需公开选择一名存活玩家`, {
      playerId: player.id, deathCause: cause
    });
    return {};
  }

  onDayAbility(gameState, player, targetId, engine) {
    if (!player.abilityState.pendingKlutzSelect) {
      return { success: false, message: '当前不是选择时机' };
    }
    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive) {
      return { success: false, message: '请选择一名存活玩家' };
    }

    player.abilityState.pendingKlutzSelect = false;
    const disabled = !!(player.abilityState.deathPoisoned || player.abilityState.deathDrunk);
    const targetTeam = getPlayerEffectiveTeam(target);
    const isEvil = targetTeam === 'EVIL';

    engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（傻瓜）公开选择 ${target.seat + 1}号 ${target.name}（${isEvil ? '邪恶' : '善良'}阵营${disabled ? '，但傻瓜死亡时中毒/醉酒，技能失效' : ''}）`, {
      playerId: player.id, targetId: target.id, targetTeam, disabled
    });

    if (!disabled && isEvil) {
      // 官方：选择邪恶玩家时「你的阵营」落败（傻瓜通常为善良，即好人输）
      const klutzTeam = getPlayerEffectiveTeam(player);
      const winner = klutzTeam === 'GOOD' ? 'EVIL' : 'GOOD';
      engine.victoryChecker.endGame(winner, `傻瓜选择了邪恶玩家 ${target.seat + 1}号 ${target.name}，${klutzTeam === 'GOOD' ? '善良' : '邪恶'}阵营落败！`, 'klutz_evil_choice');
    }

    return {
      success: true,
      targetId,
      targetName: target.name,
      targetSeat: target.seat,
      evil: isEvil,
      disabled
    };
  }
}

module.exports = {
  Mutant,
  Sweetheart,
  Barber,
  Klutz
};
