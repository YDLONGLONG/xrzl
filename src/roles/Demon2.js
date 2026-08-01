// BMR剧本（黯月初升）恶魔角色
const Role = require('./Role');
const { BMR_ROLE_IDS } = require('../config/game-config');

// 统一的能力状态存取：所有跨夜状态都保存在 player.abilityState 上，
// 避免出现「角色实例状态」与「玩家状态」两份数据互相看不见的问题。
function stateOf(player) {
  if (!player) return {};
  if (!player.abilityState || typeof player.abilityState !== 'object') {
    player.abilityState = {};
  }
  return player.abilityState;
}

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

  // 判断「刚过去的白天是否真的有人死亡」。
  // gameState.lastDayDeaths 中会混入 NO_EXECUTION / TIE 这类「无人死亡」的占位记录，
  // 必须以是否带有 playerId 为准，否则平安日 / 平票日会被误判为有人死亡。
  static hadDayDeath(gameState) {
    const deaths = (gameState && gameState.lastDayDeaths) || [];
    return deaths.some(d => d && d.playerId && d.cause !== 'FIRST_NIGHT');
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    if (isFirstNight) {
      return null; // 首夜只给信息，不杀人
    }
    // 检查白天是否有人死亡（与 NightResolver 结算使用同一判定）
    if (Zombuul.hadDayDeath(gameState)) {
      return null; // 白天有人死亡，不唤醒
    }
    return {
      canSelectCount: 1,
      message: '白天无人死亡，选择一名玩家杀害'
    };
  }

  onNightAction(gameState, player, action, engine) {
    const targetId = action.targets && action.targets[0];
    if (!targetId) {
      return { success: false, message: '请选择一名玩家' };
    }

    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive) {
      return { success: false, message: '选择的玩家无效' };
    }

    // 中毒/醉酒时能力无效：不记录击杀，但行动照常完成（玩家不应察觉），否则夜晚流程会卡死
    if (!player.isPoisoned && !player.isDrunk) {
      gameState.nightActions.zombuul = { targetId, targets: [targetId] };
    }

    engine.setPlayerPrivateInfo(player, {
      type: 'zombuul',
      targetId: targetId,
      message: `你选择杀害 ${target.seat + 1}号 ${target.name}`
    });

    return { success: true };
  }

  onDeath(gameState, player, cause, engine) {
    // 首次死亡时不死，标记为被当作死亡
    // 状态必须写在 player.abilityState 上，NightResolver / DeathManager 读的是同一份数据
    const state = stateOf(player);
    if (!state.firstDeath) {
      state.firstDeath = true;
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
    // 普卡首夜也要行动：首夜下毒，第二夜该目标才会死亡。
    // 若首夜不唤醒，整条「毒-死」链条会整体延后一夜甚至断裂。
    return {
      canSelectCount: 1,
      message: isFirstNight ? '选择一名玩家中毒（他将在明晚死亡）' : '选择一名玩家中毒'
    };
  }

  onNightAction(gameState, player, action, engine) {
    const targetId = action.targets && action.targets[0];
    if (!targetId) {
      return { success: false, message: '请选择一名玩家' };
    }

    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive) {
      return { success: false, message: '选择的玩家无效' };
    }

    // 中毒/醉酒时能力无效：不下毒、不记录，但行动照常完成
    if (!player.isPoisoned && !player.isDrunk) {
      // 记录当前选择的目标
      gameState.nightActions.pukka = { targetId, targets: [targetId] };
      // 设置目标中毒
      target.isPoisoned = true;
    }

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
      // 写入 player.abilityState，NightResolver.resolveDemonKills 读取的就是这里
      stateOf(player).lastPoisonTargetId = action.targetId;
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
    const targets = action.targets || [];
    if (targets.length !== 2) {
      return { success: false, message: '请选择两名玩家' };
    }
    if (targets[0] === targets[1]) {
      return { success: false, message: '请选择两名不同的玩家' };
    }

    const targetPlayers = [];
    for (const targetId of targets) {
      const target = engine.room.players.get(targetId);
      if (!target || !target.isAlive) {
        return { success: false, message: '选择的玩家无效' };
      }
      targetPlayers.push({ targetId, target });
    }

    // 中毒/醉酒时能力无效：不记录击杀，但行动照常完成
    if (!player.isPoisoned && !player.isDrunk) {
      // targets 为多目标数组；同时保留 targetId=null 以免被单目标读取方误判
      gameState.nightActions.shabaloth = { targets: [...targets], targetId: null };
    }

    // 多个目标合并为一条私信，避免后一条覆盖前一条只剩最后一个目标
    engine.setPlayerPrivateInfo(player, {
      type: 'shabaloth',
      targets: [...targets],
      message: `你选择杀害 ${targetPlayers.map(({ target }) => `${target.seat + 1}号 ${target.name}`).join('、')}`
    });

    return { success: true };
  }

  // 夜晚结算后更新上一夜目标记录
  // 注：反刍(复活)逻辑由 NightResolver 处理
  resolveNight(gameState, player, engine) {
    const action = gameState.nightActions.shabaloth;
    if (action && Array.isArray(action.targets)) {
      // 写入 player.abilityState，NightResolver 读取的就是这里
      stateOf(player).lastNightTargets = [...action.targets];
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
    this.canSkip = true; // 「你可以选择一名玩家」——允许不选
    this.abilityDesc = '每个夜晚，你可以选择一名玩家:他死亡。如果你上次选择时没有选择任何玩家，当晚你要选择三名玩家:他们死亡。';
  }

  onFirstNight(gameState, player, engine) {
    // 恶魔信息在分配身份时已经设置
  }

  // 本夜应选人数：上次跳过则为3，否则为1
  expectedCount(player) {
    return stateOf(player).poLastSkipped ? 3 : 1;
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    if (isFirstNight) {
      return null;
    }
    const count = this.expectedCount(player);
    // 同步到角色实例，使 NightResolver / GameEngine 的目标数量校验与机器人选人保持一致
    this.selectCount = count;
    this.canSkip = count === 1;
    return {
      canSelectCount: count,
      canSkip: count === 1,
      message: count === 3
        ? '上次跳过，本次选择三名玩家杀害'
        : '选择一名玩家杀害（或跳过）'
    };
  }

  onNightAction(gameState, player, action, engine) {
    const state = stateOf(player);
    const expectedCount = this.expectedCount(player);
    const targets = action.targets || [];
    const isSkip = action.skip === true || (targets.length === 0 && expectedCount === 1);
    const abilityWorks = !player.isPoisoned && !player.isDrunk;

    // 允许跳过（不选任何玩家），仅当期望数量为1时
    if (isSkip) {
      if (expectedCount !== 1) {
        return { success: false, message: `请选择 ${expectedCount} 名玩家` };
      }
      // 「上次是否跳过」属于行动记录，中毒时同样成立
      state.poLastSkipped = true;
      gameState.nightActions.po = { targets: [], targetId: null };
      engine.setPlayerPrivateInfo(player, {
        type: 'po',
        message: '你选择跳过本次行动'
      });
      this.selectCount = 1;
      this.canSkip = true;
      return { success: true };
    }

    if (targets.length !== expectedCount) {
      return { success: false, message: `请选择 ${expectedCount} 名玩家` };
    }
    if (new Set(targets).size !== targets.length) {
      return { success: false, message: '请选择不同的玩家' };
    }

    const targetPlayers = [];
    for (const targetId of targets) {
      const target = engine.room.players.get(targetId);
      if (!target || !target.isAlive) {
        return { success: false, message: '选择的玩家无效' };
      }
      targetPlayers.push({ targetId, target });
    }

    // 中毒/醉酒时能力无效：不记录击杀，但行动照常完成
    if (abilityWorks) {
      // 多目标时 targetId 置空，避免被单目标读取方误判
      gameState.nightActions.po = {
        targets: [...targets],
        targetId: targets.length === 1 ? targets[0] : null
      };
    }
    state.poLastSkipped = false;

    // 合并为一条私信，避免多次调用互相覆盖
    engine.setPlayerPrivateInfo(player, {
      type: 'po',
      targets: [...targets],
      targetId: targets.length === 1 ? targets[0] : null,
      message: `你选择杀害 ${targetPlayers.map(({ target }) => `${target.seat + 1}号 ${target.name}`).join('、')}`
    });

    // 恢复默认，下次唤醒时由 getNightWakeInfo 重新计算
    this.selectCount = 1;
    this.canSkip = true;

    return { success: true };
  }
}

module.exports = {
  Zombuul,
  Pukka,
  Shabaloth,
  Po
};
