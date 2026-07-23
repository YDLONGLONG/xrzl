// 死亡管理器
const { getAlivePlayers } = require('../utils/helpers');

class DeathManager {
  constructor(engine) {
    this.engine = engine;
  }

  // 杀死玩家（触发技能）
  killPlayer(playerId, cause, nightCount = -1, dayCount = -1) {
    const player = this.engine.room.players.get(playerId);
    if (!player || !player.isAlive) return null;

    player.isAlive = false;
    player.isDead = true;
    player.deathNight = nightCount;
    player.deathDay = dayCount;
    player.voteToken = 1; // 死者获得1次投票

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
