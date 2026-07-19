// 游戏配置 - 灾祸之酿剧本

// 人数配置：[玩家数, 村民, 外来者, 爪牙, 恶魔]
// 注意：如果有男爵在场，外来者+2、村民-2（在allocate时动态调整）
const ROLE_COMPOSITION = [
  [5, 3, 0, 1, 1],
  [6, 3, 1, 1, 1],
  [7, 5, 0, 1, 1],
  [8, 5, 1, 1, 1],
  [9, 5, 2, 1, 1],
  [10, 7, 0, 2, 1],
  [11, 7, 1, 2, 1],
  [12, 7, 2, 2, 1],
  [13, 9, 0, 3, 1],
  [14, 9, 1, 3, 1],
  [15, 9, 2, 3, 1]
];

function getRoleComposition(playerCount, hasBaron) {
  const entry = ROLE_COMPOSITION.find(c => c[0] === playerCount);
  if (!entry) return { townsfolk: 3, outsider: 0, minion: 1, demon: 1 };
  let townsfolk = entry[1];
  let outsider = entry[2];
  if (hasBaron) {
    townsfolk -= 2;
    outsider += 2;
  }
  return { townsfolk, outsider, minion: entry[3], demon: entry[4] };
}

// 角色ID定义
const ROLE_IDS = {
  // 村民
  WASHERWOMAN: 'washerwoman',
  LIBRARIAN: 'librarian',
  INVESTIGATOR: 'investigator',
  CHEF: 'chef',
  EMPATH: 'empath',
  FORTUNETELLER: 'fortuneteller',
  MONK: 'monk',
  RAVENKEEPER: 'ravenkeeper',
  VIRGIN: 'virgin',
  SLAYER: 'slayer',
  SOLDIER: 'soldier',
  MAYOR: 'mayor',
  UNDERTAKER: 'undertaker',
  // 外来者
  SAINT: 'saint',
  BUTLER: 'butler',
  DRUNK: 'drunk',
  RECLUSE: 'recluse',
  // 爪牙
  POISONER: 'poisoner',
  SCARLETWOMAN: 'scarletwoman',
  BARON: 'baron',
  SPY: 'spy',
  // 恶魔
  IMP: 'imp'
};

// 所有村民角色
const TOWNSFOLK_ROLES = [
  ROLE_IDS.WASHERWOMAN,
  ROLE_IDS.LIBRARIAN,
  ROLE_IDS.INVESTIGATOR,
  ROLE_IDS.CHEF,
  ROLE_IDS.EMPATH,
  ROLE_IDS.FORTUNETELLER,
  ROLE_IDS.MONK,
  ROLE_IDS.RAVENKEEPER,
  ROLE_IDS.VIRGIN,
  ROLE_IDS.SLAYER,
  ROLE_IDS.SOLDIER,
  ROLE_IDS.MAYOR,
  ROLE_IDS.UNDERTAKER
];

// 所有外来者角色
const OUTSIDER_ROLES = [
  ROLE_IDS.SAINT,
  ROLE_IDS.BUTLER,
  ROLE_IDS.DRUNK,
  ROLE_IDS.RECLUSE
];

// 所有爪牙角色
const MINION_ROLES = [
  ROLE_IDS.POISONER,
  ROLE_IDS.SCARLETWOMAN,
  ROLE_IDS.BARON,
  ROLE_IDS.SPY
];

// 所有恶魔角色
const DEMON_ROLES = [
  ROLE_IDS.IMP
];

const ALL_ROLES = [...TOWNSFOLK_ROLES, ...OUTSIDER_ROLES, ...MINION_ROLES, ...DEMON_ROLES];

// 第一夜行动顺序（角色ID）
const FIRST_NIGHT_ORDER = [
  ROLE_IDS.POISONER,
  ROLE_IDS.BUTLER,
  ROLE_IDS.SPY,
  ROLE_IDS.IMP, // 恶魔得知信息
  ROLE_IDS.WASHERWOMAN,
  ROLE_IDS.LIBRARIAN,
  ROLE_IDS.INVESTIGATOR,
  ROLE_IDS.CHEF,
  ROLE_IDS.EMPATH,
  ROLE_IDS.FORTUNETELLER,
  ROLE_IDS.UNDERTAKER
];

// 其他夜晚行动顺序
const OTHER_NIGHT_ORDER = [
  ROLE_IDS.POISONER,
  ROLE_IDS.MONK,
  ROLE_IDS.BUTLER,
  ROLE_IDS.SPY,
  ROLE_IDS.IMP, // 恶魔杀人
  ROLE_IDS.RAVENKEEPER,
  ROLE_IDS.EMPATH,
  ROLE_IDS.FORTUNETELLER,
  ROLE_IDS.UNDERTAKER
];

// 阶段枚举
const PHASES = {
  LOBBY: 'LOBBY',
  FIRST_NIGHT: 'FIRST_NIGHT',
  NIGHT_WAKE: 'NIGHT_WAKE',     // 夜晚唤醒单个角色
  DAY_DAWN: 'DAY_DAWN',         // 天亮公布死亡
  DAY_DISCUSSION: 'DAY_DISCUSSION', // 白天讨论
  NOMINATION_PHASE: 'NOMINATION_PHASE', // 提名阶段
  DEFENSE: 'DEFENSE',           // 辩护阶段
  VOTING: 'VOTING',             // 投票阶段
  EXECUTION: 'EXECUTION',       // 处决阶段
  NIGHT: 'NIGHT',               // 常规夜晚
  GAME_OVER: 'GAME_OVER'
};

module.exports = {
  getRoleComposition,
  ROLE_IDS,
  TOWNSFOLK_ROLES,
  OUTSIDER_ROLES,
  MINION_ROLES,
  DEMON_ROLES,
  ALL_ROLES,
  FIRST_NIGHT_ORDER,
  OTHER_NIGHT_ORDER,
  PHASES
};
