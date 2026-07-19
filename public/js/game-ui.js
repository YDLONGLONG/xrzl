// 游戏UI主渲染
function renderGameState(state) {
  if (!state) return;

  // 更新头部信息
  updateHeader(state);
  
  // 渲染座位
  renderSeats(state);
  
  // 渲染中央区域
  renderCenter(state);
  
  // 渲染身份卡
  renderRoleCard(state);
  
  // 更新聊天私聊列表
  if (state.players) {
    updateWhisperTargets(state.players);
  }

  // 处理夜晚遮罩
  handleNightOverlay(state);
}

function updateHeader(state) {
  $('headerRoomId').textContent = `房间: ${state.roomId || myRoomId}`;
  
  let dayText = '';
  let phaseText = '';
  let phaseClass = 'phase-lobby';

  if (state.dayCount > 0 || state.nightCount > 0) {
    dayText = `第${state.dayCount}天 / 第${state.nightCount}夜`;
  }

  switch(state.phase) {
    case 'LOBBY':
      phaseText = '大厅';
      phaseClass = 'phase-lobby';
      break;
    case 'FIRST_NIGHT':
    case 'NIGHT':
    case 'NIGHT_WAKE':
      phaseText = '夜晚';
      phaseClass = 'phase-night';
      break;
    case 'DAY_DAWN':
      phaseText = '天亮';
      phaseClass = 'phase-day';
      break;
    case 'DAY_DISCUSSION':
    case 'NOMINATION_PHASE':
      phaseText = '白天讨论';
      phaseClass = 'phase-day';
      break;
    case 'DEFENSE':
      phaseText = '辩护中';
      phaseClass = 'phase-day';
      break;
    case 'VOTING':
      phaseText = '投票中';
      phaseClass = 'phase-vote';
      break;
    case 'EXECUTION':
      phaseText = '处决';
      phaseClass = 'phase-vote';
      break;
    case 'GAME_OVER':
      phaseText = '游戏结束';
      phaseClass = 'phase-over';
      break;
  }

  $('headerDayCount').textContent = dayText;
  const phaseBadge = $('headerPhase');
  phaseBadge.textContent = phaseText;
  phaseBadge.className = 'phase-badge ' + phaseClass;
}

function renderSeats(state) {
  const container = $('seatsArea');
  const players = state.players || [];
  const seats = state.seats || new Array(15).fill(null);
  const me = players.find(p => p.id === myId);

  let html = '';
  
  // 按座位顺序显示
  for (let i = 0; i < 15; i++) {
    const pid = seats[i];
    if (pid) {
      const p = players.find(x => x.id === pid);
      if (!p) continue;
      const isMe = p.id === myId;
      const isDead = p.isDead;
      const classes = ['game-seat'];
      if (isMe) classes.push('you');
      if (isDead) classes.push('dead');
      
      let markHtml = '';
      if (isDead) markHtml += '<span class="seat-mark dead-mark">死亡</span>';
      if (p.isHost) markHtml += '<span class="seat-mark" style="color:#d4af37;">房主</span>';
      if (state.gameStarted && p.voteToken > 0 && isDead) markHtml += '<span class="seat-mark" style="color:#3498db;">剩余1票</span>';
      if (!state.gameStarted && p.isReady) markHtml += '<span class="seat-mark good">已准备</span>';

      const canNominate = (state.phase === 'DAY_DISCUSSION' || state.phase === 'NOMINATION_PHASE') && 
                          state.gameStarted && me && me.isAlive && !isDead;
      const clickHandler = canNominate ? `onclick="nominatePlayer('${p.id}')"` : '';

      html += `<div class="${classes.join(' ')}" data-pid="${p.id}" ${clickHandler}>
        <div class="seat-num">${i+1}</div>
        <div class="seat-name">${escapeHtml(p.name)}</div>
        ${markHtml}
      </div>`;
    } else if (!state.gameStarted) {
      // 空座位（大厅时可点击入座）
      html += `<div class="game-seat" onclick="sitDown(${i})">
        <div class="seat-num">${i+1}</div>
        <div style="color:#666; font-size:12px;">空座位</div>
        <div style="color:#d4af37; font-size:11px;">点击入座</div>
      </div>`;
    } else {
      html += `<div class="game-seat" style="opacity:0.3;">
        <div class="seat-num">${i+1}</div>
      </div>`;
    }
  }

  container.innerHTML = html;
}

function sitDown(seatNum) {
  sendSocket('room:seat', { seatNumber: seatNum });
}

function renderCenter(state) {
  const msg = $('centerMessage');
  const actionPanel = $('actionPanel');
  const confirmBar = $('confirmBar');
  
  let html = '';
  let msgClass = '';
  let showAction = false;
  let showConfirm = false;

  // 大厅状态
  if (!state.gameStarted) {
    const me = state.players?.find(p => p.id === myId);
    const seatedCount = (state.players || []).filter(p => p.seat !== -1).length;
    const isHost = state.hostId === myId;
    
    html = `<div style="text-align:center;">
      <h2 style="color:#d4af37; margin-bottom:20px;">游戏大厅</h2>
      <p>入座玩家: ${seatedCount}/15（至少需要5人）</p>
      <p style="margin-top:10px; color:#aaa;">点击左侧空座位入座，准备后房主开始游戏</p>
    </div>`;
    
    showAction = true;
    $('actionTitle').textContent = '操作';
    
    let buttons = '';
    if (me && me.seat !== -1) {
      buttons += `<button class="btn btn-sm ${me.isReady ? 'btn-secondary' : 'btn-success'}" onclick="toggleReady()">${me.isReady ? '取消准备' : '准备'}</button>`;
    }
    if (isHost) {
      const allReady = (state.players || []).filter(p => p.seat !== -1).every(p => p.isReady);
      const canStart = seatedCount >= 5 && allReady;
      buttons += `<button class="btn btn-sm btn-primary" ${canStart ? '' : 'disabled'} onclick="startGame()">开始游戏</button>`;
    }
    
    $('selectedTargets').innerHTML = '';
    $('actionButtons').innerHTML = buttons;
  } else {
    // 游戏中
    switch(state.phase) {
      case 'FIRST_NIGHT':
      case 'NIGHT':
        msgClass = 'night';
        html = '<div style="color:#9b59b6;">🌙 夜幕降临</div>';
        if (state.privateInfo && !state.isYourTurn) {
          html += `<div style="margin-top:15px; color:#d4af37;">${state.privateInfo.message || ''}</div>`;
        }
        if (state.isYourTurn) {
          html += '<div style="margin-top:10px; color:#f39c12;">正在等待你的行动...</div>';
        } else {
          html += '<div style="margin-top:10px; color:#666;">等待其他玩家行动...</div>';
        }
        break;

      case 'NIGHT_WAKE':
        msgClass = 'night';
        html = '<div style="color:#9b59b6;">🌙 你的回合</div>';
        if (state.privateInfo) {
          html += `<div style="margin-top:15px; color:#d4af37;">${state.privateInfo.message || ''}</div>`;
        }
        break;

      case 'DAY_DAWN':
        msgClass = 'dawn';
        html = '<div style="color:#f39c12;">☀️ 天亮了</div>';
        if (state.deathsToAnnounce && state.deathsToAnnounce.length > 0) {
          html += '<div style="margin-top:15px;">昨晚死亡的玩家：</div>';
          html += state.deathsToAnnounce.map(d => 
            `<div style="color:#e74c3c; font-size:1.2em; margin-top:5px;">${d.seat+1}号 ${d.name}</div>`
          ).join('');
        } else if (state.nightCount === 0) {
          html += '<div style="margin-top:15px; color:#27ae60;">平安夜，无人死亡</div>';
        } else {
          html += '<div style="margin-top:15px; color:#27ae60;">平安夜，无人死亡</div>';
        }
        showConfirm = true;
        break;

      case 'DAY_DISCUSSION':
        msgClass = '';
        html = `<div>💬 自由讨论中 - 第${state.dayCount}天</div>`;
        html += '<div style="margin-top:10px; color:#aaa; font-size:0.9em;">点击左侧玩家可提名；全员确认后进入投票阶段</div>';
        showConfirm = true;
        break;

      case 'NOMINATION_PHASE':
        msgClass = '';
        html = '<div>📋 提名阶段</div>';
        html += '<div style="margin-top:10px; color:#aaa; font-size:0.9em;">点击左侧玩家提名；全员确认后结束提名进行处决</div>';
        if (state.nominations && state.nominations.length > 0) {
          html += '<div style="margin-top:15px;">今日提名：</div>';
          html += state.nominations.map((n, idx) => {
            const nom = state.players.find(p => p.id === n.nominatorId);
            const nm = state.players.find(p => p.id === n.nomineeId);
            const status = n.passed ? (n.resolved ? `${n.voteCount}票 - 通过` : '投票中') : (n.resolved ? `${n.voteCount}票 - 未通过` : '');
            return `<div style="margin-top:5px;">${nom.seat+1}号提名${nm.seat+1}号 ${status}</div>`;
          }).join('');
        }
        showConfirm = true;
        showAction = true;
        $('actionTitle').textContent = '操作';
        $('selectedTargets').innerHTML = '';
        $('actionButtons').innerHTML = `<button class="btn btn-sm btn-danger" onclick="endNominations()">结束提名/处决投票</button>`;
        break;

      case 'DEFENSE':
        if (state.currentDefensePlayerId === myId) {
          html = '<div style="color:#e74c3c;">⚖️ 你被提名了！请辩护</div>';
          html += '<div style="margin-top:10px;">辩护完毕后点击"辩护完毕"按钮进入投票</div>';
        } else {
          const def = state.players.find(p => p.id === state.currentDefensePlayerId);
          html = `<div style="color:#f39c12;">⚖️ ${def ? def.seat+1+'号 '+def.name : ''} 正在辩护...</div>`;
        }
        break;

      case 'VOTING':
        html = '<div style="color:#e74c3c;">🗳️ 投票中</div>';
        const nominee = state.nominations ? state.players.find(p => p.id === state.nominations[state.nominations.length-1]?.nomineeId) : null;
        if (nominee) {
          html += `<div style="margin-top:10px; font-size:1.2em;">是否处决 ${nominee.seat+1}号 ${nominee.name}？</div>`;
        }
        if (state.nominations) {
          const cur = state.nominations[state.nominations.length-1];
          if (cur) {
            html += `<div style="margin-top:10px; color:#d4af37; font-size:1.5em;">${cur.voteCount} 票赞成</div>`;
          }
        }
        break;

      case 'EXECUTION':
        html = '<div>⚰️ 处决阶段</div>';
        showConfirm = true;
        break;

      case 'GAME_OVER':
        if (state.winner === 'GOOD') {
          msgClass = 'victory-good';
          html = '<div style="font-size:1.5em;">🎉 善良阵营胜利！</div>';
        } else {
          msgClass = 'victory-evil';
          html = '<div style="font-size:1.5em;">💀 邪恶阵营胜利！</div>';
        }
        html += `<div style="margin-top:10px; color:#aaa;">${state.winReason || ''}</div>`;
        showAction = true;
        $('actionTitle').textContent = '游戏结束';
        $('selectedTargets').innerHTML = '';
        $('actionButtons').innerHTML = `<button class="btn btn-primary btn-sm" onclick="window.location.href='/'">返回大厅</button>`;
        
        // 显示身份表
        if (state.allRoles) {
          showGameOverRoles(state.allRoles);
        }
        break;
    }
  }

  msg.className = 'center-message ' + msgClass;
  msg.innerHTML = html;
  actionPanel.style.display = showAction || state.phase === 'VOTING' || state.phase === 'DEFENSE' ? 'block' : 'none';
  confirmBar.style.display = showConfirm ? 'block' : 'none';

  // 更新确认进度
  if (showConfirm) {
    const confirmed = state.confirmedCount || 0;
    const total = state.totalNeeded || 1;
    const pct = Math.min((confirmed / total) * 100, 100);
    $('confirmText').textContent = `确认进度: ${confirmed}/${total}`;
    $('confirmProgressFill').style.width = pct + '%';
    $('confirmBtn').textContent = confirmed >= total ? '等待其他玩家...' : '我已准备好，进入下一阶段';
    $('confirmBtn').disabled = false;
  }
}

function endNominations() {
  sendSocket('game:confirm');
}

function toggleReady() {
  sendSocket('room:toggleReady');
}

function startGame() {
  sendSocket('game:start');
}

function renderRoleCard(state) {
  const card = $('roleCard');
  const me = state.players?.find(p => p.id === myId);
  
  if (!state.yourRole || !me) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'flex';
  
  const role = state.yourRole;
  const icon = $('roleIcon');
  icon.className = 'role-icon ' + (role.team === 'GOOD' ? 'good' : 'evil');
  icon.textContent = role.team === 'GOOD' ? '善' : '恶';
  
  $('roleName').textContent = role.name;
  const teamEl = $('roleTeam');
  teamEl.textContent = role.team === 'GOOD' ? '善良阵营' : '邪恶阵营';
  teamEl.className = 'role-team ' + (role.team === 'GOOD' ? 'good' : 'evil');
  $('roleDesc').textContent = role.abilityDesc;

  // 邪恶队友信息
  const evilEl = $('evilTeammates');
  if (state.evilTeam && role.team === 'EVIL') {
    evilEl.style.display = 'block';
    let info = '你的队友: ';
    info += state.evilTeam.filter(p => p.id !== myId).map(p => `${p.seat+1}号${p.name}【${p.roleName}】`).join('、');
    if (state.notInPlay && role.category === 'DEMON') {
      info += `<br>不在场身份: ${state.notInPlay.join('、')}`;
    }
    evilEl.innerHTML = info;
  } else {
    evilEl.style.display = 'none';
  }

  // 杀手技能按钮
  const slayerBtn = $('slayerBtn');
  if (role.id === 'slayer' && me.isAlive && !me.hasUsedDayAbility && 
      (state.phase === 'DAY_DISCUSSION' || state.phase === 'NOMINATION_PHASE')) {
    slayerBtn.style.display = 'block';
  } else {
    slayerBtn.style.display = 'none';
  }

  // 死者频道
  if (me.isDead) {
    $('deadChatTab').style.display = 'block';
  }
}

function handleNightOverlay(state) {
  const overlay = $('nightOverlay');
  
  if (state.isNight && state.phase !== 'GAME_OVER') {
    if (state.isYourTurn && state.phase === 'NIGHT_WAKE') {
      // 被唤醒，在night-phase.js的showNightWake中处理
      // 这里只处理未被唤醒的等待状态
      if (!overlay.classList.contains('wake')) {
        showWaitingNight();
      }
    } else if (!state.isYourTurn) {
      showWaitingNight();
    }
  } else {
    hideNightOverlay();
  }
}

function showGameOverRoles(allRoles) {
  $('gameOverPanel').style.display = 'block';
  const title = $('gameOverTitle');
  const reason = $('gameOverReason');
  
  const state = currentState;
  if (state.winner === 'GOOD') {
    title.textContent = '🎉 善良阵营胜利！';
    title.style.color = '#2ecc71';
  } else {
    title.textContent = '💀 邪恶阵营胜利！';
    title.style.color = '#e74c3c';
  }
  reason.textContent = state.winReason || '';

  const tbody = $('rolesRevealBody');
  tbody.innerHTML = allRoles.sort((a,b) => a.seat - b.seat).map(p => `
    <tr class="${p.isAlive ? '' : 'dead-row'}">
      <td>${p.seat + 1}</td>
      <td>${escapeHtml(p.name)}</td>
      <td>${p.roleName}</td>
      <td class="${p.team === 'GOOD' ? 'good' : 'evil'}">${p.team === 'GOOD' ? '善良' : '邪恶'}</td>
      <td>${p.isAlive ? '存活' : '死亡'}</td>
    </tr>
  `).join('');
}

// 初始化
window.addEventListener('DOMContentLoaded', () => {
  initGameSocket();
});
