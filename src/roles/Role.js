// 角色基类
class Role {
  constructor() {
    this.name = '';           // 中文名
    this.id = '';             // 英文ID
    this.team = '';           // GOOD | EVIL
    this.category = '';       // TOWNSFOLK | OUTSIDER | MINION | DEMON
    this.firstNightOrder = -1; // 第一夜行动顺序，-1表示不行动
    this.otherNightOrder = -1; // 其他夜行动顺序
    this.abilityDesc = '';    // 技能描述
    this.setup = false;       // 是否影响配置
    this.selectCount = 0;     // 夜晚选择玩家数量
  }

  // 第一夜初始化
  onFirstNight(gameState, player, engine) {}

  // 获取夜晚唤醒信息（返回给前端的操作提示）
  getNightWakeInfo(gameState, player, engine) {
    return null;
  }

  // 处理夜晚行动
  onNightAction(gameState, player, action, engine) {
    return { success: true };
  }

  // 夜晚结算（所有行动收集完毕后调用）
  resolveNight(gameState, player, engine) {}

  // 被提名时
  onNominated(gameState, player, nominator, engine) {
    return { continue: true };
  }

  // 白天技能使用
  onDayAbility(gameState, player, targetId, engine) {
    return { success: false, message: '该角色无白天技能' };
  }

  // 死亡时
  onDeath(gameState, player, cause, engine) {}

  // 获取给该玩家的信息（考虑中毒/醉酒）
  getInfo(rawInfo, player, engine) {
    if (player.isPoisoned || player.isDrunk) {
      return engine.balanceSystem.adjustInfo(this, rawInfo, player, engine);
    }
    return rawInfo;
  }
}

module.exports = Role;
