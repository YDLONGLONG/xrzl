// 夜晚结算器 - 支持多剧本
const { getScriptConfig, PHASES, ROLE_IDS } = require('../config/game-config');
const { getAlivePlayers } = require('../utils/helpers');

class NightResolver {
  constructor(engine) {
    this.engine = engine;
    this.pendingRavenkeeper = null;
    this.pendingMoonchild = null;
  }

  get scriptConfig() {
    const scriptId = this.engine.room.script || 'tb';
    return getScriptConfig(scriptId);
  }

  beginFirstNight() {
    const gs = this.engine.room.gameState;
    gs.phase = PHASES.FIRST_NIGHT;
    gs.nightCount = 0;
    gs.nightActions = {};
    gs.deathsToAnnounce = [];
    gs.currentNightIndex = -1;
    gs.currentWakePlayerId = null;
    this.pendingRavenkeeper = null;
    this.pendingMoonchild = null;

    gs.nightQueue = this.buildNightQueue(true);

    for (const [, player] of this.engine.room.players) {
      if (player.role && player.role.onFirstNight) {
        player.role.onFirstNight(gs, player, this.engine);
      }
    }

    this.wakeNext();
  }

  beginNight(nightCount) {
    const gs = this.engine.room.gameState;
    gs.phase = PHASES.NIGHT;
    gs.nightCount = nightCount;
    gs.nightActions = {};
    gs.deathsToAnnounce = [];
    gs.currentNightIndex = -1;
    gs.currentWakePlayerId = null;
    this.pendingRavenkeeper = null;
    this.pendingMoonchild = null;

    gs.nightQueue = this.buildNightQueue(false);

    for (const [, player] of this.engine.room.players) {
      player.hasNominated = false;
      player.wasNominatedToday = false;
      player.isProtected = false;
      if (player.role && player.role.id === 'butler') {
        player.abilityState.masterVoted = false;
      }
    }
    gs.nominations = [];
    gs.todaysDeaths = [];

    this.wakeNext();
  }

  buildNightQueue(isFirstNight) {
    const sc = this.scriptConfig;
    const baseOrder = isFirstNight ? sc.firstNightOrder : sc.otherNightOrder;
    const queue = [];
    const demonIds = sc.demonRoles;

    baseOrder.forEach(roleId => {
      // 去重（BMR首夜顺序中godfather出现两次）
      if (queue.some(e => e.roleId === roleId && e.isDuplicateHandled)) return;

      // 酒鬼假角色处理（仅TB）
      const drunksWithThisRole = getAlivePlayers(this.engine.room).filter(
        p => p.role && p.role.id === ROLE_IDS.DRUNK && p.fakeRole && p.fakeRole.id === roleId
      );

      // 疯子/莽夫假恶魔角色处理（仅BMR）
      const fakeDemonsWithThisRole = getAlivePlayers(this.engine.room).filter(
        p => p.role && (p.role.id === 'madman' || p.role.id === 'lunatic') && p.fakeRole && p.fakeRole.id === roleId
      );

      // 真实角色玩家
      const realPlayer = getAlivePlayers(this.engine.room).find(
        p => p.role && p.role.id === roleId && p.role.id !== ROLE_IDS.DRUNK && !p.role.isFakeDemon
      );

      // 首夜恶魔不唤醒杀人（只给信息）
      if (isFirstNight && demonIds.includes(roleId)) {
        // 但假恶魔（疯子/莽夫）需要被唤醒选择目标
        fakeDemonsWithThisRole.forEach(fd => {
          queue.push({ roleId, playerId: fd.id, isFakeDemon: true });
        });
        return;
      }

      // 守鸦人只有死亡时才唤醒
      if (roleId === ROLE_IDS.RAVENKEEPER) return;
      // 僧侣第一夜不行动
      if (isFirstNight && roleId === ROLE_IDS.MONK) return;
      // 旅店老板/赌徒首夜不行动
      if (isFirstNight && (roleId === 'innkeeper' || roleId === 'gambler')) return;

      if (realPlayer) {
        queue.push({ roleId, playerId: realPlayer.id, isDrunk: false });
      }
      drunksWithThisRole.forEach(drunk => {
        queue.push({ roleId, playerId: drunk.id, isDrunk: true });
      });
      fakeDemonsWithThisRole.forEach(fd => {
        queue.push({ roleId, playerId: fd.id, isFakeDemon: true });
      });
    });

    return queue;
  }

  wakeNext() {
    const gs = this.engine.room.gameState;
    const isFirstNight = gs.nightCount === 0;
    const queue = gs.nightQueue;

    gs.currentNightIndex++;

    while (gs.currentNightIndex < queue.length) {
      const entry = queue[gs.currentNightIndex];
      const player = this.engine.room.players.get(entry.playerId);

      if (player && player.isAlive) {
        const role = player.role;
        const isDrunkPlayer = entry.isDrunk;
        const isFakeDemon = entry.isFakeDemon;
        let effectiveRole = role;
        let wakeInfo = null;

        if (isDrunkPlayer && player.fakeRole) {
          effectiveRole = player.fakeRole;
          wakeInfo = role.getNightWakeInfo ? role.getNightWakeInfo(gs, player, this.engine, isFirstNight) : null;
          if (wakeInfo === null) { gs.currentNightIndex++; continue; }
        }

        if (isFakeDemon && player.fakeRole) {
          effectiveRole = player.fakeRole;
          // 假恶魔使用假角色的getNightWakeInfo
          wakeInfo = effectiveRole.getNightWakeInfo ? effectiveRole.getNightWakeInfo(gs, player, this.engine, isFirstNight) : null;
          if (wakeInfo === null) { gs.currentNightIndex++; continue; }
        }

        const wakesForInfo = effectiveRole.wakesForInfo === true;
        const selectCount = isDrunkPlayer ? (role.selectCount || 0) : (effectiveRole.selectCount || 0);
        const shouldWake = (selectCount > 0) || wakesForInfo || (isDrunkPlayer && wakeInfo !== null) || (isFakeDemon && wakeInfo !== null);

        if (shouldWake) {
          gs.currentWakePlayerId = player.id;
          gs.phase = PHASES.NIGHT_WAKE;

          const roleName = (isDrunkPlayer || isFakeDemon) ? player.fakeRole.name : role.name;
          this.engine.logAction('NIGHT_WAKE', `唤醒 ${player.seat+1}号 ${player.name}（${roleName}${isDrunkPlayer?'/酒鬼':''}${isFakeDemon?'/假恶魔':''}）行动`, {
            playerId: player.id, role: (isDrunkPlayer || isFakeDemon) ? player.fakeRole.id : role.id
          });

          if (!wakeInfo) {
            wakeInfo = effectiveRole.getNightWakeInfo ? effectiveRole.getNightWakeInfo(gs, player, this.engine, isFirstNight) : null;
          }

          // 假恶魔使用假角色的selectCount
          const effectiveSelectCount = isFakeDemon ? (effectiveRole.selectCount || 0) : selectCount;

          this.engine.io.to(player.id).emit('night:wake', {
            role: roleName,
            canSelectCount: effectiveSelectCount,
            excludeSelf: wakeInfo?.excludeSelf || false,
            message: wakeInfo?.message || '请行动'
          });

          this.engine.broadcastState();
          return;
        }

        gs.currentNightIndex++;
      } else {
        gs.currentNightIndex++;
      }
    }

    this.resolveNight();
  }

  findAlivePlayerWithRole(roleId) {
    return getAlivePlayers(this.engine.room).find(p => p.role && p.role.id === roleId);
  }

  processNightAction(playerId, action) {
    const gs = this.engine.room.gameState;
    const player = this.engine.room.players.get(playerId);

    if (!player || gs.currentWakePlayerId !== playerId) {
      return { success: false, message: '还没轮到你行动' };
    }

    const isDrunk = player.role.id === ROLE_IDS.DRUNK;
    const isFakeDemon = player.role.id === 'madman' || player.role.id === 'lunatic';

    // 假恶魔处理：使用真实角色的onNightAction，假装行动但不实际杀人
    if (isFakeDemon && player.fakeRole) {
      const fakeRole = player.fakeRole;
      const effectiveSelectCount = fakeRole.selectCount || 0;

      if (effectiveSelectCount === 0) {
        if (fakeRole.onNightAction) {
          fakeRole.onNightAction(gs, player, { targets: [] }, this.engine);
        }
      } else {
        const targets = action.targets || [];
        if (targets.length !== effectiveSelectCount) {
          return { success: false, message: `请选择${effectiveSelectCount}名玩家` };
        }
        if (fakeRole.onNightAction) {
          fakeRole.onNightAction(gs, player, action, this.engine);
        }
      }

      // 给假恶魔假确认信息
      const targetNames = (action.targets || []).map(tid => {
        const t = this.engine.room.players.get(tid);
        return t ? `${t.seat+1}号${t.name}` : tid;
      }).join('、');
      this.engine.setPlayerPrivateInfo(player, {
        type: 'fake_demon_action',
        message: targetNames ? `你选择了 ${targetNames}` : '你执行了行动',
        isFakeDemon: true
      }, true, { realInfo: `${player.role.name}无实际效果` });

      // 通知真恶魔
      const realDemon = Array.from(this.engine.room.players.values())
        .find(p => p.role.category === 'DEMON' && !p.role.isFakeDemon);
      if (realDemon) {
        this.engine.setPlayerPrivateInfo(realDemon, {
          type: 'fake_demon_choice',
          message: `${player.seat+1}号 ${player.name}（${player.role.name}）选择了：${targetNames || '无'}`
        });
      }

      gs.currentWakePlayerId = null;
      this.engine.io.to(playerId).emit('night:actionAck', { success: true });
      gs.phase = gs.nightCount === 0 ? PHASES.FIRST_NIGHT : PHASES.NIGHT;
      this.wakeNext();
      return { success: true };
    }

    const effectiveSelectCount = player.role.selectCount || 0;
    if (effectiveSelectCount === 0 && !isDrunk) {
      if (player.role.onNightAction) {
        const result = player.role.onNightAction(gs, player, { targets: [] }, this.engine);
        if (!result.success) return result;
      }
      gs.currentWakePlayerId = null;
      this.engine.io.to(playerId).emit('night:actionAck', { success: true });
      gs.phase = gs.nightCount === 0 ? PHASES.FIRST_NIGHT : PHASES.NIGHT;
      this.wakeNext();
      return { success: true };
    }

    const targets = action.targets || [];
    if (effectiveSelectCount > 0 && targets.length !== effectiveSelectCount) {
      return { success: false, message: `请选择${effectiveSelectCount}名玩家` };
    }

    if (player.role && player.role.onNightAction) {
      const result = player.role.onNightAction(gs, player, action, this.engine);
      if (!result.success) return result;
    }

    if (isDrunk) {
      player.role.selectCount = 0;
    }

    gs.currentWakePlayerId = null;
    this.engine.io.to(playerId).emit('night:actionAck', { success: true });
    gs.phase = gs.nightCount === 0 ? PHASES.FIRST_NIGHT : PHASES.NIGHT;
    this.wakeNext();
    return { success: true };
  }

  wakeRavenkeeper(player) {
    const gs = this.engine.room.gameState;
    this.pendingRavenkeeper = player.id;
    gs.currentWakePlayerId = player.id;
    gs.phase = PHASES.NIGHT_WAKE;

    this.engine.io.to(player.id).emit('night:wake', {
      role: player.role.name,
      canSelectCount: 1,
      message: '你死了。选择一名玩家查看其身份'
    });
    this.engine.broadcastState();
  }

  processRavenkeeperAction(playerId, targetId) {
    const target = this.engine.room.players.get(targetId);
    const player = this.engine.room.players.get(playerId);
    if (target && target.role && player) {
      let roleName = target.role.name;
      let teamName = target.role.team === 'GOOD' ? '善良' : '邪恶';
      this.engine.setPlayerPrivateInfo(player, {
        type: 'ravenkeeper',
        message: `${target.seat+1}号 ${target.name} 的身份是【${roleName}】（${teamName}阵营）`
      });
    }
    this.pendingRavenkeeper = null;
  }

  // 月之子死亡唤醒
  wakeMoonchild(player) {
    const gs = this.engine.room.gameState;
    this.pendingMoonchild = player.id;
    gs.currentWakePlayerId = player.id;
    gs.phase = PHASES.NIGHT_WAKE;

    this.engine.io.to(player.id).emit('night:wake', {
      role: player.role.name,
      canSelectCount: 1,
      message: '你死了。选择一名存活玩家，如果TA是善良的，TA会在当晚死亡'
    });
    this.engine.broadcastState();
  }

  processMoonchildAction(playerId, targetId) {
    const player = this.engine.room.players.get(playerId);
    const target = this.engine.room.players.get(targetId);
    if (player && target && target.role) {
      if (target.role.team === 'GOOD' && target.isAlive) {
        this.engine.deathManager.killPlayerDirect(targetId, 'MOONCHILD', this.engine.room.gameState.nightCount, -1);
      }
      this.engine.setPlayerPrivateInfo(player, {
        type: 'moonchild',
        message: `${target.seat+1}号 ${target.name} 是${target.role.team === 'GOOD' ? '善良' : '邪恶'}阵营${target.role.team === 'GOOD' ? '，TA将在今晚死亡' : '，无事发生'}`
      });
    }
    this.pendingMoonchild = null;
  }

  resolveNight() {
    const gs = this.engine.room.gameState;
    const isFirstNight = gs.nightCount === 0;

    if (!isFirstNight) {
      this.resolveDemonKills(gs);
      this.resolveMinionKills(gs);
    }

    // 修补匠可能死亡
    this.resolveTinkerDeath(gs);

    // 检查守鸦人
    const nightDead = Array.from(this.engine.room.players.values())
      .filter(p => p.isDead && p.deathNight === gs.nightCount && p.role && p.role.id === ROLE_IDS.RAVENKEEPER);

    if (nightDead.length > 0 && !nightDead[0].isPoisoned) {
      this.wakeRavenkeeper(nightDead[0]);
      return;
    }

    // 检查月之子死亡
    const moonchildDead = Array.from(this.engine.room.players.values())
      .filter(p => p.isDead && p.deathNight === gs.nightCount && p.role && p.role.id === 'moonchild' && !p.abilityState.hasUsed);

    if (moonchildDead.length > 0 && !moonchildDead[0].isPoisoned) {
      moonchildDead[0].abilityState.hasUsed = true;
      this.wakeMoonchild(moonchildDead[0]);
      return;
    }

    this.finalizeNight();
  }

  // 处理恶魔杀人
  resolveDemonKills(gs) {
    const sc = this.scriptConfig;

    // TB: 小恶魔
    if (gs.nightActions.imp) {
      const targetId = gs.nightActions.imp.targetId;
      this.executeDemonKill(targetId, gs, 'imp');
    }

    // BMR: 僵怖 - 仅当白天无人死亡时杀人
    if (gs.nightActions.zombuul) {
      const dayDeaths = (gs.todaysDeaths || []).filter(d => d.cause !== 'FIRST_NIGHT');
      if (dayDeaths.length === 0) {
        this.executeDemonKill(gs.nightActions.zombuul.targetId, gs, 'zombuul');
      }
    }

    // BMR: 普卡 - 杀上一夜的毒目标
    if (gs.nightActions.pukka) {
      const pukkaPlayer = this.findAlivePlayerWithRole('pukka');
      if (pukkaPlayer && pukkaPlayer.abilityState.lastPoisonTargetId !== undefined) {
        const lastTargetId = pukkaPlayer.abilityState.lastPoisonTargetId;
        const lastTarget = this.engine.room.players.get(lastTargetId);
        if (lastTarget && lastTarget.isAlive) {
          lastTarget.isPoisoned = false; // 恢复健康
          this.engine.deathManager.killPlayer(lastTargetId, 'DEMON', gs.nightCount, -1);
        }
      }
      // 设置当前毒目标为上一夜目标
      if (pukkaPlayer) {
        pukkaPlayer.abilityState.lastPoisonTargetId = gs.nightActions.pukka.targetId;
      }
    }

    // BMR: 沙巴洛斯 - 杀2人 + 可选复活
    if (gs.nightActions.shabaloth) {
      const targets = gs.nightActions.shabaloth.targetIds || [];
      targets.forEach(tid => this.executeDemonKill(tid, gs, 'shabaloth'));

      // 反刍：复活上一夜选择且已死亡的目标之一
      const shabalothPlayer = this.findAlivePlayerWithRole('shabaloth');
      if (shabalothPlayer && shabalothPlayer.abilityState.lastNightTargets) {
        const lastTargets = shabalothPlayer.abilityState.lastNightTargets;
        const deadLastTargets = lastTargets
          .map(id => this.engine.room.players.get(id))
          .filter(p => p && p.isDead && p.deathNight === gs.nightCount - 1);
        if (deadLastTargets.length > 0 && Math.random() < 0.5) {
          const revived = deadLastTargets[0];
          revived.isAlive = true;
          revived.isDead = false;
          revived.deathNight = -1;
          revived.deathDay = -1;
          this.engine.logAction('ABILITY', `${revived.seat+1}号 ${revived.name} 被沙巴洛斯反刍复活`, {
            playerId: revived.id
          });
        }
      }
      if (shabalothPlayer) {
        shabalothPlayer.abilityState.lastNightTargets = targets;
      }
    }

    // BMR: 珀 - 杀1或3人
    if (gs.nightActions.po) {
      const targets = gs.nightActions.po.targetIds || [gs.nightActions.po.targetId].filter(Boolean);
      targets.forEach(tid => this.executeDemonKill(tid, gs, 'po'));
    }
  }

  executeDemonKill(targetId, gs, demonType) {
    const target = this.engine.room.players.get(targetId);
    if (!target || !target.isAlive) return;

    // 检查保护
    if (target.isProtected) return;

    // 检查士兵免疫
    if (target.role.id === 'soldier' && !target.isPoisoned) return;

    // 检查水手免疫（BMR水手不会死亡）
    if (target.role.id === 'sailor' && !target.isPoisoned) return;

    // 检查弄臣首次死亡免疫
    if (target.role.id === 'fool' && !target.abilityState.usedDeath && !target.isPoisoned) {
      target.abilityState.usedDeath = true;
      this.engine.logAction('ABILITY', `${target.seat+1}号 ${target.name}（弄臣）首次死亡免疫`, {
        playerId: target.id
      });
      return;
    }

    // 检查茶艺师保护
    const Tealady = require('../roles/Townsfolk2').Tealady;
    if (Tealady.isProtectedByTealady && Tealady.isProtectedByTealady(this.engine.room, target)) {
      this.engine.logAction('ABILITY', `${target.seat+1}号 ${target.name} 被茶艺师保护`, {
        playerId: target.id
      });
      return;
    }

    // 检查僵怖首次死亡免疫
    if (target.role.id === 'zombuul' && !target.abilityState.firstDeath && !target.isPoisoned) {
      target.abilityState.firstDeath = true;
      // 仍存活但被当作死亡
      target.isDead = true;
      target.deathNight = gs.nightCount;
      target.voteToken = 1;
      this.engine.logAction('ABILITY', `${target.seat+1}号 ${target.name}（僵怖）首次死亡，仍存活但被当作死亡`, {
        playerId: target.id
      });
      return;
    }

    this.engine.deathManager.killPlayer(targetId, 'DEMON', gs.nightCount, -1);
  }

  // 处理爪牙杀人（教父、刺客）
  resolveMinionKills(gs) {
    // 教父杀人（如果有外来者在白天死亡）
    if (gs.nightActions.godfather) {
      const targetId = gs.nightActions.godfather.targetId;
      const target = this.engine.room.players.get(targetId);
      if (target && target.isAlive) {
        this.engine.deathManager.killPlayer(targetId, 'GODFATHER', gs.nightCount, -1);
      }
    }

    // 刺客杀人（无视守护）
    if (gs.nightActions.assassin) {
      const targetId = gs.nightActions.assassin.targetId;
      const target = this.engine.room.players.get(targetId);
      if (target && target.isAlive) {
        // 刺客的杀无视守护
        target.isProtected = false;
        this.engine.deathManager.killPlayerDirect(targetId, 'ASSASSIN', gs.nightCount, -1);
        this.engine.logAction('ABILITY', `${target.seat+1}号 ${target.name} 被刺客击杀（无视守护）`, {
          playerId: targetId
        });
      }
    }
  }

  // 修补匠可能死亡
  resolveTinkerDeath(gs) {
    const tinkers = getAlivePlayers(this.engine.room).filter(p => p.role && p.role.id === 'tinker');
    tinkers.forEach(tinker => {
      const probInfo = this.engine.balanceSystem.getTinkerDeathProbability(this.engine);
      if (Math.random() < probInfo.probability) {
        this.engine.deathManager.killPlayer(tinker.id, 'TINKER', gs.nightCount, -1);
        this.engine.logAction('DEATH', `${tinker.seat+1}号 ${tinker.name}（修补匠）在夜晚死亡`, {
          playerId: tinker.id, probInfo
        });
      }
    });
  }

  processRavenkeeperAction(playerId, targetId) {
    const target = this.engine.room.players.get(targetId);
    const player = this.engine.room.players.get(playerId);
    if (target && target.role && player) {
      let roleName = target.role.name;
      let teamName = target.role.team === 'GOOD' ? '善良' : '邪恶';
      let isFalse = false;
      if (player.isPoisoned) {
        const adjustedResult = this.engine.balanceSystem.adjustInfo(player.role, { roleName, teamName }, player, this.engine, '守鸦人中毒正确信息');
        if (adjustedResult.info === null) {
          isFalse = true;
          const goodRoles = ['洗衣妇','图书管理员','调查员','厨师','共情者','僧侣','守鸦人','圣女','杀手','士兵','市长','圣徒'];
          const evilRoles = ['下毒者','红唇女郎','男爵','间谍','小恶魔'];
          teamName = '邪恶';
          roleName = evilRoles[Math.floor(Math.random() * evilRoles.length)];
        }
      }
      this.engine.setPlayerPrivateInfo(player, {
        type: 'ravenkeeper',
        message: `${target.seat+1}号 ${target.name} 的身份是【${roleName}】（${teamName}阵营）`
      }, isFalse, isFalse ? { realRoleName: target.role.name, realTeamName: target.role.team === 'GOOD' ? '善良' : '邪恶' } : null);
    }
    this.pendingRavenkeeper = null;
  }

  finalizeNight() {
    const gs = this.engine.room.gameState;

    // 结算信息位技能
    for (const [, player] of this.engine.room.players) {
      if (player.isAlive && player.role && player.role.resolveNight) {
        player.role.resolveNight(gs, player, this.engine);
      }
    }

    // 收集死亡名单
    gs.deathsToAnnounce = Array.from(this.engine.room.players.values())
      .filter(p => p.isDead && p.deathNight === gs.nightCount)
      .map(p => ({
        playerId: p.id,
        seat: p.seat,
        name: p.name,
        cause: p.deathNight === 0 ? 'FIRST_NIGHT' : 'DEMON'
      }));

    if (gs.deathsToAnnounce.length > 0) {
      const names = gs.deathsToAnnounce.map(d => `${d.seat+1}号${d.name}`).join('、');
      this.engine.logAction('NIGHT_END', `第${gs.nightCount}夜结束，死亡玩家：${names}`, { deaths: gs.deathsToAnnounce });
    } else {
      this.engine.logAction('NIGHT_END', `第${gs.nightCount}夜结束，平安夜`, {});
    }

    const victory = this.engine.victoryChecker.checkVictory();
    if (victory) return;

    this.engine.transitionTo(PHASES.DAY_DAWN);
  }
}

module.exports = NightResolver;
