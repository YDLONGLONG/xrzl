// 胜负判定器
const { getAlivePlayers } = require('../utils/helpers');
const { PHASES } = require('../config/game-config');

class VictoryChecker {
  constructor(engine) {
    this.engine = engine;
  }

  checkVictory() {
    const room = this.engine.room;
    const gs = room.gameState;
    const alive = getAlivePlayers(room);

    // 检查圣徒被处决
    // 这个在VoteManager中处理

    // 检查市长三人局
    const mayor = alive.find(p => p.role.id === 'mayor');
    if (alive.length === 3 && mayor) {
      // 如果刚处决完，需要看市长是否存活
      return this.endGame('GOOD', '仅剩三人，市长存活，善良阵营获胜！');
    }

    // 检查恶魔存活情况
    const demon = alive.find(p => p.role.category === 'DEMON');
    if (!demon) {
      return this.endGame('GOOD', '恶魔已死亡，善良阵营获胜！');
    }

    // 检查邪恶胜利：仅剩2人且恶魔存活
    if (alive.length === 2 && demon) {
      return this.endGame('EVIL', '仅剩两名玩家存活且恶魔仍在，邪恶阵营获胜！');
    }

    // 检查圣徒被处决（在处决时触发，这里作为备份）
    const executedSaint = gs.todaysDeaths.find(d => {
      const p = room.players.get(d.playerId);
      return p && p.role.id === 'saint' && d.cause === 'EXECUTION';
    });
    if (executedSaint) {
      return this.endGame('EVIL', '圣徒被处决，邪恶阵营获胜！');
    }

    return null;
  }

  checkSaintExecution(playerId) {
    const player = this.engine.room.players.get(playerId);
    if (player && player.role.id === 'saint' && !player.isPoisoned) {
      return this.endGame('EVIL', '圣徒被处决，邪恶阵营获胜！');
    }
    return null;
  }

  endGame(winner, reason) {
    const room = this.engine.room;
    const gs = room.gameState;
    
    gs.phase = PHASES.GAME_OVER;
    gs.winner = winner;
    gs.winReason = reason;
    gs.endedAt = new Date();

    this.engine.logAction('GAME_OVER', `游戏结束！${winner === 'GOOD' ? '善良阵营' : '邪恶阵营'}获胜！原因：${reason}`, {
      winner, reason
    });

    // 收集所有玩家角色信息
    const allRoles = Array.from(room.players.values())
      .filter(p => p.seat !== -1)
      .map(p => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        roleName: p.role.name,
        roleId: p.role.id,
        team: p.role.team,
        isAlive: p.isAlive,
        isBot: !!p.isBot
      }));

    // 保存历史记录
    if (this.engine._onSaveHistory) {
      this.engine._onSaveHistory(allRoles);
    }

    this.engine.io.to(room.id).emit('game:over', {
      winner,
      winReason: reason,
      allRoles
    });

    // 广播完整状态更新，让前端渲染GAME_OVER界面
    this.engine.broadcastState();

    return { winner, reason };
  }
}

module.exports = VictoryChecker;
