// 概率配置 - 默认值（标准模式）
const DEFAULT_PROB_CONFIG = {
  // ===== 固定概率（角色技能干扰）=====
  recluse_evil: 0.5,
  recluse_minion: 0.5,
  recluse_demon: 0.5,
  recluse_outsider: 0.5,    // 隐士可能被登记为外来者
  spy_good_chef: 0.5,
  spy_good_empath: 0.5,
  spy_not_minion: 0.5,
  spy_as_townsfolk: 0.5,    // 间谍可能被登记为村民
  spy_as_outsider: 0.5,     // 间谍可能被登记为外来者
  bot_nominate: 0.30,
  bot_evil_vote_yes: 0.7,
  bot_good_vote_yes: 0.5,

  // ===== 动态概率（平衡系统参数）—— 标准模式：必帮弱方 =====
  // 酒鬼假占卜、中毒守鸦人假阵营、中毒图书管理员假信息等"假信息内容方向"
  // 统一由 balanceSystem.favorWeakSide() 根据局势自动决定，无需单独配置
  balance: {
    baseFavor: 1,
    maxFavor: 1,
    favorMultiplier: 1,
    mayorSaveBase: 0.5,
    mayorSaveBonus: 0.5,
    mayorSavePenalty: 0.5,
    goodWeakThreshold: -0.2,
    evilWeakThreshold: 0.3,
    redHerringFavorMinion: true,
    redHerringFavorGood: true,
    poisonedCorrectInfo: false,  // 标准：中毒/醉酒必假
    favorStrength: 1.0           // 偏袒强度（0=不偏袒，1=必帮弱方），高级模式UI用
  },

  // ===== 平衡分数权重（高级模式可调）=====
  balanceWeights: {
    numbersAdvantage: 0.3,
    deadEvil: 0.2,
    deadGood: -0.15,
    keyRolesAlive: 0.15,
    demonSafety: 0.1
  }
};

// 高级模式UI展示的精简配置项
const PROB_CONFIG_META = [
  {
    category: '角色技能干扰概率',
    items: [
      { key: 'recluse_evil', label: '隐士被登记为邪恶（厨师/共情者）', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'recluse_minion', label: '隐士被登记为爪牙（调查员）', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'recluse_demon', label: '隐士被登记为恶魔（占卜师）', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'recluse_outsider', label: '隐士被登记为外来者（图书管理员）', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'spy_good_chef', label: '间谍被登记为善良（厨师）', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'spy_good_empath', label: '间谍被登记为善良（共情者）', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'spy_not_minion', label: '间谍逃避爪牙检测（调查员）', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'spy_as_townsfolk', label: '间谍被登记为村民（洗衣妇）', min: 0, max: 1, step: 0.05, default: 0.5 },
      { key: 'spy_as_outsider', label: '间谍被登记为外来者（图书管理员）', min: 0, max: 1, step: 0.05, default: 0.5 },
    ]
  },
  {
    category: '酒鬼 / 中毒信息',
    note: '假信息的内容方向由平衡系统自动决定：好人弱势时假信息指向邪恶/恶魔（帮好人调查），邪恶弱势时假信息指向善良/无恶魔（误导好人），无需单独配置概率。',
    items: []
  },
  {
    category: 'Bot 行为',
    items: [
      { key: 'bot_nominate', label: 'Bot发起提名概率', min: 0, max: 1, step: 0.05, default: 0.30 },
      { key: 'bot_evil_vote_yes', label: '邪恶Bot投赞成票概率', min: 0, max: 1, step: 0.05, default: 0.7 },
      { key: 'bot_good_vote_yes', label: '善良Bot投赞成票概率', min: 0, max: 1, step: 0.05, default: 0.5 },
    ]
  },
  {
    category: '平衡偏袒系统',
    items: [
      { key: 'balance.favorStrength', label: '偏袒强度（0=不偏袒，1=必帮弱方）', min: 0, max: 1, step: 0.05, default: 1.0, isFavorStrength: true },
      { key: 'balance.poisonedCorrectInfo', label: '中毒/醉酒可能获得真信息', bool: true, default: false },
      { key: 'balance.redHerringFavorMinion', label: '干扰项偏向弱势方', bool: true, default: true },
    ]
  },
  {
    category: '高级参数（平衡权重）',
    advanced: true,
    items: [
      { key: 'balanceWeights.numbersAdvantage', label: '人数比权重', min: 0, max: 1, step: 0.05, default: 0.3 },
      { key: 'balanceWeights.deadEvil', label: '已死邪恶权重', min: 0, max: 1, step: 0.05, default: 0.2 },
      { key: 'balanceWeights.deadGood', label: '已死好人权重（负）', min: -1, max: 0, step: 0.05, default: -0.15 },
      { key: 'balanceWeights.keyRolesAlive', label: '关键角色存活权重', min: 0, max: 1, step: 0.05, default: 0.15 },
      { key: 'balanceWeights.demonSafety', label: '恶魔安全度权重', min: 0, max: 1, step: 0.05, default: 0.1 },
    ]
  }
];

// 固定概率项key列表
const FIXED_PROB_KEYS = [
  'recluse_evil', 'recluse_minion', 'recluse_demon', 'recluse_outsider',
  'spy_good_chef', 'spy_good_empath', 'spy_not_minion', 'spy_as_townsfolk', 'spy_as_outsider',
  'bot_nominate', 'bot_evil_vote_yes', 'bot_good_vote_yes'
];

// 偏袒强度对应的标准值映射（s: 0=完全不偏袒，1=必帮弱方）
function applyFavorStrength(cfg, strength) {
  const s = Math.max(0, Math.min(1, strength));
  const b = cfg.balance;
  // s=1(必帮弱方): baseFavor=1, 所有偏袒判断概率直接=1
  // s=0(不偏袒): baseFavor=0, favorMultiplier=0, 偏袒概率=0（纯随机）
  b.baseFavor = s;
  b.maxFavor = 1;
  b.favorMultiplier = s;
  b.mayorSaveBase = 0.5;
  b.mayorSaveBonus = 0.5 * s;
  b.mayorSavePenalty = 0.5 * s;
  b.goodWeakThreshold = -0.2;
  b.evilWeakThreshold = 0.3;
  // redHerringFavorMinion/Good 和 poisonedCorrectInfo 由开关单独控制
  b.favorStrength = s;
}

// 深拷贝默认配置
function getDefaultProbConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_PROB_CONFIG));
}

// 获取标准模式配置
function getStandardProbConfig() {
  const cfg = getDefaultProbConfig();
  applyFavorStrength(cfg, 1.0);
  cfg.balance.poisonedCorrectInfo = false;
  cfg.balance.redHerringFavorMinion = true;
  cfg.balance.redHerringFavorGood = true;
  return cfg;
}

function getProb(config, keyPath) {
  const parts = keyPath.split('.');
  let val = config;
  for (const p of parts) {
    if (val === undefined || val === null) return undefined;
    val = val[p];
  }
  return val;
}

module.exports = {
  DEFAULT_PROB_CONFIG,
  PROB_CONFIG_META,
  FIXED_PROB_KEYS,
  getDefaultProbConfig,
  getStandardProbConfig,
  applyFavorStrength,
  getProb
};
