// 胜负判定器
const { getAlivePlayers, getPlayerEffectiveTeam } = require('../utils/helpers');
const { PHASES } = require('../config/game-config');

// 圣徒能力是否生效：中毒或醉酒时技能失效，被处决不判邪恶获胜。
// 处决时的即时判定（checkSaintExecution）与 checkVictory 的备份判定共用此口径，
// 避免两处规则漂移（历史上备份分支漏了中毒/醉酒判定）。
function isSaintAbilityActive(player) {
  return !!(player && player.role && player.role.id === 'saint'
    && !player.isPoisoned && !player.isDrunk);
}

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
      return this.endGame('GOOD', '仅剩三人，市长存活，善良阵营获胜！', 'mayor_three_alive');
    }

    // 检查恶魔存活情况
    const demon = alive.find(p => p.role.category === 'DEMON' && !p.role.isFakeDemon);
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
            return p && p.role && p.role.category === 'DEMON' && !p.role.isFakeDemon && d.cause === 'EXECUTION';
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

    // 场上仅剩恶魔一人（其余玩家全部死亡）：必须立即结束，
    // 否则会进入死局——恶魔被唤醒后无法选满目标数，夜晚流程永远无法结算。
    if (demon && alive.length <= 1) {
      return this.endGame('EVIL', '场上仅剩恶魔一名玩家存活，邪恶阵营获胜！');
    }

    // 检查圣徒被处决（在处决时触发，这里作为备份）
    // 中毒/醉酒的圣徒技能失效，被处决不判邪恶胜
    const executedSaint = gs.todaysDeaths.find(d => {
      const p = room.players.get(d.playerId);
      return isSaintAbilityActive(p) && d.cause === 'EXECUTION';
    });
    if (executedSaint) {
      return this.endGame('EVIL', '圣徒被处决，邪恶阵营获胜！', 'saint_executed', {
        roleName: executedSaint.nominatorRoleName || '无名者'
      });
    }

    return null;
  }

  // 主谋额外白天处决检查：被处决的玩家阵营落败
  checkMastermindExecution(executedPlayer) {
    const gs = this.engine.room.gameState;
    if (!gs.mastermindExtraRound) return null;
    if (!executedPlayer || !executedPlayer.role) return null;

    gs.mastermindExtraRound = false;
    const losingTeam = getPlayerEffectiveTeam(executedPlayer);
    const winningTeam = losingTeam === 'GOOD' ? 'EVIL' : 'GOOD';
    return this.endGame(
      winningTeam,
      `主谋额外白天：${executedPlayer.seat+1}号${executedPlayer.name}（${losingTeam === 'GOOD' ? '善良' : '邪恶'}阵营）被处决，其阵营落败！`,
      winningTeam === 'GOOD' ? 'mastermind_good' : 'mastermind_evil'
    );
  }

  checkSaintExecution(playerId) {
    const room = this.engine.room;
    const player = room.players.get(playerId);
    // 中毒/醉酒时圣徒能力失效：被处决不判邪恶获胜
    if (!isSaintAbilityActive(player)) {
      return null;
    }
    // 提名者的角色名：来自 VoteManager 写入的处决记录（结束动画「我名xx，请求你的原谅」）
    const entry = (room.gameState.todaysDeaths || []).find(
      d => d.playerId === playerId && d.cause === 'EXECUTION'
    );
    return this.endGame('EVIL', '圣徒被处决，邪恶阵营获胜！', 'saint_executed', {
      roleName: (entry && entry.nominatorRoleName) || '无名者'
    });
  }

  endGame(winner, reason, effectType = null, effectParams = null) {
    const room = this.engine.room;
    const gs = room.gameState;
    
    gs.phase = PHASES.GAME_OVER;
    gs.winner = winner;
    gs.winReason = reason;
    gs.endedAt = new Date();
    // 专属胜利特效：显式指定 effectType，或按局势推导（如恶魔被杀手公开击杀）
    gs.winEffect = this.resolveWinEffect(winner, effectType, effectParams);

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
        category: p.role.category,
        team: getPlayerEffectiveTeam(p),
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
      winEffect: gs.winEffect || null,
      allRoles
    });

    // 广播完整状态更新，让前端渲染GAME_OVER界面
    this.engine.broadcastState();

    return { winner, reason };
  }

  // 专属胜利特效（前端据此播放胜利动画）：
  //  - 传入 effectType：按该类型直接下发，文案由前端 VICTORY_EFFECTS 注册表决定
  //    （message 留 null，前端取不到注册文案时回退到本局 winReason）；
  //    effectParams 供文案里的 {占位符} 使用（如圣徒动画的 {roleName}）
  //  - 未传入：按局势自动推导，当前只覆盖「恶魔被杀手公开击杀导致的善良胜利」
  resolveWinEffect(winner, effectType = null, effectParams = null) {
    if (effectType) {
      // winner 一并下发：前端据此决定动画配色（GOOD 绿色 / EVIL 红色）
      return { type: effectType, message: null, params: effectParams || null, winner };
    }
    const gs = this.engine.room.gameState;
    if (winner !== 'GOOD' || !gs.slayerDemonKill) return null;
    const demon = this.engine.room.players.get(gs.slayerDemonKill.demonId);
    // 恶魔必须确实死亡（未被免死效果阻止、也没有被新恶魔顶替）
    if (!demon || !demon.isDead) return null;
    return {
      type: 'slayer_demon_kill',
      message: '恶魔，你逃不掉的！',
      winner,
      slayerId: gs.slayerDemonKill.slayerId,
      demonId: gs.slayerDemonKill.demonId
    };
  }
}

module.exports = VictoryChecker;
