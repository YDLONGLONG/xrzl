// 夜晚结算器 - 支持多剧本
const { getScriptConfig, PHASES, ROLE_IDS } = require('../config/game-config');
const { getAlivePlayers, decrementDrunkPlayers } = require('../utils/helpers');
const { Lunatic } = require('../roles/Outsider2');

class NightResolver {
  constructor(engine) {
    this.engine = engine;
    this.pendingRavenkeeper = null;
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
    gs.goonTriggeredThisNight = false;

    // 醉酒时长递减：上一轮「直到明天黄昏」的醉酒在此解除
    decrementDrunkPlayers(this.engine.room);

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
    gs.goonTriggeredThisNight = false;

    // 醉酒时长递减：上一轮「直到明天黄昏」的醉酒在此解除
    decrementDrunkPlayers(this.engine.room);

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
    // 先保存「刚刚过去的这个白天」的死亡记录，供僵怖等能力判定使用，再清空当日记录
    gs.lastDayDeaths = (gs.todaysDeaths || []).slice();
    gs.todaysDeaths = [];

    this.wakeNext();
  }

  buildNightQueue(isFirstNight) {
    const sc = this.scriptConfig;
    const baseOrder = isFirstNight ? sc.firstNightOrder : sc.otherNightOrder;
    const queue = [];
    const demonIds = sc.demonRoles;
    const handledRoleIds = new Set();

    baseOrder.forEach(roleId => {
      // 去重：同一角色在顺序表中重复出现时只入队一次
      if (handledRoleIds.has(roleId)) return;
      handledRoleIds.add(roleId);

      // 酒鬼假角色处理（仅TB）
      const drunksWithThisRole = getAlivePlayers(this.engine.room).filter(
        p => p.role && p.role.id === ROLE_IDS.DRUNK && p.fakeRole && p.fakeRole.id === roleId
      );

      // 疯子假恶魔角色处理（仅BMR；莽夫是被动角色，不再视为假恶魔）
      const fakeDemonsWithThisRole = getAlivePlayers(this.engine.room).filter(
        p => p.role && p.role.isFakeDemon && p.fakeRole && p.fakeRole.id === roleId
      );

      // 真实角色玩家
      const realPlayer = getAlivePlayers(this.engine.room).find(
        p => p.role && p.role.id === roleId && p.role.id !== ROLE_IDS.DRUNK && !p.role.isFakeDemon
      );

      // 首夜恶魔不唤醒杀人（只给信息）
      if (isFirstNight && demonIds.includes(roleId)) {
        // 但假恶魔（疯子）需要被唤醒选择目标
        fakeDemonsWithThisRole.forEach(fd => {
          queue.push({ roleId, playerId: fd.id, isFakeDemon: true });
        });
        // 普卡例外：技能表为「每个夜晚，选择一名玩家中毒」，首夜同样行动
        if (roleId === 'pukka' && realPlayer) {
          queue.push({ roleId, playerId: realPlayer.id, isDrunk: false });
        }
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

        // 驱魔人：被选中的恶魔当晚能力失效，不唤醒行动
        if (!isFakeDemon && role.category === 'DEMON' &&
            player.abilityState.exorcisedNight === gs.nightCount) {
          this.engine.logAction('ABILITY', `${player.seat+1}号 ${player.name}（${role.name}）被驱魔人选中，本夜能力失效`, {
            playerId: player.id, role: role.id, event: 'exorcised'
          });
          gs.currentNightIndex++;
          continue;
        }

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
        const selectType = effectiveRole.selectType || 'player';
        const selectCount = isDrunkPlayer ? (role.selectCount || 0) : (effectiveRole.selectCount || 0);
        const canSkip = effectiveRole.canSkip === true;
        let shouldWake = (selectCount > 0) || wakesForInfo || selectType === 'role' || (isDrunkPlayer && wakeInfo !== null) || (isFakeDemon && wakeInfo !== null);

        // 唤醒信息由 getNightWakeInfo 动态生成。像教父这样 selectCount 为 0 的角色
        // 完全依靠 getNightWakeInfo 返回非空内容来决定是否被唤醒（首夜报外来者 /
        // 外来者白天死亡当夜才能杀人），所以必须先询问一次再判定。
        if (!wakeInfo) {
          wakeInfo = effectiveRole.getNightWakeInfo ? effectiveRole.getNightWakeInfo(gs, player, this.engine, isFirstNight) : null;
        }
        if (!shouldWake && wakeInfo) shouldWake = true;

        if (shouldWake) {
          if (wakeInfo === null) {
            gs.currentNightIndex++;
            continue;
          }

          gs.currentWakePlayerId = player.id;
          gs.phase = PHASES.NIGHT_WAKE;

          const roleName = (isDrunkPlayer || isFakeDemon) ? player.fakeRole.name : role.name;
          this.engine.logAction('NIGHT_WAKE', `唤醒 ${player.seat+1}号 ${player.name}（${roleName}${isDrunkPlayer?'/酒鬼':''}${isFakeDemon?'/假恶魔':''}）行动`, {
            playerId: player.id, role: (isDrunkPlayer || isFakeDemon) ? player.fakeRole.id : role.id
          });

          // 假恶魔使用假角色的selectCount
          let effectiveSelectCount = isFakeDemon ? (effectiveRole.selectCount || 0) : selectCount;
          // getNightWakeInfo 可能会动态调整本夜可选人数（如珀上次跳过后需选三人），以其返回值为准
          if (!isDrunkPlayer && typeof wakeInfo?.canSelectCount === 'number') {
            effectiveSelectCount = wakeInfo.canSelectCount;
          }
          const wakeSelectType = wakeInfo?.selectType || selectType;

          // 防御：需要选人但场上已无可选目标（例如只剩自己且技能不能自选）时，
          // 直接跳过本次唤醒，避免夜晚流程永远无法结算。
          if (effectiveSelectCount > 0 && wakeSelectType === 'player') {
            const othersAlive = getAlivePlayers(this.engine.room).filter(p => p.id !== player.id).length;
            const selfSelectable = wakeInfo?.excludeSelf !== true;
            if (othersAlive === 0 && !selfSelectable) {
              this.engine.logAction('NIGHT_WAKE', `${player.seat+1}号 ${player.name}（${roleName}）没有可选目标，跳过本次唤醒`, {
                playerId: player.id
              });
              gs.currentNightIndex++;
              continue;
            }
          }

          this.engine.io.to(player.id).emit('night:wake', {
            role: roleName,
            canSelectCount: effectiveSelectCount,
            selectType: wakeSelectType,
            selectRoles: wakeInfo?.selectRoles || null,
            canSkip: wakeInfo?.canSkip !== undefined ? wakeInfo.canSkip : canSkip,
            selectDead: wakeInfo?.selectDead || false,
            selectPlayerAndRole: wakeInfo?.selectPlayerAndRole || false,
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
    const isFakeDemon = player.role.id === 'madman';

    // 假恶魔处理：仅记录其选择并通知真恶魔，不调用真实恶魔角色的 onNightAction（避免真实伤害）
    if (isFakeDemon && player.fakeRole) {
      const fakeRole = player.fakeRole;
      const effectiveSelectCount = fakeRole.selectCount || 0;

      // 关键：假恶魔（疯子）绝不能调用真实恶魔角色的 onNightAction。
      // 疯子的假角色按设计取自「不在场的恶魔」，调用其 onNightAction 会向 nightActions
      // 注册真实的击杀/中毒等副作用（例如普卡会 Po 化目标、沙巴洛斯会记录真实击杀），
      // 而不会有任何真恶魔去覆盖这些 nightActions，从而制造出「虚假的真实伤害」。
      // 因此此处只做目标数校验，实际效果由下方「假确认信息 + 通知真恶魔」完成。
      if (effectiveSelectCount > 0) {
        const targets = action.targets || [];
        if (targets.length !== effectiveSelectCount) {
          return { success: false, message: `请选择${effectiveSelectCount}名玩家` };
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
    const roleSelectType = player.role.selectType || 'player';
    const roleCanSkip = player.role.canSkip === true;

    if (action.skip && roleCanSkip) {
      if (player.role && player.role.onNightAction) {
        const result = player.role.onNightAction(gs, player, { skip: true }, this.engine);
        if (!result.success) return result;
      }
      gs.currentWakePlayerId = null;
      this.engine.io.to(playerId).emit('night:actionAck', { success: true });
      gs.phase = gs.nightCount === 0 ? PHASES.FIRST_NIGHT : PHASES.NIGHT;
      this.wakeNext();
      return { success: true };
    }

    if (roleSelectType === 'role') {
      const roleId = action.roleId || (action.targets && action.targets[0]);
      if (!roleId) {
        return { success: false, message: '请选择一个角色' };
      }
      if (player.role && player.role.onNightAction) {
        const result = player.role.onNightAction(gs, player, { roleId }, this.engine);
        if (!result.success) return result;
      }
      gs.currentWakePlayerId = null;
      this.engine.io.to(playerId).emit('night:actionAck', { success: true });
      gs.phase = gs.nightCount === 0 ? PHASES.FIRST_NIGHT : PHASES.NIGHT;
      this.wakeNext();
      return { success: true };
    }

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

    // BMR 莽夫（Goon）：本夜第一个将能力选向莽夫的玩家醉酒，并令莽夫转变阵营
    // 兼容单目标 targetId 与多目标 targets / roleId
    const targetIds = Lunatic.getTargetedIds(action);
    for (const tid of targetIds) {
      const target = this.engine.room.players.get(tid);
      if (target && target.role && target.role.id === 'lunatic') {
        Lunatic.triggerGoon(gs, target, player, this.engine);
        break;
      }
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

    this.finalizeNight();
  }

  // 处理恶魔杀人
  resolveDemonKills(gs) {
    const sc = this.scriptConfig;

    // TB: 小恶魔（若选择自己则触发「星传」：一名存活的爪牙接任恶魔）
    if (gs.nightActions.imp) {
      const targetId = gs.nightActions.imp.targetId;
      const imp = this.findAlivePlayerWithRole('imp');
      if (imp && targetId === imp.id) {
        this.starPassImp(imp, gs);
      }
      this.executeDemonKill(targetId, gs, 'imp');
    }

    // BMR: 僵怖 - 仅当刚过去的白天无人死亡时杀人
    if (gs.nightActions.zombuul) {
      const { Zombuul } = require('../roles/Demon2');
      if (!Zombuul.hadDayDeath(gs)) {
        this.executeDemonKill(gs.nightActions.zombuul.targetId, gs, 'zombuul');
      } else {
        this.engine.logAction('ABILITY', '僵怖：白天有人死亡，本夜无法杀人', { event: 'zombuul_blocked' });
      }
    }

    // BMR: 普卡 - 上一夜被毒的玩家在今晚死亡并恢复健康
    // 结算不能依赖「本夜是否成功下毒」（gs.nightActions.pukka）：否则普卡一旦
    // 中毒/醉酒或被驱魔人封禁，毒就会永久残留在目标身上，对局直接卡死。
    const pukkaPlayer = this.findAlivePlayerWithRole('pukka');
    if (pukkaPlayer) {
      if (!pukkaPlayer.abilityState) pukkaPlayer.abilityState = {};
      const lastTargetId = pukkaPlayer.abilityState.lastPoisonTargetId;
      if (lastTargetId) {
        const lastTarget = this.engine.room.players.get(lastTargetId);
        if (lastTarget) {
          lastTarget.isPoisoned = false; // 无论是否真的死亡，毒都必须解除
          if (lastTarget.isAlive) {
            // 普卡的击杀属于恶魔击杀：统一走 executeDemonKill，
            // 以便正确应用士兵免疫与僧侣/旅店老板的守护。
            this.executeDemonKill(lastTargetId, gs, 'pukka');
          }
        }
      }
      const pukkaAction = gs.nightActions.pukka;
      pukkaPlayer.abilityState.lastPoisonTargetId =
        (pukkaAction && pukkaAction.targetId) ? pukkaAction.targetId : null;
    }

    // BMR: 沙巴洛斯 - 杀2人 + 可选复活
    if (gs.nightActions.shabaloth) {
      const targets = gs.nightActions.shabaloth.targets || [];

      // 反刍：复活上一夜选择且已死亡的目标之一（先于本夜击杀结算，避免复活本夜刚死的人）
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
      // 本夜击杀结算
      targets.forEach(tid => this.executeDemonKill(tid, gs, 'shabaloth'));

      if (shabalothPlayer) {
        shabalothPlayer.abilityState.lastNightTargets = targets;
      }
    }

    // BMR: 珀 - 杀1或3人（也可能跳过不杀）
    if (gs.nightActions.po) {
      const targets = gs.nightActions.po.targets || [];
      targets.forEach(tid => this.executeDemonKill(tid, gs, 'po'));
    }
  }

  // 小恶魔自尽时的「星传」：随机一名存活的爪牙成为新的小恶魔
  starPassImp(imp, gs) {
    const minions = getAlivePlayers(this.engine.room)
      .filter(p => p.role && p.role.category === 'MINION' && p.id !== imp.id);
    if (minions.length === 0) return;
    const heir = minions[Math.floor(Math.random() * minions.length)];
    const newRole = this.engine.roleAllocator.createRoleInstance(imp.role.id);
    if (!newRole) return;
    heir.role = newRole;
    this.engine.setPlayerPrivateInfo(heir, {
      type: 'imp_starpass',
      message: '小恶魔将恶魔身份传给了你，你成为了新的【小恶魔】！'
    });
    this.engine.logAction('ABILITY', `${imp.seat + 1}号 ${imp.name}（小恶魔）自尽，星传给了 ${heir.seat + 1}号 ${heir.name}`, {
      playerId: imp.id, heirId: heir.id
    });
  }

  executeDemonKill(targetId, gs, demonType) {
    const target = this.engine.room.players.get(targetId);
    if (!target || !target.isAlive) return;

    // 检查保护
    if (target.isProtected) return;

    // 检查士兵免疫
    if (target.role.id === 'soldier' && !target.isPoisoned && !target.isDrunk) return;

    // 检查水手免疫（BMR水手不会死亡）
    if (target.role.id === 'sailor' && !target.isPoisoned && !target.isDrunk) return;

    // 检查弄臣首次死亡免疫
    if (target.role.id === 'fool' && !target.abilityState.usedDeath && !target.isPoisoned && !target.isDrunk) {
      target.abilityState.usedDeath = true;
      this.engine.logAction('ABILITY', `${target.seat+1}号 ${target.name}（弄臣）首次死亡免疫`, {
        playerId: target.id
      });
      return;
    }

    // 检查茶艺师保护
    const Tealady = require('../roles/Townsfolk2').Tealady;
    if (Tealady.isProtectedByTealady && Tealady.isProtectedByTealady(target, this.engine)) {
      this.engine.logAction('ABILITY', `${target.seat+1}号 ${target.name} 被茶艺师保护`, {
        playerId: target.id
      });
      return;
    }

    // 检查僵怖首次死亡免疫
    if (target.role.id === 'zombuul' && !target.abilityState.firstDeath && !target.isPoisoned && !target.isDrunk) {
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

    // 隐士：「你可能在夜晚死亡，即使没人想杀你」（由平衡系统控制概率）
    const recluses = getAlivePlayers(this.engine.room).filter(p => p.role && p.role.id === 'recluse');
    recluses.forEach(recluse => {
      const probInfo = this.engine.balanceSystem.getRecluseDeathProbability(this.engine);
      if (Math.random() < probInfo.probability) {
        this.engine.deathManager.killPlayer(recluse.id, 'RECLUSE', gs.nightCount, -1);
        this.engine.logAction('DEATH', `${recluse.seat+1}号 ${recluse.name}（隐士）在夜晚意外死亡`, {
          playerId: recluse.id, probInfo
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

    // 结算月之子白天选择的目标：善良则当晚死亡
    for (const [, player] of this.engine.room.players) {
      if (player.role && player.role.id === 'moonchild' && player.abilityState && player.abilityState.selectedTarget) {
        const target = this.engine.room.players.get(player.abilityState.selectedTarget);
        const abilityWorks = !player.abilityState.deathPoisoned && !player.abilityState.deathDrunk;
        if (target && target.isAlive && target.role) {
          const isGood = target.role.team === 'GOOD';
          if (isGood && abilityWorks) {
            const moonResult = this.engine.deathManager.killPlayer(target.id, 'MOONCHILD', gs.nightCount, -1);
            if (!(moonResult && moonResult.prevented)) {
              this.engine.logAction('ABILITY', `${player.seat+1}号 ${player.name}（月之子）诅咒杀死了 ${target.seat+1}号 ${target.name}`, {
                playerId: player.id, targetId: target.id, moonchildId: player.id, cause: 'MOONCHILD'
              });
            }
          } else if (!isGood && abilityWorks) {
            // 目标邪恶，无事发生（也记录日志）
            this.engine.logAction('ABILITY', `${player.seat+1}号 ${player.name}（月之子）选择的目标 ${target.seat+1}号 ${target.name} 是邪恶阵营【${target.role.name}】，技能未生效`, {
              playerId: player.id, role: 'moonchild', event: 'resolve_skip_target_evil', targetId: target.id, targetRoleId: target.role.id
            });
          } else if (!abilityWorks) {
            // 月之子中毒/醉酒，技能失效
            const debuff = [];
            if (player.abilityState.deathPoisoned) debuff.push('中毒');
            if (player.abilityState.deathDrunk) debuff.push('醉酒');
            const debuffText = debuff.join('+');
            const realConsequence = isGood
              ? '但因月之子死亡时' + debuffText + '，技能失效，目标本应死亡却存活'
              : '且目标邪恶，技能本就不生效';
            const teamText = isGood ? '善良' : '邪恶';
            const logMsg = `${player.seat+1}号 ${player.name}（月之子）死亡时${debuffText}，目标是${teamText}阵营【${target.role.name}】（${target.seat+1}号 ${target.name}），${realConsequence}`;
            this.engine.logAction('ABILITY', logMsg, {
              playerId: player.id, role: 'moonchild', event: 'resolve_skip_disabled', targetId: target.id, targetTeam: target.role.team, disabledByPoison: !!player.abilityState.deathPoisoned, disabledByDrunk: !!player.abilityState.deathDrunk
            });
          }
        } else if (!target || !target.isAlive) {
          // 目标在白天被选择后到夜晚结算前已死亡
          this.engine.logAction('ABILITY', `${player.seat+1}号 ${player.name}（月之子）选择的目标已死亡，结算跳过`, {
            playerId: player.id, role: 'moonchild', event: 'resolve_skip_target_dead', targetId: player.abilityState.selectedTarget
          });
        }
        // 清掉选择，避免重复结算
        player.abilityState.selectedTarget = null;
      }
    }

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

    // 兜底：技能互相抵消可能造成长期没有任何死亡，房间会永久卡住
    if (this.checkStall(gs)) return;

    const victory = this.engine.victoryChecker.checkVictory();
    if (victory) return;

    this.engine.transitionTo(PHASES.DAY_DAWN);
  }

  // 对局卡死兜底：
  //  - 连续多个昼夜无人死亡（技能互相抵消）→ 先告警，超过上限强制结束；
  //  - 绝对回合上限（即使有零星死亡，也不允许对局无限拖长，例如
  //    僵怖「被当作死亡」后无法被处决 + 旅店老板持续守护导致的极慢收束）。
  // 返回 true 表示对局已因此结束。
  checkStall(gs) {
    const cfg = (this.engine.probConfig && this.engine.probConfig.balance) ? this.engine.probConfig.balance : {};
    const warnRounds = (cfg.stallWarnRounds !== undefined) ? cfg.stallWarnRounds : 15;
    const endRounds = (cfg.stallEndRounds !== undefined) ? cfg.stallEndRounds : 30;
    const maxRounds = (cfg.stallMaxRounds !== undefined) ? cfg.stallMaxRounds : 30;

    const dayDeaths = (gs.lastDayDeaths || []).filter(d => d && d.playerId);
    const hadDeath = (gs.deathsToAnnounce || []).length > 0 || dayDeaths.length > 0;
    gs.roundsWithoutDeath = hadDeath ? 0 : (gs.roundsWithoutDeath || 0) + 1;

    // 绝对回合上限
    if (maxRounds > 0 && gs.nightCount >= maxRounds) {
      this.engine.logAction('GAME_OVER', `对局已进行 ${gs.nightCount} 个夜晚仍未有结果，判定无法继续，强制结束`, {
        nightCount: gs.nightCount, maxRounds
      });
      this.engine.victoryChecker.endGame('GOOD',
        `对局进行至第 ${gs.nightCount} 个夜晚仍无结果，判善良阵营获胜（防止房间卡死）`);
      return true;
    }

    if (endRounds > 0 && gs.roundsWithoutDeath >= endRounds) {
      this.engine.logAction('GAME_OVER', `已连续 ${gs.roundsWithoutDeath} 个昼夜无任何玩家死亡，判定对局无法继续，强制结束`, {
        roundsWithoutDeath: gs.roundsWithoutDeath
      });
      this.engine.victoryChecker.endGame('GOOD',
        `连续 ${gs.roundsWithoutDeath} 个昼夜无人死亡，对局无法继续，判善良阵营获胜`);
      return true;
    }

    if (warnRounds > 0 && gs.roundsWithoutDeath >= warnRounds) {
      this.engine.logAction('ABILITY', `注意：已连续 ${gs.roundsWithoutDeath} 个昼夜无任何玩家死亡，达到 ${endRounds} 个昼夜将强制结束对局`, {
        roundsWithoutDeath: gs.roundsWithoutDeath, warnRounds, endRounds
      });
    }
    return false;
  }
}

module.exports = NightResolver;
