// BMR 爪牙角色（黯月初升）
const Role = require('./Role');
const { BMR_ROLE_IDS } = require('../config/game-config');

// 教父
class Godfather extends Role {
  constructor() {
    super();
    this.name = '教父';
    this.id = BMR_ROLE_IDS.GODFATHER;
    this.team = 'EVIL';
    this.category = 'MINION';
    this.firstNightOrder = 1;
    this.otherNightOrder = 1;
    this.setup = true; // 影响配置：外来者+1或-1
    this.selectCount = 0; // 首夜只给信息
    this.abilityDesc = '在你的首个夜晚，你会得知有哪些外来者角色在场。如果有外来者在白天死亡，你会在当晚被唤醒并且你要选择一名玩家：他死亡。在场时人数配置会变动外来者+1或-1。';
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    // 首夜：得知在场的所有外来者角色名 + 恶魔/队友信息，不选择目标
    if (isFirstNight || gameState.nightCount === 0) {
      const players = Array.from(engine.room.players.values()).filter(p => p.seat !== -1);
      const demon = players.find(p => p.role && p.role.category === 'DEMON');
      const otherMinions = players.filter(p => p.role && p.role.category === 'MINION' && p.id !== player.id);
      const outsiders = players.filter(p => p.role && p.role.category === 'OUTSIDER');

      let teamInfo = '';
      if (demon) teamInfo += `恶魔是${demon.seat+1}号 ${demon.name}【${demon.role.name}】`;
      if (otherMinions.length > 0) teamInfo += (teamInfo ? '。' : '') + `队友：${otherMinions.map(m => `${m.seat+1}号 ${m.name}【${m.role.name}】`).join('、')}`;

      const outsiderRoleNames = [...new Set(outsiders.map(o => o.role.name))];
      const outsiderInfo = outsiders.length > 0
        ? `在场的外来者有：${outsiderRoleNames.join('、')}`
        : '本局没有外来者在场';

      return {
        canSelectCount: 0,
        message: (teamInfo ? teamInfo + '\n\n' : '') + outsiderInfo
      };
    }

    // 其他夜晚：检查是否有外来者在白天死亡
    const dayDeadOutsiders = Array.from(engine.room.players.values()).filter(
      p => p.role && p.role.category === 'OUTSIDER' && !p.isAlive && p.deathDay === gameState.dayCount
    );
    if (dayDeadOutsiders.length === 0) {
      return null; // 没有外来者在白天死亡，不唤醒
    }
    // 有外来者在白天死亡，唤醒选择目标杀人
    return {
      canSelectCount: 1,
      message: '一名外来者在白天死亡，选择一名玩家：他死亡'
    };
  }

  onNightAction(gameState, player, action, engine) {
    // 首夜只给信息，不选择目标
    if (gameState.nightCount === 0) {
      const players = Array.from(engine.room.players.values()).filter(p => p.seat !== -1);
      const demon = players.find(p => p.role && p.role.category === 'DEMON');
      const otherMinions = players.filter(p => p.role && p.role.category === 'MINION' && p.id !== player.id);
      const outsiders = players.filter(p => p.role && p.role.category === 'OUTSIDER');

      let teamInfo = '';
      if (demon) teamInfo += `恶魔是${demon.seat+1}号 ${demon.name}【${demon.role.name}】`;
      if (otherMinions.length > 0) teamInfo += (teamInfo ? '。' : '') + `队友：${otherMinions.map(m => `${m.seat+1}号 ${m.name}【${m.role.name}】`).join('、')}`;

      const outsiderRoleNames = [...new Set(outsiders.map(o => o.role.name))];
      const outsiderInfo = outsiders.length > 0
        ? `在场的外来者有：${outsiderRoleNames.join('、')}`
        : '本局没有外来者在场';

      engine.setPlayerPrivateInfo(player, {
        type: 'godfather',
        outsiders: outsiders.map(o => ({ id: o.id, seat: o.seat, name: o.name, roleName: o.role.name })),
        message: (teamInfo ? teamInfo + '\n\n' : '') + outsiderInfo
      });
      return { success: true, skipSelection: true };
    }

    // 其他夜晚：选择目标杀人
    const targetId = action.targets && action.targets[0];
    if (!targetId) {
      return { success: false, message: '请选择一名玩家' };
    }
    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive) {
      return { success: false, message: '选择的玩家无效' };
    }

    if (player.isPoisoned) {
      // 中毒时杀人无效
      engine.setPlayerPrivateInfo(player, {
        type: 'godfather',
        message: `你选择杀害 ${target.seat+1}号 ${target.name}（中毒，杀人无效）`
      }, true, { realMessage: '你中毒了，杀人无效' });
      return { success: true };
    }

    gameState.nightActions.godfather = { targetId };
    engine.setPlayerPrivateInfo(player, {
      type: 'godfather',
      targetId: targetId,
      message: `你选择杀害 ${target.seat+1}号 ${target.name}`
    });
    return { success: true };
  }
}

// 魔鬼代言人
class DevilsAdvocate extends Role {
  constructor() {
    super();
    this.name = '魔鬼代言人';
    this.id = BMR_ROLE_IDS.DEVILSADVOCATE;
    this.team = 'EVIL';
    this.category = 'MINION';
    this.firstNightOrder = -1; // 首夜不行动
    this.otherNightOrder = 2;
    this.selectCount = 1;
    this.abilityDesc = '每个夜晚，选择一名存活玩家（与上个夜晚不同）：如果该玩家明天白天被处决则不会死。';
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    if (isFirstNight || gameState.nightCount === 0) {
      return null; // 首夜不行动
    }
    const lastTargetId = player.abilityState.lastTargetId;
    let message = '选择一名存活玩家：如果该玩家明天白天被处决则不会死';
    if (lastTargetId) {
      const lastTarget = engine.room.players.get(lastTargetId);
      if (lastTarget) {
        message += `（不能选择上一夜选择的 ${lastTarget.seat+1}号 ${lastTarget.name}）`;
      }
    }
    return {
      canSelectCount: 1,
      message: message
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
    // 不能与上一夜相同
    if (targetId === player.abilityState.lastTargetId) {
      return { success: false, message: '不能选择与上个夜晚相同的玩家' };
    }

    if (player.isPoisoned) {
      // 中毒时保护无效，但仍记录为上一夜选择
      player.abilityState.lastTargetId = targetId;
      engine.setPlayerPrivateInfo(player, {
        type: 'devilsadvocate',
        message: `你保护了 ${target.seat+1}号 ${target.name}（中毒，保护无效）`
      }, true, { realMessage: '你中毒了，保护无效' });
      return { success: true };
    }

    player.abilityState.lastTargetId = targetId;
    gameState.nightActions.devilsadvocate = { targetId };
    engine.setPlayerPrivateInfo(player, {
      type: 'devilsadvocate',
      targetId: targetId,
      message: `你保护了 ${target.seat+1}号 ${target.name}，若其明天被处决则不会死`
    });
    return { success: true };
  }
}

// 刺客
class Assassin extends Role {
  constructor() {
    super();
    this.name = '刺客';
    this.id = BMR_ROLE_IDS.ASSASSIN;
    this.team = 'EVIL';
    this.category = 'MINION';
    this.firstNightOrder = -1; // 首夜不行动
    this.otherNightOrder = 3;
    this.selectCount = 1; // 一次性能力
    this.abilityDesc = '在夜晚时，选择一名玩家杀死（一次性能力），无论什么情况选择的玩家都会死亡。';
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    if (isFirstNight || gameState.nightCount === 0) {
      return null; // 首夜不行动
    }
    if (player.abilityState.used) {
      return null; // 已用过，不再唤醒
    }
    return {
      canSelectCount: 1,
      message: '选择一名玩家杀死（一次性能力，无视守护，无论什么情况都会死亡）'
    };
  }

  onNightAction(gameState, player, action, engine) {
    if (player.abilityState.used) {
      return { success: false, message: '能力已使用过' };
    }
    const targetId = action.targets && action.targets[0];
    if (!targetId) {
      return { success: false, message: '请选择一名玩家' };
    }
    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive) {
      return { success: false, message: '选择的玩家无效' };
    }

    if (player.isPoisoned) {
      // 中毒时无法使用，能力未消耗
      engine.setPlayerPrivateInfo(player, {
        type: 'assassin',
        message: `你试图刺杀 ${target.seat+1}号 ${target.name}（中毒，刺杀无效，能力未消耗）`
      }, true, { realMessage: '你中毒了，刺杀无效' });
      return { success: true };
    }

    player.abilityState.used = true;
    gameState.nightActions.assassin = { targetId };
    engine.setPlayerPrivateInfo(player, {
      type: 'assassin',
      targetId: targetId,
      message: `你刺杀了 ${target.seat+1}号 ${target.name}（无视守护，无论什么情况都会死亡）`
    });
    return { success: true };
  }
}

// 主谋
class Mastermind extends Role {
  constructor() {
    super();
    this.name = '主谋';
    this.id = BMR_ROLE_IDS.MASTERMIND;
    this.team = 'EVIL';
    this.category = 'MINION';
    this.firstNightOrder = -1; // 首夜不行动
    this.otherNightOrder = -1; // 夜晚不行动（被动角色）
    this.selectCount = 0;
    this.abilityDesc = '如果恶魔因为死于处决而因此导致游戏结束时，再额外进行一个夜晚和一个白天。在那个白天如果有玩家被处决，他的阵营落败。';
  }
}

module.exports = {
  Godfather,
  DevilsAdvocate,
  Assassin,
  Mastermind
};
