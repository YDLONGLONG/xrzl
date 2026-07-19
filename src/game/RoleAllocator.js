// 身份分配器
const { 
  getRoleComposition, 
  TOWNSFOLK_ROLES, 
  OUTSIDER_ROLES, 
  MINION_ROLES, 
  DEMON_ROLES, 
  ALL_ROLES,
  ROLE_IDS 
} = require('../config/game-config');
const { shuffle } = require('../utils/helpers');

// 导入角色类
const {
  Washerwoman, Librarian, Investigator, Chef, Empath, Fortuneteller,
  Monk, Ravenkeeper, Virgin, Slayer, Soldier, Mayor, Undertaker
} = require('../roles/Townsfolk');
const { Saint, Butler, Drunk, Recluse } = require('../roles/Outsider');
const { Poisoner, ScarletWoman, Baron, Spy } = require('../roles/Minion');
const { Imp } = require('../roles/Demon');
const BalanceSystem = require('./BalanceSystem');

const ROLE_INSTANCES = {
  [ROLE_IDS.WASHERWOMAN]: Washerwoman,
  [ROLE_IDS.LIBRARIAN]: Librarian,
  [ROLE_IDS.INVESTIGATOR]: Investigator,
  [ROLE_IDS.CHEF]: Chef,
  [ROLE_IDS.EMPATH]: Empath,
  [ROLE_IDS.FORTUNETELLER]: Fortuneteller,
  [ROLE_IDS.MONK]: Monk,
  [ROLE_IDS.RAVENKEEPER]: Ravenkeeper,
  [ROLE_IDS.VIRGIN]: Virgin,
  [ROLE_IDS.SLAYER]: Slayer,
  [ROLE_IDS.SOLDIER]: Soldier,
  [ROLE_IDS.MAYOR]: Mayor,
  [ROLE_IDS.UNDERTAKER]: Undertaker,
  [ROLE_IDS.SAINT]: Saint,
  [ROLE_IDS.BUTLER]: Butler,
  [ROLE_IDS.DRUNK]: Drunk,
  [ROLE_IDS.RECLUSE]: Recluse,
  [ROLE_IDS.POISONER]: Poisoner,
  [ROLE_IDS.SCARLETWOMAN]: ScarletWoman,
  [ROLE_IDS.BARON]: Baron,
  [ROLE_IDS.SPY]: Spy,
  [ROLE_IDS.IMP]: Imp
};

class RoleAllocator {
  constructor(engine) {
    this.engine = engine;
  }

  createRoleInstance(roleId) {
    const RoleClass = ROLE_INSTANCES[roleId];
    return RoleClass ? new RoleClass() : null;
  }

  allocate(seatedPlayers) {
    const playerCount = seatedPlayers.length;
    
    // 先随机选择爪牙，检查是否有男爵
    // 策略：先按默认人数配比选角色，再根据男爵调整
    const defaultComp = getRoleComposition(playerCount, false);

    // 先选一轮不含男爵的角色，判断是否可能有男爵
    // 简化实现：随机决定是否有男爵，若有男爵则调整配比
    // 先临时选爪牙
    let selectedMinions = shuffle(MINION_ROLES).slice(0, defaultComp.minion);

    // 如果选到了男爵，需要多2个外来者少2个村民
    const hasBaron = selectedMinions.includes(ROLE_IDS.BARON);
    const composition = getRoleComposition(playerCount, hasBaron);

    // 重新选角色
    let selectedTownsfolk = shuffle(TOWNSFOLK_ROLES).slice(0, composition.townsfolk);
    let selectedOutsiders = shuffle(OUTSIDER_ROLES).slice(0, composition.outsider);

    // 确保酒鬼不在外来者中时，酒鬼"以为"自己是某个不在场的村民
    // 男爵存在时重新选爪牙（保证男爵被选中）
    if (hasBaron) {
      // 选爪牙：男爵 + 其他爪牙
      const otherMinions = MINION_ROLES.filter(r => r !== ROLE_IDS.BARON);
      selectedMinions = [ROLE_IDS.BARON, ...shuffle(otherMinions).slice(0, composition.minion - 1)];
    } else {
      selectedMinions = shuffle(MINION_ROLES.filter(r => r !== ROLE_IDS.BARON)).slice(0, composition.minion);
    }

    const selectedDemons = shuffle(DEMON_ROLES).slice(0, composition.demon);
    const selectedRoles = [...selectedTownsfolk, ...selectedOutsiders, ...selectedMinions, ...selectedDemons];
    
    // 计算不在场角色
    const notInPlay = ALL_ROLES.filter(r => !selectedRoles.includes(r));
    
    // 打乱玩家顺序分配角色
    const shuffledPlayers = shuffle([...seatedPlayers]);
    
    shuffledPlayers.forEach((player, i) => {
      player.role = this.createRoleInstance(selectedRoles[i]);
      player.isAlive = true;
      player.isDead = false;
      player.voteToken = 0;
      player.isPoisoned = false;
      player.isProtected = false;
      player.hasNominated = false;
      player.wasNominatedToday = false;
      player.hasUsedDayAbility = false;
      player.abilityState = {};
      player.privateInfo = null;
      player.deathNight = -1;
      player.deathDay = -1;
    });

    // 酒鬼处理：酒鬼以为自己是一个不在场的村民角色
    const drunkPlayers = shuffledPlayers.filter(p => p.role.id === ROLE_IDS.DRUNK);
    drunkPlayers.forEach(drunk => {
      // 选一个不在场的村民角色作为酒鬼"以为"的角色
      const notInPlayTownsfolk = TOWNSFOLK_ROLES.filter(r => !selectedTownsfolk.includes(r));
      if (notInPlayTownsfolk.length > 0) {
        const fakeRoleId = shuffle(notInPlayTownsfolk)[0];
        const fakeRole = this.createRoleInstance(fakeRoleId);
        drunk.drunkRole = fakeRoleId;
        // 酒鬼以为自己的身份
        drunk.fakeRole = fakeRole;
      }
    });

    // 记录在场/不在场角色
    this.engine.room.gameState.rolesInPlay = selectedRoles;
    this.engine.room.gameState.rolesNotInPlay = shuffle(notInPlay);
    this.engine.room.gameState.hasBaron = hasBaron;

    // 设置占卜师red herring（不产生日志）
    const fortuneteller = shuffledPlayers.find(p => p.role.id === 'fortuneteller');
    if (fortuneteller) {
      this.setupRedHerring(fortuneteller);
    }
  }

  // 自定义角色分配（测试用）：customRoles 是 { seatNumber: roleId } 映射
  allocateCustom(seatedPlayers, customRoles) {
    const playerCount = seatedPlayers.length;

    // 1. 初始化所有玩家状态
    seatedPlayers.forEach(p => {
      p.isAlive = true;
      p.isDead = false;
      p.voteToken = 0;
      p.isPoisoned = false;
      p.isProtected = false;
      p.hasNominated = false;
      p.wasNominatedToday = false;
      p.hasUsedDayAbility = false;
      p.abilityState = {};
      p.privateInfo = null;
      p.deathNight = -1;
      p.deathDay = -1;
      p.drunkRole = null;
      p.fakeRole = null;
    });

    // 2. 为已指定座位的玩家分配角色
    const assignedRoleIds = [];
    seatedPlayers.forEach(p => {
      if (customRoles[p.seat]) {
        const roleId = customRoles[p.seat];
        p.role = this.createRoleInstance(roleId);
        assignedRoleIds.push(roleId);
      }
    });

    // 3. 根据是否有男爵确定目标配比
    const hasBaron = assignedRoleIds.includes(ROLE_IDS.BARON);
    const composition = getRoleComposition(playerCount, hasBaron);

    // 4. 统计已指定角色中的各类型数量
    const counts = {
      townsfolk: assignedRoleIds.filter(r => TOWNSFOLK_ROLES.includes(r)).length,
      outsider: assignedRoleIds.filter(r => OUTSIDER_ROLES.includes(r)).length,
      minion: assignedRoleIds.filter(r => MINION_ROLES.includes(r)).length,
      demon: assignedRoleIds.filter(r => DEMON_ROLES.includes(r)).length
    };

    // 5. 计算各类型还需分配的数量（精确补全到配比）
    const needs = {
      demon: Math.max(0, composition.demon - counts.demon),
      minion: Math.max(0, composition.minion - counts.minion),
      outsider: Math.max(0, composition.outsider - counts.outsider),
      townsfolk: Math.max(0, composition.townsfolk - counts.townsfolk)
    };

    // 6. 未指定座位的玩家（打乱）
    const unassignedPlayers = shuffle(seatedPlayers.filter(p => !customRoles[p.seat]));

    // 辅助函数：从可用角色池中选取指定数量分配给未指定玩家
    const fillFromPool = (pool, need) => {
      const available = shuffle(pool.filter(r => !assignedRoleIds.includes(r)));
      const toAdd = available.slice(0, Math.min(need, available.length, unassignedPlayers.length));
      toAdd.forEach(roleId => {
        if (unassignedPlayers.length > 0) {
          const p = unassignedPlayers.shift();
          p.role = this.createRoleInstance(roleId);
          assignedRoleIds.push(roleId);
        }
      });
    };

    // 7. 按优先级精确补齐：恶魔 → 爪牙 → 村民 → 外来者
    fillFromPool(DEMON_ROLES, needs.demon);
    fillFromPool(MINION_ROLES, needs.minion);
    fillFromPool(TOWNSFOLK_ROLES, needs.townsfolk);
    fillFromPool(OUTSIDER_ROLES, needs.outsider);

    // 8. 兜底：如果还有剩余玩家（前端验证通过后不应出现），从未使用角色中随机补齐，不产生重复
    if (unassignedPlayers.length > 0) {
      const remaining = ALL_ROLES.filter(r => !assignedRoleIds.includes(r));
      const fallbackPool = remaining.length > 0 ? remaining : TOWNSFOLK_ROLES;
      unassignedPlayers.forEach(p => {
        const shuffled = shuffle(fallbackPool);
        const roleId = shuffled[0];
        p.role = this.createRoleInstance(roleId);
        assignedRoleIds.push(roleId);
        const idx = fallbackPool.indexOf(roleId);
        if (idx !== -1 && remaining.length > 0) fallbackPool.splice(idx, 1);
      });
    }

    // 9. 酒鬼假身份处理：酒鬼以为自己是一个不在场的村民角色
    const drunkPlayers = seatedPlayers.filter(p => p.role && p.role.id === ROLE_IDS.DRUNK);
    const assignedTownsfolk = assignedRoleIds.filter(r => TOWNSFOLK_ROLES.includes(r));
    drunkPlayers.forEach(drunk => {
      const notInPlayTownsfolk = TOWNSFOLK_ROLES.filter(r => !assignedTownsfolk.includes(r));
      const fakeRoleId = notInPlayTownsfolk.length > 0
        ? shuffle(notInPlayTownsfolk)[0]
        : shuffle(TOWNSFOLK_ROLES)[0];
      drunk.drunkRole = fakeRoleId;
      drunk.fakeRole = this.createRoleInstance(fakeRoleId);
    });

    // 10. 记录在场/不在场角色
    const allAssigned = [...new Set(assignedRoleIds)];
    this.engine.room.gameState.rolesInPlay = allAssigned;
    this.engine.room.gameState.rolesNotInPlay = shuffle(ALL_ROLES.filter(r => !allAssigned.includes(r)));
    this.engine.room.gameState.hasBaron = hasBaron;

    // 11. 设置占卜师 red herring
    const fortuneteller = seatedPlayers.find(p => p.role && p.role.id === ROLE_IDS.FORTUNETELLER);
    if (fortuneteller) {
      this.setupRedHerring(fortuneteller);
    }

    // 12. 日志
    const customAssigned = Object.entries(customRoles).map(([seat, rid]) => {
      const role = this.createRoleInstance(rid);
      return `${Number(seat)+1}号→${role ? role.name : rid}`;
    }).join(', ');
    this.engine.logAction('CUSTOM_ASSIGN', `[自定义] ${customAssigned || '无手动指定'}；男爵=${hasBaron ? '是' : '否'}；配比: 村民${composition.townsfolk}/外来者${composition.outsider}/爪牙${composition.minion}/恶魔${composition.demon}`);
  }

  // 设置邪恶阵营信息（在ROLE_ASSIGN日志之后调用）
  setupEvilTeamInfo(players) {
    this.setupDemonInfo(players);
    this.setupMinionInfo(players);
    // 设置酒鬼的假身份信息（酒鬼以为自己是某村民）
    this.setupDrunkInfo(players);
    // 设置间谍首夜看到魔典（间谍通过夜晚行动自动获取，这里不需要额外设置）
  }

  setupDrunkInfo(players) {
    const drunkPlayers = players.filter(p => p.role && p.role.id === ROLE_IDS.DRUNK);
    drunkPlayers.forEach(drunk => {
      if (drunk.fakeRole) {
        // 酒鬼看到的是假身份信息（玩家视角显示为假角色，上帝视角会标注）
        const fakeMsg = `你的身份是【${drunk.fakeRole.name}】（善良阵营·村民）\n技能：${drunk.fakeRole.abilityDesc}`;
        drunk.privateInfo = {
          type: 'role_info',
          role: {
            name: drunk.fakeRole.name,
            id: drunk.fakeRole.id,
            team: 'GOOD',
            category: 'TOWNSFOLK',
            abilityDesc: drunk.fakeRole.abilityDesc
          },
          message: fakeMsg,
          isDrunk: true,
          isFalse: true,
          realInfo: { realRole: '酒鬼' }
        };
        this.engine.io.to(drunk.id).emit('game:privateInfo', drunk.privateInfo);
        this.engine.logAction('PRIVATE_INFO', `${drunk.seat+1}号 ${drunk.name}（酒鬼）以为自己是【${drunk.fakeRole.name}】⚠️【假信息/酒鬼】`, {
          playerId: drunk.id,
          info: fakeMsg,
          isFalse: true,
          realInfo: { realRole: '酒鬼' }
        });
      }
    });
  }

  setupDemonInfo(players) {
    const demon = players.find(p => p.role.category === 'DEMON');
    if (!demon) return;

    const minions = players.filter(p => p.role.category === 'MINION');
    const notInPlay = this.engine.room.gameState.rolesNotInPlay.slice(0, 3);

    // 恶魔看到的爪牙（间谍可能被看成好人，但此处给恶魔真实信息）
    this.engine.setPlayerPrivateInfo(demon, {
      type: 'demon_info',
      minions: minions.map(m => ({ id: m.id, name: m.name, seat: m.seat, roleName: m.role.name })),
      notInPlay: notInPlay.map(roleId => {
        const role = this.createRoleInstance(roleId);
        return role ? role.name : roleId;
      }),
      message: `你的爪牙是：${minions.map(m => `${m.seat+1}号(${m.name})【${m.role.name}】`).join('、')}。不在场身份：${notInPlay.map(rid => {
        const r = this.createRoleInstance(rid);
        return r ? r.name : rid;
      }).join('、')}`
    });
  }

  setupMinionInfo(players) {
    const demon = players.find(p => p.role.category === 'DEMON');
    const minions = players.filter(p => p.role.category === 'MINION');

    minions.forEach(m => {
      // 酒鬼/隐士/间谍的干扰信息暂不在此处处理
      const otherMinions = minions.filter(x => x.id !== m.id);
      this.engine.setPlayerPrivateInfo(m, {
        type: 'minion_info',
        demon: demon ? { id: demon.id, name: demon.name, seat: demon.seat, roleName: demon.role.name } : null,
        teammates: otherMinions.map(om => ({ id: om.id, name: om.name, seat: om.seat, roleName: om.role.name })),
        message: `恶魔是：${demon ? `${demon.seat+1}号(${demon.name})【${demon.role.name}】` : '无'}${otherMinions.length > 0 ? '。队友：' + otherMinions.map(om => `${om.seat+1}号(${om.name})【${om.role.name}】`).join('、') : ''}`
      });
    });
  }

  // 设置占卜师red herring
  setupRedHerring(fortuneteller) {
    const players = Array.from(this.engine.room.players.values()).filter(p => p.seat !== -1);
    const demon = players.find(p => p.role.category === 'DEMON');
    if (!demon) return;

    const redHerring = BalanceSystem.selectRedHerring(players, demon, this.engine.room);
    fortuneteller.abilityState.redHerring = redHerring.id;
  }
}

module.exports = RoleAllocator;
