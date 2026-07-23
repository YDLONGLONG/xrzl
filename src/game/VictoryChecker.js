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
    const demon = alive.find(p => p.role.category === 'DEMON' && !p.isFakeDemon);
    if (!demon) {
      // 主谋额外回合中：不因恶魔死亡而结束游戏（等待额外白天结束）
      if (gs.mastermindExtraRound) {
        return null;
      }
      // 检查主谋触发：恶魔死于处决且主谋存活且尚未触发
      if (!gs.mastermindTriggered) {
        const mastermind = alive.find(p => p.role.id === 'mastermind' && !p.isPoisoned);
        if (mastermind) {
          const demonExecuted = gs.todaysDeaths.find(d => {
            const p = room.players.get(d.playerId);
            return p && p.role && p.role.category === 'DEMON' && !p.isFakeDemon && d.cause === 'EXECUTION';
          });
          if (demonExecuted) {
            gs.mastermindTriggered = true;
            gs.mastermindExtraRound = true;
            this.engine.logAction('MASTERMIND', `主谋触发！${mastermind.seat+1}号${mastermind.name}（主谋）存活，恶魔被处决但游戏继续，额外进行一个夜晚和一个白天`);
            return null;
          }
        }
      }
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

  // 主谋额外白天处决检查：被处决的玩家阵营落败
  checkMastermindExecution(executedPlayer) {
    const gs = this.engine.room.gameState;
    if (!gs.mastermindExtraRound) return null;
    if (!executedPlayer || !executedPlayer.role) return null;

    gs.mastermindExtraRound = false;
    const losingTeam = executedPlayer.role.team;
    const winningTeam = losingTeam === 'GOOD' ? 'EVIL' : 'GOOD';
    return this.endGame(
      winningTeam,
      `主谋额外白天：${executedPlayer.seat+1}号${executedPlayer.name}（${losingTeam === 'GOOD' ? '善良' : '邪恶'}阵营）被处决，其阵营落败！`
    );
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
