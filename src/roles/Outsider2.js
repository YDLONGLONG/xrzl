// 外来者角色 - 黯月初升 (BMR)
const Role = require('./Role');
const { BMR_ROLE_IDS } = require('../config/game-config');

// 查找真正的恶魔（排除伪装成恶魔的莽夫/疯子）
function findRealDemon(engine, excludePlayer) {
  const players = Array.from(engine.room.players.values()).filter(p => p.seat !== -1);
  return players.find(p =>
    p.id !== excludePlayer.id &&
    p.role &&
    p.role.category === 'DEMON' &&
    p.role.team === 'EVIL' &&
    !p.role.isFakeDemon
  );
}

// 首夜告知真恶魔：某玩家是莽夫/疯子
function revealFakeDemon(player, engine, label) {
  const demon = findRealDemon(engine, player);
  if (!demon) return;
  engine.setPlayerPrivateInfo(demon, {
    type: 'fakedemon_reveal',
    message: `${player.seat+1}号 ${player.name} 是【${label}】，他以为自己是恶魔（${player.fakeRole ? player.fakeRole.name : '?'}）`
  });
}

// 每晚告知真恶魔：莽夫/疯子的选择
function revealFakeDemonChoice(player, engine, targets, label) {
  const demon = findRealDemon(engine, player);
  if (!demon) return;
  const targetNames = targets.map(tid => {
    const t = engine.room.players.get(tid);
    return t ? `${t.seat+1}号${t.name}` : tid;
  }).join('、');
  engine.setPlayerPrivateInfo(demon, {
    type: 'fakedemon_choice',
    message: `【${label}】${player.seat+1}号 ${player.name} 今晚选择了：${targetNames || '无目标'}`
  });
}

// 修补匠
class Tinker extends Role {
  constructor() {
    super();
    this.name = '修补匠';
    this.id = BMR_ROLE_IDS.TINKER;
    this.team = 'GOOD';
    this.category = 'OUTSIDER';
    this.abilityDesc = '你可能会在夜晚死亡。';
    this.selectCount = 0;
  }
  // 被动角色，无夜晚行动；可能随机死亡由 NightResolver 处理
}

// 月之子
class Moonchild extends Role {
  constructor() {
    super();
    this.name = '月之子';
    this.id = BMR_ROLE_IDS.MOONCHILD;
    this.team = 'GOOD';
    this.category = 'OUTSIDER';
    this.abilityDesc = '当你死亡时，公开选择一名存活玩家。如果他是善良的，他会在当晚死亡。';
    this.selectCount = 0;
  }

  onFirstNight(gameState, player, engine) {
    if (!player.abilityState) player.abilityState = {};
    player.abilityState.hasUsed = false;
    player.abilityState.pendingSelect = false;
    player.abilityState.pendingSelectNextDay = false;
    player.abilityState.selectedTarget = null;
  }

  // 死亡时触发：白天死亡立即设置待选择；夜晚死亡标记为次日天亮时选择
  onDeath(gameState, player, cause, engine) {
    if (!player.abilityState) player.abilityState = {};
    if (player.abilityState.hasUsed) return;
    const PHASES = require('../config/game-config').PHASES;
    const dayPhases = [PHASES.DAY_DAWN, PHASES.DAY_DISCUSSION, PHASES.NOMINATION_PHASE, PHASES.DEFENSE, PHASES.VOTING, PHASES.EXECUTION];
    const gs = engine.room.gameState;
    const isDaytime = dayPhases.includes(gs.phase);
    // 记录死亡时的中毒/醉酒状态（用于夜晚结算，无论死亡在白天还是夜晚）
    player.abilityState.deathPoisoned = player.isPoisoned;
    player.abilityState.deathDrunk = player.isDrunk;
    player.abilityState.hasUsed = true; // 标记已使用，避免重复触发

    const debuffTags = [];
    if (player.isPoisoned) debuffTags.push('中毒');
    if (player.isDrunk) debuffTags.push('醉酒');
    const debuffStr = debuffTags.length > 0
      ? '（死亡时' + debuffTags.join('+') + '，技能可能失效）'
      : '';

    if (isDaytime) {
      player.abilityState.pendingSelect = true;
      player.abilityState.pendingSelectNextDay = false;
      engine.logAction('ABILITY', `${player.seat+1}号 ${player.name}（月之子）白天死亡，需在白天公开选择目标${debuffStr}`, {
        playerId: player.id, role: 'moonchild', event: 'death_trigger_day', deathCause: cause, isPoisoned: !!player.isPoisoned, isDrunk: !!player.isDrunk
      });
    } else {
      // 夜晚死亡：延迟到次日天亮时再显示选择按钮
      player.abilityState.pendingSelect = false;
      player.abilityState.pendingSelectNextDay = true;
      engine.logAction('ABILITY', `${player.seat+1}号 ${player.name}（月之子）夜晚死亡，次日白天需公开选择目标${debuffStr}`, {
        playerId: player.id, role: 'moonchild', event: 'death_trigger_night', deathCause: cause, isPoisoned: !!player.isPoisoned, isDrunk: !!player.isDrunk
      });
    }
  }

  // 白天处理月之子选择目标
  onDayAbility(gameState, player, targetId, engine) {
    if (!player.abilityState || !player.abilityState.pendingSelect) {
      return { success: false, message: '当前不是选择时机' };
    }
    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive) {
      return { success: false, message: '请选择一名存活玩家' };
    }
    player.abilityState.pendingSelect = false;
    player.abilityState.selectedTarget = targetId;

    const targetRoleName = target.role ? target.role.name : '未知';
    const targetTeam = target.role ? (target.role.team === 'GOOD' ? '善良' : '邪恶') : '未知';
    const debuffTags = [];
    if (player.abilityState.deathPoisoned) debuffTags.push('中毒');
    if (player.abilityState.deathDrunk) debuffTags.push('醉酒');
    let resultHint;
    if (debuffTags.length > 0) {
      resultHint = '（月之子死亡时' + debuffTags.join('+') + '，技能将失效，目标是' + targetTeam + '阵营【' + targetRoleName + '】）';
    } else {
      resultHint = '（目标是' + targetTeam + '阵营【' + targetRoleName + '】，若为善良则今晚死亡）';
    }

    engine.logAction('ABILITY', `${player.seat+1}号 ${player.name}（月之子）公开选择 ${target.seat+1}号 ${target.name} ${resultHint}`, {
      playerId: player.id, role: 'moonchild', event: 'choose_target', targetId: target.id, targetSeat: target.seat, targetRoleId: target.role ? target.role.id : null, targetTeam: target.role ? target.role.team : null, abilityWillWork: !player.abilityState.deathPoisoned && !player.abilityState.deathDrunk
    });

    return {
      success: true,
      targetId,
      targetName: target.name,
      targetSeat: target.seat
    };
  }
}

// 莽夫（技能表设定：莽夫能令最初每夜选择其的玩家醉酒，并转而属于该玩家的阵营）
// 注意：与「疯子（假恶魔）」不同，莽夫为被动角色，没有夜晚行动。
class Lunatic extends Role {
  constructor() {
    super();
    this.name = '莽夫';
    this.id = BMR_ROLE_IDS.LUNATIC;
    this.team = 'GOOD';
    this.category = 'OUTSIDER';
    this.abilityDesc = '每个夜晚，第一个将能力选择指向你的玩家会醉酒直到明天黄昏，而你会转而属于该玩家的阵营。此后你被视作该阵营（除非被再次转化）。你不会死亡。';
    this.selectCount = 0; // 被动角色，无夜晚行动
    this.isFakeDemon = false; // 不是假恶魔，不在夜晚被唤醒
    this.drunkDuration = 2; // 直到明天黄昏（覆盖本夜 + 次日白天，于下次黄昏清除）
    this.deathImmune = true; // 莽夫不会死亡
  }

  // 首夜初始化转化状态
  onFirstNight(gameState, player, engine) {
    if (!player.abilityState) player.abilityState = {};
    player.abilityState.transformedTeam = null; // 尚未被转化，仍属善良
  }

  // 被动角色，没有夜晚行动，不会被唤醒
  getNightWakeInfo() {
    return null;
  }

  // 从一次夜晚行动中取出「被指向的玩家 id 列表」：兼容单目标 targetId 与多目标 targets / roleId
  static getTargetedIds(action) {
    if (!action) return [];
    const ids = [];
    if (Array.isArray(action.targets)) ids.push(...action.targets);
    if (action.targetId) ids.push(action.targetId);
    if (action.roleId) ids.push(action.roleId);
    return ids.filter(Boolean);
  }

  // 莽夫（Goon）能力触发器：本夜「第一个」将能力选向莽夫、且自身未中毒/醉酒的玩家触发。
  // 效果：该玩家醉酒至明天黄昏；莽夫转而属于该玩家的阵营（若该玩家不是恶魔，则莽夫保留原阵营）。
  // 返回 true 表示成功触发（已消耗本夜的转化机会）。
  static triggerGoon(gameState, lunaticPlayer, acterPlayer, engine) {
    if (!lunaticPlayer || !lunaticPlayer.isAlive || lunaticPlayer.role.id !== BMR_ROLE_IDS.LUNATIC) {
      return false;
    }
    if (!acterPlayer) return false;

    // 本夜已经成功触发过，则不再触发（仅真正成功的转化占用该机会）
    if (gameState.goonTriggeredThisNight) return false;

    // 触发者自身处于中毒/醉酒状态则其能力无效，且本夜不再重试（避免随后清醒的玩家被算作「第一个」）
    if (acterPlayer.isPoisoned || acterPlayer.isDrunk) {
      engine.logAction('ABILITY', `${acterPlayer.seat + 1}号 ${acterPlayer.name}（中毒/醉酒）指向莽夫，莽夫能力对其失效`, {
        playerId: lunaticPlayer.id, acterId: acterPlayer.id, event: 'goon_fizzle'
      });
      return false;
    }

    // 占用本夜的转化机会
    gameState.goonTriggeredThisNight = true;

    // 该玩家醉酒至明天黄昏
    if (!acterPlayer.abilityState) acterPlayer.abilityState = {};
    acterPlayer.isDrunk = true;
    acterPlayer.drunkDuration = lunaticPlayer.role.drunkDuration || 2;
    acterPlayer.drunkTurns = 0;

    // 莽夫转而属于该玩家的阵营；若指向者是恶魔则不转化（莽夫仍属善良）
    const isDemon = acterPlayer.role && acterPlayer.role.category === 'DEMON';
    const state = lunaticPlayer.abilityState || (lunaticPlayer.abilityState = {});
    state.transformedTeam = isDemon ? state.transformedTeam : (acterPlayer.team || 'GOOD');

    engine.logAction('ABILITY', `${acterPlayer.seat + 1}号 ${acterPlayer.name} 是第一个指向莽夫的玩家，已醉酒；莽夫转而属于${state.transformedTeam === 'GOOD' ? '善良' : '邪恶'}阵营`, {
      playerId: lunaticPlayer.id,
      acterId: acterPlayer.id,
      acterTeam: acterPlayer.team,
      transformedTeam: state.transformedTeam,
      event: 'goon_triggered'
    });
    return true;
  }

  // 供胜利判定/阵营相关逻辑查询莽夫当前所属阵营
  static getEffectiveTeam(player) {
    if (player.abilityState && player.abilityState.transformedTeam) {
      return player.abilityState.transformedTeam;
    }
    return 'GOOD';
  }
}

// 疯子
class Madman extends Role {
  constructor() {
    super();
    this.name = '疯子';
    this.id = BMR_ROLE_IDS.MADMAN;
    this.team = 'GOOD';
    this.category = 'OUTSIDER';
    this.abilityDesc = '你以为你是一个恶魔，但其实你不是。恶魔知道你是疯子以及你在每个夜晚选择了哪些玩家。';
    this.selectCount = 1;
    this.isFakeDemon = true;
  }

  // 首夜：通过 fakeRole 机制让疯子以为自己是某个恶魔；同时告知真恶魔
  onFirstNight(gameState, player, engine) {
    if (!player.abilityState) player.abilityState = {};
    revealFakeDemon(player, engine, '疯子');
  }

  // 假装是恶魔被唤醒，委托给假恶魔角色的唤醒信息
  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    if (!player.fakeRole) return null;
    const fake = player.fakeRole;
    if (isFirstNight && fake.firstNightOrder < 0) return null;
    if (fake.getNightWakeInfo) {
      const info = fake.getNightWakeInfo(gameState, player, engine, isFirstNight);
      if (info) {
        this.selectCount = fake.selectCount || 1;
        return info;
      }
    }
    this.selectCount = fake.selectCount || 1;
    return {
      canSelectCount: this.selectCount,
      message: '选择一名玩家进行攻击'
    };
  }

  // 假装行动成功，不产生实际击杀；真恶魔得知疯子的选择
  onNightAction(gameState, player, action, engine) {
    this.selectCount = 1;
    const targets = (action.targets || []).filter(t => t);
    const targetNames = targets.map(tid => {
      const t = engine.room.players.get(tid);
      return t ? `${t.seat+1}号${t.name}` : tid;
    }).join('、');

    engine.setPlayerPrivateInfo(player, {
      type: 'madman_action',
      message: targets.length ? `你攻击了 ${targetNames}` : '你本次未选择目标',
      isFakeDemon: true
    }, true, { realInfo: '疯子不是恶魔，行动无实际效果' });

    revealFakeDemonChoice(player, engine, targets, '疯子');
    return { success: true };
  }
}

module.exports = {
  Tinker,
  Moonchild,
  Lunatic,
  Madman
};
