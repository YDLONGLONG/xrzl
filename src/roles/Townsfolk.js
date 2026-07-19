// 村民角色集合
const Role = require('./Role');
const { ROLE_IDS } = require('../config/game-config');
const { shuffle, randomChoice, getAlivePlayers, getAliveNeighbors } = require('../utils/helpers');

// 洗衣妇
class Washerwoman extends Role {
  constructor() {
    super();
    this.name = '洗衣妇';
    this.id = ROLE_IDS.WASHERWOMAN;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = 3;
    this.abilityDesc = '你在首个夜晚得知两名玩家以及其中一名玩家的村民角色。';
  }

  resolveNight(gameState, player, engine) {
    if (gameState.nightCount !== 0) return; // 只有第一夜
    
    const alive = getAlivePlayers(engine.room).filter(p => p.id !== player.id);
    // 村民候选人：真正的村民，或间谍（可能被登记为村民）
    const townsfolkCandidates = alive.filter(p => {
      if (p.role.team === 'GOOD' && p.role.category === 'TOWNSFOLK') return true;
      if (p.role.id === 'spy' && Math.random() < 0.3) return true;
      return false;
    });
    
    if (townsfolkCandidates.length === 0) return;
    
    const townsfolk = randomChoice(townsfolkCandidates);
    const others = alive.filter(p => p.id !== townsfolk.id);
    const other = randomChoice(others);
    const pair = shuffle([townsfolk, other]);

    let roleName = townsfolk.role.category === 'TOWNSFOLK' ? townsfolk.role.name : randomChoice(['洗衣妇','图书管理员','调查员','厨师','共情者','占卜师','僧侣','守鸦人','圣女','杀手','士兵','市长','掘墓人']);
    let isFalse = false;
    let realRoleName = townsfolk.role.name;
    
    if (player.isPoisoned) {
      const correctInfo = { roleName, pair };
      const adjusted = engine.balanceSystem.adjustInfo(this, correctInfo, player, engine);
      if (adjusted === null) {
        realRoleName = roleName;
        isFalse = true;
        const otherTowns = townsfolkCandidates.filter(p => p.id !== townsfolk.id);
        if (otherTowns.length > 0) {
          roleName = randomChoice(otherTowns).role.category === 'TOWNSFOLK' ? randomChoice(otherTowns).role.name : '洗衣妇';
        }
      }
    }
    
    engine.setPlayerPrivateInfo(player, {
      type: 'washerwoman',
      players: pair.map(p => ({ id: p.id, name: p.name, seat: p.seat })),
      roleName: roleName,
      message: `${pair[0].seat+1}号(${pair[0].name})和${pair[1].seat+1}号(${pair[1].name})中，有一位是【${roleName}】`
    }, isFalse, isFalse ? { realRoleName: realRoleName, realPlayerId: townsfolk.id } : null);
  }
}

// 图书管理员
class Librarian extends Role {
  constructor() {
    super();
    this.name = '图书管理员';
    this.id = ROLE_IDS.LIBRARIAN;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = 4;
    this.abilityDesc = '你在首个夜晚得知两名玩家以及其中一名玩家的外来者角色，如果没有外来者则得知此信息。';
  }

  resolveNight(gameState, player, engine) {
    if (gameState.nightCount !== 0) return;
    
    const alive = getAlivePlayers(engine.room).filter(p => p.id !== player.id);
    // 外来者：真正的外来者或隐士（可能登记为外来者），间谍可能被误登记
    const outsiderCandidates = alive.filter(p => {
      if (p.role.category === 'OUTSIDER') return true;
      if (p.role.id === 'recluse' && Math.random() < 0.3) return true;
      if (p.role.id === 'spy' && Math.random() < 0.3) return true;
      return false;
    });
    
    if (outsiderCandidates.length === 0) {
      let msg = '本局游戏没有外来者';
      let isFalse = false;
      if (player.isPoisoned) {
        const adjusted = engine.balanceSystem.adjustInfo(this, msg, player, engine);
        if (adjusted === null && Math.random() < 0.5) {
          isFalse = true;
          const fakeOutsider = randomChoice(alive);
          msg = `${fakeOutsider.seat+1}号(${fakeOutsider.name})附近有外来者`;
          engine.setPlayerPrivateInfo(player, {
            type: 'librarian',
            message: msg
          }, isFalse, { realMessage: '本局游戏没有外来者' });
          return;
        }
      }
      engine.setPlayerPrivateInfo(player, { type: 'librarian', message: msg }, isFalse, isFalse ? { realMessage: msg } : null);
      return;
    }
    
    const outsider = randomChoice(outsiderCandidates);
    const others = alive.filter(p => p.id !== outsider.id);
    const other = randomChoice(others);
    const pair = shuffle([outsider, other]);
    
    let roleName = outsider.role.category === 'OUTSIDER' ? outsider.role.name : randomChoice(['圣徒','管家','酒鬼','隐士']);
    let isFalse = false;
    let realRoleName = outsider.role.name;
    if (player.isPoisoned) {
      const adjusted = engine.balanceSystem.adjustInfo(this, roleName, player, engine);
      if (adjusted === null) {
        isFalse = true;
        const outNames = ['圣徒','管家','酒鬼','隐士'];
        roleName = randomChoice(outNames.filter(n => n !== roleName));
      }
    }
    
    engine.setPlayerPrivateInfo(player, {
      type: 'librarian',
      players: pair.map(p => ({ id: p.id, name: p.name, seat: p.seat })),
      roleName: roleName,
      message: `${pair[0].seat+1}号(${pair[0].name})和${pair[1].seat+1}号(${pair[1].name})中，有一位是【${roleName}】`
    }, isFalse, isFalse ? { realRoleName, realPlayerId: outsider.id } : null);
  }
}

// 调查员
class Investigator extends Role {
  constructor() {
    super();
    this.name = '调查员';
    this.id = ROLE_IDS.INVESTIGATOR;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = 5;
    this.abilityDesc = '你在首个夜晚得知两名玩家以及其中一名玩家的爪牙角色。';
  }

  resolveNight(gameState, player, engine) {
    if (gameState.nightCount !== 0) return;
    
    const alive = getAlivePlayers(engine.room).filter(p => p.id !== player.id);
    // 爪牙或隐士（隐士可能被登记为爪牙）
    const minionCandidates = alive.filter(p => 
      (p.role && p.role.category === 'MINION') ||
      (p.role && p.role.id === 'recluse' && Math.random() < 0.5)
    );
    // 排除间谍（间谍可能不被登记为爪牙）
    const actualMinions = minionCandidates.filter(p => {
      if (p.role.category === 'MINION' && p.role.id !== 'spy') return true;
      if (p.role.id === 'spy') return Math.random() >= 0.5;
      return true; // 隐士
    });
    
    if (actualMinions.length === 0) return;
    
    const minion = randomChoice(actualMinions);
    const others = alive.filter(p => p.id !== minion.id);
    const other = randomChoice(others);
    const pair = shuffle([minion, other]);
    
    let roleName = minion.role.category === 'MINION' ? minion.role.name : randomChoice(['下毒者','红唇女郎','男爵','间谍']);
    let isFalse = false;
    let realRoleName = minion.role.name;
    if (player.isPoisoned) {
      const adjusted = engine.balanceSystem.adjustInfo(this, roleName, player, engine);
      if (adjusted === null) {
        isFalse = true;
        const allMinionNames = ['下毒者','红唇女郎','男爵','间谍'];
        roleName = randomChoice(allMinionNames.filter(n => n !== roleName));
      }
    }
    
    engine.setPlayerPrivateInfo(player, {
      type: 'investigator',
      players: pair.map(p => ({ id: p.id, name: p.name, seat: p.seat })),
      roleName: roleName,
      message: `${pair[0].seat+1}号(${pair[0].name})和${pair[1].seat+1}号(${pair[1].name})中，有一位是【${roleName}】`
    }, isFalse, isFalse ? { realRoleName, realPlayerId: minion.id } : null);
  }
}

// 厨师
class Chef extends Role {
  constructor() {
    super();
    this.name = '厨师';
    this.id = ROLE_IDS.CHEF;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = 6;
    this.abilityDesc = '你在首个夜晚得知邪恶玩家相邻的对数。';
  }

  resolveNight(gameState, player, engine) {
    if (gameState.nightCount !== 0) return;
    
    const seats = engine.room.seats;
    let evilPairs = 0;
    
    for (let i = 0; i < seats.length; i++) {
      const p1 = seats[i];
      const p2 = seats[(i + 1) % seats.length];
      if (p1 && p2 && p1.role && p2.role && p1.isAlive && p2.isAlive) {
        // 判断是否为"邪恶相邻"，考虑隐士/间谍的干扰
        const appearsEvil = (p) => {
          if (p.role.team === 'EVIL') {
            if (p.role.id === 'spy' && Math.random() < 0.5) return false;
            return true;
          }
          if (p.role.id === 'recluse' && Math.random() < 0.5) return true;
          return false;
        };
        if (appearsEvil(p1) && appearsEvil(p2)) evilPairs++;
      }
    }
    
    let info = evilPairs;
    let isFalse = false;
    let realInfo = evilPairs;
    if (player.isPoisoned) {
      const possible = [0, 1, 2, 3, 4].filter(n => n !== evilPairs);
      const adjusted = engine.balanceSystem.adjustInfo(this, evilPairs, player, engine);
      if (adjusted !== null) {
        info = adjusted;
      } else {
        isFalse = true;
        info = randomChoice(possible);
      }
    }
    
    engine.setPlayerPrivateInfo(player, {
      type: 'chef',
      count: info,
      message: `邪恶玩家相邻的对数是：${info}`
    }, isFalse, isFalse ? { realCount: realInfo } : null);
  }
}

// 共情者
class Empath extends Role {
  constructor() {
    super();
    this.name = '共情者';
    this.id = ROLE_IDS.EMPATH;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = 7;
    this.otherNightOrder = 5;
    this.abilityDesc = '每个夜晚，你得知你的左右存活邻居中有多少名邪恶玩家。';
  }

  resolveNight(gameState, player, engine) {
    const neighbors = getAliveNeighbors(engine.room, player);
    const evilCount = neighbors.filter(n => {
      if (n.role.team === 'EVIL') {
        // 间谍可能被登记为善良
        if (n.role.id === 'spy' && Math.random() < 0.5) return false;
        return true;
      }
      // 隐士可能被登记为邪恶
      if (n.role.id === 'recluse' && Math.random() < 0.5) return true;
      return false;
    }).length;
    
    let info = evilCount;
    let isFalse = false;
    let realInfo = evilCount;
    if (player.isPoisoned) {
      const possible = [0, 1, 2].filter(n => n !== evilCount);
      const adjusted = engine.balanceSystem.adjustInfo(this, evilCount, player, engine);
      if (adjusted !== null) {
        info = adjusted;
      } else {
        isFalse = true;
        info = randomChoice(possible);
      }
    }
    
    engine.setPlayerPrivateInfo(player, {
      type: 'empath',
      count: info,
      neighbors: neighbors.map(n => ({ id: n.id, seat: n.seat, name: n.name })),
      message: `你的存活邻居中有 ${info} 名邪恶玩家`
    }, isFalse, isFalse ? { realCount: realInfo } : null);
  }
}

// 占卜师
class Fortuneteller extends Role {
  constructor() {
    super();
    this.name = '占卜师';
    this.id = ROLE_IDS.FORTUNETELLER;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = 8;
    this.otherNightOrder = 6;
    this.selectCount = 2;
    this.abilityDesc = '每个夜晚，选择两名玩家：你得知他们之中是否有恶魔。有一名善良玩家会被你当作恶魔。';
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    return {
      canSelectCount: 2,
      message: '选择两名玩家，得知他们之中是否有恶魔'
    };
  }

  onNightAction(gameState, player, action, engine) {
    const targets = action.targets || [];
    if (targets.length !== 2) {
      return { success: false, message: '请选择两名玩家' };
    }
    
    const p1 = engine.room.players.get(targets[0]);
    const p2 = engine.room.players.get(targets[1]);
    if (!p1 || !p2 || !p1.isAlive || !p2.isAlive) {
      return { success: false, message: '选择的玩家无效' };
    }
    
    const redHerring = player.abilityState.redHerring;
    // 隐士可能被登记为恶魔
    const p1RecluseDemon = p1.role.id === 'recluse' && Math.random() < 0.5;
    const p2RecluseDemon = p2.role.id === 'recluse' && Math.random() < 0.5;
    // 间谍可能被登记为非恶魔（已作为恶魔时正常检测）
    const hasDemon = (p1.role.category === 'DEMON' || p2.role.category === 'DEMON' ||
                      p1.id === redHerring || p2.id === redHerring ||
                      p1RecluseDemon || p2RecluseDemon);
    
    let result = hasDemon;
    let isFalse = false;
    let realResult = hasDemon;
    if (player.isPoisoned) {
      const adjusted = engine.balanceSystem.adjustInfo(this, hasDemon, player, engine);
      if (adjusted !== null) {
        result = adjusted;
      } else {
        isFalse = true;
        result = !hasDemon;
      }
    }
    
    engine.setPlayerPrivateInfo(player, {
      type: 'fortuneteller',
      targets: targets.map(id => {
        const p = engine.room.players.get(id);
        return { id, name: p.name, seat: p.seat };
      }),
      result: result,
      message: result ? '你选择的玩家中有恶魔' : '你选择的玩家中没有恶魔'
    }, isFalse, isFalse ? { realResult, redHerringId: redHerring } : null);
    
    return { success: true };
  }
}

// 僧侣
class Monk extends Role {
  constructor() {
    super();
    this.name = '僧侣';
    this.id = ROLE_IDS.MONK;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.otherNightOrder = 2;
    this.selectCount = 1;
    this.abilityDesc = '每个夜晚（除了首个夜晚），选择除你以外的一名玩家：该玩家今晚不会被恶魔杀害。';
  }

  getNightWakeInfo(gameState, player, engine) {
    return {
      canSelectCount: 1,
      excludeSelf: true,
      message: '选择一名其他玩家守护（不能选自己）'
    };
  }

  onNightAction(gameState, player, action, engine) {
    if (player.isPoisoned) {
      // 中毒守护无效，但仍然显示"守护了XX"的信息给玩家
      const targetId = action.targets && action.targets[0];
      const target = targetId ? engine.room.players.get(targetId) : null;
      if (target) {
        engine.setPlayerPrivateInfo(player, {
          type: 'monk',
          message: `你守护了 ${target.seat+1}号 ${target.name}（中毒，守护无效）`
        }, true, { realMessage: '你中毒了，守护无效' });
      }
      return { success: true };
    }
    
    const targetId = action.targets && action.targets[0];
    if (!targetId || targetId === player.id) {
      return { success: false, message: '请选择除自己以外的一名玩家' };
    }
    
    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive) {
      return { success: false, message: '选择的玩家无效' };
    }
    
    gameState.nightActions.monk = { targetId };
    target.isProtected = true;
    
    engine.setPlayerPrivateInfo(player, {
      type: 'monk',
      protectedId: targetId,
      message: `你守护了 ${target.seat+1}号 ${target.name}`
    });
    
    return { success: true };
  }
}

// 守鸦人
class Ravenkeeper extends Role {
  constructor() {
    super();
    this.name = '守鸦人';
    this.id = ROLE_IDS.RAVENKEEPER;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.otherNightOrder = 4;
    this.selectCount = 1;
    this.abilityDesc = '如果你在夜晚死亡，你被唤醒并选择一名玩家：你得知他的角色。';
  }
}

// 圣女
class Virgin extends Role {
  constructor() {
    super();
    this.name = '圣女';
    this.id = ROLE_IDS.VIRGIN;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.abilityDesc = '如果你首次被提名，提名你的玩家若是村民则立即死亡。';
  }

  onNominated(gameState, player, nominator, engine) {
    if (!player.abilityState.hasBeenNominated && !player.isPoisoned) {
      player.abilityState.hasBeenNominated = true;
      if (nominator.role && nominator.role.category === 'TOWNSFOLK') {
        engine.deathManager.killPlayer(nominator.id, 'VIRGIN', gameState.nightCount, gameState.dayCount);
        return { continue: false, immediateDeath: nominator.id };
      }
    }
    return { continue: true };
  }
}

// 杀手
class Slayer extends Role {
  constructor() {
    super();
    this.name = '杀手';
    this.id = ROLE_IDS.SLAYER;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.abilityDesc = '每局游戏限一次，白天时可以公开选择一名玩家，如果是恶魔则恶魔死亡。';
  }

  onDayAbility(gameState, player, targetId, engine) {
    if (player.hasUsedDayAbility) {
      return { success: false, message: '你已经使用过杀手技能了' };
    }
    
    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive) {
      return { success: false, message: '选择的玩家无效' };
    }
    
    player.hasUsedDayAbility = true;
    
    if (!player.isPoisoned && target.role.category === 'DEMON') {
      engine.deathManager.killPlayer(targetId, 'SLAYER', gameState.nightCount, gameState.dayCount);
      engine.logAction('ABILITY', `${player.seat+1}号 ${player.name}（杀手）击杀了 ${target.seat+1}号 ${target.name}，对方是恶魔！`, {
        playerId: player.id, targetId, killed: true
      });
      return { success: true, message: `你击杀了恶魔！`, killed: true };
    }
    
    engine.logAction('ABILITY', `${player.seat+1}号 ${player.name}（杀手）对 ${target.seat+1}号 ${target.name} 使用技能，无事发生`, {
      playerId: player.id, targetId, killed: false
    });
    return { success: true, message: '无事发生', killed: false };
  }
}

// 士兵
class Soldier extends Role {
  constructor() {
    super();
    this.name = '士兵';
    this.id = ROLE_IDS.SOLDIER;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.abilityDesc = '你不会被恶魔杀害。';
  }
}

// 市长
class Mayor extends Role {
  constructor() {
    super();
    this.name = '市长';
    this.id = ROLE_IDS.MAYOR;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.abilityDesc = '如果只剩三名玩家存活且你未被处决，你的阵营获胜。如果你在夜晚死亡，可能有其他玩家替你死去。';
  }

  onDeath(gameState, player, cause, engine) {
    if (cause === 'DEMON' && !player.isPoisoned) {
      const prob = engine.balanceSystem.getMayorSaveProbability(engine.room);
      if (Math.random() < prob) {
        const others = getAlivePlayers(engine.room).filter(p => p.id !== player.id);
        if (others.length > 0) {
          const sacrifice = randomChoice(others);
          player.isAlive = true;
          player.isDead = false;
          player.deathNight = -1;
          engine.deathManager.killPlayerDirect(sacrifice.id, 'MAYOR_SAVE', gameState.nightCount, gameState.dayCount);
          engine.logAction('ABILITY', `${player.seat+1}号 ${player.name}（市长）的死亡被 ${sacrifice.seat+1}号 ${sacrifice.name} 代替`, {
            playerId: player.id, sacrificeId: sacrifice.id
          });
          return { revived: true, sacrifice: sacrifice.id };
        }
      }
    }
    return {};
  }
}

// 掘墓人
class Undertaker extends Role {
  constructor() {
    super();
    this.name = '掘墓人';
    this.id = ROLE_IDS.UNDERTAKER;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = 13;
    this.otherNightOrder = 9;
    this.abilityDesc = '每个夜晚（除了首个夜晚），你得知今天白天被处决玩家的角色。';
  }

  resolveNight(gameState, player, engine) {
    // 第一夜没有处决，不给信息
    if (gameState.nightCount === 0) return;
    
    // 找到今天被处决的玩家
    const executedEntry = (gameState.todaysDeaths || []).find(d => d.cause === 'EXECUTION');
    if (!executedEntry || !executedEntry.playerId) {
      engine.setPlayerPrivateInfo(player, {
        type: 'undertaker',
        message: '今天白天没有人被处决'
      });
      return;
    }
    
    const executed = engine.room.players.get(executedEntry.playerId);
    if (!executed) {
      engine.setPlayerPrivateInfo(player, {
        type: 'undertaker',
        message: '今天白天没有人被处决'
      });
      return;
    }
    
    let roleName = executed.role.name;
    let isFalse = false;
    let realRoleName = roleName;
    if (player.isPoisoned) {
      const adjusted = engine.balanceSystem.adjustInfo(this, { roleName }, player, engine);
      if (adjusted === null) {
        isFalse = true;
        const otherRoles = ['洗衣妇','图书管理员','调查员','厨师','共情者','占卜师','僧侣','守鸦人','圣女','杀手','士兵','市长','掘墓人','圣徒','管家','酒鬼','隐士','下毒者','红唇女郎','男爵','间谍'];
        roleName = otherRoles[Math.floor(Math.random() * otherRoles.length)];
      }
    }
    
    engine.setPlayerPrivateInfo(player, {
      type: 'undertaker',
      executedId: executed.id,
      executedSeat: executed.seat,
      executedName: executed.name,
      roleName: roleName,
      message: `今天白天被处决的 ${executed.seat+1}号 ${executed.name} 是【${roleName}】`
    }, isFalse, isFalse ? { realRoleName } : null);
  }
}

module.exports = {
  Washerwoman,
  Librarian,
  Investigator,
  Chef,
  Empath,
  Fortuneteller,
  Monk,
  Ravenkeeper,
  Virgin,
  Slayer,
  Soldier,
  Mayor,
  Undertaker
};
