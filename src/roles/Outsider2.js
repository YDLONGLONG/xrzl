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
    this.abilityDesc = '当你得知你死亡时，选择一名存活玩家。如果他是善良的，在当晚他会死亡。';
    this.selectCount = 0;
  }

  onFirstNight(gameState, player, engine) {
    if (!player.abilityState) player.abilityState = {};
    player.abilityState.hasUsed = false;
  }

  // 死亡时设置 pending 状态，等待玩家选择目标（类似守鸦人，由 NightResolver 唤醒处理）
  onDeath(gameState, player, cause, engine) {
    if (player.isPoisoned) return;
    if (player.abilityState && player.abilityState.hasUsed) return;
    if (!player.abilityState) player.abilityState = {};
    player.abilityState.hasUsed = true;
    if (engine.nightResolver) {
      engine.nightResolver.pendingMoonchild = player.id;
    }
  }
}

// 莽夫
class Lunatic extends Role {
  constructor() {
    super();
    this.name = '莽夫';
    this.id = BMR_ROLE_IDS.LUNATIC;
    this.team = 'GOOD';
    this.category = 'OUTSIDER';
    this.abilityDesc = '你以为自己是一个恶魔。恶魔知道你是莽夫以及你在每个夜晚选择了哪些玩家。';
    this.selectCount = 0;
    this.isFakeDemon = true;
  }

  // 首夜：通过 fakeRole 机制让莽夫以为自己是某个恶魔；同时告知真恶魔
  onFirstNight(gameState, player, engine) {
    if (!player.abilityState) player.abilityState = {};
    player.abilityState.transformedTeam = null;
    revealFakeDemon(player, engine, '莽夫');
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

  // 假装行动成功，不产生实际击杀；真恶魔得知莽夫的选择
  onNightAction(gameState, player, action, engine) {
    this.selectCount = 0;
    const targets = (action.targets || []).filter(t => t);
    const targetNames = targets.map(tid => {
      const t = engine.room.players.get(tid);
      return t ? `${t.seat+1}号${t.name}` : tid;
    }).join('、');

    engine.setPlayerPrivateInfo(player, {
      type: 'lunatic_action',
      message: targets.length ? `你选择了 ${targetNames}` : '你本次未选择目标',
      isFakeDemon: true
    }, true, { realInfo: '莽夫不是恶魔，行动无实际效果' });

    revealFakeDemonChoice(player, engine, targets, '莽夫');
    return { success: true };
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
