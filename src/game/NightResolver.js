// 夜晚结算器
const { FIRST_NIGHT_ORDER, OTHER_NIGHT_ORDER, PHASES, ROLE_IDS } = require('../config/game-config');
const { getAlivePlayers } = require('../utils/helpers');

class NightResolver {
  constructor(engine) {
    this.engine = engine;
    this.pendingRavenkeeper = null; // 守鸦人待处理
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

    // 构建夜晚唤醒队列（包含酒鬼按假角色位置插入）
    gs.nightQueue = this.buildNightQueue(true);

    // 触发所有角色第一夜初始化（洗衣妇、图书管理员、调查员、厨师、共情者等信息位在此设置信息）
    for (const [, player] of this.engine.room.players) {
      if (player.role && player.role.onFirstNight) {
        player.role.onFirstNight(gs, player, this.engine);
      }
    }

    // 开始唤醒流程
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

    // 构建夜晚唤醒队列（包含酒鬼按假角色位置插入）
    gs.nightQueue = this.buildNightQueue(false);

    // 重置每日状态
    for (const [, player] of this.engine.room.players) {
      player.hasNominated = false;
      player.wasNominatedToday = false;
      player.isProtected = false;
      // 管家重置主人投票状态
      if (player.role && player.role.id === 'butler') {
        player.abilityState.masterVoted = false;
      }
    }
    gs.nominations = [];
    gs.todaysDeaths = [];

    this.wakeNext();
  }

  // 构建夜晚队列：基础角色顺序 + 酒鬼按假角色位置插入
  buildNightQueue(isFirstNight) {
    const baseOrder = isFirstNight ? FIRST_NIGHT_ORDER : OTHER_NIGHT_ORDER;
    const queue = [];

    // 先把基础角色加入队列
    baseOrder.forEach(roleId => {
      // 检查是否有酒鬼的假角色是这个roleId
      const drunksWithThisRole = getAlivePlayers(this.engine.room).filter(
        p => p.role && p.role.id === ROLE_IDS.DRUNK && p.fakeRole && p.fakeRole.id === roleId
      );
      
      // 真实角色玩家（非酒鬼）
      const realPlayer = getAlivePlayers(this.engine.room).find(p => p.role && p.role.id === roleId && p.role.id !== ROLE_IDS.DRUNK);
      
      // 第一夜特殊处理
      if (isFirstNight && roleId === ROLE_IDS.IMP) {
        // 第一夜恶魔不唤醒，只给信息（通过setupDemonInfo）
        // 但如果有酒鬼以为自己是小恶魔，也不唤醒（简化）
        return;
      }
      if (roleId === ROLE_IDS.RAVENKEEPER) {
        return; // 守鸦人只有死亡时才唤醒
      }
      if (isFirstNight && roleId === ROLE_IDS.MONK) {
        return; // 僧侣第一夜不行动
      }

      if (realPlayer) {
        queue.push({ roleId, playerId: realPlayer.id, isDrunk: false });
      }
      drunksWithThisRole.forEach(drunk => {
        queue.push({ roleId, playerId: drunk.id, isDrunk: true });
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
        let effectiveRole = role;
        let wakeInfo = null;

        if (isDrunkPlayer && player.fakeRole) {
          effectiveRole = player.fakeRole;
          // 先调用getNightWakeInfo来设置selectCount，若返回null则不唤醒
          wakeInfo = role.getNightWakeInfo ? role.getNightWakeInfo(gs, player, this.engine, isFirstNight) : null;
          if (wakeInfo === null) {
            gs.currentNightIndex++;
            continue;
          }
        }

        // 判断是否需要唤醒该角色：
        // 1. selectCount > 0：需要选择目标
        // 2. role.wakesForInfo === true：需要唤醒查看信息（如间谍查看魔典）
        // 3. 酒鬼且getNightWakeInfo返回了非null
        const wakesForInfo = effectiveRole.wakesForInfo === true;
        const selectCount = isDrunkPlayer ? (role.selectCount || 0) : (effectiveRole.selectCount || 0);
        const shouldWake = (selectCount > 0) || wakesForInfo || (isDrunkPlayer && wakeInfo !== null);
        
        if (shouldWake) {
          gs.currentWakePlayerId = player.id;
          gs.phase = PHASES.NIGHT_WAKE;

          const roleName = isDrunkPlayer ? player.fakeRole.name : role.name;
          this.engine.logAction('NIGHT_WAKE', `唤醒 ${player.seat+1}号 ${player.name}（${roleName}${isDrunkPlayer?'/酒鬼':''}）行动`, {
            playerId: player.id, role: isDrunkPlayer ? player.fakeRole.id : role.id
          });

          if (!wakeInfo) {
            wakeInfo = effectiveRole.getNightWakeInfo ? 
              effectiveRole.getNightWakeInfo(gs, player, this.engine, isFirstNight) : null;
          }

          this.engine.io.to(player.id).emit('night:wake', {
            role: roleName,
            canSelectCount: selectCount,
            excludeSelf: wakeInfo?.excludeSelf || false,
            message: wakeInfo?.message || '请行动'
          });

          this.engine.broadcastState();
          return;
        }
        
        // 不需要唤醒，继续下一个
        gs.currentNightIndex++;
      } else {
        gs.currentNightIndex++;
      }
    }

    // 所有角色唤醒完毕，开始结算
    this.resolveNight();
  }

  findAlivePlayerWithRole(roleId) {
    return getAlivePlayers(this.engine.room).find(p => p.role.id === roleId);
  }

  processNightAction(playerId, action) {
    const gs = this.engine.room.gameState;
    const player = this.engine.room.players.get(playerId);
    
    if (!player || gs.currentWakePlayerId !== playerId) {
      return { success: false, message: '还没轮到你行动' };
    }

    const isDrunk = player.role.id === ROLE_IDS.DRUNK;

    // 处理selectCount=0的角色（如间谍查看魔典）或酒鬼假角色selectCount=0的情况
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

    // 校验选择数量
    const targets = action.targets || [];
    if (effectiveSelectCount > 0 && targets.length !== effectiveSelectCount) {
      return { success: false, message: `请选择${effectiveSelectCount}名玩家` };
    }

    if (player.role && player.role.onNightAction) {
      const result = player.role.onNightAction(gs, player, action, this.engine);
      if (!result.success) {
        return result;
      }
    }

    // 重置酒鬼的selectCount
    if (isDrunk) {
      player.role.selectCount = 0;
    }

    gs.currentWakePlayerId = null;
    this.engine.io.to(playerId).emit('night:actionAck', { success: true });
    
    // 继续下一个
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
    if (target && target.role) {
      const player = this.engine.room.players.get(playerId);
      if (player) {
        let isFalse = false;
        let roleName = target.role.name;
        let teamName = target.role.team === 'GOOD' ? '善良' : '邪恶';
        let realRoleName = roleName;
        let realTeamName = teamName;
        if (player.isPoisoned) {
          const adjusted = this.engine.balanceSystem.adjustInfo(player.role, { roleName, teamName }, player, this.engine);
          if (adjusted === null) {
            isFalse = true;
            // 假信息方向由平衡系统决定：好人弱势→显示邪恶（帮好人找邪恶），邪恶弱势→显示善良（误导好人）
            const helpGood = this.engine.balanceSystem.favorWeakSide(this.engine);
            const goodRoles = ['洗衣妇','图书管理员','调查员','厨师','共情者','僧侣','守鸦人','圣女','杀手','士兵','市长','圣徒'];
            const evilRoles = ['下毒者','红唇女郎','男爵','间谍','小恶魔'];
            if (helpGood) {
              teamName = '邪恶';
              roleName = evilRoles[Math.floor(Math.random() * evilRoles.length)];
            } else {
              teamName = '善良';
              roleName = goodRoles[Math.floor(Math.random() * goodRoles.length)];
            }
          }
        }
        this.engine.setPlayerPrivateInfo(player, {
          type: 'ravenkeeper',
          message: `${target.seat+1}号 ${target.name} 的身份是【${roleName}】（${teamName}阵营）`
        }, isFalse, isFalse ? { realRoleName, realTeamName, realPlayerId: targetId } : null);
      }
    }
    this.pendingRavenkeeper = null;
  }

  resolveNight() {
    const gs = this.engine.room.gameState;
    const isFirstNight = gs.nightCount === 0;

    // 处理恶魔杀人（非第一夜）
    if (!isFirstNight) {
      if (gs.nightActions.imp) {
        const targetId = gs.nightActions.imp.targetId;
        const target = this.engine.room.players.get(targetId);
        
        if (target && target.isAlive) {
          if (target.isProtected) {
            // 守护成功
          } else if (target.role.id === ROLE_IDS.SOLDIER && !target.isPoisoned) {
            // 士兵免疫恶魔杀害
          } else {
            this.engine.deathManager.killPlayer(targetId, 'DEMON', gs.nightCount, -1);
          }
        }
      }
    }

    // 检查守鸦人（夜晚死亡的守鸦人需要唤醒看身份）
    const nightDead = Array.from(this.engine.room.players.values())
      .filter(p => p.isDead && p.deathNight === gs.nightCount && p.role.id === ROLE_IDS.RAVENKEEPER);
    
    if (nightDead.length > 0 && !nightDead[0].isPoisoned) {
      // 唤醒第一个死亡的守鸦人（一般只有一个）
      this.wakeRavenkeeper(nightDead[0]);
      return; // 等守鸦人行动后继续
    }

    // 结算所有信息位技能
    this.finalizeNight();
  }

  finalizeNight() {
    const gs = this.engine.room.gameState;

    // 结算信息位技能（共情者等每晚触发的）
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

    // 检查胜负
    const victory = this.engine.victoryChecker.checkVictory();
    if (victory) return;

    // 进入天亮公布
    this.engine.transitionTo(PHASES.DAY_DAWN);
  }
}

module.exports = NightResolver;
