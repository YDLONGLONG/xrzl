// 外来者角色
const Role = require('./Role');
const { ROLE_IDS } = require('../config/game-config');
const { randomChoice, shuffle } = require('../utils/helpers');

// 圣徒
class Saint extends Role {
  constructor() {
    super();
    this.name = '圣徒';
    this.id = ROLE_IDS.SAINT;
    this.team = 'GOOD';
    this.category = 'OUTSIDER';
    this.abilityDesc = '如果你被处决，邪恶阵营获胜。';
  }
}

// 管家
class Butler extends Role {
  constructor() {
    super();
    this.name = '管家';
    this.id = ROLE_IDS.BUTLER;
    this.team = 'GOOD';
    this.category = 'OUTSIDER';
    this.firstNightOrder = 2;
    this.otherNightOrder = 3;
    this.selectCount = 1;
    this.abilityDesc = '每个夜晚，选择一名玩家（不是自己）：明天你只能在该玩家投票时投票。';
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    return {
      canSelectCount: 1,
      excludeSelf: true,
      message: '选择一名玩家作为你的主人（不能选自己），明天只能在主人投票时投票'
    };
  }

  onNightAction(gameState, player, action, engine) {
    const targetId = action.targets && action.targets[0];
    if (!targetId || targetId === player.id) {
      return { success: false, message: '请选择除自己以外的一名玩家' };
    }
    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive) {
      return { success: false, message: '选择的玩家无效' };
    }

    // 清除上一晚的主人
    if (player.abilityState.masterId) {
      const oldMaster = engine.room.players.get(player.abilityState.masterId);
      if (oldMaster) oldMaster.isMasterOf = null;
    }

    player.abilityState.masterId = targetId;
    player.abilityState.masterVoted = false;
    target.isMasterOf = player.id;

    engine.setPlayerPrivateInfo(player, {
      type: 'butler',
      masterId: targetId,
      message: `你选择了 ${target.seat+1}号 ${target.name} 作为主人，明天只能在TA投票时投票`
    });

    return { success: true };
  }
}

// 酒鬼
class Drunk extends Role {
  constructor() {
    super();
    this.name = '酒鬼';
    this.id = ROLE_IDS.DRUNK;
    this.team = 'GOOD';
    this.category = 'OUTSIDER';
    this.abilityDesc = '你不知道自己是酒鬼。你以为自己是一个村民角色，但实际上你没有技能。';
    // 酒鬼以为自己是某个村民，在分配时会设置 drunkRole/fakeRole 属性
    this.drunkRole = null;
    this.fakeRole = null;
    this.selectCount = 0;
  }

  // 酒鬼在夜晚被唤醒时，假装自己是假角色（需要玩家操作，但不产生实际效果）
  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    if (!player.fakeRole) return null;
    const fake = player.fakeRole;
    // 僧侣第一夜不行动
    if (isFirstNight && fake.id === 'monk') return null;
    // 掘墓人第一夜无信息
    if (isFirstNight && fake.id === 'undertaker') return null;
    // 无选择操作的角色（信息位）不需要唤醒，通过resolveNight给假信息
    if (!fake.selectCount || fake.selectCount === 0) return null;
    
    // 假装有假角色的selectCount
    this.selectCount = fake.selectCount || 0;
    
    if (fake.getNightWakeInfo) {
      return fake.getNightWakeInfo(gameState, player, engine, isFirstNight);
    }
    return { canSelectCount: this.selectCount, message: '请行动' };
  }

  onNightAction(gameState, player, action, engine) {
    if (!player.fakeRole) return { success: true };
    const fake = player.fakeRole;
    this.selectCount = 0; // reset
    
    // 假装行动成功，但不产生实际效果
    const targets = action.targets || [];
    const targetNames = targets.map(tid => {
      const t = engine.room.players.get(tid);
      return t ? `${t.seat+1}号${t.name}` : tid;
    }).join('、');
    
    // 给酒鬼一个无意义的确认信息
    let fakeMsg = '你执行了行动';
    if (fake.id === 'fortuneteller' && targets.length === 2) {
      // 假信息方向由平衡系统决定：好人弱势→"有恶魔"（帮好人调查），邪恶弱势→"没有恶魔"（误导好人）
      const helpGood = engine.balanceSystem.favorWeakSide(engine);
      fakeMsg = helpGood ? '你选择的玩家中有恶魔' : '你选择的玩家中没有恶魔';
    } else if (fake.id === 'monk' && targets.length === 1) {
      fakeMsg = `你守护了 ${targetNames || '某玩家'}`;
    } else {
      fakeMsg = `你选择了 ${targetNames || '无目标'}`;
    }
    
    engine.setPlayerPrivateInfo(player, {
      type: 'drunk_action',
      message: fakeMsg,
      isDrunk: true
    }, true, { realInfo: '酒鬼无技能' });
    
    return { success: true };
  }

  // 酒鬼的resolveNight：如果假角色是信息位，给随机假信息
  resolveNight(gameState, player, engine) {
    if (!player.fakeRole) return;
    const fake = player.fakeRole;
    const isFirstNight = gameState.nightCount === 0;
    
    // 如果假角色有resolveNight且不是操作类角色，生成假信息
    if (fake.selectCount === 0) {
      const players = Array.from(engine.room.players.values()).filter(p => p.seat !== -1);
      const alive = players.filter(p => p.isAlive && p.id !== player.id);
      
      if (fake.id === 'chef') {
        const fakeCount = Math.floor(Math.random() * 3);
        engine.setPlayerPrivateInfo(player, {
          type: 'chef',
          count: fakeCount,
          message: `邪恶玩家相邻的对数是：${fakeCount}`,
          isDrunk: true
        }, true, { realInfo: '酒鬼无技能' });
      } else if (fake.id === 'empath') {
        const fakeCount = Math.floor(Math.random() * 3);
        engine.setPlayerPrivateInfo(player, {
          type: 'empath',
          count: fakeCount,
          message: `你的存活邻居中有 ${fakeCount} 名邪恶玩家`,
          isDrunk: true
        }, true, { realInfo: '酒鬼无技能' });
      } else if (fake.id === 'washerwoman' && isFirstNight) {
        if (alive.length >= 2) {
          const shuffled = shuffle(alive);
          const p1 = shuffled[0], p2 = shuffled[1];
          const townsRoles = ['洗衣妇','图书管理员','调查员','厨师','共情者','占卜师','僧侣','守鸦人','圣女','杀手','士兵','市长','掘墓人'];
          const fakeRole = townsRoles[Math.floor(Math.random()*townsRoles.length)];
          engine.setPlayerPrivateInfo(player, {
            type: 'washerwoman',
            message: `${p1.seat+1}号(${p1.name})和${p2.seat+1}号(${p2.name})中，有一位是【${fakeRole}】`,
            isDrunk: true
          }, true, { realInfo: '酒鬼无技能' });
        }
      } else if (fake.id === 'librarian' && isFirstNight) {
        if (alive.length >= 2) {
          const shuffled = shuffle(alive);
          const p1 = shuffled[0], p2 = shuffled[1];
          const outRoles = ['圣徒','管家','酒鬼','隐士'];
          const fakeRole = outRoles[Math.floor(Math.random()*outRoles.length)];
          engine.setPlayerPrivateInfo(player, {
            type: 'librarian',
            message: `${p1.seat+1}号(${p1.name})和${p2.seat+1}号(${p2.name})中，有一位是【${fakeRole}】`,
            isDrunk: true
          }, true, { realInfo: '酒鬼无技能' });
        }
      } else if (fake.id === 'investigator' && isFirstNight) {
        if (alive.length >= 2) {
          const shuffled = shuffle(alive);
          const p1 = shuffled[0], p2 = shuffled[1];
          const minRoles = ['下毒者','红唇女郎','男爵','间谍'];
          const fakeRole = minRoles[Math.floor(Math.random()*minRoles.length)];
          engine.setPlayerPrivateInfo(player, {
            type: 'investigator',
            message: `${p1.seat+1}号(${p1.name})和${p2.seat+1}号(${p2.name})中，有一位是【${fakeRole}】`,
            isDrunk: true
          }, true, { realInfo: '酒鬼无技能' });
        }
      } else if (fake.id === 'undertaker' && !isFirstNight) {
        const executed = (gameState.todaysDeaths || []).find(d => d.cause === 'EXECUTION');
        if (executed) {
          const allRoles = ['洗衣妇','图书管理员','调查员','厨师','共情者','占卜师','僧侣','守鸦人','圣女','杀手','士兵','市长','掘墓人','圣徒','管家','酒鬼','隐士','下毒者','红唇女郎','男爵','间谍','小恶魔'];
          const fakeRole = allRoles[Math.floor(Math.random()*allRoles.length)];
          const ep = engine.room.players.get(executed.playerId);
          if (ep) {
            engine.setPlayerPrivateInfo(player, {
              type: 'undertaker',
              message: `今天白天被处决的 ${ep.seat+1}号 ${ep.name} 是【${fakeRole}】`,
              isDrunk: true
            }, true, { realInfo: '酒鬼无技能' });
          }
        } else {
          engine.setPlayerPrivateInfo(player, {
            type: 'undertaker',
            message: '今天白天没有人被处决',
            isDrunk: true
          });
        }
      }
    }
  }
}

// 隐士
class Recluse extends Role {
  constructor() {
    super();
    this.name = '隐士';
    this.id = ROLE_IDS.RECLUSE;
    this.team = 'GOOD';
    this.category = 'OUTSIDER';
    this.abilityDesc = '你可能被登记为邪恶阵营、爪牙或恶魔。你可能在夜晚死亡，即使没人想杀你。';
    this.selectCount = 0;
    // 对于信息位角色，隐士可能被登记为邪恶/恶魔
    this.registerAsEvil = true;
    this.registerAsMinion = true;
    this.registerAsDemon = true;
  }
}

module.exports = {
  Saint,
  Butler,
  Drunk,
  Recluse
};
