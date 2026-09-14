// 恶魔角色
const Role = require('./Role');
const { ROLE_IDS } = require('../config/game-config');
const { getAlivePlayers } = require('../utils/helpers');

// 小恶魔
class Imp extends Role {
  constructor() {
    super();
    this.name = '小恶魔';
    this.id = ROLE_IDS.IMP;
    this.team = 'EVIL';
    this.category = 'DEMON';
    this.firstNightOrder = 2;
    this.otherNightOrder = 3;
    this.selectCount = 1;
    this.abilityDesc = '每个夜晚（除首夜），选择一名玩家将其杀害。首夜得知爪牙和3个不在场身份。';
  }

  onFirstNight(gameState, player, engine) {
    // 恶魔信息在分配身份时已经设置
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    if (isFirstNight) {
      return null; // 第一夜只给信息，不杀人
    }
    return {
      canSelectCount: 1,
      message: '选择一名玩家杀害'
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
    
    // 中毒/醉酒时能力失效：不记录击杀（与 BMR 四个恶魔保持一致），但行动照常完成
    if (!player.isPoisoned && !player.isDrunk) {
      gameState.nightActions.imp = { targetId };
    }

    engine.setPlayerPrivateInfo(player, {
      type: 'imp',
      targetId: targetId,
      message: `你选择杀害 ${target.seat+1}号 ${target.name}`
    });

    return { success: true };
  }
}

module.exports = {
  Imp
};
