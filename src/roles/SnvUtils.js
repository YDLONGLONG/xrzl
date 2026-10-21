// 紫罗兰教派（SNV）公共工具
// 说明：角色文件与 server.js 都会用到这里的判定，集中一份避免规则漂移。
const { getScriptConfig } = require('../config/game-config');

// 玩家当前是否能力异常（中毒/醉酒都算）
function isImpaired(player) {
  return !!(player && (player.isPoisoned || player.isDrunk));
}

// 是否处于白天阶段（白天技能只能在白天使用）
const DAY_PHASES = [
  'DAY_DAWN', 'DAY_DISCUSSION', 'NOMINATION_PHASE', 'DEFENSE', 'VOTING', 'EXECUTION'
];

function isDayPhase(gameState) {
  return !!gameState && DAY_PHASES.includes(gameState.phase);
}

// 混沌是否在场并生效：存活、未被中毒/醉酒
function isVortoxActive(engine) {
  if (!engine || !engine.room) return false;
  const players = Array.from(engine.room.players.values())
    .filter(p => p.seat !== -1 && p.isAlive && p.role);
  const vortox = players.find(p => p.role.id === 'vortox');
  return !!(vortox && !isImpaired(vortox));
}

// 每夜开始时维护 SNV 的持续中毒状态：
//  - 舞蛇人造成的「原恶魔永久中毒」不可解除
//  - 亡灵法师对相邻村民的中毒只持续到下一个黎明
function maintainPersistentPoison(engine) {
  if (!engine || !engine.room) return;
  for (const [, p] of engine.room.players) {
    if (p.seat === -1) continue;
    if (p.snvPoisonSource === 'snakecharmer') p.isPoisoned = true;
    if (p.snvPoisonSource === 'vigormortis_aura') {
      p.isPoisoned = false;
      p.snvPoisonSource = null;
    }
  }
}

// 当前剧本全部角色（含名称/阵营/类别），供选角色类技能使用
function scriptRoleInfos(engine, filterFn = null) {
  const sc = getScriptConfig((engine.room && engine.room.script) || 'tb');
  return sc.allRoles
    .map(rid => {
      const inst = engine.roleAllocator ? engine.roleAllocator.createRoleInstance(rid) : null;
      return inst
        ? { id: rid, name: inst.name, team: inst.team, category: inst.category }
        : null;
    })
    .filter(Boolean)
    .filter(r => (filterFn ? filterFn(r) : true));
}

// 在 [min, max] 区间内取一个「与正确值不同」的数字（用于中毒/混沌的假信息）
function pickWrongNumber(correct, min, max) {
  const pool = [];
  for (let i = min; i <= max; i++) {
    if (i !== correct) pool.push(i);
  }
  if (pool.length === 0) return correct;
  return pool[Math.floor(Math.random() * pool.length)];
}

// 随机取数组中的一个元素
function pickRandom(list) {
  if (!list || list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)];
}

// 座位之间的环形距离（相邻座位距离为 1）
function seatDistance(total, a, b) {
  const diff = Math.abs(a - b) % total;
  return Math.min(diff, total - diff);
}

module.exports = {
  isImpaired,
  isDayPhase,
  isVortoxActive,
  maintainPersistentPoison,
  scriptRoleInfos,
  pickWrongNumber,
  pickRandom,
  seatDistance
};
