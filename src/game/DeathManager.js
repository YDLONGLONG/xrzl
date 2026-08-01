// 死亡管理器
const { getAlivePlayers } = require('../utils/helpers');

class DeathManager {
  constructor(engine) {
    this.engine = engine;
  }

  // 统一的免死判定：返回免死原因字符串，未免死则返回 null
  // 适用于所有死亡来源（恶魔杀害、处决、技能击杀等），刺客除外（走 killPlayerDirect）
  checkDeathPrevention(player, cause, nightCount, dayCount) {
    const gs = this.engine.room.gameState;
    const roleId = player.role && player.role.id;
    const impaired = player.isPoisoned || player.isDrunk;

    // 魔鬼代言人：昨夜被保护的玩家今天被处决时不会死
    if (cause === 'EXECUTION') {
      const daAction = gs.nightActions && gs.nightActions.devilsadvocate;
      if (daAction && daAction.targetId === player.id) {
        this.engine.logAction('ABILITY', `${player.seat+1}号 ${player.name} 被魔鬼代言人保护，处决无效`, {
          playerId: player.id, event: 'devilsadvocate_save'
        });
        return 'DEVILSADVOCATE';
      }
    }

    // 水手：水手不会死亡
    if (roleId === 'sailor' && !impaired) {
      this.engine.logAction('ABILITY', `${player.seat+1}号 ${player.name}（水手）不会死亡`, {
        playerId: player.id, cause, event: 'sailor_immune'
      });
      return 'SAILOR';
    }

    // 茶艺师：与茶艺师邻近的两名存活玩家都善良时，他们不会死亡
    const { Tealady } = require('../roles/Townsfolk2');
    if (Tealady && Tealady.isProtectedByTealady && Tealady.isProtectedByTealady(player, this.engine)) {
      this.engine.logAction('ABILITY', `${player.seat+1}号 ${player.name} 被茶艺师保护，不会死亡`, {
        playerId: player.id, cause, event: 'tealady_save'
      });
      return 'TEALADY';
    }

    // 僵怖：首次死亡后仍存活，但会被当作死亡
    if (roleId === 'zombuul' && !player.abilityState.firstDeath && !impaired) {
      player.abilityState.firstDeath = true;
      player.isDead = true;     // 被当作死亡
      player.isAlive = true;    // 实际仍存活
      player.deathNight = nightCount;
      player.deathDay = dayCount;
      player.voteToken = 1;
      this.engine.logAction('ABILITY', `${player.seat+1}号 ${player.name}（僵怖）首次死亡，仍存活但被当作死亡`, {
        playerId: player.id, cause, event: 'zombuul_first_death'
      });
      return 'ZOMBUUL';
    }

    // 弄臣：首次将要死亡时不会死亡（一次性）
    if (roleId === 'fool' && !player.abilityState.usedDeath && !impaired) {
      player.abilityState.usedDeath = true;
      this.engine.logAction('ABILITY', `${player.seat+1}号 ${player.name}（弄臣）首次死亡免疫`, {
        playerId: player.id, cause, event: 'fool_immune'
      });
      return 'FOOL';
    }

    return null;
  }

  // 杀死玩家（触发技能）
  killPlayer(playerId, cause, nightCount = -1, dayCount = -1) {
    const player = this.engine.room.players.get(playerId);
    if (!player || !player.isAlive) return null;

    // 莽夫等「不会死亡」角色：任何死因都免疫
    if (player.role && player.role.deathImmune) {
      this.engine.io.to(this.engine.room.id).emit('player:deathPrevented', {
        playerId, seat: player.seat, name: player.name, cause
      });
      this.engine.logAction('DEATH', `${player.seat + 1}号 ${player.name} 不会死亡（${player.role.name}免疫）`, {
        playerId, cause, role: player.role.id
      });
      return { playerId, cause, prevented: true, reason: 'deathImmune', triggers: {} };
    }

    // 统一免死判定
    const prevented = this.checkDeathPrevention(player, cause, nightCount, dayCount);
    if (prevented) {
      this.engine.io.to(this.engine.room.id).emit('player:deathPrevented', {
        playerId, seat: player.seat, name: player.name, cause
      });
      return { playerId, cause, prevented: true, reason: prevented, triggers: {} };
    }

    player.isAlive = false;
    player.isDead = true;
    player.deathNight = nightCount;
    player.deathDay = dayCount;
    player.deathCause = cause;
    player.voteToken = 1; // 死者获得1次投票

    // 记录白天死亡：仅当由白天事件触发（nightCount=-1 且 dayCount>0）时，
    // 供「僵怖白天无人死亡才能杀人」等判定使用。夜间死亡（nightCount>=1）不在此列。
    if (nightCount === -1 && dayCount > 0) {
      const gs = this.engine.room.gameState;
      if (gs && Array.isArray(gs.todaysDeaths)) {
        if (!gs.todaysDeaths.some(d => d.playerId === playerId)) {
          gs.todaysDeaths.push({ playerId, cause });
        }
      }
    }

    const causeText = {
      'DEMON': '被恶魔杀害',
      'EXECUTION': '被处决',
      'VIRGIN': '提名圣女而死',
      'SLAYER': '被杀手击杀',
      'MAYOR_SAVE': '替市长而死',
      'POISON': '中毒而死',
      'GODFATHER': '被教父杀害',
      'ASSASSIN': '被刺客刺杀',
      'MOONCHILD': '被月之子诅咒而死',
      'TINKER': '夜晚死亡',
      'GAMBLER': '赌徒猜错而死'
    }[cause] || '死亡';

    this.engine.logAction('DEATH', `${player.seat+1}号 ${player.name} ${causeText}，身份是【${player.role ? player.role.name : '?'}】`, {
      playerId, cause, role: player.role?.id
    });

    const result = { playerId, cause, triggers: {} };

    // 触发角色死亡技能
    if (player.role && player.role.onDeath) {
      const triggerResult = player.role.onDeath(this.engine.room.gameState, player, cause, this.engine);
      result.triggers = triggerResult || {};
    }

    // 检查红唇女郎继承
    this.checkScarletWoman();

    // 广播死亡
    this.engine.io.to(this.engine.room.id).emit('player:died', {
      playerId,
      seat: player.seat,
      name: player.name,
      cause
    });

    return result;
  }

  // 直接杀死（不触发市长替死等，用于替死者）
  killPlayerDirect(playerId, cause, nightCount = -1, dayCount = -1) {
    const player = this.engine.room.players.get(playerId);
    if (!player || !player.isAlive) return null;

    player.isAlive = false;
    player.isDead = true;
    player.deathNight = nightCount;
    player.deathDay = dayCount;
    player.voteToken = 1;

    this.checkScarletWoman();

    this.engine.io.to(this.engine.room.id).emit('player:died', {
      playerId,
      seat: player.seat,
      name: player.name,
      cause
    });

    return player;
  }

  // 检查红唇女郎继承
  checkScarletWoman() {
    const room = this.engine.room;
    const gs = room.gameState;
    const alive = getAlivePlayers(room);

    const demonAlive = alive.some(p => p.role.category === 'DEMON' && !p.role.isFakeDemon);
    if (demonAlive) return;

    const sw = alive.find(p => p.role.id === 'scarletwoman');
    if (sw && alive.length >= 5) {
      // 红唇女郎变成新恶魔（保持同剧本的恶魔类型）
      const { getScriptConfig } = require('../config/game-config');
      const sc = getScriptConfig(room.script || 'tb');
      const { shuffle } = require('../utils/helpers');
      const RoleAllocator = require('./RoleAllocator');
      const allocator = new RoleAllocator(this.engine);
      const newDemonId = shuffle(sc.demonRoles)[0];
      sw.role = allocator.createRoleInstance(newDemonId);
      this.engine.setPlayerPrivateInfo(sw, {
        type: 'scarletwoman',
        message: `恶魔已死，你成为了新的${sw.role.name}！`
      });
    }
  }

  getAliveCount() {
    return getAlivePlayers(this.engine.room).length;
  }
}

module.exports = DeathManager;
