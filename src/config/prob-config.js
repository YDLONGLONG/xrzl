// 概率配置 - 默认值（标准模式）
// 每个剧本有独立的角色技能干扰概率；Bot行为/平衡系统/权重为通用配置。

// ==================== TB（灾祸之酿）专属固定概率 ====================
const TB_FIXED_PROB = {
  recluse_evil: 0.5,
  recluse_minion: 0.5,
  recluse_demon: 0.5,
  recluse_outsider: 0.5,    // 隐士可能被登记为外来者
  spy_good_chef: 0.5,
  spy_good_empath: 0.5,
  spy_not_minion: 0.5,
  spy_as_townsfolk: 0.5,    // 间谍可能被登记为村民
  spy_as_outsider: 0.5,     // 间谍可能被登记为外来者
};

// ==================== BMR（黯月初升）专属固定概率 ====================
const BMR_FIXED_PROB = {
  // 注：修补匠夜晚死亡概率、和平主义者拯救概率已改由平衡系统自动控制，不再在此配置
  // 注：疯子/莽夫获得假恶魔身份为角色固有机制，不应作为可调概率，已移除
  // 造谣者：bot发表声明时，声明为真（导致死亡）的概率
  gossip_true_statement: 0.4,
};

// ==================== Bot 行为（通用） ====================
const BOT_PROB = {
  bot_nominate: 0.30,
  bot_evil_vote_yes: 0.7,
  bot_good_vote_yes: 0.5,
};

// ==================== 默认配置（标准模式） ====================
const DEFAULT_PROB_CONFIG = {
  ...TB_FIXED_PROB,
  ...BMR_FIXED_PROB,
  ...BOT_PROB,

  // ===== 动态概率（平衡系统参数）—— 标准模式：按失衡程度帮弱方 =====
  balance: {
    baseFavor: 0,                // 偏袒基准概率（必须为 0，否则概率失去渐变）
    maxFavor: 1,
    favorMultiplier: 1,          // 偏袒斜率
    mayorSaveBase: 0.5,
    mayorSaveBonus: 0.5,
    mayorSavePenalty: 0.5,
    goodWeakThreshold: -0.2,
    evilWeakThreshold: 0.3,
    redHerringFavorMinion: true,
    redHerringFavorGood: true,
    favorStrength: 1.0           // 偏袒强度（0=完全不偏袒；1=按 |score| 线性偏袒，越失衡越强）
  },

  // ===== 平衡分数权重（通用）=====
  balanceWeights: {
    numbersAdvantage: 0.3,
    deadEvil: 0.2,
    deadGood: -0.15,
    keyRolesAlive: 0.15,
    demonSafety: 0.1
  }
};

// ==================== 各剧本固定概率项 ====================
const SCRIPT_FIXED_PROB = {
  tb: TB_FIXED_PROB,
  bmr: BMR_FIXED_PROB
};

// ==================== UI 展示（按剧本过滤） ====================
// 每个 item 可指定 script 字段：'tb' / 'bmr' / undefined(通用)
const PROB_CONFIG_META = [
  {
    category: '角色技能干扰概率',
    script: 'tb',
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
    category: '角色技能干扰概率',
    script: 'bmr',
    items: [
      { key: 'gossip_true_statement', label: '造谣者Bot声明为真（导致死亡）', min: 0, max: 1, step: 0.05, default: 0.4 },
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
      // 注：偏袒强度、平衡权重、中毒/醉酒真伪判断、干扰项偏向弱势方 全部内置启用，不再可选
    ]
  }
];

// 偏袒强度对应的标准值映射
// 偏袒概率 = min(|score| * favorMultiplier + baseFavor, maxFavor)
//   baseFavor 固定为 0：强度只控制「斜率」，否则 prob 会被抬到恒定值，
//   所有偏袒项退化成 0/1 开关（越失衡偏袒越强的设计就失效了）。
//   s=0 → prob=0，完全不偏袒；s=1 → prob=|score|，按失衡程度线性偏袒。
function applyFavorStrength(cfg, strength) {
  const s = Math.max(0, Math.min(1, strength));
  const b = cfg.balance;
  b.baseFavor = 0;
  b.maxFavor = 1;
  b.favorMultiplier = s;
  b.mayorSaveBase = 0.5;
  b.mayorSaveBonus = 0.5 * s;
  b.mayorSavePenalty = 0.5 * s;
  b.goodWeakThreshold = -0.2;
  b.evilWeakThreshold = 0.3;
  b.favorStrength = s;
}

// 深拷贝默认配置
function getDefaultProbConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_PROB_CONFIG));
}

// 获取标准模式配置（按剧本）
function getStandardProbConfig(scriptId = 'tb') {
  const cfg = {
    ...BOT_PROB,
    ...(SCRIPT_FIXED_PROB[scriptId] || TB_FIXED_PROB),
    balance: {
      baseFavor: 0, maxFavor: 1, favorMultiplier: 1,
      mayorSaveBase: 0.5, mayorSaveBonus: 0.5, mayorSavePenalty: 0.5,
      goodWeakThreshold: -0.2, evilWeakThreshold: 0.3,
      redHerringFavorMinion: true, redHerringFavorGood: true,
      favorStrength: 1.0
    },
    balanceWeights: {
      numbersAdvantage: 0.3, deadEvil: 0.2, deadGood: -0.15,
      keyRolesAlive: 0.15, demonSafety: 0.1
    }
  };
  applyFavorStrength(cfg, 1.0);
  return cfg;
}

// 按剧本过滤 META（供前端渲染）
function getProbConfigMeta(scriptId = 'tb') {
  return PROB_CONFIG_META.filter(cat => !cat.script || cat.script === scriptId)
    .map(cat => ({ ...cat, script: undefined }));
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
  SCRIPT_FIXED_PROB,
  getDefaultProbConfig,
  getStandardProbConfig,
  getProbConfigMeta,
  applyFavorStrength,
  getProb
};
