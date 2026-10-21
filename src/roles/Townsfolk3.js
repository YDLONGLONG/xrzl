// SNV 剧本（紫罗兰教派）村民角色
const Role = require('./Role');
const { SNV_ROLE_IDS } = require('../config/game-config');
const { applyDrunk, clearDrunkSource, getPlayerEffectiveTeam } = require('../utils/helpers');
const {
  isImpaired, isDayPhase, isVortoxActive, scriptRoleInfos, pickWrongNumber, pickRandom, seatDistance
} = require('./SnvUtils');

function seatedPlayers(engine) {
  return Array.from(engine.room.players.values()).filter(p => p.seat !== -1);
}

// 统一的数字类信息交付：中毒/醉酒按平衡系统决定真假，混沌在场时好人信息必须为假
function deliverNumber(engine, role, player, correct, min, max) {
  let value = correct;
  let isFalse = false;
  let probInfo = null;
  if (isImpaired(player)) {
    const adj = engine.balanceSystem.adjustInfo(role, correct, player, engine, `${role.name}中毒正确信息`);
    probInfo = adj.probInfo;
    if (adj.info === null) {
      isFalse = true;
      value = pickWrongNumber(correct, min, max);
    }
  }
  if (!isFalse && isVortoxActive(engine)) {
    isFalse = true;
    value = pickWrongNumber(correct, min, max);
  }
  return { value, isFalse, probInfo };
}

// ==================== 1. 钟表匠 ====================
class Clockmaker extends Role {
  constructor() {
    super();
    this.name = '钟表匠';
    this.id = SNV_ROLE_IDS.CLOCKMAKER;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = 8;
    this.otherNightOrder = -1;
    this.selectCount = 0;
    this.abilityDesc = '在你的首个夜晚，你得知恶魔与最近的爪牙之间隔了几名玩家。';
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    if (!isFirstNight) return null;
    return { canSelectCount: 0, message: '你得知恶魔与最近的爪牙之间隔了几名玩家' };
  }

  onNightAction(gameState, player, action, engine) {
    if (gameState.nightCount !== 0) return { success: true };
    const players = seatedPlayers(engine);
    const demon = players.find(p => p.role && p.role.category === 'DEMON');
    const minions = players.filter(p => p.role && p.role.category === 'MINION');

    if (!demon || minions.length === 0) {
      engine.setPlayerPrivateInfo(player, {
        type: 'clockmaker',
        message: '场上没有爪牙，你无法得知距离'
      });
      return { success: true };
    }

    const total = players.length;
    const correct = Math.min(...minions.map(m =>
      Math.max(0, seatDistance(total, demon.seat, m.seat) - 1)
    ));
    const { value, isFalse, probInfo } = deliverNumber(engine, this, player, correct, 0, Math.max(0, total - 2));

    engine.setPlayerPrivateInfo(player, {
      type: 'clockmaker',
      distance: value,
      message: `恶魔与最近的爪牙之间隔了 ${value} 名玩家`
    }, isFalse, isFalse ? { realDistance: correct, probInfo } : (probInfo ? { probInfo } : null));

    return { success: true };
  }
}

// ==================== 2. 入梦人 ====================
class Dreamer extends Role {
  constructor() {
    super();
    this.name = '入梦人';
    this.id = SNV_ROLE_IDS.DREAMER;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = 6;
    this.otherNightOrder = 10;
    this.selectCount = 1;
    this.abilityDesc = '每个夜晚，选择除你以外的一名玩家：你得知一个善良角色和一个邪恶角色，其中一个是该玩家的角色。';
  }

  getNightWakeInfo(gameState, player, engine) {
    return {
      canSelectCount: 1,
      excludeSelf: true,
      message: '选择一名玩家：你得知一善一恶两个角色，其中一个是他的角色'
    };
  }

  onNightAction(gameState, player, action, engine) {
    const targetId = action.targets && action.targets[0];
    if (!targetId) return { success: false, message: '请选择一名玩家' };
    if (targetId === player.id) return { success: false, message: '不能选择自己' };
    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive || !target.role) {
      return { success: false, message: '选择的玩家无效' };
    }

    const roles = scriptRoleInfos(engine);
    const actual = target.role;
    const oppositeRoles = roles.filter(r => r.id !== actual.id && r.team !== actual.team);
    const other = pickRandom(oppositeRoles);

    const pair = [actual.name, other ? other.name : '未知'];
    let isFalse = false;
    let realPair = null;
    let probInfo = null;

    const falsify = () => {
      // 两个都不是目标的真实角色（先取一善一恶的随机组合）
      const goodPool = roles.filter(r => r.team === 'GOOD' && r.id !== actual.id);
      const evilPool = roles.filter(r => r.team === 'EVIL' && r.id !== actual.id);
      const g = pickRandom(goodPool);
      const e = pickRandom(evilPool);
      return [g ? g.name : '未知', e ? e.name : '未知'];
    };

    if (isImpaired(player)) {
      const adj = engine.balanceSystem.adjustInfo(this, pair, player, engine, '入梦人中毒正确信息');
      probInfo = adj.probInfo;
      if (adj.info === null) {
        isFalse = true;
        realPair = [...pair];
        pair.splice(0, pair.length, ...falsify());
      }
    }
    if (!isFalse && isVortoxActive(engine)) {
      isFalse = true;
      realPair = [...pair];
      pair.splice(0, pair.length, ...falsify());
    }

    const shuffled = Math.random() < 0.5 ? pair : [pair[1], pair[0]];
    engine.setPlayerPrivateInfo(player, {
      type: 'dreamer',
      targetId,
      roles: shuffled,
      message: `梦境中你看到 ${target.seat + 1}号 ${target.name} 是【${shuffled[0]}】或【${shuffled[1]}】，其中一个是他的真实角色`
    }, isFalse, isFalse ? { realRoles: realPair, probInfo } : (probInfo ? { probInfo } : null));

    return { success: true };
  }
}

// ==================== 3. 舞蛇人 ====================
class SnakeCharmer extends Role {
  constructor() {
    super();
    this.name = '舞蛇人';
    this.id = SNV_ROLE_IDS.SNAKECHARMER;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = 2;
    this.otherNightOrder = 2;
    this.selectCount = 1;
    this.abilityDesc = '每个夜晚，选择一名存活玩家：如果你选中了恶魔，他变成中毒的舞蛇人，你变成恶魔。';
  }

  getNightWakeInfo(gameState, player, engine) {
    return {
      canSelectCount: 1,
      excludeSelf: true,
      message: '选择一名玩家（若选中恶魔，你们互换身份）'
    };
  }

  onNightAction(gameState, player, action, engine) {
    const targetId = action.targets && action.targets[0];
    if (!targetId) return { success: false, message: '请选择一名玩家' };
    if (targetId === player.id) return { success: false, message: '不能选择自己' };
    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive || !target.role) {
      return { success: false, message: '选择的玩家无效' };
    }

    const isDemon = target.role.category === 'DEMON';
    gameState.nightActions.snakecharmer = { targetId, swapped: false };

    if (!isDemon || isImpaired(player)) {
      engine.setPlayerPrivateInfo(player, {
        type: 'snakecharmer',
        targetId,
        message: `你选择了 ${target.seat + 1}号 ${target.name}，无事发生`
      });
      return { success: true };
    }

    // 身份互换：自己变成恶魔，目标变成中毒的舞蛇人
    const demonRoleId = target.role.id;
    const demonRoleName = target.role.name;
    const newDemonRole = engine.roleAllocator.createRoleInstance(demonRoleId);
    const newSnakeRole = engine.roleAllocator.createRoleInstance(SNV_ROLE_IDS.SNAKECHARMER);
    if (!newDemonRole || !newSnakeRole) return { success: true };

    player.role = newDemonRole;
    target.role = newSnakeRole;
    target.isPoisoned = true;
    target.snvPoisonSource = 'snakecharmer';
    target.abilityState = target.abilityState || {};

    gameState.nightActions.snakecharmer = { targetId, swapped: true, newDemonId: player.id, oldDemonId: target.id };

    const minions = seatedPlayers(engine).filter(p => p.role && p.role.category === 'MINION');
    engine.setPlayerPrivateInfo(player, {
      type: 'snakecharmer_swap',
      demon: true,
      message: `你选中了恶魔！你现在是【${demonRoleName}】。你的爪牙是：${minions.map(m => `${m.seat + 1}号(${m.name})【${m.role.name}】`).join('、') || '无'}`
    });
    engine.setPlayerPrivateInfo(target, {
      type: 'snakecharmer_swapped',
      message: `舞蛇人选中了你！你变成了中毒的【舞蛇人】，不再拥有恶魔能力。`
    });
    engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（舞蛇人）选中恶魔 ${target.seat + 1}号 ${target.name}，双方身份互换`, {
      playerId: player.id, targetId: target.id, demonRoleId
    });

    // 新恶魔在本次夜晚的恶魔唤醒顺位立即行动（原恶魔的队列项会因角色变化被跳过）
    if (Array.isArray(gameState.nightQueue)) {
      gameState.nightQueue.splice(gameState.currentNightIndex + 1, 0, {
        roleId: demonRoleId,
        playerId: player.id,
        swappedDemon: true
      });
    }

    return { success: true };
  }
}

// ==================== 4. 数学家 ====================
class Mathematician extends Role {
  constructor() {
    super();
    this.name = '数学家';
    this.id = SNV_ROLE_IDS.MATHEMATICIAN;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = 9;
    this.otherNightOrder = 16;
    this.selectCount = 0;
    this.abilityDesc = '每个夜晚，你得知自拂晓起有多少名玩家的技能因其他角色的技能而未正常生效。';
  }

  getNightWakeInfo() {
    return { canSelectCount: 0, message: '你得知自拂晓起有多少名玩家的技能未正常生效' };
  }

  onNightAction(gameState, player, action, engine) {
    const abnormal = seatedPlayers(engine)
      .filter(p => p.isAlive && p.role && isImpaired(p)).length;
    const { value, isFalse, probInfo } = deliverNumber(engine, this, player, abnormal, 0, Math.max(0, seatedPlayers(engine).length));

    engine.setPlayerPrivateInfo(player, {
      type: 'mathematician',
      count: value,
      message: `自拂晓起有 ${value} 名玩家的技能未能正常生效（中毒/醉酒）`
    }, isFalse, isFalse ? { realCount: abnormal, probInfo } : (probInfo ? { probInfo } : null));

    return { success: true };
  }
}

// ==================== 5. 花艺师 ====================
class Flowergirl extends Role {
  constructor() {
    super();
    this.name = '花艺师';
    this.id = SNV_ROLE_IDS.FLOWERGIRL;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = -1;
    this.otherNightOrder = 13;
    this.selectCount = 0;
    this.abilityDesc = '每个夜晚（首夜除外），你得知恶魔在今天是否投过票。';
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    if (isFirstNight) return null;
    return { canSelectCount: 0, message: '你得知恶魔今天是否投过票' };
  }

  onNightAction(gameState, player, action, engine) {
    if (gameState.nightCount === 0) return { success: true };
    const demon = seatedPlayers(engine).find(p => p.role && p.role.category === 'DEMON' && !p.role.isFakeDemon);
    const noms = gameState.lastDayNominations || [];
    const voted = !!(demon && noms.some(n =>
      n.currentVotes && n.currentVotes[demon.id] === true
    ));

    let value = voted;
    let isFalse = false;
    let probInfo = null;
    if (isImpaired(player)) {
      const adj = engine.balanceSystem.adjustInfo(this, voted, player, engine, '花艺师中毒正确信息');
      probInfo = adj.probInfo;
      if (adj.info === null) { isFalse = true; value = !voted; }
    }
    if (!isFalse && isVortoxActive(engine)) { isFalse = true; value = !voted; }

    engine.setPlayerPrivateInfo(player, {
      type: 'flowergirl',
      voted: value,
      message: value ? '恶魔今天投过票' : '恶魔今天没有投票'
    }, isFalse, isFalse ? { realVoted: voted, probInfo } : (probInfo ? { probInfo } : null));

    return { success: true };
  }
}

// ==================== 6. 公告员 ====================
class TownCrier extends Role {
  constructor() {
    super();
    this.name = '公告员';
    this.id = SNV_ROLE_IDS.TOWNCRIER;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = -1;
    this.otherNightOrder = 14;
    this.selectCount = 0;
    this.abilityDesc = '每个夜晚（首夜除外），你得知今天是否有爪牙发起过提名。';
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    if (isFirstNight) return null;
    return { canSelectCount: 0, message: '你得知今天是否有爪牙发起过提名' };
  }

  onNightAction(gameState, player, action, engine) {
    if (gameState.nightCount === 0) return { success: true };
    const noms = gameState.lastDayNominations || [];
    const nominated = noms.some(n => {
      const p = engine.room.players.get(n.nominatorId);
      return p && p.role && p.role.category === 'MINION';
    });

    let value = nominated;
    let isFalse = false;
    let probInfo = null;
    if (isImpaired(player)) {
      const adj = engine.balanceSystem.adjustInfo(this, nominated, player, engine, '公告员中毒正确信息');
      probInfo = adj.probInfo;
      if (adj.info === null) { isFalse = true; value = !nominated; }
    }
    if (!isFalse && isVortoxActive(engine)) { isFalse = true; value = !nominated; }

    engine.setPlayerPrivateInfo(player, {
      type: 'towncrier',
      nominated: value,
      message: value ? '今天有爪牙发起过提名' : '今天没有爪牙发起提名'
    }, isFalse, isFalse ? { realNominated: nominated, probInfo } : (probInfo ? { probInfo } : null));

    return { success: true };
  }
}

// ==================== 7. 神谕者 ====================
class Oracle extends Role {
  constructor() {
    super();
    this.name = '神谕者';
    this.id = SNV_ROLE_IDS.ORACLE;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = -1;
    this.otherNightOrder = 15;
    this.selectCount = 0;
    this.abilityDesc = '每个夜晚（首夜除外），你得知死亡玩家中有多少名是邪恶阵营。';
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    if (isFirstNight) return null;
    return { canSelectCount: 0, message: '你得知死亡玩家中有多少名邪恶阵营' };
  }

  onNightAction(gameState, player, action, engine) {
    if (gameState.nightCount === 0) return { success: true };
    const dead = seatedPlayers(engine).filter(p => p.isDead && p.role);
    const correct = dead.filter(p => getPlayerEffectiveTeam(p) === 'EVIL').length;
    const { value, isFalse, probInfo } = deliverNumber(engine, this, player, correct, 0, dead.length);

    engine.setPlayerPrivateInfo(player, {
      type: 'oracle',
      count: value,
      message: `死亡玩家中有 ${value} 名邪恶阵营`
    }, isFalse, isFalse ? { realCount: correct, probInfo } : (probInfo ? { probInfo } : null));

    return { success: true };
  }
}

// ==================== 8. 学者 ====================
// 白天向说书人（AI 裁判）私下提问两个是非题，其中恰好一个是真话、一个是假话。
class Savant extends Role {
  constructor() {
    super();
    this.name = '学者';
    this.id = SNV_ROLE_IDS.SAVANT;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = -1;
    this.otherNightOrder = -1;
    this.selectCount = 0;
    this.abilityDesc = '每个白天，你可以私下向说书人问两个是非题，你会得到一个真话和一个假话。';
  }

  onDayAbility(gameState, player, payload, engine) {
    if (!isDayPhase(gameState)) {
      return { success: false, message: '只能在白天提问' };
    }
    if (player.abilityState.savantDay === gameState.dayCount) {
      return { success: false, message: '你今天已经问过问题了' };
    }
    // 正在等待说书人回答时不允许重复提交
    if (Array.isArray(player.abilityState.savantPending) && player.abilityState.savantPending.length === 2) {
      return { success: false, message: '正在等待说书人回答，请稍候' };
    }
    const questions = Array.isArray(payload) ? payload : (payload && payload.questions);
    if (!Array.isArray(questions) || questions.length !== 2) {
      return { success: false, message: '请提出两个问题' };
    }
    const cleaned = questions.map(q => String(q || '').trim());
    for (const q of cleaned) {
      if (q.length < 2) return { success: false, message: '问题内容过短' };
      if (q.length > 120) return { success: false, message: '问题不能超过120字' };
    }

    // 注意：这里不占用当日次数，等 AI 回答成功（applyAnswers）后再计次，
    // 否则裁判服务失败时会被误判为「今日已提问」
    player.abilityState.savantPending = cleaned;
    return { success: true, questions: cleaned };
  }

  // AI 裁判给出两个答案后调用：随机把其中一个答案反转，保证「一真一假」
  applyAnswers(gameState, player, answers, engine) {
    const questions = player.abilityState.savantPending || [];
    player.abilityState.savantPending = null;
    if (questions.length !== 2 || !Array.isArray(answers) || answers.length !== 2) return;

    // 成功拿到答案才占用当日次数（前端据此禁用按钮）
    player.abilityState.savantDay = gameState.dayCount;
    // 成功后清掉失败重试用的回填内容，避免之后还带出旧问题
    player.abilityState.savantLastAttempt = null;
    player.abilityState.savantLastAttemptDay = null;

    const normalized = answers.map(a => a === true || a === 'true');
    const vortox = isVortoxActive(engine);
    let finalAnswers;
    let falseIndex = null;
    if (vortox) {
      // 混沌：好人信息必须为假 → 两个答案都反转
      finalAnswers = normalized.map(a => !a);
    } else {
      const invertIndex = Math.random() < 0.5 ? 0 : 1;
      finalAnswers = normalized.map((a, i) => (i === invertIndex ? !a : a));
      falseIndex = invertIndex;
    }
    // 哪一问是假话：混沌在场时两问都是假话
    const isFalseAt = (i) => (vortox ? true : i === falseIndex);

    const lines = questions.map((q, i) => `问：${q}\n答：${finalAnswers[i] ? '是' : '否'}`).join('\n');
    engine.setPlayerPrivateInfo(player, {
      type: 'savant',
      day: gameState.dayCount,
      questions,
      answers: finalAnswers,
      // 玩家自己不知道哪句是真/假，故 message 里不做标注
      message: `你向说书人提出两个问题（其中一个是真话，一个是假话）：\n${lines}`
    });

    // 上帝视角/历史记录专用：记录哪一问是真、哪一问是假（不随玩家状态下发）
    player.savantLog = player.savantLog || [];
    player.savantLog.push({
      day: gameState.dayCount,
      questions,
      answers: finalAnswers,
      falseIndex,
      vortox
    });

    const detailText = questions.map((q, i) =>
      `${i === 0 ? '①' : '②'} ${q} → ${finalAnswers[i] ? '是' : '否'}（${isFalseAt(i) ? '假话' : '真话'}）`
    ).join('；');
    engine.logAction('ABILITY',
      `${player.seat + 1}号 ${player.name}（学者）私下提问两个是非题：${detailText}${vortox ? '【混沌在场：两问均为假话】' : ''}`, {
        playerId: player.id, questions, answers: finalAnswers, falseIndex, vortox
      });
  }

  // 裁判 AI 失败：回滚当日次数，并记住这次的问题，当天重试时自动回填
  cancelDayAbility(gameState, player) {
    const pending = player.abilityState.savantPending;
    if (Array.isArray(pending) && pending.length === 2) {
      player.abilityState.savantLastAttempt = pending.slice();
      player.abilityState.savantLastAttemptDay = gameState.dayCount;
    }
    player.abilityState.savantDay = null;
    player.abilityState.savantPending = null;
  }
}

// ==================== 9. 裁缝 ====================
class Seamstress extends Role {
  constructor() {
    super();
    this.name = '裁缝';
    this.id = SNV_ROLE_IDS.SEAMSTRESS;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = 9;
    this.otherNightOrder = 11;
    this.selectCount = 2;
    this.abilityDesc = '每局游戏限一次，在夜晚时选择除你以外的两名玩家（可以是死亡玩家）：你得知他们是否属于同一阵营。';
  }

  getNightWakeInfo(gameState, player, engine) {
    if (player.abilityState.used) return null;
    return {
      canSelectCount: 2,
      excludeSelf: true,
      // 官方：可以选死亡玩家
      selectDead: true,
      message: '选择两名其他玩家（可选死亡玩家）：你得知他们是否属于同一阵营（每局限一次）'
    };
  }

  onNightAction(gameState, player, action, engine) {
    if (player.abilityState.used) return { success: true };
    const targets = action.targets || [];
    if (targets.length !== 2) return { success: false, message: '请选择两名玩家' };
    if (targets[0] === targets[1]) return { success: false, message: '请选择两名不同的玩家' };
    for (const tid of targets) {
      if (tid === player.id) return { success: false, message: '不能选择自己' };
      const t = engine.room.players.get(tid);
      if (!t || !t.role) return { success: false, message: '选择的玩家无效' };
    }

    player.abilityState.used = true;
    const [a, b] = targets.map(tid => engine.room.players.get(tid));
    const correct = getPlayerEffectiveTeam(a) === getPlayerEffectiveTeam(b);

    let value = correct;
    let isFalse = false;
    let probInfo = null;
    if (isImpaired(player)) {
      const adj = engine.balanceSystem.adjustInfo(this, correct, player, engine, '裁缝中毒正确信息');
      probInfo = adj.probInfo;
      if (adj.info === null) { isFalse = true; value = !correct; }
    }
    if (!isFalse && isVortoxActive(engine)) { isFalse = true; value = !correct; }

    engine.setPlayerPrivateInfo(player, {
      type: 'seamstress',
      targets,
      sameTeam: value,
      message: `${a.seat + 1}号 ${a.name} 和 ${b.seat + 1}号 ${b.name} ${value ? '属于同一阵营' : '不属于同一阵营'}`
    }, isFalse, isFalse ? { realSameTeam: correct, probInfo } : (probInfo ? { probInfo } : null));

    return { success: true };
  }
}

// ==================== 10. 哲学家 ====================
class Philosopher extends Role {
  constructor() {
    super();
    this.name = '哲学家';
    this.id = SNV_ROLE_IDS.PHILOSOPHER;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = 2;
    this.otherNightOrder = 2;
    this.selectCount = 1;
    this.selectType = 'role';
    this.canSkip = true;
    this.abilityDesc = '每局游戏限一次，在夜晚时选择一个善良角色：你获得该角色的能力。如果该角色在场，该玩家醉酒直到你死亡。';
  }

  getNightWakeInfo(gameState, player, engine, isFirstNight) {
    const gainedId = player.abilityState && player.abilityState.philosopherRoleId;
    if (player.abilityState && player.abilityState.philosopherUsed && gainedId) {
      const inst = engine.roleAllocator.createRoleInstance(gainedId);
      if (!inst) return null;
      const info = typeof inst.getNightWakeInfo === 'function'
        ? inst.getNightWakeInfo(gameState, player, engine, isFirstNight)
        : null;
      this.selectCount = inst.selectCount || 0;
      this.selectType = inst.selectType || 'player';
      this.canSkip = inst.canSkip === true;
      return info;
    }
    return {
      selectType: 'role',
      canSelectCount: 1,
      canSkip: true,
      // 官方：只能选择善良角色
      selectRoles: scriptRoleInfos(engine, r => r.id !== SNV_ROLE_IDS.PHILOSOPHER && r.team === 'GOOD'),
      message: '选择一个善良角色获得其能力（每局限一次）。若该角色在场，该玩家会醉酒直到你死亡。也可以选择不使用。'
    };
  }

  // 哲学家死亡：被他「复制」的在场的角色恢复清醒
  onDeath(gameState, player, cause, engine) {
    const drunkId = player.abilityState && player.abilityState.philosopherDrunkId;
    if (!drunkId) return {};
    const holder = engine.room.players.get(drunkId);
    if (holder) {
      clearDrunkSource(holder, 'philosopher');
      engine.setPlayerPrivateInfo(holder, {
        type: 'philosopher_end',
        message: '哲学家已死亡，你不再因其能力而醉酒'
      });
    }
    engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（哲学家）死亡，${holder ? `${holder.seat + 1}号 ${holder.name}` : '目标'} 恢复清醒`, {
      playerId: player.id, drunkPlayerId: drunkId
    });
    return {};
  }

  onNightAction(gameState, player, action, engine) {
    if (player.abilityState && player.abilityState.philosopherUsed) {
      const gainedId = player.abilityState.philosopherRoleId;
      const inst = gainedId ? engine.roleAllocator.createRoleInstance(gainedId) : null;
      if (inst && typeof inst.onNightAction === 'function') {
        return inst.onNightAction(gameState, player, action, engine) || { success: true };
      }
      return { success: true };
    }

    if (action.skip) {
      engine.setPlayerPrivateInfo(player, {
        type: 'philosopher',
        message: '你选择今晚不使用哲学家能力'
      });
      return { success: true };
    }

    const roleId = action.roleId;
    if (!roleId) return { success: false, message: '请选择一个角色或跳过' };
    if (roleId === SNV_ROLE_IDS.PHILOSOPHER) {
      return { success: false, message: '不能选择哲学家自己' };
    }
    const inst = engine.roleAllocator.createRoleInstance(roleId);
    if (!inst) return { success: false, message: '角色不存在' };
    if (inst.team !== 'GOOD') {
      return { success: false, message: '只能选择善良角色' };
    }

    player.abilityState.philosopherUsed = true;
    player.abilityState.philosopherRoleId = roleId;

    // 该角色是否在场：在场则持有者醉酒（直到哲学家死亡）
    const holder = seatedPlayers(engine).find(p =>
      p.id !== player.id && p.role && p.role.id === roleId
    );

    if (holder) {
      applyDrunk(holder, 'philosopher', 999);
      player.abilityState.philosopherDrunkId = holder.id;
    }

    // 官方规则：哲学家不会被告知所选角色是否在场，玩家侧信息与结果无关
    engine.setPlayerPrivateInfo(player, {
      type: 'philosopher',
      roleId,
      roleName: inst.name,
      message: `你选择了【${inst.name}】，你获得了该能力。`
    });

    // 「是否在场 / 谁被醉酒」只写入上帝视角日志
    if (holder) {
      engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（哲学家）选择【${inst.name}】，持有者 ${holder.seat + 1}号 ${holder.name} 醉酒`, {
        playerId: player.id, roleId, drunkPlayerId: holder.id
      });
    } else {
      engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（哲学家）选择【${inst.name}】（不在场），获得该能力`, {
        playerId: player.id, roleId
      });
    }

    // 同步本夜后续的行动面板参数
    this.selectCount = inst.selectCount || 0;
    this.selectType = inst.selectType || 'player';
    this.canSkip = inst.canSkip === true;

    return { success: true };
  }
}

// ==================== 11. 艺术家 ====================
// 白天私下向说书人（AI 裁判）提一个是非题，获得真实答案。
class Artist extends Role {
  constructor() {
    super();
    this.name = '艺术家';
    this.id = SNV_ROLE_IDS.ARTIST;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = -1;
    this.otherNightOrder = -1;
    this.selectCount = 0;
    this.abilityDesc = '每局游戏限一次，在白天时私下向说书人提一个是非题，你会得到真实答案。';
  }

  onDayAbility(gameState, player, question, engine) {
    if (!isDayPhase(gameState)) {
      return { success: false, message: '只能在白天提问' };
    }
    if (player.abilityState.artistUsed) {
      return { success: false, message: '你已经使用过艺术家能力了' };
    }
    // 正在等待说书人回答时不允许重复提交
    if (player.abilityState.artistPending) {
      return { success: false, message: '正在等待说书人回答，请稍候' };
    }
    const q = String(question || '').trim();
    if (q.length < 2) return { success: false, message: '请输入问题（至少2个字）' };
    if (q.length > 120) return { success: false, message: '问题不能超过120字' };

    // 注意：这里不占用本局次数，等 AI 回答成功（applyAnswer）后再置位，
    // 否则裁判服务失败时会被误判为「已使用」
    player.abilityState.artistPending = q;
    return { success: true, question: q };
  }

  applyAnswer(gameState, player, answer, engine) {
    const question = player.abilityState.artistPending;
    player.abilityState.artistPending = null;
    if (!question) return;

    // 成功拿到答案才占用本局次数（前端据此禁用按钮）
    player.abilityState.artistUsed = true;
    // 成功后清掉失败重试用的回填内容，避免之后还带出旧问题
    player.abilityState.artistLastAttempt = null;
    player.abilityState.artistLastAttemptDay = null;

    const vortox = isVortoxActive(engine);
    const finalAnswer = vortox ? !answer : answer;

    engine.setPlayerPrivateInfo(player, {
      type: 'artist',
      question,
      answer: finalAnswer,
      message: `你的提问："${question}"\n说书人的回答：${finalAnswer ? '是' : '否'}`
    });
    engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（艺术家）提问："${question}"，回答：${finalAnswer ? '是' : '否'}`, {
      playerId: player.id, question, answer: finalAnswer
    });
  }

  // 裁判 AI 失败：回滚本次提交，并记住这次的问题，当天重试时自动回填
  cancelDayAbility(gameState, player) {
    const pending = player.abilityState.artistPending;
    if (pending) {
      player.abilityState.artistLastAttempt = pending;
      player.abilityState.artistLastAttemptDay = gameState.dayCount;
    }
    player.abilityState.artistPending = null;
  }
}

// ==================== 12. 杂耍艺人 ====================
class Juggler extends Role {
  constructor() {
    super();
    this.name = '杂耍艺人';
    this.id = SNV_ROLE_IDS.JUGGLER;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = -1;
    this.otherNightOrder = 9;
    this.selectCount = 0;
    this.abilityDesc = '在首个白天，你可以公开猜测至多5名玩家的角色。当晚，你得知你猜对了几个。';
  }

  static MAX_GUESSES = 5;

  getNightWakeInfo(gameState, player, engine) {
    // 只在第一个白天之后的夜晚（nightCount === 1）给结果
    if (gameState.nightCount !== 1) return null;
    const guesses = player.abilityState.jugglerGuesses;
    if (!guesses || guesses.length === 0) return null;
    return { canSelectCount: 0, message: '你得知今晚你的猜测猜对了几个' };
  }

  onDayAbility(gameState, player, payload, engine) {
    if (!isDayPhase(gameState)) {
      return { success: false, message: '只能在白天进行猜测' };
    }
    if (gameState.dayCount !== 1) {
      return { success: false, message: '只能在首个白天进行猜测' };
    }
    const targetId = payload && payload.targetId;
    const roleId = payload && payload.roleId;
    if (!targetId || !roleId) return { success: false, message: '请选择玩家与角色' };

    const target = engine.room.players.get(targetId);
    if (!target || !target.isAlive || !target.role) {
      return { success: false, message: '选择的玩家无效' };
    }
    const inst = engine.roleAllocator.createRoleInstance(roleId);
    if (!inst) return { success: false, message: '角色不存在' };

    const guesses = player.abilityState.jugglerGuesses || [];
    // 官方：首个白天最多公开猜测 5 名玩家
    if (guesses.length >= Juggler.MAX_GUESSES) {
      return { success: false, message: `最多只能猜测 ${Juggler.MAX_GUESSES} 名玩家` };
    }
    if (guesses.some(g => g.targetId === targetId)) {
      return { success: false, message: '已经猜过这名玩家了' };
    }
    guesses.push({ targetId, roleId });
    player.abilityState.jugglerGuesses = guesses;

    return {
      success: true,
      targetId,
      targetSeat: target.seat,
      targetName: target.name,
      roleName: inst.name
    };
  }

  onNightAction(gameState, player, action, engine) {
    if (gameState.nightCount !== 1) return { success: true };
    const guesses = player.abilityState.jugglerGuesses || [];
    if (guesses.length === 0) return { success: true };

    const correct = guesses.filter(g => {
      const t = engine.room.players.get(g.targetId);
      return t && t.role && t.role.id === g.roleId;
    }).length;

    let value = correct;
    let isFalse = false;
    let probInfo = null;
    if (isImpaired(player)) {
      const adj = engine.balanceSystem.adjustInfo(this, correct, player, engine, '杂耍艺人中毒正确信息');
      probInfo = adj.probInfo;
      if (adj.info === null) { isFalse = true; value = pickWrongNumber(correct, 0, guesses.length); }
    }
    if (!isFalse && isVortoxActive(engine)) {
      isFalse = true;
      value = pickWrongNumber(correct, 0, guesses.length);
    }

    engine.setPlayerPrivateInfo(player, {
      type: 'juggler',
      guesses: guesses.length,
      correct: value,
      message: `你一共猜了 ${guesses.length} 个角色，其中猜对了 ${value} 个`
    }, isFalse, isFalse ? { realCorrect: correct, probInfo } : (probInfo ? { probInfo } : null));

    player.abilityState.jugglerGuesses = [];
    return { success: true };
  }
}

// ==================== 13. 贤者 ====================
class Sage extends Role {
  constructor() {
    super();
    this.name = '贤者';
    this.id = SNV_ROLE_IDS.SAGE;
    this.team = 'GOOD';
    this.category = 'TOWNSFOLK';
    this.firstNightOrder = -1;
    this.otherNightOrder = -1;
    this.selectCount = 0;
    this.abilityDesc = '如果你被恶魔杀害，你得知两名玩家，其中一名是恶魔。';
  }

  onDeath(gameState, player, cause, engine) {
    if (cause !== 'DEMON') return {};
    if (isImpaired(player)) {
      engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（贤者）死亡时中毒/醉酒，无法获得恶魔信息`, {
        playerId: player.id, disabled: true
      });
      return {};
    }

    const players = seatedPlayers(engine);
    const demon = players.find(p => p.role && p.role.category === 'DEMON' && !p.role.isFakeDemon);
    if (!demon) return {};

    const others = players.filter(p => p.id !== demon.id && p.isAlive);
    const decoy = pickRandom(others) || demon;
    const pair = Math.random() < 0.5 ? [demon, decoy] : [decoy, demon];

    engine.setPlayerPrivateInfo(player, {
      type: 'sage',
      message: `你是被恶魔杀害的。恶魔是这两名玩家之一：${pair.map(p => `${p.seat + 1}号 ${p.name}`).join('、')}`,
      players: pair.map(p => ({ id: p.id, seat: p.seat, name: p.name }))
    });
    engine.logAction('ABILITY', `${player.seat + 1}号 ${player.name}（贤者）被恶魔杀害，得知恶魔在 ${pair.map(p => `${p.seat + 1}号`).join('/')} 之中`, {
      playerId: player.id, demonId: demon.id
    });

    return {};
  }
}

module.exports = {
  Clockmaker,
  Dreamer,
  SnakeCharmer,
  Mathematician,
  Flowergirl,
  TownCrier,
  Oracle,
  Savant,
  Seamstress,
  Philosopher,
  Artist,
  Juggler,
  Sage
};
