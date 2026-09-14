// 身份分配器 - 支持多剧本
const {
  getRoleComposition,
  getScriptConfig,
  ROLE_IDS,
  BMR_ROLE_IDS
} = require('../config/game-config');
const { shuffle } = require('../utils/helpers');

// TB 角色类
const {
  Washerwoman, Librarian, Investigator, Chef, Empath, Fortuneteller,
  Monk, Ravenkeeper, Virgin, Slayer, Soldier, Mayor, Undertaker
} = require('../roles/Townsfolk');
const { Saint, Butler, Drunk, Recluse } = require('../roles/Outsider');
const { Poisoner, ScarletWoman, Baron, Spy } = require('../roles/Minion');
const { Imp } = require('../roles/Demon');

// BMR 角色类
const {
  Grandmother, Sailor, Maid, Exorcist, Innkeeper, Gambler,
  Gossip, Courtier, Professor, Bard, Tealady, Pacifist, Fool
} = require('../roles/Townsfolk2');
const { Tinker, Moonchild, Lunatic, Madman } = require('../roles/Outsider2');
const { Godfather, DevilsAdvocate, Assassin, Mastermind } = require('../roles/Minion2');
const { Zombuul, Pukka, Shabaloth, Po } = require('../roles/Demon2');

const BalanceSystem = require('./BalanceSystem');

// 合并所有角色实例映射
const ROLE_INSTANCES = {
  // TB
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
  [ROLE_IDS.IMP]: Imp,
  // BMR
  [BMR_ROLE_IDS.GRANDMOTHER]: Grandmother,
  [BMR_ROLE_IDS.SAILOR]: Sailor,
  [BMR_ROLE_IDS.MAID]: Maid,
  [BMR_ROLE_IDS.EXORCIST]: Exorcist,
  [BMR_ROLE_IDS.INNKEEPER]: Innkeeper,
  [BMR_ROLE_IDS.GAMBLER]: Gambler,
  [BMR_ROLE_IDS.GOSSIP]: Gossip,
  [BMR_ROLE_IDS.COURTIER]: Courtier,
  [BMR_ROLE_IDS.PROFESSOR]: Professor,
  [BMR_ROLE_IDS.BARD]: Bard,
  [BMR_ROLE_IDS.TEALADY]: Tealady,
  [BMR_ROLE_IDS.PACIFIST]: Pacifist,
  [BMR_ROLE_IDS.FOOL]: Fool,
  [BMR_ROLE_IDS.TINKER]: Tinker,
  [BMR_ROLE_IDS.MOONCHILD]: Moonchild,
  [BMR_ROLE_IDS.LUNATIC]: Lunatic,
  [BMR_ROLE_IDS.MADMAN]: Madman,
  [BMR_ROLE_IDS.GODFATHER]: Godfather,
  [BMR_ROLE_IDS.DEVILSADVOCATE]: DevilsAdvocate,
  [BMR_ROLE_IDS.ASSASSIN]: Assassin,
  [BMR_ROLE_IDS.MASTERMIND]: Mastermind,
  [BMR_ROLE_IDS.ZOMBUUL]: Zombuul,
  [BMR_ROLE_IDS.PUKKA]: Pukka,
  [BMR_ROLE_IDS.SHABALOTH]: Shabaloth,
  [BMR_ROLE_IDS.PO]: Po
};

class RoleAllocator {
  constructor(engine) {
    this.engine = engine;
  }

  get scriptConfig() {
    const scriptId = this.engine.room.script || 'tb';
    return getScriptConfig(scriptId);
  }

  createRoleInstance(roleId) {
    const RoleClass = ROLE_INSTANCES[roleId];
    return RoleClass ? new RoleClass() : null;
  }

  // 获取假身份候选角色（TB: 不在场的村民；BMR: 不在场的恶魔给疯子/莽夫）
  getFakeRolePool(scriptConfig, selectedRoles, category) {
    const pool = category === 'TOWNSFOLK' ? scriptConfig.townsfolkRoles : scriptConfig.demonRoles;
    return pool.filter(r => !selectedRoles.includes(r));
  }

  allocate(seatedPlayers) {
    const playerCount = seatedPlayers.length;
    const sc = this.scriptConfig;

    // 检查是否有影响配置的爪牙（TB:男爵, BMR:教父）
    const setupCharId = sc.setupCharacterId;
    const setupType = sc.setupType;

    // 先临时选爪牙判断是否有setup角色
    const defaultComp = getRoleComposition(playerCount, false, setupType);
    let selectedMinions = shuffle(sc.minionRoles).slice(0, defaultComp.minion);
    const hasSetupChar = selectedMinions.includes(setupCharId);
    const composition = getRoleComposition(playerCount, hasSetupChar, setupType);

    // 重新选角色
    let selectedTownsfolk = shuffle(sc.townsfolkRoles).slice(0, composition.townsfolk);
    let selectedOutsiders = shuffle(sc.outsiderRoles).slice(0, composition.outsider);

    if (hasSetupChar) {
      const otherMinions = sc.minionRoles.filter(r => r !== setupCharId);
      selectedMinions = [setupCharId, ...shuffle(otherMinions).slice(0, composition.minion - 1)];
    } else {
      selectedMinions = shuffle(sc.minionRoles.filter(r => r !== setupCharId)).slice(0, composition.minion);
    }

    const selectedDemons = shuffle(sc.demonRoles).slice(0, composition.demon);
    const selectedRoles = [...selectedTownsfolk, ...selectedOutsiders, ...selectedMinions, ...selectedDemons];

    const notInPlay = sc.allRoles.filter(r => !selectedRoles.includes(r));

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
      player.privateInfoHistory = [];
      player.deathNight = -1;
      player.deathDay = -1;
      player.drunkRole = null;
      player.fakeRole = null;
    });

    // 假身份处理
    this.assignFakeRoles(shuffledPlayers, sc, selectedTownsfolk, selectedDemons);

    // 记录在场/不在场角色
    this.engine.room.gameState.rolesInPlay = selectedRoles;
    this.engine.room.gameState.rolesNotInPlay = shuffle(notInPlay);
    this.engine.room.gameState.hasBaron = hasSetupChar;
    this.engine.room.gameState.setupCharId = hasSetupChar ? setupCharId : null;

    // TB: 设置占卜师red herring
    if (scriptId_or_tb(this.engine.room) === 'tb') {
      const fortuneteller = shuffledPlayers.find(p => p.role.id === 'fortuneteller');
      if (fortuneteller) this.setupRedHerring(fortuneteller);
    }
  }

  // 分配假身份（TB:酒鬼→假村民；BMR:疯子/莽夫→假恶魔）
  assignFakeRoles(players, sc, selectedTownsfolk, selectedDemons) {
    // TB: 酒鬼
    const drunkPlayers = players.filter(p => p.role.id === 'drunk');
    drunkPlayers.forEach(drunk => {
      const notInPlayTownsfolk = sc.townsfolkRoles.filter(r => !selectedTownsfolk.includes(r));
      if (notInPlayTownsfolk.length > 0) {
        const fakeRoleId = shuffle(notInPlayTownsfolk)[0];
        drunk.drunkRole = fakeRoleId;
        drunk.fakeRole = this.createRoleInstance(fakeRoleId);
      }
    });

    // BMR: 只有疯子以为自己是不在场的恶魔；莽夫（Goon）是普通外来者，没有假身份
    const fakeDemonPlayers = players.filter(p => p.role.id === 'madman');
    fakeDemonPlayers.forEach(player => {
      const notInPlayDemons = sc.demonRoles.filter(r => !selectedDemons.includes(r));
      const pool = notInPlayDemons.length > 0 ? notInPlayDemons : sc.demonRoles;
      const fakeRoleId = shuffle(pool)[0];
      player.fakeRole = this.createRoleInstance(fakeRoleId);
    });
  }

  allocateCustom(seatedPlayers, customRoles) {
    const playerCount = seatedPlayers.length;
    const sc = this.scriptConfig;
    const setupCharId = sc.setupCharacterId;
    const setupType = sc.setupType;

    seatedPlayers.forEach(p => {
      p.isAlive = true; p.isDead = false; p.voteToken = 0;
      p.isPoisoned = false; p.isProtected = false;
      p.hasNominated = false; p.wasNominatedToday = false;
      p.hasUsedDayAbility = false; p.abilityState = {};
      p.privateInfo = null; p.privateInfoHistory = [];
      p.deathNight = -1; p.deathDay = -1;
      p.drunkRole = null; p.fakeRole = null;
    });

    const assignedRoleIds = [];
    seatedPlayers.forEach(p => {
      if (customRoles[p.seat]) {
        const roleId = customRoles[p.seat];
        p.role = this.createRoleInstance(roleId);
        assignedRoleIds.push(roleId);
      }
    });

    const hasSetupChar = assignedRoleIds.includes(setupCharId);
    const composition = getRoleComposition(playerCount, hasSetupChar, setupType);

    const counts = {
      townsfolk: assignedRoleIds.filter(r => sc.townsfolkRoles.includes(r)).length,
      outsider: assignedRoleIds.filter(r => sc.outsiderRoles.includes(r)).length,
      minion: assignedRoleIds.filter(r => sc.minionRoles.includes(r)).length,
      demon: assignedRoleIds.filter(r => sc.demonRoles.includes(r)).length
    };

    const needs = {
      demon: Math.max(0, composition.demon - counts.demon),
      minion: Math.max(0, composition.minion - counts.minion),
      outsider: Math.max(0, composition.outsider - counts.outsider),
      townsfolk: Math.max(0, composition.townsfolk - counts.townsfolk)
    };

    const unassignedPlayers = shuffle(seatedPlayers.filter(p => !customRoles[p.seat]));

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

    fillFromPool(sc.demonRoles, needs.demon);
    fillFromPool(sc.minionRoles, needs.minion);
    fillFromPool(sc.townsfolkRoles, needs.townsfolk);
    fillFromPool(sc.outsiderRoles, needs.outsider);

    if (unassignedPlayers.length > 0) {
      const remaining = sc.allRoles.filter(r => !assignedRoleIds.includes(r));
      const fallbackPool = remaining.length > 0 ? remaining : sc.townsfolkRoles;
      unassignedPlayers.forEach(p => {
        const shuffled = shuffle(fallbackPool);
        const roleId = shuffled[0];
        p.role = this.createRoleInstance(roleId);
        assignedRoleIds.push(roleId);
        const idx = fallbackPool.indexOf(roleId);
        if (idx !== -1 && remaining.length > 0) fallbackPool.splice(idx, 1);
      });
    }

    // 假身份处理
    const assignedTownsfolk = assignedRoleIds.filter(r => sc.townsfolkRoles.includes(r));
    const assignedDemons = assignedRoleIds.filter(r => sc.demonRoles.includes(r));
    this.assignFakeRoles(seatedPlayers, sc, assignedTownsfolk, assignedDemons);

    const allAssigned = [...new Set(assignedRoleIds)];
    this.engine.room.gameState.rolesInPlay = allAssigned;
    this.engine.room.gameState.rolesNotInPlay = shuffle(sc.allRoles.filter(r => !allAssigned.includes(r)));
    this.engine.room.gameState.hasBaron = hasSetupChar;
    this.engine.room.gameState.setupCharId = hasSetupChar ? setupCharId : null;

    // TB: 设置占卜师 red herring
    if ((this.engine.room.script || 'tb') === 'tb') {
      const fortuneteller = seatedPlayers.find(p => p.role && p.role.id === ROLE_IDS.FORTUNETELLER);
      if (fortuneteller) this.setupRedHerring(fortuneteller);
    }

    const customAssigned = Object.entries(customRoles).map(([seat, rid]) => {
      const role = this.createRoleInstance(rid);
      return `${Number(seat)+1}号→${role ? role.name : rid}`;
    }).join(', ');
    this.engine.logAction('CUSTOM_ASSIGN', `[自定义] ${customAssigned || '无手动指定'}；${setupCharId}=${hasSetupChar ? '是' : '否'}；配比: 村民${composition.townsfolk}/外来者${composition.outsider}/爪牙${composition.minion}/恶魔${composition.demon}`);
  }

  // 设置邪恶阵营信息
  setupEvilTeamInfo(players) {
    this.setupDemonInfo(players);
    this.setupMinionInfo(players);
    this.setupDrunkInfo(players);
    this.setupFakeDemonInfo(players);
  }

  setupDrunkInfo(players) {
    const drunkPlayers = players.filter(p => p.role && p.role.id === 'drunk');
    drunkPlayers.forEach(drunk => {
      if (drunk.fakeRole) {
        const fakeMsg = `你的身份是【${drunk.fakeRole.name}】（善良阵营·村民）\n技能：${drunk.fakeRole.abilityDesc}`;
        drunk.privateInfo = {
          type: 'role_info',
          role: { name: drunk.fakeRole.name, id: drunk.fakeRole.id, team: 'GOOD', category: 'TOWNSFOLK', abilityDesc: drunk.fakeRole.abilityDesc },
          message: fakeMsg, isDrunk: true, isFalse: true, realInfo: { realRole: '酒鬼' },
          day: 0, phase: 'FIRST_NIGHT', id: 'info_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)
        };
        drunk.privateInfoHistory = [drunk.privateInfo];
        this.engine.io.to(drunk.id).emit('game:privateInfo', drunk.privateInfo);
        this.engine.logAction('PRIVATE_INFO', `${drunk.seat+1}号 ${drunk.name}（酒鬼）以为自己是【${drunk.fakeRole.name}】⚠️`, {
          playerId: drunk.id, info: fakeMsg, isFalse: true, realInfo: { realRole: '酒鬼' }
        });
      }
    });
  }

  // BMR: 疯子以为自己是恶魔
  setupFakeDemonInfo(players) {
    const fakeDemonPlayers = players.filter(p => p.role && p.role.id === 'madman');
    const realDemon = players.find(p => p.role.category === 'DEMON' && !p.role.isFakeDemon);

    fakeDemonPlayers.forEach(player => {
      if (!player.fakeRole) return;
      const fakeName = player.fakeRole.name;
      const fakeMsg = `你的身份是【${fakeName}】（邪恶阵营·恶魔）\n技能：${player.fakeRole.abilityDesc}`;

      // 给假恶魔发恶魔信息（爪牙 + 不在场角色）
      const minions = players.filter(p => p.role.category === 'MINION');
      const notInPlay = this.engine.room.gameState.rolesNotInPlay.slice(0, 3);
      const minionInfo = minions.map(m => `${m.seat+1}号(${m.name})【${m.role.name}】`).join('、');
      const notInPlayNames = notInPlay.map(rid => {
        const r = this.createRoleInstance(rid);
        return r ? r.name : rid;
      }).join('、');

      player.privateInfo = {
        type: 'role_info',
        role: { name: fakeName, id: player.fakeRole.id, team: 'EVIL', category: 'DEMON', abilityDesc: player.fakeRole.abilityDesc },
        message: `${fakeMsg}\n你的爪牙是：${minionInfo}。不在场身份：${notInPlayNames}`,
        isFalse: true, realInfo: { realRole: player.role.name },
        day: 0, phase: 'FIRST_NIGHT', id: 'info_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)
      };
      player.privateInfoHistory = [player.privateInfo];
      this.engine.io.to(player.id).emit('game:privateInfo', player.privateInfo);
      this.engine.logAction('PRIVATE_INFO', `${player.seat+1}号 ${player.name}（${player.role.name}）以为自己是【${fakeName}】⚠️`, {
        playerId: player.id, info: fakeMsg, isFalse: true, realInfo: { realRole: player.role.name }
      });
    });

    // 通知真恶魔关于疯子/莽夫的存在
    if (realDemon && fakeDemonPlayers.length > 0) {
      const fakeDemonInfo = fakeDemonPlayers.map(p => `${p.seat+1}号 ${p.name}（${p.role.name}，以为是${p.fakeRole ? p.fakeRole.name : '恶魔'}）`).join('、');
      this.engine.setPlayerPrivateInfo(realDemon, {
        type: 'fake_demon_info',
        message: `以下玩家以为自己是恶魔，但实际不是：${fakeDemonInfo}`
      });
    }
  }

  setupDemonInfo(players) {
    const demon = players.find(p => p.role.category === 'DEMON' && !p.role.isFakeDemon);
    if (!demon) return;

    const minions = players.filter(p => p.role.category === 'MINION');
    const notInPlay = this.engine.room.gameState.rolesNotInPlay.slice(0, 3);

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
    const demon = players.find(p => p.role.category === 'DEMON' && !p.role.isFakeDemon);
    const minions = players.filter(p => p.role.category === 'MINION');

    minions.forEach(m => {
      const otherMinions = minions.filter(x => x.id !== m.id);
      this.engine.setPlayerPrivateInfo(m, {
        type: 'minion_info',
        demon: demon ? { id: demon.id, name: demon.name, seat: demon.seat, roleName: demon.role.name } : null,
        teammates: otherMinions.map(om => ({ id: om.id, name: om.name, seat: om.seat, roleName: om.role.name })),
        message: `恶魔是：${demon ? `${demon.seat+1}号(${demon.name})【${demon.role.name}】` : '无'}${otherMinions.length > 0 ? '。队友：' + otherMinions.map(om => `${om.seat+1}号(${om.name})【${om.role.name}】`).join('、') : ''}`
      });
    });
  }

  setupRedHerring(fortuneteller) {
    const players = Array.from(this.engine.room.players.values()).filter(p => p.seat !== -1);
    const demon = players.find(p => p.role.category === 'DEMON' && !p.role.isFakeDemon);
    if (!demon) return;

    const result = BalanceSystem.selectRedHerring(players, demon, this.engine);
    fortuneteller.abilityState.redHerring = result.player.id;
    this.engine.logAction('ABILITY', `占卜师红鲱鱼设置为 ${result.player.seat+1}号 ${result.player.name}（${result.player.role.name}）`, {
      playerId: fortuneteller.id, redHerringId: result.player.id, probInfo: result.probInfo
    });
  }
}

// 辅助函数
function scriptId_or_tb(room) {
  return room.script || 'tb';
}

module.exports = RoleAllocator;
