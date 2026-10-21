// SNV 剧本（紫罗兰教派）恶魔角色
const Role = require('./Role');
const { SNV_ROLE_IDS } = require('../config/game-config');
const { getAlivePlayers, getAliveNeighbors } = require('../utils/helpers');
const { isImpaired, pickRandom, isVortoxActive } = require('./SnvUtils');

function seatedPlayers(engine) {
  return Array.from(engine.room.players.values()).filter(p => p.seat !== -1);
}

// SNV 恶魔公共行为：首夜不杀人，之后每夜杀一人
class SnvDemon extends Role {
  constructor() {
    super();
    this.team = 'EVIL';
    this.category = 'DEMON';
    this.selectCount = 1;
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    if (isFirstNight) return null;
    return {
      canSelectCount: 1,
      message: '选择一名玩家杀害'
    };
  }

  onNightAction(gameState, player, action, engine) {
    const targetId = action.targets && action.targets[0];
    if (!targetId) return { success: false, message: '请选择一名玩家' };
    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive) return { success: false, message: '选择的玩家无效' };

    if (isImpaired(player)) {
      engine.setPlayerPrivateInfo(player, {
        type: this.id,
        message: `你选择了 ${target.seat + 1}号 ${target.name}（中毒/醉酒，杀人无效）`
      }, true, { realMessage: '你中毒/醉酒了，杀人无效' });
      return { success: true };
    }

    gameState.nightActions[this.id] = { targetId, actorId: player.id };
    engine.setPlayerPrivateInfo(player, {
      type: this.id,
      targetId,
      message: `你选择杀害 ${target.seat + 1}号 ${target.name}`
    });
    return { success: true };
  }
}

// ==================== 1. 方古 ====================
class FangGu extends SnvDemon {
  constructor() {
    super();
    this.name = '方古';
    this.id = SNV_ROLE_IDS.FANGGU;
    this.firstNightOrder = -1;
    this.otherNightOrder = 6;
    this.abilityDesc = '每个夜晚（首夜除外），选择一名玩家杀害。方古首次杀死外来者时，该外来者变成邪恶的方古，你死亡。（设置修正：外来者+1）';
  }
}

// ==================== 2. 亡灵法师 ====================
class Vigormortis extends SnvDemon {
  constructor() {
    super();
    this.name = '亡灵法师';
    this.id = SNV_ROLE_IDS.VIGORMORTIS;
    this.firstNightOrder = -1;
    this.otherNightOrder = 7;
    this.abilityDesc = '每个夜晚（首夜除外），选择一名玩家杀害。被你杀害的爪牙保留技能但中毒，并使一名相邻村民中毒；当你死亡时，一名爪牙死亡。（设置修正：外来者-1）';
  }

  // 被你杀害的爪牙：保留技能（死亡后仍会被唤醒）并中毒；另毒一名相邻村民
  static applyKill(engine, victim, gs) {
    if (!victim || !victim.role || victim.role.category !== 'MINION') return;
    victim.abilityState = victim.abilityState || {};
    victim.abilityState.vigormortisKeepAbility = true;
    victim.isPoisoned = true;
    victim.snvPoisonSource = 'vigormortis'; // 永久中毒（不随黎明解除）
    engine.logAction('ABILITY', `被亡灵法师杀害的爪牙 ${victim.seat + 1}号 ${victim.name} 保留技能但中毒`, {
      playerId: victim.id, keepAbility: true
    });

    // 使一名相邻村民中毒（持续到下一个黎明，来源标记 vigormortis_aura）
    const neighbors = getAliveNeighbors(engine.room, victim)
      .filter(n => n.role && n.role.category === 'TOWNSFOLK' && !isImpaired(n));
    const target = neighbors[0];
    if (!target) return;
    target.isPoisoned = true;
    target.snvPoisonSource = 'vigormortis_aura';
    engine.setPlayerPrivateInfo(target, {
      type: 'vigormortis_poison',
      message: '亡灵法师的能力使你中毒（持续到明天黄昏）'
    });
    engine.logAction('ABILITY', `${target.seat + 1}号 ${target.name} 因亡灵法师而中毒`, {
      playerId: victim.id, targetId: target.id, poisonSource: 'vigormortis'
    });
  }

  onDeath(gameState, player, cause, engine) {
    // 恶魔死亡：一名存活爪牙随之死亡
    const minions = getAlivePlayers(engine.room).filter(p =>
      p.id !== player.id && p.role && p.role.category === 'MINION'
    );
    if (minions.length === 0) return {};
    const victim = pickRandom(minions);
    engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（亡灵法师）死亡，${victim.seat + 1}号 ${victim.name}（爪牙）随之死亡`, {
      playerId: player.id, victimId: victim.id
    });
    engine.deathManager.killPlayer(victim.id, 'VIGORMORTIS', gameState.nightCount, gameState.dayCount);
    return {};
  }
}

// ==================== 3. 黑暗之源 ====================
class NoDashii extends SnvDemon {
  constructor() {
    super();
    this.name = '黑暗之源';
    this.id = SNV_ROLE_IDS.NODASHII;
    this.firstNightOrder = -1;
    this.otherNightOrder = 8;
    this.abilityDesc = '每个夜晚（首夜除外），选择一名玩家杀害。与你相邻的两名存活村民中毒。';
  }

  // 每个夜晚开始时重算邻座中毒（来源标记为 nodashii，下个夜晚开始前清除）
  static applyNeighborPoison(engine) {
    const players = seatedPlayers(engine);
    for (const p of players) {
      if (p.snvPoisonSource === 'nodashii') {
        p.isPoisoned = false;
        p.snvPoisonSource = null;
      }
    }

    const demon = players.find(p => p.isAlive && p.role &&
      p.role.id === SNV_ROLE_IDS.NODASHII && !isImpaired(p));
    if (!demon) return;

    const neighbors = getAliveNeighbors(engine.room, demon);
    neighbors.forEach(n => {
      if (n.role && n.role.category === 'TOWNSFOLK' && !n.isPoisoned) {
        n.isPoisoned = true;
        n.snvPoisonSource = 'nodashii';
        engine.logAction('ABILITY', `${n.seat + 1}号 ${n.name} 因与黑暗之源相邻而中毒`, {
          playerId: demon.id, targetId: n.id
        });
      }
    });
  }
}

// ==================== 4. 混沌 ====================
class Vortox extends SnvDemon {
  constructor() {
    super();
    this.name = '混沌';
    this.id = SNV_ROLE_IDS.VORTOX;
    this.firstNightOrder = -1;
    this.otherNightOrder = 9;
    this.abilityDesc = '每个夜晚（首夜除外），选择一名玩家杀害。所有村民技能必定产出错误信息。如果今天无人被处决，邪恶阵营获胜。';
  }
}

module.exports = {
  FangGu,
  Vigormortis,
  NoDashii,
  Vortox,
  SnvDemon,
  isVortoxActive
};
