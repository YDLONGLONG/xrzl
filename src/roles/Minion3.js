// SNV 剧本（紫罗兰教派）爪牙角色
const Role = require('./Role');
const { SNV_ROLE_IDS, getScriptConfig } = require('../config/game-config');
const { pickRandom, scriptRoleInfos } = require('./SnvUtils');
const { getAlivePlayers, getPlayerEffectiveTeam } = require('../utils/helpers');

function seatedPlayers(engine) {
  return Array.from(engine.room.players.values()).filter(p => p.seat !== -1);
}

// ==================== 1. 邪恶双子 ====================
class EvilTwin extends Role {
  constructor() {
    super();
    this.name = '邪恶双子';
    this.id = SNV_ROLE_IDS.EVILTWIN;
    this.team = 'EVIL';
    this.category = 'MINION';
    this.firstNightOrder = -1;
    this.otherNightOrder = -1;
    this.selectCount = 0;
    this.abilityDesc = '你与一名善良玩家互知身份。若善良的双子被处决，邪恶阵营获胜；若你被处决，善良阵营获胜。';
  }

  // 由 RoleAllocator 在开局时调用：为邪恶双子指定一名善良双子并互相告知
  static setupTwins(engine, players) {
    const evilTwin = players.find(p => p.role && p.role.id === SNV_ROLE_IDS.EVILTWIN);
    if (!evilTwin) return;

    const goodCandidates = players.filter(p =>
      p.id !== evilTwin.id && p.role && p.role.team === 'GOOD'
    );
    if (goodCandidates.length === 0) return;

    const goodTwin = pickRandom(goodCandidates);
    evilTwin.abilityState = evilTwin.abilityState || {};
    goodTwin.abilityState = goodTwin.abilityState || {};
    evilTwin.abilityState.twinId = goodTwin.id;
    goodTwin.abilityState.twinId = evilTwin.id;

    engine.setPlayerPrivateInfo(evilTwin, {
      type: 'evil_twin',
      twinId: goodTwin.id,
      message: `你的善良双子是 ${goodTwin.seat + 1}号 ${goodTwin.name}【${goodTwin.role.name}】。若他被处决，邪恶阵营获胜；若你被处决，善良阵营获胜。`
    });
    engine.setPlayerPrivateInfo(goodTwin, {
      type: 'good_twin',
      twinId: evilTwin.id,
      message: `你的邪恶双子是 ${evilTwin.seat + 1}号 ${evilTwin.name}【邪恶双子】。若他被处决，善良阵营获胜；若你被处决，邪恶阵营获胜。`
    });
    engine.logAction('ABILITY', `邪恶双子：${evilTwin.seat + 1}号 ${evilTwin.name} 与 ${goodTwin.seat + 1}号 ${goodTwin.name} 互为双子`, {
      playerId: evilTwin.id, twinId: goodTwin.id
    });
  }

  // 当日处决是否触发了双子胜负（由 VictoryChecker 调用）
  static checkTwinExecution(engine, gs) {
    const deaths = gs.todaysDeaths || [];
    for (const d of deaths) {
      if (d.cause !== 'EXECUTION' || !d.playerId) continue;
      const p = engine.room.players.get(d.playerId);
      if (!p || !p.role) continue;
      if (p.role.id === SNV_ROLE_IDS.EVILTWIN) {
        return { winner: 'GOOD', player: p };
      }
      if (p.abilityState && p.abilityState.twinId) {
        const twin = engine.room.players.get(p.abilityState.twinId);
        if (twin && twin.role && twin.role.id === SNV_ROLE_IDS.EVILTWIN) {
          return { winner: 'EVIL', player: p };
        }
      }
    }
    return null;
  }
}

// ==================== 2. 女巫 ====================
class Witch extends Role {
  constructor() {
    super();
    this.name = '女巫';
    this.id = SNV_ROLE_IDS.WITCH;
    this.team = 'EVIL';
    this.category = 'MINION';
    this.firstNightOrder = 4;
    this.otherNightOrder = 4;
    this.selectCount = 1;
    this.abilityDesc = '每个夜晚，选择一名玩家：如果他在明天发起了提名，他会死亡。场上仅剩3名存活玩家时你失去此技能。';
  }

  // 官方：场上仅剩 3 名存活玩家时女巫失去能力
  isAbilityLost(engine) {
    return getAlivePlayers(engine.room).length <= 3;
  }

  getNightWakeInfo(gameState, player, engine) {
    if (engine && this.isAbilityLost(engine)) return null;
    return {
      canSelectCount: 1,
      excludeSelf: true,
      message: '选择一名玩家：如果他明天发起提名，他会死亡'
    };
  }

  onNightAction(gameState, player, action, engine) {
    if (this.isAbilityLost(engine)) {
      gameState.witchCurse = null;
      return { success: true };
    }
    const targetId = action.targets && action.targets[0];
    if (!targetId) return { success: false, message: '请选择一名玩家' };
    if (targetId === player.id) return { success: false, message: '不能选择自己' };
    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive) return { success: false, message: '选择的玩家无效' };

    // 新的一夜覆盖旧的诅咒
    gameState.witchCurse = null;

    if (player.isPoisoned || player.isDrunk) {
      engine.setPlayerPrivateInfo(player, {
        type: 'witch',
        message: `你诅咒了 ${target.seat + 1}号 ${target.name}（中毒/醉酒，诅咒无效）`
      }, true, { realMessage: '你中毒/醉酒了，诅咒无效' });
      return { success: true };
    }

    gameState.witchCurse = { targetId, day: gameState.dayCount + 1 };
    engine.setPlayerPrivateInfo(player, {
      type: 'witch',
      targetId,
      message: `你诅咒了 ${target.seat + 1}号 ${target.name}：如果他明天发起提名，他会死亡`
    });
    engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（女巫）诅咒了 ${target.seat + 1}号 ${target.name}`, {
      playerId: player.id, targetId
    });

    return { success: true };
  }
}

// ==================== 3. 洗脑师 ====================
class Cerenovus extends Role {
  constructor() {
    super();
    this.name = '洗脑师';
    this.id = SNV_ROLE_IDS.CERENOVUS;
    this.team = 'EVIL';
    this.category = 'MINION';
    this.firstNightOrder = 4;
    this.otherNightOrder = 4;
    this.selectCount = 1;
    this.selectType = 'playerAndRole';
    this.abilityDesc = '每个夜晚，选择一名玩家和一个善良角色：如果他明天没有公开声称自己是该角色，他会被处决。';
  }

  getNightWakeInfo(gameState, player, engine) {
    return {
      canSelectCount: 1,
      selectType: 'playerAndRole',
      selectRoles: scriptRoleInfos(engine, r => r.team === 'GOOD'),
      message: '选择一名玩家和一个善良角色：他明天必须公开声称自己是该角色，否则会被处决'
    };
  }

  onNightAction(gameState, player, action, engine) {
    const targetId = action.targetId || (action.targets && action.targets[0]);
    const roleId = action.roleId;
    if (!targetId || !roleId) return { success: false, message: '请选择玩家与角色' };
    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive) return { success: false, message: '选择的玩家无效' };
    const roleInst = engine.roleAllocator.createRoleInstance(roleId);
    if (!roleInst) return { success: false, message: '角色不存在' };

    gameState.cerenovusCurse = null;

    if (player.isPoisoned || player.isDrunk) {
      engine.setPlayerPrivateInfo(player, {
        type: 'cerenovus',
        message: `你洗脑了 ${target.seat + 1}号 ${target.name}（中毒/醉酒，无效）`
      }, true, { realMessage: '你中毒/醉酒了，洗脑无效' });
      return { success: true };
    }

    gameState.cerenovusCurse = { targetId, roleId, roleName: roleInst.name, day: gameState.dayCount + 1 };
    engine.setPlayerPrivateInfo(player, {
      type: 'cerenovus',
      targetId,
      roleId,
      message: `你洗脑了 ${target.seat + 1}号 ${target.name}：他明天必须公开声称自己是【${roleInst.name}】`
    });
    engine.setPlayerPrivateInfo(target, {
      type: 'cerenovus_cursed',
      roleId,
      roleName: roleInst.name,
      day: gameState.dayCount + 1,
      message: `你被洗脑了！今天你必须公开声称自己是【${roleInst.name}】（可使用「洗脑宣告」按钮），否则你将被处决。`
    });
    engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（洗脑师）要求 ${target.seat + 1}号 ${target.name} 今天声称自己是【${roleInst.name}】`, {
      playerId: player.id, targetId, roleId
    });

    return { success: true };
  }
}

// ==================== 4. 坑巫 ====================
class PitHag extends Role {
  constructor() {
    super();
    this.name = '坑巫';
    this.id = SNV_ROLE_IDS.PITHAG;
    this.team = 'EVIL';
    this.category = 'MINION';
    this.firstNightOrder = -1; // 首夜不行动
    this.otherNightOrder = 5;
    this.selectCount = 1;
    this.selectType = 'playerAndRole';
    this.abilityDesc = '每个夜晚（首夜除外），选择一名玩家和一个不在场的角色：该玩家变成该角色（阵营不变）。';
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    if (isFirstNight) return null;
    const inPlay = new Set(gameState.rolesInPlay || []);
    const selectRoles = scriptRoleInfos(engine, r => !inPlay.has(r.id));
    if (selectRoles.length === 0) return null;
    return {
      canSelectCount: 1,
      selectType: 'playerAndRole',
      selectRoles,
      message: '选择一名玩家和一个不在场的角色：该玩家变成该角色（阵营不变）'
    };
  }

  onNightAction(gameState, player, action, engine) {
    const targetId = action.targetId || (action.targets && action.targets[0]);
    const roleId = action.roleId;
    if (!targetId || !roleId) return { success: false, message: '请选择玩家与角色' };

    // 速查表：坑巫首夜不发动（首夜选择使用也按「不发动，无事发生」处理）
    if (gameState.nightCount === 0) {
      engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（坑巫）首夜不发动技能`, {
        playerId: player.id, disabled: true
      });
      return { success: true };
    }

    const target = engine.room.players.get(targetId);
    if (!target || !target.role) return { success: false, message: '选择的玩家无效' };
    // 速查表：被选中玩家已死亡时无法被唤醒执行变身
    if (!target.isAlive) {
      return { success: false, message: '该玩家已死亡，无法被变身' };
    }
    if (target.role.id === roleId) return { success: false, message: '该玩家已经是该角色' };

    const newRole = engine.roleAllocator.createRoleInstance(roleId);
    if (!newRole) return { success: false, message: '角色不存在' };
    if ((gameState.rolesInPlay || []).includes(roleId)) {
      return { success: false, message: '该角色已在场，请选择一个不在场的角色' };
    }

    if (player.isPoisoned || player.isDrunk) {
      engine.setPlayerPrivateInfo(player, {
        type: 'pithag',
        message: `你试图把 ${target.seat + 1}号 ${target.name} 变成【${newRole.name}】（中毒/醉酒，无效）`
      }, true, { realMessage: '你中毒/醉酒了，变形无效' });
      return { success: true };
    }

    const oldRole = target.role;
    const oldRoleId = oldRole.id;
    const oldRoleName = oldRole.name;
    // 阵营跟随玩家，不跟随角色：变成恶魔也不会改变阵营
    const oldTeam = getPlayerEffectiveTeam(target);

    const wasDemon = oldRole.category === 'DEMON';
    const isDemon = newRole.category === 'DEMON';

    target.role = newRole;
    target.abilityState = target.abilityState || {};
    if (oldTeam && oldTeam !== newRole.team) newRole.snvAlignment = oldTeam;
    else delete newRole.snvAlignment;

    // 重新计算在场/不在场角色
    const players = seatedPlayers(engine);
    gameState.rolesInPlay = [...new Set(players.map(p => p.role.id))];
    const sc = getScriptConfig(engine.room.script || 'tb');
    gameState.rolesNotInPlay = sc.allRoles.filter(r => !gameState.rolesInPlay.includes(r));

    // 速查表「第二步：变身成功后是否制造恶魔」
    let outcomeCase = null;
    let oldDemonId = null;
    let note = '';
    if (wasDemon && isDemon) {
      // 邪恶恶魔 → 不在场恶魔：恶魔类型改变，当晚通常不杀人（给好人线索）
      outcomeCase = 'demon_swapped';
      note = '。恶魔类型已改变，本夜通常不杀人，好人才有机会察觉恶魔被替换';
    } else if (!wasDemon && isDemon) {
      const otherDemon = players.find(p =>
        p.id !== targetId && p.isAlive && p.role && p.role.category === 'DEMON' && !p.role.isFakeDemon);
      oldDemonId = otherDemon ? otherDemon.id : null;
      if (oldTeam === 'EVIL') {
        // 制造出新的邪恶恶魔：旧恶魔仍存活时让其当晚死亡，避免场上有多个邪恶恶魔
        outcomeCase = 'new_evil_demon';
        note = '。场上出现了新的邪恶恶魔，旧恶魔当晚将死亡';
      } else {
        // 善良玩家 → 不在场恶魔：制造善良恶魔，本夜不再额外杀人
        outcomeCase = 'new_good_demon';
        note = '。出现了善良阵营的恶魔，本夜不再额外杀人';
      }
    } else if (wasDemon && !isDemon) {
      // 邪恶恶魔 → 不在场非恶魔：未制造恶魔，只换身份，不触发随机死亡
      note = '。旧恶魔已不再是恶魔，本夜不触发随机死亡';
    }

    gameState.pithagOutcome = outcomeCase ? {
      night: gameState.nightCount,
      case: outcomeCase,
      targetId,
      oldDemonId,
      oldRoleId,
      roleId
    } : null;

    engine.setPlayerPrivateInfo(player, {
      type: 'pithag',
      targetId,
      roleId,
      message: `你把 ${target.seat + 1}号 ${target.name}（${oldRoleName}）变成了【${newRole.name}】${note}`
    });
    // 官方：被变身的玩家不会被告知，只能从之后的能力/信息自行发现；
    // 变化仅在上帝视角日志与身份面板中体现，不额外推送私信。
    engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（坑巫）把 ${target.seat + 1}号 ${target.name} 从【${oldRoleName}】变成【${newRole.name}】${note}`, {
      playerId: player.id, targetId, roleId, oldRoleId,
      becameDemon: isDemon, oldWasDemon: wasDemon, outcomeCase
    });

    return { success: true };
  }
}

module.exports = {
  EvilTwin,
  Witch,
  Cerenovus,
  PitHag
};
