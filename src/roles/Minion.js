// 爪牙角色
const Role = require('./Role');
const { ROLE_IDS } = require('../config/game-config');

// 下毒者
class Poisoner extends Role {
  constructor() {
    super();
    this.name = '下毒者';
    this.id = ROLE_IDS.POISONER;
    this.team = 'EVIL';
    this.category = 'MINION';
    this.firstNightOrder = 1;
    this.otherNightOrder = 1;
    this.selectCount = 1;
    this.abilityDesc = '每个夜晚，选择一名玩家：该玩家今晚和明天中毒，技能异常或失效。';
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    let message = '选择一名玩家下毒';
    // 首夜唤醒时，显示恶魔和队友信息（因夜晚遮罩覆盖了私密信息区）
    if (isFirstNight || gameState.nightCount === 0) {
      const players = Array.from(engine.room.players.values()).filter(p => p.seat !== -1);
      const demon = players.find(p => p.role && p.role.category === 'DEMON');
      const otherMinions = players.filter(p => p.role && p.role.category === 'MINION' && p.id !== player.id);
      let info = '';
      if (demon) {
        info += `恶魔是${demon.seat+1}号 ${demon.name}【${demon.role.name}】`;
      }
      if (otherMinions.length > 0) {
        info += `。队友：${otherMinions.map(m => `${m.seat+1}号 ${m.name}【${m.role.name}】`).join('、')}`;
      }
      if (info) {
        message = info + '\n\n选择一名玩家下毒';
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
    if (!target) {
      return { success: false, message: '选择的玩家无效' };
    }
    
    // 清除所有人的毒，再给新目标下毒
    for (const [, p] of engine.room.players) {
      p.isPoisoned = false;
    }
    target.isPoisoned = true;
    gameState.nightActions.poisoner = { targetId };
    
    // 保留恶魔/队友信息，追加下毒结果
    const players = Array.from(engine.room.players.values()).filter(p => p.seat !== -1);
    const demon = players.find(p => p.role && p.role.category === 'DEMON');
    const otherMinions = players.filter(p => p.role && p.role.category === 'MINION' && p.id !== player.id);
    let teamInfo = '';
    if (demon) teamInfo += `恶魔是${demon.seat+1}号 ${demon.name}【${demon.role.name}】`;
    if (otherMinions.length > 0) teamInfo += (teamInfo ? '。' : '') + `队友：${otherMinions.map(m => `${m.seat+1}号 ${m.name}【${m.role.name}】`).join('、')}`;
    
    engine.setPlayerPrivateInfo(player, {
      type: 'poisoner',
      targetId: targetId,
      message: (teamInfo ? teamInfo + '\n' : '') + `你对 ${target.seat+1}号 ${target.name} 下了毒`
    });
    
    return { success: true };
  }
}

// 红唇女郎
class ScarletWoman extends Role {
  constructor() {
    super();
    this.name = '红唇女郎';
    this.id = ROLE_IDS.SCARLETWOMAN;
    this.team = 'EVIL';
    this.category = 'MINION';
    this.abilityDesc = '如果恶魔死亡时存活玩家数≥5，你成为新恶魔。';
  }
}

// 男爵
class Baron extends Role {
  constructor() {
    super();
    this.name = '男爵';
    this.id = ROLE_IDS.BARON;
    this.team = 'EVIL';
    this.category = 'MINION';
    this.setup = true; // 影响配置
    this.abilityDesc = '有两名额外的外来者在场（因此少两名村民）。';
  }
}

// 生成统一格式的「魔典」文本：恶魔/同伙单独列出，其余玩家按座位排序、每人独占一行。
// 这样在信息面板、唤醒遮罩、上帝视角里都不会挤成一整串难以分辨的字符串。
function buildGrimoireText(engine, spyPlayer) {
  const players = Array.from(engine.room.players.values())
    .filter(p => p.seat !== -1)
    .sort((a, b) => a.seat - b.seat);

  const demon = players.find(p => p.role.category === 'DEMON' && !p.role.isFakeDemon);
  // 同伙只列爪牙（恶魔已单独一行，避免重复显示）
  const teammates = players.filter(p =>
    p.id !== spyPlayer.id && p.role.category === 'MINION');

  const lines = [];
  lines.push('👹 恶魔：' + (demon
    ? `${demon.seat + 1}号 ${demon.name}【${demon.role.name}】`
    : '（不在场）'));
  lines.push('🩸 同伙：' + (teammates.length > 0
    ? teammates.map(m => `${m.seat + 1}号 ${m.name}【${m.role.name}】`).join('、')
    : '（无）'));
  lines.push('──────────────');
  lines.push(`📖 全员身份（共 ${players.length} 人）`);

  // 每行只呈现「座位号 + 名称 + 身份」，不显示存活/中毒/醉酒等状态
  players.forEach(p => {
    lines.push(`${p.seat + 1}号 ${p.name} ·【${p.role.name}】`);
  });

  return lines.join('\n');
}

// 间谍
class Spy extends Role {
  constructor() {
    super();
    this.name = '间谍';
    this.id = ROLE_IDS.SPY;
    this.team = 'EVIL';
    this.category = 'MINION';
    this.firstNightOrder = 3;
    this.otherNightOrder = 4;
    this.selectCount = 0;
    this.wakesForInfo = true; // 需要每晚唤醒查看魔典
    this.abilityDesc = '每个夜晚，你查看恶魔魔典（得知所有玩家身份）。你可能被登记为善良阵营、村民或外来者。';
    // 间谍可能被善良信息位登记为善良/村民/外来者
    this.registerAsGood = true;
    this.registerAsTownsfolk = true;
    this.registerAsOutsider = true;
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    // 间谍每晚看到所有玩家身份（魔典），无需选择目标
    return {
      canSelectCount: 0,
      selectType: 'info',
      message: '你查看了魔典：\n' + buildGrimoireText(engine, player)
    };
  }

  onNightAction(gameState, player, action, engine) {
    // 间谍不选择目标，但每晚给其完整魔典信息
    const players = Array.from(engine.room.players.values()).filter(p => p.seat !== -1);

    engine.setPlayerPrivateInfo(player, {
      type: 'spy',
      grimoire: players.map(p => ({
        id: p.id, seat: p.seat, name: p.name, role: p.role.name, team: p.role.team, isAlive: p.isAlive
      })),
      message: buildGrimoireText(engine, player)
    });

    // 间谍不需要选择目标，直接返回成功
    return { success: true, skipSelection: true };
  }
}

module.exports = {
  Poisoner,
  ScarletWoman,
  Baron,
  Spy
};
