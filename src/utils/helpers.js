// 辅助函数

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function randomChoice(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function getSeatedPlayers(room) {
  return Array.from(room.players.values()).filter(p => p.seat !== -1);
}

function getAlivePlayers(room) {
  return Array.from(room.players.values()).filter(p => p.isAlive && p.seat !== -1);
}

function getDeadPlayers(room) {
  return Array.from(room.players.values()).filter(p => p.isDead);
}

function getPlayerById(room, id) {
  return room.players.get(id) || null;
}

function getAliveNeighbors(room, player) {
  const seats = room.seats;
  const total = seats.length;
  const seatNum = player.seat;
  const neighbors = [];

  // 找左边存活邻居
  for (let i = 1; i < total; i++) {
    const leftIdx = (seatNum - i + total) % total;
    const left = seats[leftIdx];
    if (left && left.isAlive) {
      neighbors.push(left);
      break;
    }
  }

  // 找右边存活邻居
  for (let i = 1; i < total; i++) {
    const rightIdx = (seatNum + i) % total;
    const right = seats[rightIdx];
    if (right && right.isAlive) {
      neighbors.push(right);
      break;
    }
  }

  return neighbors;
}

// 醉酒状态按「来源(source)」独立计时，避免多个醉酒效果互相覆盖。
// 每个来源用 { turns, duration } 记录：turns 从 0 开始，每个夜晚开始 +1，达到 duration 即解除。
// 该来源解除后不影响其它来源；全部来源解除时玩家才不再醉酒。
function ensureDrunkEffects(p) {
  if (!p.drunkEffects || typeof p.drunkEffects !== 'object') p.drunkEffects = {};
  return p.drunkEffects;
}

// 施加/续期某个来源的醉酒。duration=2 表示「当前夜晚 + 次日白天」直到下次黄昏。
function applyDrunk(p, source, duration = 2) {
  const effects = ensureDrunkEffects(p);
  const existing = effects[source];
  if (existing) {
    existing.duration = Math.max(existing.duration, duration);
  } else {
    effects[source] = { turns: 0, duration };
  }
  p.isDrunk = true;
}

// 清除某个来源的醉酒（如教授复活、宫廷侍从解除）。
function clearDrunkSource(p, source) {
  if (!p.drunkEffects) return;
  delete p.drunkEffects[source];
  if (Object.keys(p.drunkEffects).length === 0) {
    p.isDrunk = false;
  }
}

// 醉酒持续时长递减：每个夜晚开始时调用一次。
// 醉酒在「当前夜晚 + 次日白天」之后（即再下一次夜晚开始时）解除，
// 对应技能表「直到明天黄昏」的语义。duration 为 0 时立即解除。
function decrementDrunkPlayers(room) {
  for (const [, p] of room.players) {
    if (!p.drunkEffects || Object.keys(p.drunkEffects).length === 0) {
      if (p.isDrunk) p.isDrunk = false;
      continue;
    }
    const effects = p.drunkEffects;
    for (const key of Object.keys(effects)) {
      const e = effects[key];
      e.turns = (e.turns || 0) + 1;
      if (e.turns >= (e.duration || 1)) {
        delete effects[key];
      }
    }
    p.isDrunk = Object.keys(effects).length > 0;
  }
}

// 取得玩家的「有效阵营」。
// 疯子(莽夫)被莽夫机制转为邪恶阵营时，其角色实例的 team 仍是善良，
// 需通过 getEffectiveTeam 读取 transformedTeam（若存在）。
function getPlayerEffectiveTeam(player) {
  if (player && player.role && typeof player.role.getEffectiveTeam === 'function') {
    return player.role.getEffectiveTeam(player);
  }
  return player && player.role ? player.role.team : 'GOOD';
}

module.exports = {
  shuffle,
  randomChoice,
  getSeatedPlayers,
  getAlivePlayers,
  getDeadPlayers,
  getPlayerById,
  getAliveNeighbors,
  decrementDrunkPlayers,
  applyDrunk,
  clearDrunkSource,
  getPlayerEffectiveTeam
};
