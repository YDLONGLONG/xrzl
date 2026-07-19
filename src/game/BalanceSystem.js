// 弱方偏袒平衡系统
class BalanceSystem {
  static WEIGHTS = {
    numbersAdvantage: 0.3,
    deadEvil: 0.2,
    deadGood: -0.15,
    keyRolesAlive: 0.15,
    demonSafety: 0.1
  };

  // 计算平衡分数 [-1, 1]，正=好人优势，负=邪恶优势
  static calculateBalanceScore(room) {
    const players = Array.from(room.players.values());
    const alive = players.filter(p => p.isAlive && p.seat !== -1);
    const dead = players.filter(p => p.isDead);

    const aliveGood = alive.filter(p => p.role && p.role.team === 'GOOD').length;
    const aliveEvil = alive.filter(p => p.role && p.role.team === 'EVIL').length;
    const deadEvil = dead.filter(p => p.role && p.role.team === 'EVIL').length;
    const deadGood = dead.filter(p => p.role && p.role.team === 'GOOD').length;

    let score = 0;

    // 人数比：恶魔权重2，爪牙1.5
    const evilPower = alive.filter(p => p.role.category === 'DEMON').length * 2
                    + alive.filter(p => p.role.category === 'MINION').length * 1.5;
    const goodPower = aliveGood;
    if (alive.length > 0) {
      score += (goodPower - evilPower) / alive.length * this.WEIGHTS.numbersAdvantage * 3;
    }

    // 已死邪恶/好人
    score += deadEvil * this.WEIGHTS.deadEvil;
    score -= deadGood * this.WEIGHTS.deadGood;

    // 关键角色存活
    const infoRoles = ['chef', 'empath', 'fortuneteller', 'investigator', 'washerwoman', 'librarian'];
    const infoRolesAlive = alive.some(p => infoRoles.includes(p.role.id));
    const monkAlive = alive.some(p => p.role.id === 'monk');
    const slayerAlive = alive.some(p => p.role.id === 'slayer' && !p.hasUsedDayAbility);
    score += (infoRolesAlive ? 0.1 : 0) + (monkAlive ? 0.1 : 0) + (slayerAlive ? 0.05 : 0);

    return Math.max(-1, Math.min(1, score));
  }

  static getFavorProbability(balanceScore) {
    return Math.min(Math.abs(balanceScore) * 0.6 + 0.1, 0.7);
  }

  // 是否给中毒/醉酒玩家正确信息
  static shouldGiveCorrectInfo(player, room) {
    const score = this.calculateBalanceScore(room);
    const prob = this.getFavorProbability(score);

    if (player.role.team === 'GOOD' && score < -0.2) {
      return Math.random() < prob;
    }
    return false;
  }

  // 调整信息（中毒时）
  static adjustInfo(role, correctInfo, player, engine) {
    if (this.shouldGiveCorrectInfo(player, engine.room)) {
      return correctInfo;
    }
    // 返回null表示调用方自行生成错误信息
    return null;
  }

  // 选择red herring位置
  static selectRedHerring(players, demon, room) {
    const score = this.calculateBalanceScore(room);
    const candidates = players.filter(p => p.id !== demon.id);

    // 好人弱势时，red herring倾向选爪牙
    if (score < -0.2) {
      const minions = candidates.filter(p => p.role.category === 'MINION');
      if (minions.length > 0 && Math.random() < this.getFavorProbability(score)) {
        return minions[Math.floor(Math.random() * minions.length)];
      }
    }

    // 邪恶弱势时，red herring倾向选强好人
    if (score > 0.3) {
      const keyGood = candidates.filter(p => 
        p.role.team === 'GOOD' && ['fortuneteller', 'empath', 'chef', 'investigator'].includes(p.role.id)
      );
      if (keyGood.length > 0 && Math.random() < this.getFavorProbability(score)) {
        return keyGood[Math.floor(Math.random() * keyGood.length)];
      }
    }

    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // 市长替死概率
  static getMayorSaveProbability(room) {
    const score = this.calculateBalanceScore(room);
    const base = 0.5;
    if (score < -0.2) {
      return Math.min(base + this.getFavorProbability(score) * 0.2, 0.7);
    }
    if (score > 0.3) {
      return Math.max(base - this.getFavorProbability(score) * 0.2, 0.3);
    }
    return base;
  }
}

module.exports = BalanceSystem;
