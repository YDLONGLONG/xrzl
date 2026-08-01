// BMR镇民角色集合（黯月初升）
const Role = require('./Role');
const { BMR_ROLE_IDS } = require('../config/game-config');
const { shuffle, randomChoice, getAlivePlayers, getAliveNeighbors, applyDrunk, clearDrunkSource } = require('../utils/helpers');

// 辅助：获取当晚因自身能力被唤醒的玩家ID集合
// 判定必须与 NightResolver.wakeNext 的 shouldWake 逻辑保持一致，
// 否则女仆等依赖"谁被唤醒"的技能会得到错误结果。
// 注意：夜晚行动顺序的真正来源是脚本配置（FIRST_NIGHT_ORDER / OTHER_NIGHT_ORDER）
// 与 getNightWakeInfo，而不是角色类上的 firstNightOrder/otherNightOrder 数值。
function getWokenPlayerIds(gameState, engine) {
  const wokenIds = new Set();
  const isFirstNight = gameState.nightCount === 0;
  for (const [, player] of engine.room.players) {
    if (!player.isAlive || !player.role) continue;
    const role = player.role;
    const isDrunk = player.isDrunk === true;
    const effectiveRole = (isDrunk && player.fakeRole) ? player.fakeRole : role;
    const wakeInfo = role.getNightWakeInfo ? role.getNightWakeInfo(gameState, player, engine, isFirstNight) : null;
    const selectCount = isDrunk ? (role.selectCount || 0) : (effectiveRole.selectCount || 0);
    const wakesForInfo = effectiveRole.wakesForInfo === true;
    const selectType = effectiveRole.selectType || 'player';
    const isFakeDemon = role.isFakeDemon === true;
    const shouldWake = (selectCount > 0) || wakesForInfo || selectType === 'role'
      || (isDrunk && wakeInfo !== null) || (isFakeDemon && wakeInfo !== null);
    if (shouldWake) {
      wokenIds.add(player.id);
    }
  }
  return wokenIds;
}

// 辅助：从夜晚行动记录中取出目标ID列表（兼容单目标 targetId 与多目标 targets）
function getActionTargetIds(action) {
  if (!action) return [];
  const ids = [];
  if (Array.isArray(action.targets)) ids.push(...action.targets);
  if (action.targetId) ids.push(action.targetId);
  return ids.filter(Boolean);
}

// 辅助：检查玩家是否被恶魔杀害（当夜）
function isKilledByDemon(gameState, playerId) {
  const demonActionKeys = ['imp', 'zombuul', 'pukka', 'shabaloth', 'po'];
  return demonActionKeys.some(k => {
    const action = gameState.nightActions[k];
    return getActionTargetIds(action).includes(playerId);
  });
}

// ==================== 1. 祖母 ====================
class Grandmother extends Role {
  constructor() {
    super();
    this.name = '祖母';
    this.id = BMR_ROLE_IDS.GRANDMOTHER;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = 5;
    this.otherNightOrder = 6;
    this.abilityDesc = '首夜得知一名善良玩家及其角色（你的"孙子"）；若孙子被恶魔杀死，你也会死亡。';
  }

  resolveNight(gameState, player, engine) {
    if (gameState.nightCount === 0) {
      // 首夜：随机选一名善良玩家作为孙子
      const alive = getAlivePlayers(engine.room).filter(p => p.id !== player.id && p.role.team === 'GOOD');
      if (alive.length === 0) return;
      const grandchild = randomChoice(alive);
      player.abilityState.grandchildId = grandchild.id;

      let roleName = grandchild.role.name;
      let isFalse = false;
      let realRoleName = roleName;
      let realGrandchildId = grandchild.id;
      let probInfo = null;

      if (player.isPoisoned || player.isDrunk) {
        const adjustedResult = engine.balanceSystem.adjustInfo(this, { roleName, grandchildId: grandchild.id }, player, engine, '祖母中毒正确信息');
        probInfo = adjustedResult.probInfo;
        if (adjustedResult.info === null) {
          isFalse = true;
          const others = getAlivePlayers(engine.room).filter(p => p.id !== player.id && p.id !== grandchild.id);
          if (others.length > 0) {
            const fake = randomChoice(others);
            player.abilityState.grandchildId = fake.id;
            roleName = fake.role.name;
          }
        }
      }

      const target = engine.room.players.get(player.abilityState.grandchildId);
      const realData = isFalse ? { realRoleName, realGrandchildId, probInfo } : (probInfo ? { probInfo } : null);
      engine.setPlayerPrivateInfo(player, {
        type: 'grandmother',
        grandchildId: player.abilityState.grandchildId,
        grandchildSeat: target ? target.seat : -1,
        grandchildName: target ? target.name : '',
        roleName: roleName,
        message: `你的孙子是 ${target ? target.seat + 1 + '号 ' + target.name : '?'}，角色是【${roleName}】`
      }, isFalse, realData);
    } else {
      // 其他夜晚：检查孙子是否被恶魔杀死
      const grandchildId = player.abilityState.grandchildId;
      if (!grandchildId) return;
      const grandchild = engine.room.players.get(grandchildId);
      if (!grandchild) return;

      if (grandchild.isDead && grandchild.deathNight === gameState.nightCount && isKilledByDemon(gameState, grandchildId)) {
        if (player.isAlive && !player.isPoisoned) {
          const result = engine.deathManager.killPlayer(player.id, 'GRANDMOTHER', gameState.nightCount, -1);
          if (result && !result.prevented) {
            engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（祖母）因孙子被恶魔杀害而死亡`, {
              playerId: player.id, grandchildId
            });
          }
        }
      }
    }
  }
}

// ==================== 2. 水手 ====================
class Sailor extends Role {
  constructor() {
    super();
    this.name = '水手';
    this.id = BMR_ROLE_IDS.SAILOR;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = 6;
    this.otherNightOrder = 5;
    this.selectCount = 1;
    this.abilityDesc = '每个夜晚，选择一名存活玩家，你或该玩家醉酒直到下一个黄昏；你不会被恶魔杀害。';
  }

  getNightWakeInfo(gameState, player, engine) {
    return {
      canSelectCount: 1,
      message: '选择一名玩家，你或TA将醉酒直到下一个黄昏'
    };
  }

  onNightAction(gameState, player, action, engine) {
    const targetId = action.targets && action.targets[0];
    if (!targetId || targetId === player.id) {
      return { success: false, message: '请选择另一名玩家' };
    }
    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive) {
      return { success: false, message: '选择的玩家无效' };
    }

    // 随机决定水手或目标醉酒（持续到明天黄昏：本夜+次日白天）
    const sailorDrunk = Math.random() < 0.5;
    const drunked = sailorDrunk ? player : target;
    applyDrunk(drunked, 'sailor', 2);
    player.abilityState.lastTargetId = targetId;

    engine.setPlayerPrivateInfo(player, {
      type: 'sailor',
      targetId: targetId,
      message: `你选择了 ${target.seat + 1}号 ${target.name}，${sailorDrunk ? '你' : 'TA'}醉酒了`
    });

    return { success: true };
  }

  onDeath(gameState, player, cause, engine) {
    // 水手不会被恶魔杀害（类似士兵），醉酒或中毒时失效
    if (cause === 'DEMON' && !player.isPoisoned && !player.isDrunk) {
      player.isAlive = true;
      player.isDead = false;
      player.deathNight = -1;
      engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（水手）不会被恶魔杀害`, {
        playerId: player.id
      });
      return { revived: true };
    }
    return {};
  }
}

// ==================== 3. 侍女 ====================
class Maid extends Role {
  constructor() {
    super();
    this.name = '侍女';
    this.id = BMR_ROLE_IDS.MAID;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = 9;
    this.otherNightOrder = 10;
    this.selectCount = 2;
    this.abilityDesc = '每个夜晚，选择除自己外的两名存活玩家，得知他们中有几人在当晚因自身能力被唤醒。';
  }

  getNightWakeInfo(gameState, player, engine) {
    return {
      canSelectCount: 2,
      excludeSelf: true,
      message: '选择两名其他玩家，得知他们中有几人当晚被唤醒'
    };
  }

  onNightAction(gameState, player, action, engine) {
    const targets = action.targets || [];
    if (targets.length !== 2) {
      return { success: false, message: '请选择两名玩家' };
    }
    for (const tid of targets) {
      if (tid === player.id) return { success: false, message: '不能选择自己' };
      const t = engine.room.players.get(tid);
      if (!t || !t.isAlive) return { success: false, message: '选择的玩家无效' };
    }
    player.abilityState.maidTargets = targets;
    return { success: true };
  }

  resolveNight(gameState, player, engine) {
    const targets = player.abilityState.maidTargets;
    if (!targets || targets.length !== 2) return;

    const wokenIds = getWokenPlayerIds(gameState, engine);
    let count = 0;
    for (const tid of targets) {
      if (wokenIds.has(tid)) count++;
    }

    let info = count;
    let isFalse = false;
    let realInfo = count;
    let probInfo = null;

    if (player.isPoisoned || player.isDrunk) {
      const adjustedResult = engine.balanceSystem.adjustInfo(this, count, player, engine, '侍女中毒正确信息');
      probInfo = adjustedResult.probInfo;
      if (adjustedResult.info !== null) {
        info = adjustedResult.info;
      } else {
        isFalse = true;
        const possible = [0, 1, 2].filter(n => n !== count);
        info = randomChoice(possible);
      }
    }

    const realData = isFalse ? { realCount: realInfo, probInfo } : (probInfo ? { probInfo } : null);
    const targetNames = targets.map(tid => {
      const t = engine.room.players.get(tid);
      return t ? `${t.seat + 1}号${t.name}` : '?';
    }).join('、');

    engine.setPlayerPrivateInfo(player, {
      type: 'maid',
      targets: targets,
      count: info,
      message: `${targetNames} 中有 ${info} 人在当晚被唤醒`
    }, isFalse, realData);

    player.abilityState.maidTargets = null;
  }
}

// ==================== 4. 驱魔人 ====================
class Exorcist extends Role {
  constructor() {
    super();
    this.name = '驱魔人';
    this.id = BMR_ROLE_IDS.EXORCIST;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = 7;
    this.otherNightOrder = 6;
    this.selectCount = 1;
    this.abilityDesc = '每个夜晚，选择一名玩家（不能与上夜相同），若选中恶魔：恶魔得知驱魔人是谁，该恶魔能力失效。';
  }

  getNightWakeInfo(gameState, player, engine) {
    const lastTarget = player.abilityState.lastTargetId;
    let msg = '选择一名玩家（不能与上夜相同），若为恶魔则其能力失效';
    if (lastTarget) {
      const lt = engine.room.players.get(lastTarget);
      if (lt) msg = `选择一名玩家（不能选上夜的 ${lt.seat + 1}号 ${lt.name}），若为恶魔则其能力失效`;
    }
    return { canSelectCount: 1, message: msg };
  }

  onNightAction(gameState, player, action, engine) {
    const targetId = action.targets && action.targets[0];
    if (!targetId) {
      return { success: false, message: '请选择一名玩家' };
    }
    if (targetId === player.abilityState.lastTargetId) {
      return { success: false, message: '不能选择与上一夜相同的玩家' };
    }
    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive) {
      return { success: false, message: '选择的玩家无效' };
    }

    player.abilityState.lastTargetId = targetId;

    // 检查目标是否是恶魔
    const isDemon = target.role && target.role.category === 'DEMON' && target.role.team === 'EVIL';

    if (isDemon && !player.isPoisoned && !player.isDrunk) {
      // 恶魔得知驱魔人是谁
      engine.setPlayerPrivateInfo(target, {
        type: 'exorcist_reveal',
        exorcistId: player.id,
        message: `驱魔人是 ${player.seat + 1}号 ${player.name}！你的能力今晚失效。`
      });
      // 标记恶魔能力失效（NightResolver 据此当夜跳过该恶魔的唤醒与行动）
      gameState.nightActions.exorcist = { targetId, demonId: target.id };
      target.abilityState = target.abilityState || {};
      target.abilityState.exorcisedNight = gameState.nightCount;

      engine.setPlayerPrivateInfo(player, {
        type: 'exorcist',
        targetId: targetId,
        message: `你选择了 ${target.seat + 1}号 ${target.name}，TA是恶魔！恶魔能力失效。`
      });
      engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（驱魔人）选中恶魔 ${target.seat + 1}号 ${target.name}，恶魔能力失效`, {
        playerId: player.id, targetId
      });
    } else {
      engine.setPlayerPrivateInfo(player, {
        type: 'exorcist',
        targetId: targetId,
        message: `你选择了 ${target.seat + 1}号 ${target.name}，无事发生`
      });
    }

    return { success: true };
  }
}

// ==================== 5. 旅店老板 ====================
class Innkeeper extends Role {
  constructor() {
    super();
    this.name = '旅店老板';
    this.id = BMR_ROLE_IDS.INNKEEPER;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = -1; // 首夜不行动
    this.otherNightOrder = 8;
    this.selectCount = 2;
    this.abilityDesc = '第二夜起，选择两名玩家，他们当晚不会死亡，但其中一人会醉酒到下一个黄昏。';
  }

  getNightWakeInfo(gameState, player, engine) {
    return {
      canSelectCount: 2,
      message: '选择两名玩家保护，其中一人会醉酒'
    };
  }

  onNightAction(gameState, player, action, engine) {
    if (player.isPoisoned) {
      const targets = action.targets || [];
      const names = targets.map(tid => {
        const t = engine.room.players.get(tid);
        return t ? `${t.seat + 1}号${t.name}` : '?';
      }).join('、');
      engine.setPlayerPrivateInfo(player, {
        type: 'innkeeper',
        message: `你保护了 ${names}（中毒，保护无效）`
      }, true, { realMessage: '你中毒了，保护无效' });
      return { success: true };
    }

    const targets = action.targets || [];
    if (targets.length !== 2) {
      return { success: false, message: '请选择两名玩家' };
    }
    for (const tid of targets) {
      const t = engine.room.players.get(tid);
      if (!t || !t.isAlive) return { success: false, message: '选择的玩家无效' };
    }

    // 保护两名玩家
    for (const tid of targets) {
      const t = engine.room.players.get(tid);
      if (t) t.isProtected = true;
    }

    // 随机一人醉酒（持续到明天黄昏：本夜+次日白天）
    const drunkTarget = Math.random() < 0.5 ? targets[0] : targets[1];
    const drunkPlayer = engine.room.players.get(drunkTarget);
    if (drunkPlayer) {
      applyDrunk(drunkPlayer, 'innkeeper', 2);
    }

    gameState.nightActions.innkeeper = { targetIds: targets };

    const names = targets.map(tid => {
      const t = engine.room.players.get(tid);
      return t ? `${t.seat + 1}号${t.name}` : '?';
    }).join('、');
    const drunkName = drunkPlayer ? `${drunkPlayer.seat + 1}号${drunkPlayer.name}` : '?';

    engine.setPlayerPrivateInfo(player, {
      type: 'innkeeper',
      protectedIds: targets,
      message: `你保护了 ${names}，其中 ${drunkName} 醉酒了`
    });

    return { success: true };
  }
}

// ==================== 6. 赌徒 ====================
class Gambler extends Role {
  constructor() {
    super();
    this.name = '赌徒';
    this.id = BMR_ROLE_IDS.GAMBLER;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = -1;
    this.otherNightOrder = 9;
    this.selectCount = 1;
    this.selectType = 'playerAndRole';
    this.abilityDesc = '第二夜起，选择一名存活玩家并猜测其角色，猜错则赌徒死亡。';
  }

  getNightWakeInfo(gameState, player, engine) {
    const { getScriptConfig } = require('../config/game-config');
    const scriptConfig = getScriptConfig(engine.room.script || 'bmr');
    const roles = scriptConfig.allRoles.map(rid => {
      const roleInstance = engine.roleAllocator.createRoleInstance(rid);
      return {
        id: rid,
        name: roleInstance ? roleInstance.name : rid,
        team: roleInstance ? roleInstance.team : '',
        category: roleInstance ? roleInstance.category : ''
      };
    });
    return {
      canSelectCount: 1,
      selectType: 'playerAndRole',
      selectRoles: roles,
      selectDead: false,
      excludeSelf: false,
      message: '选择一名存活玩家（可以选自己），然后猜测该玩家的角色。猜错则你死亡。'
    };
  }

  onNightAction(gameState, player, action, engine) {
    const targetId = action.targetId || (action.targets && action.targets[0]);
    const guessRoleId = action.roleId;

    if (!targetId) {
      return { success: false, message: '请选择一名玩家' };
    }
    if (!guessRoleId) {
      return { success: false, message: '请猜测目标的角色' };
    }

    const target = engine.room.players.get(targetId);
    if (!target) {
      return { success: false, message: '选择的玩家无效' };
    }
    if (!target.isAlive) {
      return { success: false, message: '只能选择存活玩家' };
    }

    const guessRoleInstance = engine.roleAllocator.createRoleInstance(guessRoleId);
    const guessName = guessRoleInstance ? guessRoleInstance.name : guessRoleId;

    player.abilityState.gambleTarget = targetId;
    player.abilityState.gambleGuessId = guessRoleId;
    player.abilityState.gambleGuess = guessName;

    engine.setPlayerPrivateInfo(player, {
      type: 'gambler',
      targetId: targetId,
      guess: guessName,
      message: `你猜测 ${target.seat + 1}号 ${target.name} 是【${guessName}】，等待天亮结算...`
    });

    return { success: true };
  }

  resolveNight(gameState, player, engine) {
    const targetId = player.abilityState.gambleTarget;
    const guess = player.abilityState.gambleGuess;
    const guessId = player.abilityState.gambleGuessId;
    if (!targetId || !guess) return;

    const target = engine.room.players.get(targetId);
    if (!target) {
      player.abilityState.gambleTarget = null;
      player.abilityState.gambleGuess = null;
      player.abilityState.gambleGuessId = null;
      return;
    }

    const realRoleId = target.role ? target.role.id : '';
    const realRole = target.role ? target.role.name : '';
    const correct = (realRoleId === guessId);

    if (correct) {
      engine.setPlayerPrivateInfo(player, {
        type: 'gambler',
        targetId: targetId,
        guess: guess,
        result: true,
        message: `你猜测 ${target.seat + 1}号 ${target.name} 是【${guess}】，猜对了！`
      });
    } else {
      engine.setPlayerPrivateInfo(player, {
        type: 'gambler',
        targetId: targetId,
        guess: guess,
        result: false,
        realRole: realRole,
        message: `你猜测 ${target.seat + 1}号 ${target.name} 是【${guess}】，其实TA是【${realRole}】，你死了！`
      });
      if (player.isAlive && !player.isProtected) {
        engine.deathManager.killPlayer(player.id, 'GAMBLER', gameState.nightCount, -1);
        engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（赌徒）猜测错误，死亡。目标 ${target.seat + 1}号 ${target.name} 实为【${realRole}】`, {
          playerId: player.id, targetId, guess, guessId, realRole, realRoleId
        });
      }
    }

    player.abilityState.gambleTarget = null;
    player.abilityState.gambleGuess = null;
    player.abilityState.gambleGuessId = null;
  }
}

// ==================== 7. 造谣者 ====================
class Gossip extends Role {
  constructor() {
    super();
    this.name = '造谣者';
    this.id = BMR_ROLE_IDS.GOSSIP;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = -1;
    this.otherNightOrder = -1;
    this.abilityDesc = '每个白天可公开发表一个声明（自由文本）。当晚由裁判判断声明真伪：若声明为真且你未中毒/醉酒，当晚一名玩家死亡。';
  }

  onDayAbility(gameState, player, statement, engine) {
    if (player.abilityState.gossipDay === gameState.dayCount) {
      return { success: false, message: '你今天已经发表过声明了' };
    }
    if (!statement || typeof statement !== 'string' || statement.trim().length < 2) {
      return { success: false, message: '请输入声明内容（至少2个字）' };
    }
    if (statement.length > 200) {
      return { success: false, message: '声明不能超过200字' };
    }

    const cleanStatement = statement.trim().substring(0, 200);

    player.abilityState.gossipDay = gameState.dayCount;
    player.abilityState.gossipStatement = cleanStatement;
    player.abilityState.gossipResult = null;
    player.abilityState.gossipAIPending = true;

    engine.setPlayerPrivateInfo(player, {
      type: 'gossip',
      day: gameState.dayCount,
      statement: cleanStatement,
      message: `你发表了声明："${cleanStatement}"，等待裁判判断真伪...`
    });

    return {
      success: true,
      statement: cleanStatement,
      message: '声明已公布，等待裁判判断真伪...'
    };
  }

  resolveNight(gameState, player, engine) {
    const BalanceSystem = require('../game/BalanceSystem');
    const statement = player.abilityState.gossipStatement;
    if (!statement) return;

    const result = player.abilityState.gossipResult;
    const isTrue = result === true;
    const isPoisoned = player.isPoisoned;
    const isDrunk = player.isDrunk;

    player.abilityState.gossipStatement = null;
    player.abilityState.gossipResult = null;
    player.abilityState.gossipAIPending = false;

    if (isTrue && !isPoisoned && !isDrunk) {
      const victimInfo = BalanceSystem.selectGossipVictim(engine);
      if (victimInfo && victimInfo.player) {
        const victim = victimInfo.player;
        engine.deathManager.killPlayer(victim.id, 'GOSSIP', gameState.nightCount, -1);
        engine.setPlayerPrivateInfo(player, {
          type: 'gossip',
          result: true,
          victimId: victim.id,
          message: `你的声明"${statement}"为真，${victim.seat + 1}号 ${victim.name} 因此死亡`
        });
        engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（造谣者）的声明"${statement}"为真，${victim.seat + 1}号 ${victim.name} 死亡（偏袒${victimInfo.favoredTeam === 'GOOD' ? '好人' : victimInfo.favoredTeam === 'EVIL' ? '邪恶' : '随机'}）`, {
          playerId: player.id, victimId: victim.id, statement, balanceScore: victimInfo.balanceScore
        });
      }
    } else {
      let reason = '声明为假';
      if (isPoisoned) reason = '声明为真但你中毒了';
      else if (isDrunk) reason = '声明为真但你醉酒了';
      engine.setPlayerPrivateInfo(player, {
        type: 'gossip',
        result: false,
        message: `你的声明"${statement}"${reason}，无事发生`
      });
      engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（造谣者）的声明"${statement}"${reason}，无事发生`, {
        playerId: player.id, statement, isPoisoned, isDrunk
      });
    }
  }
}

// ==================== 8. 侍臣 ====================
class Courtier extends Role {
  constructor() {
    super();
    this.name = '侍臣';
    this.id = BMR_ROLE_IDS.COURTIER;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = 8;
    this.otherNightOrder = 9;
    this.selectCount = 0;
    this.selectType = 'role';
    this.canSkip = true;
    this.abilityDesc = '每局限一次，夜晚选择一个角色：如果该角色在场，该角色之一从当晚开始醉酒三天三夜。你可以选择不使用技能。';
  }

  getNightWakeInfo(gameState, player, engine) {
    if (player.abilityState.used) {
      return null;
    }
    const { getScriptConfig } = require('../config/game-config');
    const scriptConfig = getScriptConfig(engine.room.script || 'bmr');
    const roles = scriptConfig.allRoles.map(rid => {
      const roleInstance = engine.roleAllocator.createRoleInstance(rid);
      return { id: rid, name: roleInstance ? roleInstance.name : rid, team: roleInstance ? roleInstance.team : '', category: roleInstance ? roleInstance.category : '' };
    });
    return {
      selectType: 'role',
      canSelectCount: 1,
      canSkip: true,
      selectRoles: roles,
      message: '选择一个角色：若该角色在场，持有该角色的玩家将醉酒三天三夜。你也可以选择不使用技能。'
    };
  }

  onNightAction(gameState, player, action, engine) {
    if (player.abilityState.used) {
      engine.setPlayerPrivateInfo(player, {
        type: 'courtier',
        message: '你已使用过技能'
      });
      return { success: true };
    }

    if (action.skip) {
      engine.setPlayerPrivateInfo(player, {
        type: 'courtier',
        message: '你选择今晚不使用技能'
      });
      engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（侍臣）选择今晚不使用技能`, {
        playerId: player.id, skipped: true
      });
      return { success: true };
    }

    const roleId = action.roleId;
    if (!roleId) {
      return { success: false, message: '请选择一个角色或选择跳过' };
    }

    if (player.isPoisoned) {
      engine.setPlayerPrivateInfo(player, {
        type: 'courtier',
        message: '你中毒了，技能无效'
      });
      return { success: true };
    }

    const roleInstance = engine.roleAllocator.createRoleInstance(roleId);
    const drunkRoleName = roleInstance ? roleInstance.name : roleId;

    const target = Array.from(engine.room.players.values()).find(p => p.seat !== -1 && p.role && p.role.id === roleId);

    player.abilityState.used = true;
    player.abilityState.drunkRoleId = roleId;

    if (target) {
      player.abilityState.drunkPlayerId = target.id;
      // 醉酒三天三夜：由 helpers 的按来源计时负责递减，此处只需施加
      applyDrunk(target, 'courtier', 3);

      engine.setPlayerPrivateInfo(player, {
        type: 'courtier',
        roleId: roleId,
        targetId: target.id,
        roleName: drunkRoleName,
        message: `你选择了【${drunkRoleName}】（${target.seat + 1}号 ${target.name}），该角色醉酒三天三夜`
      });
      engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（侍臣）使【${drunkRoleName}】${target.seat + 1}号 ${target.name} 醉酒三天三夜`, {
        playerId: player.id, targetId: target.id, drunkRoleId: roleId
      });
    } else {
      engine.setPlayerPrivateInfo(player, {
        type: 'courtier',
        roleId: roleId,
        roleName: drunkRoleName,
        message: `你选择了【${drunkRoleName}】，该角色不在场，无人醉酒`
      });
      engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（侍臣）选择了【${drunkRoleName}】，该角色不在场，无人醉酒`, {
        playerId: player.id, drunkRoleId: roleId, notInPlay: true
      });
    }

    return { success: true };
  }
}

// ==================== 9. 教授 ====================
class Professor extends Role {
  constructor() {
    super();
    this.name = '教授';
    this.id = BMR_ROLE_IDS.PROFESSOR;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = -1;
    this.otherNightOrder = 12;
    this.selectCount = 1;
    this.abilityDesc = '每局限一次，夜晚选择一名死亡玩家：若该玩家是镇民，将其复活。中毒/醉酒时技能无效。';
  }

  getNightWakeInfo(gameState, player, engine) {
    if (player.abilityState.used) {
      return null;
    }
    const deadPlayers = Array.from(engine.room.players.values()).filter(p => p.seat !== -1 && !p.isAlive);
    if (deadPlayers.length === 0) {
      return null;
    }
    return {
      canSelectCount: 1,
      selectDead: true,
      message: '选择一名死亡玩家：若该玩家是镇民，将其复活（每局限一次）'
    };
  }

  onNightAction(gameState, player, action, engine) {
    if (player.abilityState.used) {
      engine.setPlayerPrivateInfo(player, {
        type: 'professor',
        message: '你已使用过技能'
      });
      return { success: true };
    }

    const targetId = action.targets && action.targets[0];
    if (!targetId) {
      return { success: false, message: '请选择一名死亡玩家' };
    }
    const target = engine.room.players.get(targetId);
    if (!target) {
      return { success: false, message: '选择的玩家无效' };
    }
    if (target.isAlive) {
      return { success: false, message: '只能选择死亡玩家' };
    }

    player.abilityState.used = true;

    if (!player.isPoisoned && !player.isDrunk && target.role && target.role.category === 'TOWNSFOLK') {
      target.isAlive = true;
      target.isDead = false;
      target.deathNight = -1;
      target.deathDay = -1;
      target.voteToken = 0;
      clearDrunkSource(target, 'courtier'); // 复活解除侍臣的醉酒
      target.isDrunk = false;
      target.isPoisoned = false;

      engine.setPlayerPrivateInfo(player, {
        type: 'professor',
        targetId: targetId,
        success: true,
        message: `你复活了 ${target.seat + 1}号 ${target.name}（${target.role.name}，镇民）！`
      });
      engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（教授）复活了 ${target.seat + 1}号 ${target.name}（${target.role.name}）`, {
        playerId: player.id, targetId, revived: true
      });
    } else {
      const reason = player.isPoisoned ? '你中毒了' : (player.isDrunk ? '你醉酒了' : '该玩家不是镇民');
      engine.setPlayerPrivateInfo(player, {
        type: 'professor',
        targetId: targetId,
        success: false,
        message: `${reason}，技能已消耗，${target.seat + 1}号 ${target.name} 未能复活`
      });
      engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（教授）对 ${target.seat + 1}号 ${target.name} 使用技能但失败：${reason}`, {
        playerId: player.id, targetId, revived: false, reason
      });
    }

    return { success: true };
  }
}

// ==================== 10. 吟游诗人 ====================
class Bard extends Role {
  constructor() {
    super();
    this.name = '吟游诗人';
    this.id = BMR_ROLE_IDS.BARD;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = -1;
    this.otherNightOrder = -1;
    this.abilityDesc = '当一名爪牙死于处决时，除了你以外的所有其他玩家醉酒直到明天黄昏。';
  }

  // 当处决爪牙时由处决逻辑调用：让除吟游诗人外的所有玩家醉酒（持续到明天黄昏）
  // 返回 true 表示触发成功
  static applyMinionExecutionEffect(gameState, engine, bardPlayer) {
    if (!bardPlayer || !bardPlayer.isAlive) return false;
    if (bardPlayer.isPoisoned) return false;
    for (const [, p] of engine.room.players) {
      if (p.id !== bardPlayer.id && p.isAlive) {
        applyDrunk(p, 'bard', 2); // 每个来源独立计时，不覆盖其它醉酒
      }
    }
    engine.logAction('ABILITY', `${bardPlayer.seat + 1}号 ${bardPlayer.name}（吟游诗人）触发：爪牙被处决，其他所有玩家醉酒`, {
      playerId: bardPlayer.id
    });
    return true;
  }
}

// ==================== 11. 茶艺师 ====================
class Tealady extends Role {
  constructor() {
    super();
    this.name = '茶艺师';
    this.id = BMR_ROLE_IDS.TEALADY;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = -1;
    this.otherNightOrder = -1;
    this.abilityDesc = '如果与你邻近的两名存活的玩家是善良的，他们不会死亡。';
  }

  // 由 NightResolver 杀人逻辑调用：检查目标是否被茶艺师保护
  // 返回 true 表示目标受茶艺师保护不应被杀
  static isProtectedByTealady(target, engine) {
    const alive = getAlivePlayers(engine.room);
    for (const tl of alive) {
      if (!tl.role || tl.role.id !== BMR_ROLE_IDS.TEALADY) continue;
      if (tl.isPoisoned) continue;
      const neighbors = getAliveNeighbors(engine.room, tl);
      if (neighbors.length !== 2) continue;
      // 两名邻居必须都是善良
      if (neighbors[0].role.team === 'GOOD' && neighbors[1].role.team === 'GOOD') {
        // 目标是这两名邻居之一则受保护
        if (neighbors.some(n => n.id === target.id)) {
          return true;
        }
      }
    }
    return false;
  }
}

// ==================== 12. 和平主义者 ====================
class Pacifist extends Role {
  constructor() {
    super();
    this.name = '和平主义者';
    this.id = BMR_ROLE_IDS.PACIFIST;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = -1;
    this.otherNightOrder = -1;
    this.abilityDesc = '被处决的善良玩家可能不会死亡。';
  }

  // 由处决逻辑调用：检查善良玩家被处决时是否被和平主义者拯救
  // 返回 true 表示处决被阻止
  static checkPacifistSave(executedPlayer, engine) {
    if (!executedPlayer || !executedPlayer.role) return false;
    if (executedPlayer.role.team !== 'GOOD') return false;
    const alive = getAlivePlayers(engine.room);
    const pacifist = alive.find(p => p.role && p.role.id === BMR_ROLE_IDS.PACIFIST);
    if (!pacifist) return false;
    if (pacifist.isPoisoned || pacifist.isDrunk) return false;
    // 拯救概率由平衡系统自动决定
    const probInfo = engine.balanceSystem.getPacifistSaveProbability(engine);
    const saved = Math.random() < probInfo.probability;
    if (saved) {
      engine.logAction('ABILITY', `${pacifist.seat + 1}号 ${pacifist.name}（和平主义者）拯救了被处决的 ${executedPlayer.seat + 1}号 ${executedPlayer.name}`, {
        pacifistId: pacifist.id, savedId: executedPlayer.id, probInfo
      });
    }
    return saved;
  }
}

// ==================== 13. 弄臣 ====================
class Fool extends Role {
  constructor() {
    super();
    this.name = '弄臣';
    this.id = BMR_ROLE_IDS.FOOL;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = -1;
    this.otherNightOrder = -1;
    this.abilityDesc = '当你首次将要死亡时，你不会死亡。';
  }

  onDeath(gameState, player, cause, engine) {
    if (!player.abilityState.usedDeath && !player.isPoisoned) {
      player.abilityState.usedDeath = true;
      player.isAlive = true;
      player.isDead = false;
      player.deathNight = -1;
      player.deathDay = -1;
      engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（弄臣）首次死亡被免疫`, {
        playerId: player.id
      });
      return { revived: true };
    }
    return {};
  }
}

module.exports = {
  Grandmother,
  Sailor,
  Maid,
  Exorcist,
  Innkeeper,
  Gambler,
  Gossip,
  Courtier,
  Professor,
  Bard,
  Tealady,
  Pacifist,
  Fool,
  getActionTargetIds,
  isKilledByDemon
};
