// 弱方偏袒平衡系统
class BalanceSystem {
  // 获取配置（从engine读取，若无则用默认值）
  static getConfig(engine) {
    return engine && engine.probConfig ? engine.probConfig : null;
  }

  static getW(engine, key) {
    const cfg = this.getConfig(engine);
    if (cfg && cfg.balanceWeights && cfg.balanceWeights[key] !== undefined) {
      return cfg.balanceWeights[key];
    }
    const defaults = { numbersAdvantage: 0.3, deadEvil: 0.2, deadGood: -0.15, keyRolesAlive: 0.15, demonSafety: 0.1 };
    return defaults[key] || 0;
  }

  // 计算平衡分数 [-1, 1]，正=好人优势，负=邪恶优势
  static calculateBalanceScore(room, engine) {
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
      score += (goodPower - evilPower) / alive.length * this.getW(engine, 'numbersAdvantage') * 3;
    }

    // 已死邪恶/好人
    score += deadEvil * this.getW(engine, 'deadEvil');
    score -= deadGood * this.getW(engine, 'deadGood');

    // 关键角色存活
    const infoRoles = ['chef', 'empath', 'fortuneteller', 'investigator', 'washerwoman', 'librarian'];
    const infoRolesAlive = alive.some(p => infoRoles.includes(p.role.id));
    const monkAlive = alive.some(p => p.role.id === 'monk');
    const slayerAlive = alive.some(p => p.role.id === 'slayer' && !p.hasUsedDayAbility);
    score += (infoRolesAlive ? 0.1 : 0) + (monkAlive ? 0.1 : 0) + (slayerAlive ? 0.05 : 0);

    return Math.max(-1, Math.min(1, score));
  }

  static getFavorProbability(balanceScore, engine) {
    const cfg = this.getConfig(engine);
    const base = cfg ? cfg.balance.baseFavor : 0.1;
    const max = cfg ? cfg.balance.maxFavor : 0.7;
    const mult = cfg ? cfg.balance.favorMultiplier : 0.6;
    return Math.min(Math.abs(balanceScore) * mult + base, max);
  }

  // 是否给中毒/醉酒玩家正确信息
  static shouldGiveCorrectInfo(player, engine) {
    const room = engine.room;
    const cfg = this.getConfig(engine);
    // 配置禁用时，中毒/醉酒永远获得假信息
    if (cfg && cfg.balance && cfg.balance.poisonedCorrectInfo === false) {
      return false;
    }
    const score = this.calculateBalanceScore(room, engine);
    const prob = this.getFavorProbability(score, engine);
    const threshold = cfg ? cfg.balance.goodWeakThreshold : -0.2;

    if (player.role.team === 'GOOD' && score < threshold) {
      return Math.random() < prob;
    }
    return false;
  }

  // 调整信息（中毒时）
  static adjustInfo(role, correctInfo, player, engine) {
    if (this.shouldGiveCorrectInfo(player, engine)) {
      return correctInfo;
    }
    return null;
  }

  // 决定假信息方向：true=偏向帮好人（好人弱势，假信息指向邪恶/恶魔），false=偏向帮邪恶（邪恶弱势，假信息指向善良/无恶魔）
  // 由平衡系统根据当前局势自动决定，无需单独配置概率
  static favorWeakSide(engine) {
    const room = engine.room;
    const cfg = this.getConfig(engine);
    const score = this.calculateBalanceScore(room, engine);
    const prob = this.getFavorProbability(score, engine);
    const goodWeakTh = cfg ? cfg.balance.goodWeakThreshold : -0.2;
    const evilWeakTh = cfg ? cfg.balance.evilWeakThreshold : 0.3;

    if (score < goodWeakTh) {
      // 好人弱势：按偏袒概率返回true（帮好人）
      return Math.random() < prob;
    }
    if (score > evilWeakTh) {
      // 邪恶弱势：按偏袒概率返回false（帮邪恶=误导好人）
      return !(Math.random() < prob);
    }
    // 局势均衡：50/50随机
    return Math.random() < 0.5;
  }

  // 选择red herring位置
  static selectRedHerring(players, demon, engine) {
    const room = engine.room;
    const cfg = this.getConfig(engine);
    const score = this.calculateBalanceScore(room, engine);
    const candidates = players.filter(p => p.id !== demon.id);
    const goodWeakTh = cfg ? cfg.balance.goodWeakThreshold : -0.2;
    const evilWeakTh = cfg ? cfg.balance.evilWeakThreshold : 0.3;
    const favorMinion = cfg ? cfg.balance.redHerringFavorMinion !== false : true;
    const favorGood = cfg ? cfg.balance.redHerringFavorGood !== false : true;

    // 好人弱势时，red herring倾向选爪牙
    if (favorMinion && score < goodWeakTh) {
      const minions = candidates.filter(p => p.role.category === 'MINION');
      if (minions.length > 0 && Math.random() < this.getFavorProbability(score, engine)) {
        return minions[Math.floor(Math.random() * minions.length)];
      }
    }

    // 邪恶弱势时，red herring倾向选强好人
    if (favorGood && score > evilWeakTh) {
      const keyGood = candidates.filter(p => 
        p.role.team === 'GOOD' && ['fortuneteller', 'empath', 'chef', 'investigator'].includes(p.role.id)
      );
      if (keyGood.length > 0 && Math.random() < this.getFavorProbability(score, engine)) {
        return keyGood[Math.floor(Math.random() * keyGood.length)];
      }
    }

    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // 市长替死概率
  static getMayorSaveProbability(engine) {
    const room = engine.room;
    const cfg = this.getConfig(engine);
    const score = this.calculateBalanceScore(room, engine);
    const base = cfg ? cfg.balance.mayorSaveBase : 0.5;
    const bonus = cfg ? cfg.balance.mayorSaveBonus : 0.2;
    const penalty = cfg ? cfg.balance.mayorSavePenalty : 0.2;
    const goodWeakTh = cfg ? cfg.balance.goodWeakThreshold : -0.2;
    const evilWeakTh = cfg ? cfg.balance.evilWeakThreshold : 0.3;

    if (score < goodWeakTh) {
      return Math.min(base + this.getFavorProbability(score, engine) * (bonus / 0.2), base + bonus);
    }
    if (score > evilWeakTh) {
      return Math.max(base - this.getFavorProbability(score, engine) * (penalty / 0.2), base - penalty);
    }
    return base;
  }
}

module.exports = BalanceSystem;
