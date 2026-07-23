// BMR剧本（黯月初升）恶魔角色
const Role = require('./Role');
const { BMR_ROLE_IDS } = require('../config/game-config');

// 僵怖 (Zombuul)
// 每个夜晚，若白天无人死亡，选择一名玩家杀死。当你首次死亡后，你仍存活，但是会被当作死亡。
class Zombuul extends Role {
  constructor() {
    super();
    this.name = '僵怖';
    this.id = BMR_ROLE_IDS.ZOMBUUL;
    this.team = 'EVIL';
    this.category = 'DEMON';
    this.firstNightOrder = 2;
    this.otherNightOrder = 3;
    this.selectCount = 1;
    this.abilityDesc = '每个夜晚，若白天无人死亡，选择一名玩家杀死。当你首次死亡后，你仍存活，但是会被当作死亡。';
    this.abilityState = {
      firstDeath: false
    };
  }

  onFirstNight(gameState, player, engine) {
    // 恶魔信息在分配身份时已经设置
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    if (isFirstNight) {
      return null; // 首夜只给信息，不杀人
    }
    // 检查白天是否有人死亡
    const dayDeaths = gameState.dayDeaths || [];
    if (dayDeaths.length > 0) {
      return null; // 白天有人死亡，不唤醒
    }
    return {
      canSelectCount: 1,
      message: '白天无人死亡，选择一名玩家杀害'
    };
  }

  onNightAction(gameState, player, action, engine) {
    // 中毒/醉酒时恶魔能力失效
    if (player.isPoisoned || player.isDrunk) {
      return { success: false, message: '你中毒/醉酒了，能力失效' };
    }

    const targetId = action.targets && action.targets[0];
    if (!targetId) {
      return { success: false, message: '请选择一名玩家' };
    }

    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive) {
      return { success: false, message: '选择的玩家无效' };
    }

    gameState.nightActions.zombuul = { targetId };

    engine.setPlayerPrivateInfo(player, {
      type: 'zombuul',
      targetId: targetId,
      message: `你选择杀害 ${target.seat + 1}号 ${target.name}`
    });

    return { success: true };
  }

  onDeath(gameState, player, cause, engine) {
    // 首次死亡时不死，标记为被当作死亡
    if (!this.abilityState.firstDeath) {
      this.abilityState.firstDeath = true;
      player.isAlive = true;   // 仍存活
      player.isDead = true;    // 被当作死亡
      return { preventDeath: true };
    }
    return { preventDeath: false };
  }
}

// 普卡 (Pukka)
// 每个夜晚，选择一名玩家中毒，上一夜被毒的玩家在当晚死亡并恢复健康。
class Pukka extends Role {
  constructor() {
    super();
    this.name = '普卡';
    this.id = BMR_ROLE_IDS.PUKKA;
    this.team = 'EVIL';
    this.category = 'DEMON';
    this.firstNightOrder = 2;
    this.otherNightOrder = 1; // 最先行动
    this.selectCount = 1;
    this.abilityDesc = '每个夜晚，选择一名玩家中毒，上一夜被毒的玩家在当晚死亡并恢复健康。';
    this.abilityState = {
      lastPoisonTargetId: null
    };
  }

  onFirstNight(gameState, player, engine) {
    // 恶魔信息在分配身份时已经设置
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    if (isFirstNight) {
      return null;
    }
    return {
      canSelectCount: 1,
      message: '选择一名玩家中毒'
    };
  }

  onNightAction(gameState, player, action, engine) {
    // 中毒/醉酒时恶魔能力失效
    if (player.isPoisoned || player.isDrunk) {
      return { success: false, message: '你中毒/醉酒了，能力失效' };
    }

    const targetId = action.targets && action.targets[0];
    if (!targetId) {
      return { success: false, message: '请选择一名玩家' };
    }

    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive) {
      return { success: false, message: '选择的玩家无效' };
    }

    // 记录当前选择的目标
    gameState.nightActions.pukka = { targetId };

    // 设置目标中毒
    target.isPoisoned = true;

    engine.setPlayerPrivateInfo(player, {
      type: 'pukka',
      targetId: targetId,
      message: `你选择毒杀 ${target.seat + 1}号 ${target.name}`
    });

    return { success: true };
  }

  // 夜晚结算后更新上一夜毒目标记录
  // 注：杀掉上一夜毒目标并恢复健康的逻辑由 NightResolver 处理
  resolveNight(gameState, player, engine) {
    const action = gameState.nightActions.pukka;
    if (action && action.targetId) {
      this.abilityState.lastPoisonTargetId = action.targetId;
    }
  }
}

// 沙巴洛斯 (Shabaloth)
// 每个夜晚，选择两名玩家杀死；你上个夜晚选择过且当前死亡的玩家之一可能会被你反刍(复活)。
class Shabaloth extends Role {
  constructor() {
    super();
    this.name = '沙巴洛斯';
    this.id = BMR_ROLE_IDS.SHABALOTH;
    this.team = 'EVIL';
    this.category = 'DEMON';
    this.firstNightOrder = 2;
    this.otherNightOrder = 3;
    this.selectCount = 2;
    this.abilityDesc = '每个夜晚，选择两名玩家杀死；你上个夜晚选择过且当前死亡的玩家之一可能会被你反刍(复活)。';
    this.abilityState = {
      lastNightTargets: []
    };
  }

  onFirstNight(gameState, player, engine) {
    // 恶魔信息在分配身份时已经设置
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    if (isFirstNight) {
      return null;
    }
    return {
      canSelectCount: 2,
      message: '选择两名玩家杀害'
    };
  }

  onNightAction(gameState, player, action, engine) {
    // 中毒/醉酒时恶魔能力失效
    if (player.isPoisoned || player.isDrunk) {
      return { success: false, message: '你中毒/醉酒了，能力失效' };
    }

    const targets = action.targets || [];
    if (targets.length !== 2) {
      return { success: false, message: '请选择两名玩家' };
    }

    const targetPlayers = [];
    for (const targetId of targets) {
      const target = engine.room.players.get(targetId);
      if (!target || !target.isAlive) {
        return { success: false, message: '选择的玩家无效' };
      }
      targetPlayers.push({ targetId, target });
    }

    gameState.nightActions.shabaloth = { targets };

    for (const { targetId, target } of targetPlayers) {
      engine.setPlayerPrivateInfo(player, {
        type: 'shabaloth',
        targetId: targetId,
        message: `你选择杀害 ${target.seat + 1}号 ${target.name}`
      });
    }

    return { success: true };
  }

  // 夜晚结算后更新上一夜目标记录
  // 注：反刍(复活)逻辑由 NightResolver 处理
  resolveNight(gameState, player, engine) {
    const action = gameState.nightActions.shabaloth;
    if (action && action.targets) {
      this.abilityState.lastNightTargets = [...action.targets];
    }
  }
}

// 珀 (Po)
// 每个夜晚，你可以选择一名玩家:他死亡。如果你上次选择时没有选择任何玩家，当晚你要选择三名玩家:他们死亡。
class Po extends Role {
  constructor() {
    super();
    this.name = '珀';
    this.id = BMR_ROLE_IDS.PO;
    this.team = 'EVIL';
    this.category = 'DEMON';
    this.firstNightOrder = 2;
    this.otherNightOrder = 3;
    this.selectCount = 1;
    this.abilityDesc = '每个夜晚，你可以选择一名玩家:他死亡。如果你上次选择时没有选择任何玩家，当晚你要选择三名玩家:他们死亡。';
    this.abilityState = {
      lastSkipped: false
    };
  }

  onFirstNight(gameState, player, engine) {
    // 恶魔信息在分配身份时已经设置
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    if (isFirstNight) {
      return null;
    }
    const count = this.abilityState.lastSkipped ? 3 : 1;
    return {
      canSelectCount: count,
      message: count === 3
        ? '上次跳过，本次选择三名玩家杀害'
        : '选择一名玩家杀害（或跳过）'
    };
  }

  onNightAction(gameState, player, action, engine) {
    // 中毒/醉酒时恶魔能力失效
    if (player.isPoisoned || player.isDrunk) {
      return { success: false, message: '你中毒/醉酒了，能力失效' };
    }

    const expectedCount = this.abilityState.lastSkipped ? 3 : 1;
    const targets = action.targets || [];

    // 允许跳过（不选任何玩家），仅当期望数量为1时
    if (targets.length === 0 && expectedCount === 1) {
      this.abilityState.lastSkipped = true;
      gameState.nightActions.po = { targets: [] };
      engine.setPlayerPrivateInfo(player, {
        type: 'po',
        message: '你选择跳过本次行动'
      });
      return { success: true };
    }

    if (targets.length !== expectedCount) {
      return { success: false, message: `请选择 ${expectedCount} 名玩家` };
    }

    const targetPlayers = [];
    for (const targetId of targets) {
      const target = engine.room.players.get(targetId);
      if (!target || !target.isAlive) {
        return { success: false, message: '选择的玩家无效' };
      }
      targetPlayers.push({ targetId, target });
    }

    gameState.nightActions.po = { targets };
    this.abilityState.lastSkipped = false;

    for (const { targetId, target } of targetPlayers) {
      engine.setPlayerPrivateInfo(player, {
        type: 'po',
        targetId: targetId,
        message: `你选择杀害 ${target.seat + 1}号 ${target.name}`
      });
    }

    return { success: true };
  }
}

module.exports = {
  Zombuul,
  Pukka,
  Shabaloth,
  Po
};
