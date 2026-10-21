// 游戏配置 - 多剧本支持

// 人数配置：[玩家数, 村民, 外来者, 爪牙, 恶魔]
// 注意：如果有男爵(TB)在场，外来者+2、村民-2；如果有教父(BMR)在场，外来者+1或-1
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

// setupDelta：教父的「外来者 ±1」方向。
// 传入 1 / -1 时按房主（自定义角色模式）的指定值执行，否则随机。
// 返回值含 setupDelta（实际生效的方向：1 / -1 / 0 表示不变化），便于日志与前端展示。
function getRoleComposition(playerCount, hasSetupChar, setupType = 'baron', setupDelta = null) {
  const entry = ROLE_COMPOSITION.find(c => c[0] === playerCount);
  if (!entry) return { townsfolk: 3, outsider: 0, minion: 1, demon: 1, setupDelta: null };
  let townsfolk = entry[1];
  let outsider = entry[2];
  let appliedDelta = null;
  if (hasSetupChar) {
    if (setupType === 'baron') {
      townsfolk -= 2;
      outsider += 2;
    } else if (setupType === 'godfather') {
      // 教父：外来者+1或-1。外来者基准为 0 时 -1 无处可减，
      // 此时按「不变化」处理（否则村民会被凭空 +1，总人数对不上）。
      let delta = (setupDelta === 1 || setupDelta === -1)
        ? setupDelta
        : (Math.random() < 0.5 ? 1 : -1);
      if (outsider + delta < 0) delta = 0;
      outsider += delta;
      townsfolk -= delta;
      appliedDelta = delta;
    }
  }
  return { townsfolk, outsider, minion: entry[3], demon: entry[4], setupDelta: appliedDelta };
}

// ==================== 灾祸之酿 (TB) ====================
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

const TOWNSFOLK_ROLES = [
  ROLE_IDS.WASHERWOMAN, ROLE_IDS.LIBRARIAN, ROLE_IDS.INVESTIGATOR,
  ROLE_IDS.CHEF, ROLE_IDS.EMPATH, ROLE_IDS.FORTUNETELLER,
  ROLE_IDS.MONK, ROLE_IDS.RAVENKEEPER, ROLE_IDS.VIRGIN,
  ROLE_IDS.SLAYER, ROLE_IDS.SOLDIER, ROLE_IDS.MAYOR, ROLE_IDS.UNDERTAKER
];

const OUTSIDER_ROLES = [ROLE_IDS.SAINT, ROLE_IDS.BUTLER, ROLE_IDS.DRUNK, ROLE_IDS.RECLUSE];
const MINION_ROLES = [ROLE_IDS.POISONER, ROLE_IDS.SCARLETWOMAN, ROLE_IDS.BARON, ROLE_IDS.SPY];
const DEMON_ROLES = [ROLE_IDS.IMP];
const ALL_ROLES = [...TOWNSFOLK_ROLES, ...OUTSIDER_ROLES, ...MINION_ROLES, ...DEMON_ROLES];

const FIRST_NIGHT_ORDER = [
  ROLE_IDS.POISONER, ROLE_IDS.BUTLER, ROLE_IDS.SPY, ROLE_IDS.IMP,
  ROLE_IDS.WASHERWOMAN, ROLE_IDS.LIBRARIAN, ROLE_IDS.INVESTIGATOR,
  ROLE_IDS.CHEF, ROLE_IDS.EMPATH, ROLE_IDS.FORTUNETELLER, ROLE_IDS.UNDERTAKER
];

const OTHER_NIGHT_ORDER = [
  ROLE_IDS.POISONER, ROLE_IDS.MONK, ROLE_IDS.BUTLER, ROLE_IDS.SPY,
  ROLE_IDS.IMP, ROLE_IDS.RAVENKEEPER, ROLE_IDS.EMPATH, ROLE_IDS.FORTUNETELLER, ROLE_IDS.UNDERTAKER
];

// ==================== 黯月初升 (BMR) ====================
const BMR_ROLE_IDS = {
  // 村民
  GRANDMOTHER: 'grandmother',
  SAILOR: 'sailor',
  MAID: 'maid',
  EXORCIST: 'exorcist',
  INNKEEPER: 'innkeeper',
  GAMBLER: 'gambler',
  GOSSIP: 'gossip',
  COURTIER: 'courtier',
  PROFESSOR: 'professor',
  BARD: 'bard',
  TEALADY: 'tealady',
  PACIFIST: 'pacifist',
  FOOL: 'fool',
  // 外来者
  TINKER: 'tinker',
  MOONCHILD: 'moonchild',
  LUNATIC: 'lunatic',
  MADMAN: 'madman',
  // 爪牙
  GODFATHER: 'godfather',
  DEVILSADVOCATE: 'devilsadvocate',
  ASSASSIN: 'assassin',
  MASTERMIND: 'mastermind',
  // 恶魔
  ZOMBUUL: 'zombuul',
  PUKKA: 'pukka',
  SHABALOTH: 'shabaloth',
  PO: 'po'
};

const BMR_TOWNSFOLK_ROLES = [
  BMR_ROLE_IDS.GRANDMOTHER, BMR_ROLE_IDS.SAILOR, BMR_ROLE_IDS.MAID,
  BMR_ROLE_IDS.EXORCIST, BMR_ROLE_IDS.INNKEEPER, BMR_ROLE_IDS.GAMBLER,
  BMR_ROLE_IDS.GOSSIP, BMR_ROLE_IDS.COURTIER, BMR_ROLE_IDS.PROFESSOR,
  BMR_ROLE_IDS.BARD, BMR_ROLE_IDS.TEALADY, BMR_ROLE_IDS.PACIFIST, BMR_ROLE_IDS.FOOL
];

const BMR_OUTSIDER_ROLES = [BMR_ROLE_IDS.TINKER, BMR_ROLE_IDS.MOONCHILD, BMR_ROLE_IDS.LUNATIC, BMR_ROLE_IDS.MADMAN];
const BMR_MINION_ROLES = [BMR_ROLE_IDS.GODFATHER, BMR_ROLE_IDS.DEVILSADVOCATE, BMR_ROLE_IDS.ASSASSIN, BMR_ROLE_IDS.MASTERMIND];
const BMR_DEMON_ROLES = [BMR_ROLE_IDS.ZOMBUUL, BMR_ROLE_IDS.PUKKA, BMR_ROLE_IDS.SHABALOTH, BMR_ROLE_IDS.PO];
const BMR_ALL_ROLES = [...BMR_TOWNSFOLK_ROLES, ...BMR_OUTSIDER_ROLES, ...BMR_MINION_ROLES, ...BMR_DEMON_ROLES];

// 注意：恶魔角色ID必须出现在首夜顺序中，假恶魔（疯子）才能在首夜被唤醒；
// 真恶魔首夜不行动的过滤逻辑在 NightResolver.buildNightQueue 中处理（普卡除外）。
const BMR_FIRST_NIGHT_ORDER = [
  BMR_ROLE_IDS.GODFATHER,     // 教父得知外来者
  BMR_ROLE_IDS.ZOMBUUL,       // 仅用于唤醒假恶魔（疯子）
  BMR_ROLE_IDS.PUKKA,         // 普卡首夜即中毒（技能表：每个夜晚）
  BMR_ROLE_IDS.SHABALOTH,     // 仅用于唤醒假恶魔（疯子）
  BMR_ROLE_IDS.PO,            // 仅用于唤醒假恶魔（疯子）
  BMR_ROLE_IDS.GRANDMOTHER,
  BMR_ROLE_IDS.SAILOR,
  BMR_ROLE_IDS.EXORCIST,
  BMR_ROLE_IDS.COURTIER,
  BMR_ROLE_IDS.MAID,
  BMR_ROLE_IDS.DEVILSADVOCATE  // 技能表为「每个夜晚」，首夜同样守护，否则第一天的处决无法被保护
];

// 驱魔人必须排在恶魔之前，否则「该恶魔能力失效」当晚无法生效
const BMR_OTHER_NIGHT_ORDER = [
  BMR_ROLE_IDS.SAILOR,
  BMR_ROLE_IDS.INNKEEPER,
  BMR_ROLE_IDS.DEVILSADVOCATE,
  BMR_ROLE_IDS.EXORCIST,
  BMR_ROLE_IDS.ZOMBUUL,
  BMR_ROLE_IDS.PUKKA,
  BMR_ROLE_IDS.SHABALOTH,
  BMR_ROLE_IDS.PO,
  BMR_ROLE_IDS.COURTIER,
  BMR_ROLE_IDS.PROFESSOR,
  BMR_ROLE_IDS.ASSASSIN,
  BMR_ROLE_IDS.GODFATHER,
  BMR_ROLE_IDS.GAMBLER,
  BMR_ROLE_IDS.GRANDMOTHER,
  BMR_ROLE_IDS.MAID
];

// ==================== 紫罗兰教派 (SNV) ====================
const SNV_ROLE_IDS = {
  // 村民
  CLOCKMAKER: 'clockmaker',
  DREAMER: 'dreamer',
  SNAKECHARMER: 'snakecharmer',
  MATHEMATICIAN: 'mathematician',
  FLOWERGIRL: 'flowergirl',
  TOWNCRIER: 'towncrier',
  ORACLE: 'oracle',
  SAVANT: 'savant',
  SEAMSTRESS: 'seamstress',
  PHILOSOPHER: 'philosopher',
  ARTIST: 'artist',
  JUGGLER: 'juggler',
  SAGE: 'sage',
  // 外来者
  MUTANT: 'mutant',
  SWEETHEART: 'sweetheart',
  BARBER: 'barber',
  KLUTZ: 'klutz',
  // 爪牙
  EVILTWIN: 'eviltwin',
  WITCH: 'witch',
  CERENOVUS: 'cerenovus',
  PITHAG: 'pithag',
  // 恶魔
  FANGGU: 'fanggu',
  VIGORMORTIS: 'vigormortis',
  NODASHII: 'nodashii',
  VORTOX: 'vortox'
};

const SNV_TOWNSFOLK_ROLES = [
  SNV_ROLE_IDS.CLOCKMAKER, SNV_ROLE_IDS.DREAMER, SNV_ROLE_IDS.SNAKECHARMER,
  SNV_ROLE_IDS.MATHEMATICIAN, SNV_ROLE_IDS.FLOWERGIRL, SNV_ROLE_IDS.TOWNCRIER,
  SNV_ROLE_IDS.ORACLE, SNV_ROLE_IDS.SAVANT, SNV_ROLE_IDS.SEAMSTRESS,
  SNV_ROLE_IDS.PHILOSOPHER, SNV_ROLE_IDS.ARTIST, SNV_ROLE_IDS.JUGGLER, SNV_ROLE_IDS.SAGE
];

const SNV_OUTSIDER_ROLES = [
  SNV_ROLE_IDS.MUTANT, SNV_ROLE_IDS.SWEETHEART, SNV_ROLE_IDS.BARBER, SNV_ROLE_IDS.KLUTZ
];
const SNV_MINION_ROLES = [
  SNV_ROLE_IDS.EVILTWIN, SNV_ROLE_IDS.WITCH, SNV_ROLE_IDS.CERENOVUS, SNV_ROLE_IDS.PITHAG
];
const SNV_DEMON_ROLES = [
  SNV_ROLE_IDS.FANGGU, SNV_ROLE_IDS.VIGORMORTIS, SNV_ROLE_IDS.NODASHII, SNV_ROLE_IDS.VORTOX
];
const SNV_ALL_ROLES = [
  ...SNV_TOWNSFOLK_ROLES, ...SNV_OUTSIDER_ROLES, ...SNV_MINION_ROLES, ...SNV_DEMON_ROLES
];

// 首夜：恶魔不行动（与 TB 小恶魔一致），因此恶魔角色不列入首夜顺序。
// 花艺师/公告员/神谕者/数学家的信息依赖「刚刚过去的白天」，首夜无可报信息，
// 由各自 getNightWakeInfo 在首夜返回 null，这里仍列入以保持顺序表完整。
// 官方首夜顺序：爪牙互认/恶魔得知爪牙（在第 1 步统一处理）→ 哲学家 → 舞蛇人
// → 邪恶双子 → 女巫 → 洗脑师 → 钟表匠 → 入梦人 → 裁缝 → 数学家
// （坑巫首夜不行动）
const SNV_FIRST_NIGHT_ORDER = [
  SNV_ROLE_IDS.PHILOSOPHER,
  SNV_ROLE_IDS.SNAKECHARMER,
  SNV_ROLE_IDS.EVILTWIN,
  SNV_ROLE_IDS.WITCH,
  SNV_ROLE_IDS.CERENOVUS,
  SNV_ROLE_IDS.CLOCKMAKER,
  SNV_ROLE_IDS.DREAMER,
  SNV_ROLE_IDS.SEAMSTRESS,
  SNV_ROLE_IDS.MATHEMATICIAN
];

// 恶魔必须排在杀人前的位置之前完成信息/毒杀类结算（方古的「首次外来者」跳转在
// resolveDemonKills 中统一处理），因此恶魔放在中段唤醒。
const SNV_OTHER_NIGHT_ORDER = [
  SNV_ROLE_IDS.PHILOSOPHER,
  SNV_ROLE_IDS.SNAKECHARMER,
  SNV_ROLE_IDS.WITCH,
  SNV_ROLE_IDS.CERENOVUS,
  SNV_ROLE_IDS.PITHAG,
  SNV_ROLE_IDS.FANGGU,
  SNV_ROLE_IDS.VIGORMORTIS,
  SNV_ROLE_IDS.NODASHII,
  SNV_ROLE_IDS.VORTOX,
  SNV_ROLE_IDS.JUGGLER,
  SNV_ROLE_IDS.DREAMER,
  SNV_ROLE_IDS.SEAMSTRESS,
  SNV_ROLE_IDS.FLOWERGIRL,
  SNV_ROLE_IDS.TOWNCRIER,
  SNV_ROLE_IDS.ORACLE,
  SNV_ROLE_IDS.MATHEMATICIAN
];

// SNV 恶魔自带的配比修正（外来者 ±1）
const SNV_DEMON_SETUP_DELTA = {
  [SNV_ROLE_IDS.FANGGU]: 1,       // 方古：外来者 +1，村民 -1
  [SNV_ROLE_IDS.VIGORMORTIS]: -1  // 亡灵法师：外来者 -1，村民 +1
};

// ==================== 剧本注册表 ====================
const SCRIPTS = {
  tb: {
    id: 'tb',
    name: '灾祸之酿',
    nameEn: 'Trouble Brewing',
    roleIds: ROLE_IDS,
    townsfolkRoles: TOWNSFOLK_ROLES,
    outsiderRoles: OUTSIDER_ROLES,
    minionRoles: MINION_ROLES,
    demonRoles: DEMON_ROLES,
    allRoles: ALL_ROLES,
    firstNightOrder: FIRST_NIGHT_ORDER,
    otherNightOrder: OTHER_NIGHT_ORDER,
    setupCharacterId: 'baron',
    setupType: 'baron'
  },
  bmr: {
    id: 'bmr',
    name: '黯月初升',
    nameEn: 'Bad Moon Rising',
    roleIds: BMR_ROLE_IDS,
    townsfolkRoles: BMR_TOWNSFOLK_ROLES,
    outsiderRoles: BMR_OUTSIDER_ROLES,
    minionRoles: BMR_MINION_ROLES,
    demonRoles: BMR_DEMON_ROLES,
    allRoles: BMR_ALL_ROLES,
    firstNightOrder: BMR_FIRST_NIGHT_ORDER,
    otherNightOrder: BMR_OTHER_NIGHT_ORDER,
    setupCharacterId: 'godfather',
    setupType: 'godfather'
  },
  snv: {
    id: 'snv',
    name: '紫罗兰教派',
    nameEn: 'Sects & Violets',
    roleIds: SNV_ROLE_IDS,
    townsfolkRoles: SNV_TOWNSFOLK_ROLES,
    outsiderRoles: SNV_OUTSIDER_ROLES,
    minionRoles: SNV_MINION_ROLES,
    demonRoles: SNV_DEMON_ROLES,
    allRoles: SNV_ALL_ROLES,
    firstNightOrder: SNV_FIRST_NIGHT_ORDER,
    otherNightOrder: SNV_OTHER_NIGHT_ORDER,
    // 紫罗兰教派没有影响人数配比的角色（无男爵/教父），配比恒为标准值
    setupCharacterId: null,
    setupType: null
  }
};

function getScriptConfig(scriptId) {
  return SCRIPTS[scriptId] || SCRIPTS.tb;
}

// 阶段枚举
const PHASES = {
  LOBBY: 'LOBBY',
  FIRST_NIGHT: 'FIRST_NIGHT',
  NIGHT_WAKE: 'NIGHT_WAKE',
  DAY_DAWN: 'DAY_DAWN',
  DAY_DISCUSSION: 'DAY_DISCUSSION',
  NOMINATION_PHASE: 'NOMINATION_PHASE',
  DEFENSE: 'DEFENSE',
  VOTING: 'VOTING',
  EXECUTION: 'EXECUTION',
  NIGHT: 'NIGHT',
  GAME_OVER: 'GAME_OVER'
};

module.exports = {
  getRoleComposition,
  getScriptConfig,
  SCRIPTS,
  SNV_DEMON_SETUP_DELTA,
  // TB 剧本（向后兼容）
  ROLE_IDS,
  TOWNSFOLK_ROLES,
  OUTSIDER_ROLES,
  MINION_ROLES,
  DEMON_ROLES,
  ALL_ROLES,
  FIRST_NIGHT_ORDER,
  OTHER_NIGHT_ORDER,
  // BMR 剧本
  BMR_ROLE_IDS,
  BMR_TOWNSFOLK_ROLES,
  BMR_OUTSIDER_ROLES,
  BMR_MINION_ROLES,
  BMR_DEMON_ROLES,
  BMR_ALL_ROLES,
  BMR_FIRST_NIGHT_ORDER,
  BMR_OTHER_NIGHT_ORDER,
  // SNV 剧本
  SNV_ROLE_IDS,
  SNV_TOWNSFOLK_ROLES,
  SNV_OUTSIDER_ROLES,
  SNV_MINION_ROLES,
  SNV_DEMON_ROLES,
  SNV_ALL_ROLES,
  SNV_FIRST_NIGHT_ORDER,
  SNV_OTHER_NIGHT_ORDER,
  PHASES
};
