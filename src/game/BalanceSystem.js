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

  // 是否给中毒/醉酒玩家正确信息（返回详细信息对象）
  static shouldGiveCorrectInfo(player, engine, description = '中毒正确信息') {
    const room = engine.room;
    const cfg = this.getConfig(engine);
    const score = this.calculateBalanceScore(room, engine);
    const prob = this.getFavorProbability(score, engine);
    const goodWeakTh = cfg ? cfg.balance.goodWeakThreshold : -0.2;
    const evilWeakTh = cfg ? cfg.balance.evilWeakThreshold : 0.3;

    let result = false;
    let scenario = 'balanced';
    let threshold = 0;

    // 中毒/醉酒信息真伪由平衡系统自动决定（内置启用，不可关闭）
    if (player.role.team === 'GOOD' && score < goodWeakTh) {
      // 好人弱势：按偏袒概率给真信息（帮好人调查）
      scenario = 'good_weak';
      threshold = prob;
      result = Math.random() < prob;
    } else if (player.role.team === 'GOOD' && score > evilWeakTh) {
      // 邪恶弱势：保持假信息（误导好人，帮邪恶）
      scenario = 'evil_weak';
      threshold = 0;
      result = false;
    } else {
      // 局势均衡：假信息
      scenario = 'balanced';
      threshold = 0;
      result = false;
    }

    return {
      result,
      balanceScore: score,
      probability: prob,
      threshold,
      scenario,
      goodWeakThreshold: goodWeakTh,
      evilWeakThreshold: evilWeakTh,
      description
    };
  }

  // 调整信息（中毒时），返回 { info, probInfo }
  static adjustInfo(role, correctInfo, player, engine, description) {
    const infoResult = this.shouldGiveCorrectInfo(player, engine, description);
    if (infoResult.result) {
      return { info: correctInfo, probInfo: infoResult };
    }
    return { info: null, probInfo: infoResult };
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

    let result;
    let scenario = 'balanced';
    let threshold = 0.5;

    if (score < goodWeakTh) {
      // 好人弱势：按偏袒概率返回true（帮好人）
      scenario = 'good_weak';
      threshold = prob;
      result = Math.random() < prob;
    } else if (score > evilWeakTh) {
      // 邪恶弱势：按偏袒概率返回false（帮邪恶=误导好人）
      scenario = 'evil_weak';
      threshold = prob;
      result = !(Math.random() < prob);
    } else {
      // 局势均衡：50/50随机
      scenario = 'balanced';
      threshold = 0.5;
      result = Math.random() < 0.5;
    }

    return {
      result,
      balanceScore: score,
      probability: prob,
      threshold,
      scenario,
      goodWeakThreshold: goodWeakTh,
      evilWeakThreshold: evilWeakTh
    };
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
    const prob = this.getFavorProbability(score, engine);

    let scenario = 'balanced';
    let threshold = 0;
    let result = null;
    let favored = false;

    // 好人弱势时，red herring倾向选爪牙（帮好人：让占卜师更容易查到邪恶）
    if (favorMinion && score < goodWeakTh) {
      scenario = 'good_weak_favor_minion';
      threshold = prob;
      const minions = candidates.filter(p => p.role.category === 'MINION');
      if (minions.length > 0 && Math.random() < prob) {
        result = minions[Math.floor(Math.random() * minions.length)];
        favored = true;
      }
    }

    // 邪恶弱势时，red herring倾向选强好人（帮邪恶：误导好人出强好人）
    if (!result && favorGood && score > evilWeakTh) {
      scenario = 'evil_weak_favor_good';
      threshold = prob;
      const keyGood = candidates.filter(p => 
        p.role.team === 'GOOD' && ['fortuneteller', 'empath', 'chef', 'investigator'].includes(p.role.id)
      );
      if (keyGood.length > 0 && Math.random() < prob) {
        result = keyGood[Math.floor(Math.random() * keyGood.length)];
        favored = true;
      }
    }

    if (!result) {
      scenario = scenario === 'balanced' ? 'random' : scenario + '_fallback';
      threshold = 1 / candidates.length;
      result = candidates[Math.floor(Math.random() * candidates.length)];
      favored = false;
    }

    return {
      player: result,
      probInfo: {
        type: 'red_herring',
        balanceScore: score,
        probability: prob,
        threshold,
        scenario,
        result: favored,
        description: '占卜师红鲱鱼选择',
        selectedId: result.id,
        selectedName: result.name
      }
    };
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

  // 修补匠夜晚死亡概率（由平衡系统控制）
  // 修补匠是善良外来者，其死亡削弱好人：好人弱势时降低死亡概率，邪恶弱势时提高死亡概率
  static getTinkerDeathProbability(engine) {
    const room = engine.room;
    const cfg = this.getConfig(engine);
    const score = this.calculateBalanceScore(room, engine);
    const base = cfg && cfg.balance && cfg.balance.tinkerDeathBase !== undefined ? cfg.balance.tinkerDeathBase : 0.15;
    const bonus = cfg && cfg.balance && cfg.balance.tinkerDeathBonus !== undefined ? cfg.balance.tinkerDeathBonus : 0.15;
    const penalty = cfg && cfg.balance && cfg.balance.tinkerDeathPenalty !== undefined ? cfg.balance.tinkerDeathPenalty : 0.15;
    const goodWeakTh = cfg ? cfg.balance.goodWeakThreshold : -0.2;
    const evilWeakTh = cfg ? cfg.balance.evilWeakThreshold : 0.3;
    const prob = this.getFavorProbability(score, engine);

    let scenario = 'balanced';
    let probability = base;

    if (score < goodWeakTh) {
      // 好人弱势：降低修补匠死亡概率（帮好人保人）
      scenario = 'good_weak';
      probability = Math.max(base - prob * (penalty / 0.2), 0);
    } else if (score > evilWeakTh) {
      // 邪恶弱势：提高修补匠死亡概率（帮邪恶削减好人）
      scenario = 'evil_weak';
      probability = Math.min(base + prob * (bonus / 0.2), 1);
    }

    return {
      probability,
      balanceScore: score,
      threshold: probability,
      scenario,
      goodWeakThreshold: goodWeakTh,
      evilWeakThreshold: evilWeakTh,
      baseProbability: base,
      description: '修补匠夜晚死亡概率'
    };
  }

  // 和平主义者拯救善良被处决者概率（由平衡系统控制）
  // 和平主义者是善良村民，能阻止善良玩家被处决：好人弱势时提高拯救概率，邪恶弱势时降低拯救概率
  static getPacifistSaveProbability(engine) {
    const room = engine.room;
    const cfg = this.getConfig(engine);
    const score = this.calculateBalanceScore(room, engine);
    const base = cfg && cfg.balance && cfg.balance.pacifistSaveBase !== undefined ? cfg.balance.pacifistSaveBase : 0.5;
    const bonus = cfg && cfg.balance && cfg.balance.pacifistSaveBonus !== undefined ? cfg.balance.pacifistSaveBonus : 0.3;
    const penalty = cfg && cfg.balance && cfg.balance.pacifistSavePenalty !== undefined ? cfg.balance.pacifistSavePenalty : 0.3;
    const goodWeakTh = cfg ? cfg.balance.goodWeakThreshold : -0.2;
    const evilWeakTh = cfg ? cfg.balance.evilWeakThreshold : 0.3;
    const prob = this.getFavorProbability(score, engine);

    let scenario = 'balanced';
    let probability = base;

    if (score < goodWeakTh) {
      // 好人弱势：提高拯救概率（帮好人保人）
      scenario = 'good_weak';
      probability = Math.min(base + prob * (bonus / 0.2), 1);
    } else if (score > evilWeakTh) {
      // 邪恶弱势：降低拯救概率（帮邪恶处决好人）
      scenario = 'evil_weak';
      probability = Math.max(base - prob * (penalty / 0.2), 0);
    }

    return {
      probability,
      balanceScore: score,
      threshold: probability,
      scenario,
      goodWeakThreshold: goodWeakTh,
      evilWeakThreshold: evilWeakTh,
      baseProbability: base,
      description: '和平主义者拯救概率'
    };
  }

  // 造谣者声明为真时选择死亡玩家（平衡系统决定好人/坏人）
  static selectGossipVictim(engine) {
    const room = engine.room;
    const cfg = this.getConfig(engine);
    const score = this.calculateBalanceScore(room, engine);
    const alive = Array.from(room.players.values()).filter(p => p.isAlive && p.seat !== -1);
    const goodWeakTh = cfg ? cfg.balance.goodWeakThreshold : -0.2;
    const evilWeakTh = cfg ? cfg.balance.evilWeakThreshold : 0.3;
    const prob = this.getFavorProbability(score, engine);

    let target = null;
    let favoredTeam = 'random';

    if (alive.length === 0) return null;

    if (score < goodWeakTh) {
      const evilAlive = alive.filter(p => p.role.team === 'EVIL');
      if (evilAlive.length > 0 && Math.random() < prob) {
        target = evilAlive[Math.floor(Math.random() * evilAlive.length)];
        favoredTeam = 'EVIL';
      }
    } else if (score > evilWeakTh) {
      const goodAlive = alive.filter(p => p.role.team === 'GOOD');
      if (goodAlive.length > 0 && Math.random() < prob) {
        target = goodAlive[Math.floor(Math.random() * goodAlive.length)];
        favoredTeam = 'GOOD';
      }
    }

    if (!target) {
      target = alive[Math.floor(Math.random() * alive.length)];
      favoredTeam = target.role.team;
    }

    return {
      player: target,
      balanceScore: score,
      favoredTeam,
      description: '造谣者选择死亡目标'
    };
  }
}

module.exports = BalanceSystem;
