// 血染钟楼前端主逻辑 - 单页应用
let socket;
let currentState = null;
let myId = null;
let myRoomId = null;
let myName = null;
let nightSelectedTargets = [];
let nightCanSelectCount = 0;
let currentChatChannel = 'public';
let selectedNominateTarget = null;
let whisperTargetId = null; // 当前私聊对象ID
let isGodView = false;
let godState = null;
let isReconnecting = false;
let reconnectAttempts = 0;

// ========== 初始化 ==========
window.addEventListener('DOMContentLoaded', () => {
  socket = io({ reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: 30 });
  initSocketEvents();
  
  // 回车提交
  $('createName').addEventListener('keydown', e => { if (e.key === 'Enter') createRoom(); });
  $('joinName').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
  $('joinRoomId').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

  // 移动端：点击聊天标签栏（拖拽区域）切换聊天面板
  const chatTabs = document.querySelector('.chat-tabs');
  if (chatTabs) {
    chatTabs.addEventListener('click', (e) => {
      if (window.innerWidth > 768) return;
      // 如果点击的是tab本身，由switchChatChannel处理
      if (e.target.classList.contains('chat-tab')) return;
      // 点击标签栏空白区域，切换面板
      toggleMobileChat();
    });
  }

  // 尝试自动重连
  tryAutoReconnect();
});

// 尝试自动重连（从sessionStorage恢复）
function tryAutoReconnect() {
  try {
    const saved = sessionStorage.getItem('xrzl_session');
    if (saved) {
      const { roomId, playerName } = JSON.parse(saved);
      if (roomId && playerName) {
        myRoomId = roomId;
        myName = playerName;
        // 等待socket连接后重连
        if (socket.connected) {
          doReconnect();
        } else {
          isReconnecting = true;
          showToast('正在尝试重新连接...');
        }
      }
    }
  } catch(e) {
    console.error('恢复会话失败:', e);
  }
}

function doReconnect() {
  if (!myRoomId || !myName) return;
  console.log('尝试重连到房间:', myRoomId, '昵称:', myName);
  socket.emit('room:join', { roomId: myRoomId, playerName: myName, isReconnect: true });
}

function saveSession() {
  if (myRoomId && myName) {
    sessionStorage.setItem('xrzl_session', JSON.stringify({ roomId: myRoomId, playerName: myName }));
  }
}

function clearSession() {
  sessionStorage.removeItem('xrzl_session');
}

function initSocketEvents() {
  socket.on('connect', () => {
    console.log('已连接到服务器');
    // 如果之前有会话，尝试重连
    if (isReconnecting || (myRoomId && myName)) {
      doReconnect();
    }
  });

  socket.on('disconnect', () => {
    console.log('与服务器断开连接');
    if (myRoomId && myName) {
      showToast('与服务器断开，正在尝试重新连接...');
      isReconnecting = true;
    }
  });

  socket.on('room:created', ({ roomId, playerId }) => {
    myId = playerId;
    myRoomId = roomId;
    saveSession();
    showGameView();
  });

  socket.on('room:joined', ({ roomId, playerId }) => {
    myId = playerId;
    myRoomId = roomId;
    saveSession();
    showGameView();
  });

  socket.on('room:reconnected', ({ roomId, playerId, gameStarted }) => {
    myId = playerId;
    myRoomId = roomId;
    isReconnecting = false;
    saveSession();
    showGameView();
    showToast('重新连接成功！');
    // 关闭可能打开的断线遮罩
    const overlay = $('disconnectOverlay');
    if (overlay) overlay.style.display = 'none';
  });

  socket.on('room:playerDisconnected', ({ name }) => {
    showToast(`玩家 ${name} 已断线，AI将托管其行动`);
  });

  socket.on('room:playerReconnected', ({ name }) => {
    showToast(`玩家 ${name} 已重新连接`);
  });

  socket.on('room:stateUpdate', (state) => {
    currentState = state;
    renderGameState(state);
  });

  socket.on('game:stateUpdate', (state) => {
    currentState = state;
    renderGameState(state);
  });

  socket.on('room:error', ({ message }) => {
    showToast(message);
  });

  socket.on('room:kicked', ({ message }) => {
    showToast(message || '你已被踢出房间');
    backToHome();
  });

  socket.on('game:over', (data) => {
    showGameOver(data);
  });

  socket.on('night:wake', (data) => {
    showNightWake(data);
  });

  socket.on('night:actionAck', (data) => {
    if (data.success) hideNightOverlay();
  });

  socket.on('game:votingStarted', (data) => {
    showVotingPanel(data);
  });

  socket.on('game:voteUpdate', (data) => {
    updateVoteDisplay(data);
  });

  socket.on('game:voteResult', (data) => {
    showVoteResult(data);
  });

  socket.on('game:nominationStarted', (data) => {
    showNominationStarted(data);
  });

  socket.on('game:executionResult', (data) => {
    showExecutionResult(data);
  });

  socket.on('game:abilityUsed', (data) => {
    showAbilityUsed(data);
  });

  socket.on('chat:message', (msg) => {
    addChatMessage(msg);
  });

  socket.on('player:died', (data) => {
    showPlayerDied(data);
  });

  // 上帝视角事件
  socket.on('god:loginResult', (data) => {
    if (data.success) {
      isGodView = true;
      $('godLoginForm').style.display = 'none';
      $('godContent').style.display = 'block';
      $('godBtn').style.background = 'linear-gradient(135deg,#9b59b6,#8e44ad)';
      $('godBtn').style.color = '#fff';
    } else {
      const err = $('godLoginError');
      err.textContent = '密码错误，请重试';
      err.style.display = 'block';
    }
  });

  socket.on('god:state', (state) => {
    godState = state;
    renderGodView();
  });

  socket.on('god:actionLog', (entry) => {
    if (godState) {
      godState.actionLog.push(entry);
      if (godState.actionLog.length > 200) godState.actionLog.shift();
      appendGodLogEntry(entry);
    }
  });

  socket.on('god:playerUpdate', (playerData) => {
    if (godState && godState.players) {
      const idx = godState.players.findIndex(p => p.id === playerData.id);
      if (idx >= 0) {
        godState.players[idx] = playerData;
      } else {
        godState.players.push(playerData);
      }
      // 只更新玩家相关区域，不重新渲染日志
      updateGodPlayers();
    }
  });

  socket.on('god:logoutResult', () => {
    isGodView = false;
    godState = null;
    $('godPanel').style.display = 'none';
    $('godContent').style.display = 'none';
    $('godLoginForm').style.display = 'block';
    $('godPassword').value = '';
    $('godLoginError').style.display = 'none';
    $('godBtn').style.background = 'rgba(155,89,182,0.3)';
    $('godBtn').style.color = '#d4a5e8';
  });
}

// ========== 视图切换 ==========
function showGameView() {
  $('homeView').style.display = 'none';
  $('gameView').style.display = 'grid';
  $('gameOverPanel').style.display = 'none';
}

function backToHome() {
  $('homeView').style.display = 'flex';
  $('gameView').style.display = 'none';
  $('gameOverPanel').style.display = 'none';
  $('godPanel').style.display = 'none';
  isGodView = false;
  godState = null;
  $('createName').value = '';
  $('joinRoomId').value = '';
  $('joinName').value = '';
  // 离开房间
  if (myRoomId) {
    socket.emit('room:leave');
  }
  clearSession();
  myId = null;
  myRoomId = null;
  myName = null;
  currentState = null;
  chatMessages = [];
  whisperTargetId = null;
  unreadPublic = 0;
  unreadDead = 0;
  unreadWhispers = {};
  customRoleMode = false;
  customRoleMap = {};
}

// ========== 首页操作 ==========
function createRoom() {
  const name = $('createName').value.trim();
  if (!name) {
    showError('请输入昵称', 'createError');
    return;
  }
  myName = name;
  socket.emit('room:create', { playerName: name });
}

function joinRoom() {
  const roomId = $('joinRoomId').value.trim().toUpperCase();
  const name = $('joinName').value.trim();
  if (!roomId || roomId.length !== 4) {
    showError('请输入4位房间码', 'joinError');
    return;
  }
  if (!name) {
    showError('请输入昵称', 'joinError');
    return;
  }
  myName = name;
  socket.emit('room:join', { roomId, playerName: name });
}

function leaveRoom() {
  if (confirm('确定要离开房间吗？')) {
    socket.emit('room:leave');
    backToHome();
  }
}

function sitDown(seatNum) {
  socket.emit('room:seat', { seatNumber: seatNum });
}

function toggleReady() {
  socket.emit('room:toggleReady');
}

let customRoleMode = false;  // 是否启用自定义角色分配
let customRoleMap = {};      // seat -> roleId

function startGame() {
  const seatedPlayers = (currentState.players || []).filter(p => p.seat !== -1);
  if (customRoleMode) {
    // 使用统一的验证函数
    const v = validateCustomRoles(customRoleMap, seatedPlayers.length);
    if (!v.valid) {
      showToast('自定义角色配置有误：' + v.errors[0]);
      return;
    }
    const roleAssignments = {};
    seatedPlayers.forEach(p => {
      if (customRoleMap[p.seat]) {
        roleAssignments[p.seat] = customRoleMap[p.seat];
      }
    });
    socket.emit('game:start', { customRoles: roleAssignments });
  } else {
    socket.emit('game:start', {});
  }
}

function addBot() {
  socket.emit('room:addBot');
}

function kickPlayer(pid) {
  const p = currentState && currentState.players ? currentState.players.find(x => x.id === pid) : null;
  if (!p) return;
  const name = p.name + (p.isBot ? '(机器人)' : '');
  if (!confirm(`确定要将 ${name} 踢出房间吗？`)) return;
  socket.emit('room:kick', { targetId: pid });
}

// 角色数量配置（人数 → 村民/外来者/爪牙/恶魔）
const ROLE_COMPOSITION_MAP = {};
[
  [5, 3, 0, 1, 1],
  [6, 3, 1, 1, 1],
  [7, 5, 0, 1, 1],
  [8, 5, 1, 1, 1],
  [9, 5, 2, 1, 1],
  [10, 7, 0, 2, 1],
  [11, 7, 1, 2, 1],
  [12, 7, 2, 2, 1],
  [13, 9, 0, 3, 1],
  [14, 9, 1, 3, 1],
  [15, 9, 2, 3, 1]
].forEach(([n, t, o, m, d]) => {
  ROLE_COMPOSITION_MAP[n] = { townsfolk: t, outsider: o, minion: m, demon: d };
});

function getCompHTML(playerCount) {
  const comp = ROLE_COMPOSITION_MAP[playerCount];
  if (!comp) return '';
  const badges = [];
  if (comp.townsfolk > 0) badges.push(`<span class="comp-badge comp-townsfolk">👤${comp.townsfolk}村民</span>`);
  if (comp.outsider > 0) badges.push(`<span class="comp-badge comp-outsider">❓${comp.outsider}外来者</span>`);
  if (comp.minion > 0) badges.push(`<span class="comp-badge comp-minion">🗡️${comp.minion}爪牙</span>`);
  if (comp.demon > 0) badges.push(`<span class="comp-badge comp-demon">👿${comp.demon}恶魔</span>`);
  return badges.join('');
}

// ========== 游戏状态渲染 ==========
function renderGameState(state) {
  if (!state) return;
  updateHeader(state);
  renderSeats(state);
  renderCenter(state);
  renderRoleCard(state);
  if (state.players) updateWhisperTargets(state.players);
  handleNightOverlay(state);
}

function updateHeader(state) {
  $('headerRoomId').textContent = `房间: ${state.roomId || myRoomId}`;

  // 显示角色数量配置
  const playerCount = state.players ? state.players.filter(p => p.seat !== -1).length : 0;
  const compEl = $('headerRoomComp');
  const compHTML = getCompHTML(playerCount);
  const compPlayers = state.players ? state.players.length : 0;
  compEl.innerHTML = compHTML ? `<span class="comp-players">${compPlayers}人</span>${compHTML}` : '';
  
  let dayText = '';
  let phaseText = '';
  let phaseClass = 'phase-lobby';

  if (state.dayCount > 0 || state.nightCount > 0) {
    dayText = `第${state.dayCount}天 / 第${state.nightCount}夜`;
  }

  switch(state.phase) {
    case 'LOBBY': phaseText = '大厅'; phaseClass = 'phase-lobby'; break;
    case 'FIRST_NIGHT': case 'NIGHT': case 'NIGHT_WAKE':
      phaseText = '夜晚'; phaseClass = 'phase-night'; break;
    case 'DAY_DAWN': phaseText = '天亮'; phaseClass = 'phase-day'; break;
    case 'DAY_DISCUSSION': case 'NOMINATION_PHASE':
      phaseText = '白天'; phaseClass = 'phase-day'; break;
    case 'DEFENSE': phaseText = '辩护中'; phaseClass = 'phase-day'; break;
    case 'VOTING': phaseText = '投票中'; phaseClass = 'phase-vote'; break;
    case 'EXECUTION': phaseText = '处决'; phaseClass = 'phase-vote'; break;
    case 'GAME_OVER': phaseText = '游戏结束'; phaseClass = 'phase-over'; break;
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
      if (p.isConnected === false) classes.push('disconnected');

      let markHtml = '';
      if (isDead) markHtml += '<span class="seat-mark dead-mark">死亡</span>';
      if (p.isHost) markHtml += '<span class="seat-mark" style="color:#d4af37;">房主</span>';
      if (state.gameStarted && p.voteToken > 0 && isDead) markHtml += '<span class="seat-mark" style="color:#3498db;">余1票</span>';
      if (!state.gameStarted && p.isReady) markHtml += '<span class="seat-mark good">已准备</span>';
      if (p.isConnected === false) markHtml += '<span class="seat-mark" style="color:#e67e22; background:rgba(230,126,34,0.15);">断线</span>';

      const canNominate = (state.phase === 'DAY_DISCUSSION' || state.phase === 'NOMINATION_PHASE') &&
                          state.gameStarted && me && me.isAlive && !isDead;
      const isHostView = state.hostId === myId;
      const canKick = isHostView && !state.gameStarted && !p.isHost;
      const clickHandler = canNominate ? `onclick="nominatePlayer('${p.id}')"` : '';
      const kickBtn = canKick ? `<span class="kick-btn" onclick="event.stopPropagation(); kickPlayer('${p.id}')" title="踢出房间">✕</span>` : '';

      html += `<div class="${classes.join(' ')}" data-pid="${p.id}" ${clickHandler}>
        <div class="seat-num">${i+1}</div>
        <div class="seat-name">${escapeHtml(p.name)}${p.isBot ? ' 🤖' : ''}</div>
        ${markHtml}
        ${kickBtn}
      </div>`;
    } else if (!state.gameStarted) {
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

function renderCenter(state) {
  const msg = $('centerMessage');
  const actionPanel = $('actionPanel');
  const confirmBar = $('confirmBar');
  
  let html = '';
  let msgClass = '';
  let showAction = false;
  let showConfirm = false;

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
      buttons += `<button class="btn btn-sm btn-warning" onclick="addBot()">+ 添加机器人</button>`;
      const customCount = Object.values(customRoleMap).filter(r => r).length;
      const customLabel = customRoleMode ? `🎭 自定义角色(${customCount})` : '🎭 自定义角色';
      const customClass = customRoleMode ? 'btn-info' : 'btn-secondary';
      buttons += `<button class="btn btn-sm ${customClass}" onclick="openCustomRolePanel()">${customLabel}</button>`;
      const allReady = (state.players || []).filter(p => p.seat !== -1).every(p => p.isReady);
      const canStart = seatedCount >= 5 && allReady;
      buttons += `<button class="btn btn-sm btn-primary" ${canStart ? '' : 'disabled'} onclick="startGame()">开始游戏</button>`;
    }
    
    $('selectedTargets').innerHTML = '';
    $('actionButtons').innerHTML = buttons;
  } else {
    switch(state.phase) {
      case 'FIRST_NIGHT': case 'NIGHT':
        msgClass = 'night';
        html = '<div style="color:#9b59b6;">🌙 夜幕降临</div>';
        if (state.isYourTurn) {
          html += '<div style="margin-top:10px; color:#f39c12;">正在等待你的行动...</div>';
        } else {
          html += '<div style="margin-top:10px; color:#666;">等待其他玩家行动...</div>';
        }
        break;

      case 'NIGHT_WAKE':
        msgClass = 'night';
        html = '<div style="color:#9b59b6;">🌙 你的回合</div>';
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
        html += '<div style="margin-top:10px; color:#aaa; font-size:0.9em;">点击左侧玩家可提名；全员确认后进入提名投票</div>';
        showConfirm = true;
        break;

      case 'NOMINATION_PHASE':
        msgClass = '';
        html = '<div>📋 提名阶段</div>';
        html += '<div style="margin-top:10px; color:#aaa; font-size:0.9em;">点击左侧玩家提名；全员确认后结束提名</div>';
        if (state.nominations && state.nominations.length > 0) {
          html += '<div style="margin-top:15px;">今日提名：</div>';
          html += state.nominations.map((n, idx) => {
            const nom = state.players.find(p => p.id === n.nominatorId);
            const nm = state.players.find(p => p.id === n.nomineeId);
            let resultHtml = '';
            if (n.resolved) {
              // 已完成投票：显示结果 + 详细投票名单
              const yesVoters = [];
              const noVoters = [];
              const abstain = [];
              const cvotes = n.currentVotes || {};
              state.players.forEach(p => {
                if (p.seat < 0) return;
                const voted = cvotes[p.id];
                if (voted === true) yesVoters.push(p);
                else if (voted === false) noVoters.push(p);
                else abstain.push(p);
              });
              const passTag = n.passed
                ? `<span style="color:#2ecc71; font-weight:bold;">✅ 通过 (${n.voteCount}票)</span>`
                : `<span style="color:#e74c3c; font-weight:bold;">❌ 未通过 (${n.voteCount}票)</span>`;
              resultHtml = `<div style="margin:6px 0 8px 0; padding:8px 10px; background:rgba(0,0,0,0.25); border-radius:6px; border-left:3px solid ${n.passed ? '#2ecc71' : '#e74c3c'};">
                <div style="margin-bottom:4px;">${passTag}</div>
                <div style="font-size:0.85em; line-height:1.6;">
                  <div><span style="color:#2ecc71;">✅ 赞成(${yesVoters.length})：</span><span style="color:#ccc;">${yesVoters.map(p => `${p.seat+1}号`).join(' ') || '—'}</span></div>
                  <div><span style="color:#e74c3c;">❌ 反对(${noVoters.length})：</span><span style="color:#ccc;">${noVoters.map(p => `${p.seat+1}号`).join(' ') || '—'}</span></div>
                  ${abstain.length > 0 ? `<div><span style="color:#95a5a6;">⏳ 未投票(${abstain.length})：</span><span style="color:#777;">${abstain.map(p => `${p.seat+1}号`).join(' ')}</span></div>` : ''}
                </div>
              </div>`;
            } else {
              // 投票中或待投票
              resultHtml = ` <span style="color:#f39c12;">⏳ 投票中</span>`;
            }
            return `<div style="margin-top:8px; font-size:0.95em;">
              <div>${nom ? nom.seat+1 : '?'}号提名 <strong>${nm ? nm.seat+1 : '?'}号 ${nm ? escapeHtml(nm.name) : ''}</strong></div>
              ${resultHtml}
            </div>`;
          }).join('');
        }
        showConfirm = true;
        break;

      case 'DEFENSE':
        if (state.currentDefensePlayerId === myId) {
          html = '<div style="color:#e74c3c;">⚖️ 你被提名了！请辩护</div>';
          html += '<div style="margin-top:10px;">辩护完毕后点击按钮进入投票</div>';
          showAction = true;
          $('actionTitle').textContent = '辩护';
          $('selectedTargets').innerHTML = '';
          $('actionButtons').innerHTML = `<button class="btn btn-primary" onclick="endDefense()">辩护完毕</button>`;
        } else {
          const def = state.players.find(p => p.id === state.currentDefensePlayerId);
          html = `<div style="color:#f39c12;">⚖️ ${def ? def.seat+1+'号 '+def.name : ''} 正在辩护...</div>`;
        }
        break;

      case 'VOTING':
        html = '<div style="color:#e74c3c;">🗳️ 投票中</div>';
        const curNom = state.nominations ? state.nominations[state.nominations.length-1] : null;
        const nominee = curNom ? state.players.find(p => p.id === curNom.nomineeId) : null;
        if (nominee) {
          html += `<div style="margin-top:10px; font-size:1.2em;">是否处决 ${nominee.seat+1}号 ${nominee.name}？</div>`;
        }

        // 显示赞成/反对/未投票名单
        let myVote = null;
        let hasUnvoted = false;
        if (curNom && state.players) {
          const yesVoters = [];
          const noVoters = [];
          const unvoted = [];
          const cvotes = curNom.currentVotes || {};
          state.players.forEach(p => {
            if (p.seat < 0) return;
            const voted = cvotes[p.id];
            if (voted === true) yesVoters.push(p);
            else if (voted === false) noVoters.push(p);
            else unvoted.push(p);
            if (p.id === myId) myVote = voted;
          });
          hasUnvoted = unvoted.some(p => p.isAlive || (!p.isAlive && p.voteToken > 0));
          html += `<div class="vote-detail">
            <div class="vote-detail-row">
              <span class="vote-detail-label yes">✅ 赞成 (${yesVoters.length})：</span>
              <span class="vote-detail-names">${yesVoters.map(p => `${p.seat+1}号${p.name}`).join('、') || '—'}</span>
            </div>
            <div class="vote-detail-row">
              <span class="vote-detail-label no">❌ 反对 (${noVoters.length})：</span>
              <span class="vote-detail-names">${noVoters.map(p => `${p.seat+1}号${p.name}`).join('、') || '—'}</span>
            </div>
            <div class="vote-detail-row">
              <span class="vote-detail-label wait">⏳ 未投票 (${unvoted.length})：</span>
              <span class="vote-detail-names">${unvoted.map(p => `${p.seat+1}号${p.name}`).join('、') || '—'}</span>
            </div>
          </div>`;
        }

        showAction = true;
        $('actionTitle').textContent = '投票';
        $('selectedTargets').innerHTML = '';
        if (myVote === true || myVote === false) {
          // 已投票：显示当前选择 + 改票按钮（还有人未投时可改票）
          const voteLabel = myVote === true
            ? '<span style="color:#2ecc71; font-weight:bold;">✅ 已投赞成</span>'
            : '<span style="color:#e74c3c; font-weight:bold;">❌ 已投反对</span>';
          if (hasUnvoted) {
            $('actionButtons').innerHTML = `
              <div style="text-align:center; margin-bottom:8px;">${voteLabel}</div>
              <button class="btn btn-sm btn-warning" onclick="showVoteButtons()" style="width:100%;">🔄 改票</button>
            `;
          } else {
            $('actionButtons').innerHTML = `<div style="text-align:center;">${voteLabel}<br><span style="color:#aaa; font-size:0.85em;">投票即将结束...</span></div>`;
          }
        } else {
          // 未投票：显示投票按钮
          $('actionButtons').innerHTML = `
            <button class="btn btn-success vote-btn yes" onclick="castVote(true)">赞成处决</button>
            <button class="btn btn-danger vote-btn no" onclick="castVote(false)">反对</button>
          `;
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
        $('actionButtons').innerHTML = `<button class="btn btn-primary btn-sm" onclick="backToHome()">返回大厅</button>`;
        if (state.allRoles) showGameOverRoles(state.allRoles);
        break;
    }

    // 统一显示玩家私密信息（所有阶段都显示，不标注真假——仅在上帝视角标注）
    if (state.privateInfo && state.privateInfo.message) {
      html += `<div style="margin-top:15px; padding:12px; background:rgba(212,175,55,0.08); border-left:3px solid #d4af37; border-radius:4px;">
        <div style="color:#d4af37; font-size:0.85em; margin-bottom:5px; letter-spacing:1px;">📜 你的信息</div>
        <div style="color:#f0d78c; line-height:1.6;">${state.privateInfo.message}</div>
      </div>`;
    }
  }

  msg.className = 'center-message ' + msgClass;
  msg.innerHTML = html;
  actionPanel.style.display = showAction || (state.phase === 'DEFENSE' && state.currentDefensePlayerId === myId) || state.phase === 'VOTING' ? 'block' : 'none';
  confirmBar.style.display = showConfirm ? 'block' : 'none';

  if (showConfirm) {
    const confirmed = state.confirmedCount || 0;
    const total = state.totalNeeded || 1;
    const pct = Math.min((confirmed / total) * 100, 100);
    $('confirmText').textContent = `确认进度: ${confirmed}/${total}`;
    $('confirmProgressFill').style.width = pct + '%';

    // 显示已确认/未确认的玩家列表
    const confirmedIds = state.confirmedIds || [];
    const players = state.players || [];
    const confirmList = $('confirmPlayers');
    const chips = players
      .filter(p => p.seat >= 0)
      .map(p => {
        const isConfirmed = confirmedIds.includes(p.id);
        const isYou = p.id === myId;
        return `<span class="confirm-player-chip${isConfirmed ? ' confirmed' : ' unconfirmed'}${isYou ? ' you' : ''}">
          ${isConfirmed ? '✓' : '○'} ${p.seat+1}号${p.name}
        </span>`;
      })
      .join('');
    confirmList.innerHTML = chips;
  }
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

  const slayerBtn = $('slayerBtn');
  if (role.id === 'slayer' && me.isAlive && !me.hasUsedDayAbility &&
      (state.phase === 'DAY_DISCUSSION' || state.phase === 'NOMINATION_PHASE')) {
    slayerBtn.style.display = 'block';
  } else {
    slayerBtn.style.display = 'none';
  }

  if (me.isDead) {
    $('deadChatTab').style.display = 'block';
  }
}

// ========== 夜晚交互 ==========
function showNightWake(data) {
  const overlay = $('nightOverlay');
  const text = $('nightText');
  const subtext = $('nightSubtext');
  const selectArea = $('nightSelectArea');
  const confirmBtn = $('nightConfirmBtn');

  overlay.classList.add('active', 'wake');
  text.textContent = `你的回合：${data.role}`;
  // 支持换行显示
  subtext.innerHTML = (data.message || '').replace(/\n/g, '<br>');
  
  nightSelectedTargets = [];
  const canSelectCount = data.canSelectCount || 0;
  nightCanSelectCount = canSelectCount;
  const excludeSelf = data.excludeSelf || false;

  if (canSelectCount > 0) {
    selectArea.innerHTML = '';
    const players = currentState.players.filter(p => {
      if (excludeSelf && p.id === myId) return false;
      return p.seat !== -1;
    });

    players.forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'night-player-btn';
      btn.textContent = `${p.seat + 1}号 ${p.name}${p.isDead ? ' (死者)' : ''}`;
      btn.dataset.pid = p.id;
      btn.onclick = () => toggleNightTarget(p.id, btn);
      selectArea.appendChild(btn);
    });

    confirmBtn.style.display = 'block';
    confirmBtn.disabled = true;
    confirmBtn.textContent = '确认行动';
  } else {
    // 不需要选择目标，直接显示提示文字和确认按钮
    selectArea.innerHTML = '';
    confirmBtn.style.display = 'block';
    confirmBtn.disabled = false;
    confirmBtn.textContent = '确认';
  }
}

function toggleNightTarget(pid, btn) {
  const idx = nightSelectedTargets.indexOf(pid);
  if (idx >= 0) {
    nightSelectedTargets.splice(idx, 1);
    btn.classList.remove('selected');
  } else {
    const maxCount = nightCanSelectCount || 1;
    
    if (nightSelectedTargets.length >= maxCount) {
      const first = nightSelectedTargets.shift();
      const firstBtn = document.querySelector(`.night-player-btn[data-pid="${first}"]`);
      if (firstBtn) firstBtn.classList.remove('selected');
    }
    nightSelectedTargets.push(pid);
    btn.classList.add('selected');
  }

  // 检查是否选够了
  const neededCount = getNeededSelectCount();
  $('nightConfirmBtn').disabled = nightSelectedTargets.length !== neededCount;
}

function getNeededSelectCount() {
  // 从night:wake数据推断
  return nightCanSelectCount || 1;
}

function submitNightAction() {
  const neededCount = getNeededSelectCount();
  if (nightSelectedTargets.length > 0 && nightSelectedTargets.length !== neededCount) {
    showToast(`请选择${neededCount}名玩家`);
    return;
  }

  socket.emit('night:action', { targets: nightSelectedTargets });
}

function hideNightOverlay() {
  $('nightOverlay').classList.remove('active', 'wake');
}

function showWaitingNight() {
  const overlay = $('nightOverlay');
  const text = $('nightText');
  const subtext = $('nightSubtext');
  const selectArea = $('nightSelectArea');
  const confirmBtn = $('nightConfirmBtn');

  overlay.classList.add('active');
  overlay.classList.remove('wake');
  text.textContent = '夜幕降临';
  subtext.textContent = '等待其他玩家行动...';
  selectArea.innerHTML = '';
  confirmBtn.style.display = 'none';
}

function handleNightOverlay(state) {
  if (state.isNight && state.phase !== 'GAME_OVER') {
    if (state.isYourTurn && state.phase === 'NIGHT_WAKE') {
      // 被唤醒，showNightWake已处理
    } else if (!state.isYourTurn) {
      showWaitingNight();
    }
  } else {
    hideNightOverlay();
  }
}

// ========== 白天交互 ==========
function nominatePlayer(targetId) {
  const phase = currentState.phase;
  if (phase !== 'DAY_DISCUSSION' && phase !== 'NOMINATION_PHASE') {
    showToast('现在不是提名时间');
    return;
  }
  const me = currentState.players.find(p => p.id === myId);
  if (!me.isAlive) {
    if (me.voteToken <= 0) {
      showToast('你已使用死后投票标记');
      return;
    }
  }
  const target = currentState.players.find(p => p.id === targetId);
  if (confirm(`确定提名 ${target.seat+1}号 ${target.name} 吗？`)) {
    socket.emit('day:nominates', { targetId });
  }
}

function endDefense() {
  socket.emit('day:endDefense');
}

function showNominationStarted(data) {
  // 中央消息区会更新
}

function showVotingPanel(data) {
  // 由renderCenter处理
}

function castVote(vote) {
  const me = currentState.players.find(p => p.id === myId);
  if (!me.isAlive && me.voteToken <= 0) {
    showToast('你已使用死后投票标记');
    return;
  }
  socket.emit('day:vote', { vote });
}

// 显示投票按钮（改票模式）
function showVoteButtons() {
  $('actionButtons').innerHTML = `
    <button class="btn btn-success vote-btn yes" onclick="castVote(true)">赞成处决</button>
    <button class="btn btn-danger vote-btn no" onclick="castVote(false)">反对</button>
  `;
}

function endVoting() {
  socket.emit('day:endVoting');
}

function updateVoteDisplay(data) {}

function showVoteResult(data) {
  // renderCenter处理
}

function showExecutionResult(data) {
  // renderCenter处理
}

function confirmPhase() {
  socket.emit('game:confirm');
}

function useSlayerAbility() {
  const players = currentState.players.filter(p => p.isAlive && p.seat !== -1 && p.id !== myId);
  const name = prompt('杀手技能：选择要击杀的玩家\n' + players.map((p,i) => `${i+1}: ${p.seat+1}号 ${p.name}`).join('\n'));
  if (name) {
    const idx = parseInt(name) - 1;
    if (idx >= 0 && idx < players.length) {
      if (confirm(`确定对 ${players[idx].seat+1}号 ${players[idx].name} 使用杀手技能吗？每局只能使用一次。`)) {
        socket.emit('day:useAbility', { abilityName: 'slayer', targetId: players[idx].id });
      }
    }
  }
}

function showAbilityUsed(data) {
  let msg = '';
  if (data.abilityName === 'slayer') {
    if (data.result.killed) {
      msg = `${data.fromName} 使用杀手技能击杀了恶魔！`;
    } else {
      msg = `${data.fromName} 使用杀手技能，但无事发生。`;
    }
  }
  showToast(msg);
}

function showPlayerDied(data) {
  const p = currentState.players.find(x => x.id === data.playerId);
  if (p) {
    let causeText = '';
    if (data.cause === 'EXECUTION') {
      causeText = '被处决';
    } else {
      causeText = '死亡';
    }
    showToast(`${p.seat+1}号 ${p.name} ${causeText}`);
  }
}

// ========== 聊天 ==========
let chatMessages = [];
let unreadPublic = 0;       // 公聊未读数
let unreadDead = 0;         // 死者频道未读数
let unreadWhispers = {};    // { playerId: count } 每个私聊对象的未读数

function getWhisperUnreadTotal() {
  return Object.values(unreadWhispers).reduce((a, b) => a + b, 0);
}

function clearUnreadForChannel(channel) {
  if (channel === 'public') unreadPublic = 0;
  else if (channel === 'dead') unreadDead = 0;
  updateChatTabBadges();
}

function clearUnreadForWhisper(pid) {
  if (pid) {
    unreadWhispers[pid] = 0;
    delete unreadWhispers[pid];
  }
  updateChatTabBadges();
  renderWhisperPlayerList();
}

function updateChatTabBadges() {
  // 公聊tab
  const pubTab = document.querySelector('.chat-tab[data-channel="public"]');
  if (pubTab) {
    let badge = pubTab.querySelector('.unread-badge');
    if (unreadPublic > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'unread-badge';
        pubTab.appendChild(badge);
      }
      badge.textContent = unreadPublic > 99 ? '99+' : unreadPublic;
    } else if (badge) {
      badge.remove();
    }
  }
  // 死者tab
  const deadTab = document.querySelector('.chat-tab[data-channel="dead"]');
  if (deadTab) {
    let badge = deadTab.querySelector('.unread-badge');
    if (unreadDead > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'unread-badge';
        deadTab.appendChild(badge);
      }
      badge.textContent = unreadDead > 99 ? '99+' : unreadDead;
    } else if (badge) {
      badge.remove();
    }
  }
  // 私聊tab
  const whTab = document.querySelector('.chat-tab[data-channel="whisper"]');
  if (whTab) {
    let badge = whTab.querySelector('.unread-badge');
    const total = getWhisperUnreadTotal();
    if (total > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'unread-badge';
        whTab.appendChild(badge);
      }
      badge.textContent = total > 99 ? '99+' : total;
      // 闪烁效果
      whTab.style.animation = 'none';
      whTab.offsetHeight;
      whTab.style.animation = 'pulse 1s ease-in-out 3';
    } else if (badge) {
      badge.remove();
    }
  }
}

function renderWhisperPlayerList() {
  // 重新渲染私聊玩家列表以显示未读红点
  if (currentState && currentState.players) {
    updateWhisperTargets(currentState.players);
  }
}

function switchChatChannel(channel) {
  currentChatChannel = channel;
  document.querySelectorAll('.chat-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.channel === channel);
  });

  // 清除对应频道的未读标记
  clearUnreadForChannel(channel);

  // 移动端：切换频道时自动打开聊天面板
  if (window.innerWidth <= 768) {
    const chatArea = document.querySelector('.chat-area');
    if (chatArea && !chatArea.classList.contains('mobile-open')) {
      chatArea.classList.add('mobile-open');
    }
  }

  // 显示/隐藏私聊相关UI
  const whisperPanel = $('whisperPanel');
  const whisperCurrent = $('whisperCurrent');
  const chatInput = $('chatInput');

  if (channel === 'whisper') {
    if (whisperTargetId) {
      // 已有私聊对象，清除该对象未读
      clearUnreadForWhisper(whisperTargetId);
      // 已有私聊对象，显示当前私聊状态
      whisperPanel.style.display = 'none';
      whisperCurrent.style.display = 'flex';
      const target = (currentState && currentState.players) 
        ? currentState.players.find(p => p.id === whisperTargetId) : null;
      $('whisperCurrentName').textContent = target 
        ? `${target.seat >= 0 ? target.seat+1+'号 ' : ''}${target.name}` 
        : '(未知)';
      chatInput.placeholder = `私聊 ${target ? target.name : ''}...`;
    } else {
      // 未选择对象，清除所有私聊未读
      unreadWhispers = {};
      updateChatTabBadges();
      renderWhisperPlayerList();
      // 未选择对象，显示选择面板
      whisperPanel.style.display = 'block';
      whisperCurrent.style.display = 'none';
      chatInput.placeholder = '请先选择私聊对象...';
    }
  } else {
    whisperPanel.style.display = 'none';
    whisperCurrent.style.display = 'none';
    chatInput.placeholder = '输入消息...';
  }

  renderChatMessages();
}

function showWhisperPanel() {
  $('whisperPanel').style.display = 'block';
  $('whisperCurrent').style.display = 'none';
  $('chatInput').placeholder = '请先选择私聊对象...';
}

function selectWhisperTarget(pid) {
  whisperTargetId = pid;
  clearUnreadForWhisper(pid);
  switchChatChannel('whisper');
}

function sendChat() {
  const input = $('chatInput');
  const content = input.value.trim();
  if (!content) return;

  let targetId = null;
  if (currentChatChannel === 'whisper') {
    targetId = whisperTargetId;
    if (!targetId) {
      showToast('请选择私聊对象');
      return;
    }
  }

  socket.emit('chat:send', { content, channel: currentChatChannel, targetId });
  input.value = '';
}

function addChatMessage(msg) {
  chatMessages.push(msg);

  // 未读计数逻辑
  const isFromMe = msg.fromId === myId;
  if (!isFromMe) {
    if (msg.channel === 'public') {
      // 公聊：如果当前不在公聊tab，记未读
      if (currentChatChannel !== 'public') {
        unreadPublic++;
      }
    } else if (msg.channel === 'dead') {
      if (currentChatChannel !== 'dead') {
        unreadDead++;
      }
    } else if (msg.channel === 'whisper') {
      const otherId = msg.fromId === myId ? msg.toId : msg.fromId;
      // 如果正在看和该玩家的私聊，则不记未读
      const isViewingThisWhisper = currentChatChannel === 'whisper' && whisperTargetId === otherId;
      if (!isViewingThisWhisper && otherId) {
        unreadWhispers[otherId] = (unreadWhispers[otherId] || 0) + 1;
      }
    }
  }

  updateChatTabBadges();
  renderChatMessages();

  // 私聊列表中显示未读红点
  if (msg.channel === 'whisper') {
    renderWhisperPlayerList();
  }
}

function renderChatMessages() {
  const container = $('chatMessages');
  const visible = chatMessages.filter(m => {
    if (currentChatChannel === 'public') return m.channel === 'public';
    if (currentChatChannel === 'dead') return m.channel === 'dead';
    if (currentChatChannel === 'whisper') {
      if (m.channel !== 'whisper') return false;
      // 只显示与当前私聊对象的对话
      if (whisperTargetId) {
        return m.fromId === whisperTargetId || m.toId === whisperTargetId ||
               (m.fromId === myId && m.toId === whisperTargetId);
      }
      return true; // 未选择对象时显示所有私聊
    }
    return false;
  });

  container.innerHTML = visible.map(msg => {
    const senderClass = msg.fromId === myId ? 'you' : '';
    const deadClass = msg.isDead ? 'dead' : '';
    const privateClass = msg.channel === 'whisper' ? 'private' : '';
    const seatText = msg.fromSeat >= 0 ? `${msg.fromSeat + 1}号 ` : '';
    let senderDisplay = '';
    if (msg.channel === 'whisper') {
      if (msg.fromId === myId) {
        const toSeat = msg.toSeat !== undefined ? msg.toSeat : '';
        const toSeatText = typeof toSeat === 'number' && toSeat >= 0 ? `${toSeat+1}号 ` : '';
        senderDisplay = `[悄悄对 ${toSeatText}${msg.toName || '某人'}说] ${seatText}${msg.fromName}`;
      } else {
        senderDisplay = `[${seatText}${msg.fromName}悄悄对你说]`;
      }
    } else {
      const deadPrefix = msg.isDead && msg.channel === 'public' ? '[死者] ' : '';
      senderDisplay = `${deadPrefix}${seatText}${msg.fromName}`;
    }
    return `<div class="chat-msg ${privateClass}">
      <span class="msg-sender ${senderClass} ${deadClass}">${senderDisplay}:</span>
      <span>${escapeHtml(msg.content)}</span>
    </div>`;
  }).join('');

}

function updateWhisperTargets(players) {
  const list = $('whisperPlayerList');
  if (!list) return;
  const others = players.filter(p => p.id !== myId && p.seat !== -1);
  if (others.length === 0) {
    list.innerHTML = '<div style="color:#888; font-size:12px;">暂无其他玩家</div>';
    return;
  }
  list.innerHTML = others.map(p => {
    const deadClass = p.isDead ? ' dead' : '';
    const statusMark = p.isDead ? ' 💀' : (p.isConnected === false ? ' 📡' : '');
    const unreadCount = unreadWhispers[p.id] || 0;
    const unreadClass = unreadCount > 0 ? ' whisper-chip-unread' : '';
    const unreadDot = unreadCount > 0 ? `<span class="chip-unread-dot" title="${unreadCount}条未读"></span>` : '';
    return `<div class="whisper-player-chip${deadClass}${unreadClass}" onclick="selectWhisperTarget('${p.id}')">
      <span class="chip-seat">${p.seat + 1}号</span>
      <span>${escapeHtml(p.name)}${statusMark}</span>
      ${unreadDot}
    </div>`;
  }).join('');
}

// ========== 游戏结束 ==========
function showGameOver(data) {
  // 由renderCenter处理
}

function showGameOverRoles(allRoles) {
  $('gameOverPanel').style.display = 'block';
  const title = $('gameOverTitle');
  const reason = $('gameOverReason');

  if (currentState.winner === 'GOOD') {
    title.textContent = '🎉 善良阵营胜利！';
    title.style.color = '#2ecc71';
  } else {
    title.textContent = '💀 邪恶阵营胜利！';
    title.style.color = '#e74c3c';
  }
  reason.textContent = currentState.winReason || '';

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

// ========== 工具函数 ==========
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showError(msg, elementId) {
  const el = $(elementId);
  if (el) {
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
  } else {
    showToast(msg);
  }
}

// ========== 上帝视角 ==========
function toggleGodView() {
  if (isGodView) {
    closeGodView();
    return;
  }
  if (!currentState || !currentState.gameStarted) {
    showToast('游戏开始后才能使用上帝视角');
    return;
  }
  $('godPanel').style.display = 'block';
  $('godLoginForm').style.display = 'block';
  $('godContent').style.display = 'none';
  $('godLoginError').style.display = 'none';
  $('godPassword').value = '';
  setTimeout(() => $('godPassword').focus(), 100);
}

function closeGodView() {
  if (isGodView) {
    socket.emit('god:logout');
  } else {
    $('godPanel').style.display = 'none';
  }
}

function godLogin() {
  const password = $('godPassword').value;
  if (!password) {
    const err = $('godLoginError');
    err.textContent = '请输入密码';
    err.style.display = 'block';
    return;
  }
  socket.emit('god:login', { password });
}

function renderGodView() {
  if (!godState) return;

  const gs = godState;
  const players = gs.players || [];

  updateGodPlayers();

  // 游戏状态
  const phaseNames = {
    'LOBBY': '大厅', 'FIRST_NIGHT': '第一夜', 'NIGHT_WAKE': '夜晚唤醒',
    'NIGHT': '夜晚', 'DAY_DAWN': '天亮', 'DAY_DISCUSSION': '白天讨论',
    'NOMINATION_PHASE': '提名阶段', 'DEFENSE': '辩护', 'VOTING': '投票',
    'EXECUTION': '处决', 'GAME_OVER': '游戏结束'
  };
  const phaseName = phaseNames[gs.phase] || gs.phase;
  let statusHtml = `<div><strong>阶段：</strong>${phaseName}</div>`;
  statusHtml += `<div><strong>天数：</strong>第${gs.dayCount}天 / 第${gs.nightCount}夜</div>`;
  
  if (gs.currentWakePlayerId) {
    const wp = players.find(p => p.id === gs.currentWakePlayerId);
    if (wp) {
      statusHtml += `<div style="color:#9b59b6;"><strong>当前行动：</strong>${wp.seat+1}号 ${wp.name}（${wp.roleName}）</div>`;
    }
  }
  if (gs.currentDefensePlayerId) {
    const dp = players.find(p => p.id === gs.currentDefensePlayerId);
    if (dp) {
      statusHtml += `<div style="color:#f39c12;"><strong>辩护中：</strong>${dp.seat+1}号 ${dp.name}</div>`;
    }
  }
  if (gs.nightActions && Object.keys(gs.nightActions).length > 0) {
    let nightInfo = '<div style="margin-top:8px; color:#aaa;"><strong>夜晚行动记录：</strong><ul style="margin:5px 0 0 20px;">';
    for (const [role, action] of Object.entries(gs.nightActions)) {
      if (action.targetId) {
        const t = players.find(p => p.id === action.targetId);
        nightInfo += `<li>${role} → ${t ? t.seat+1+'号'+t.name : action.targetId}</li>`;
      }
    }
    nightInfo += '</ul></div>';
    statusHtml += nightInfo;
  }
  if (gs.nominations && gs.nominations.length > 0) {
    let nomInfo = '<div style="margin-top:8px; color:#aaa;"><strong>今日提名：</strong><ul style="margin:5px 0 0 20px;">';
    gs.nominations.forEach(n => {
      const nomPlayer = players.find(p => p.id === n.nominatorId);
      const nmPlayer = players.find(p => p.id === n.nomineeId);
      const nomSeat = nomPlayer ? nomPlayer.seat+1 : '?';
      const nmSeat = nmPlayer ? nmPlayer.seat+1 : '?';
      const nmName = nmPlayer ? escapeHtml(nmPlayer.name) : '';
      if (n.resolved) {
        const yesList = [], noList = [], abstainList = [];
        const cv = n.currentVotes || {};
        players.forEach(p => {
          if (p.seat < 0) return;
          if (cv[p.id] === true) yesList.push(p.seat+1+'号');
          else if (cv[p.id] === false) noList.push(p.seat+1+'号');
          else abstainList.push(p.seat+1+'号');
        });
        const passTag = n.passed
          ? `<span style="color:#2ecc71;">✅通过(${n.voteCount}票)</span>`
          : `<span style="color:#e74c3c;">❌未通过(${n.voteCount}票)</span>`;
        nomInfo += `<li>${nomSeat}号提名${nmSeat}号${nmName} - ${passTag}
          <div style="font-size:0.9em; margin-top:2px; color:#ccc;">
            赞成: ${yesList.join(' ') || '—'} | 反对: ${noList.join(' ') || '—'}${abstainList.length > 0 ? ' | 未投: '+abstainList.join(' ') : ''}
          </div>
        </li>`;
      } else {
        nomInfo += `<li>${nomSeat}号提名${nmSeat}号${nmName} - <span style="color:#f39c12;">⏳进行中</span></li>`;
      }
    });
    nomInfo += '</ul></div>';
    statusHtml += nomInfo;
  }
  if (gs.winner) {
    statusHtml += `<div style="margin-top:10px; font-size:1.2em; color:${gs.winner==='GOOD'?'#2ecc71':'#e74c3c'};"><strong>${gs.winner==='GOOD'?'🎉善良阵营获胜！':'💀邪恶阵营获胜！'}</strong></div>`;
    statusHtml += `<div style="color:#aaa;">${gs.winReason||''}</div>`;
  }
  $('godStatus').innerHTML = statusHtml;

  // 渲染全部日志
  const logContainer = $('godActionLog');
  logContainer.innerHTML = '';
  gs.actionLog.forEach(entry => appendGodLogEntry(entry));
}

function updateGodPlayers() {
  if (!godState) return;
  const players = godState.players || [];
  const good = players.filter(p => p.team === 'GOOD');
  const evil = players.filter(p => p.team === 'EVIL');

  // 阵营列表
  $('godGoodPlayers').innerHTML = good.map(p => renderGodPlayer(p, 'good')).join('');
  $('godEvilPlayers').innerHTML = evil.map(p => renderGodPlayer(p, 'evil')).join('');

  // 完整玩家表格
  $('godPlayersTable').innerHTML = players.sort((a,b) => a.seat - b.seat).map(p => {
    const statusText = p.isAlive ? '存活' : '💀死亡';
    const statusColor = p.isAlive ? '#2ecc71' : '#888';
    let marks = [];
    if (p.isPoisoned) marks.push('<span style="color:#9b59b6;">中毒</span>');
    if (p.isProtected) marks.push('<span style="color:#3498db;">守护</span>');
    if (p.isDrunk) marks.push('<span style="color:#e67e22;">醉酒</span>');
    if (p.isBot) marks.push('<span style="color:#888;">AI</span>');
    if (p.isConnected === false) marks.push('<span style="color:#e67e22;">断线</span>');
    if (p.voteToken > 0 && p.isDead) marks.push('<span style="color:#3498db;">余1票</span>');
    const teamColor = p.team === 'GOOD' ? '#2ecc71' : '#e74c3c';
    const teamText = p.team === 'GOOD' ? '善良' : '邪恶';
    let infoCell = '<span style="color:#555;">-</span>';
    if (p.privateInfo && p.privateInfo.message) {
      const falseStyle = p.privateInfo.isFalse ? 'color:#e74c3c;' : 'color:#f0d78c;';
      const falseTag = p.privateInfo.isFalse 
        ? ' <span style="color:#e74c3c;font-weight:bold;font-size:11px;">⚠假</span>' 
        : ' <span style="color:#2ecc71;font-size:11px;">✓</span>';
      infoCell = `<span style="${falseStyle} font-size:12px;">${escapeHtml(p.privateInfo.message)}${falseTag}</span>`;
    }
    return `<tr style="border-bottom:1px solid rgba(255,255,255,0.05); opacity:${p.isAlive?1:0.5};">
      <td style="padding:8px;">${p.seat+1}</td>
      <td style="padding:8px;">${escapeHtml(p.name)}</td>
      <td style="padding:8px; color:#d4af37; font-weight:bold;">${p.roleName}</td>
      <td style="padding:8px; color:${teamColor};">${teamText}</td>
      <td style="padding:8px; color:${statusColor};">${statusText}</td>
      <td style="padding:8px;">${marks.join(' ')}</td>
      <td style="padding:8px; max-width:300px; line-height:1.4;">${infoCell}</td>
    </tr>`;
  }).join('');
}

function renderGodPlayer(p, team) {
  const color = team === 'good' ? '#2ecc71' : '#e74c3c';
  const deadStyle = p.isDead ? 'opacity:0.5; text-decoration:line-through;' : '';
  let marks = '';
  if (p.isPoisoned) marks += ' 🟣';
  if (p.isProtected) marks += ' 🔵';
  if (p.isBot) marks += ' 🤖';
  if (p.isConnected === false) marks += ' 📡断线';
  let infoHtml = '';
  if (p.privateInfo && p.privateInfo.message) {
    const falseMark = p.privateInfo.isFalse 
      ? '<span style="color:#e74c3c; font-weight:bold;"> ⚠️假信息</span>' 
      : '<span style="color:#2ecc71;"> ✓真</span>';
    infoHtml = `<div style="font-size:12px; margin-left:20px; margin-top:3px; padding:4px 8px; background:rgba(0,0,0,0.2); border-radius:3px;">
      <span style="color:#d4af37;">💬</span>
      <span style="color:${p.privateInfo.isFalse ? '#e74c3c' : '#f0d78c'};">${escapeHtml(p.privateInfo.message)}</span>
      ${falseMark}
    </div>`;
  }
  return `<div style="padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.05); ${deadStyle}">
    <span style="color:#888;">${p.seat+1}号</span>
    <span style="color:${color}; font-weight:bold; margin-left:5px;">${escapeHtml(p.name)}</span>
    <span style="color:#d4af37; margin-left:8px;">【${p.roleName}】</span>
    ${marks}
    ${infoHtml}
  </div>`;
}

function appendGodLogEntry(entry) {
  const logContainer = $('godActionLog');
  if (!logContainer) return;
  
  const typeColors = {
    'ROLE_ASSIGN': '#d4af37',
    'GAME_START': '#fff',
    'NIGHT_WAKE': '#9b59b6',
    'NIGHT_ACTION': '#9b59b6',
    'NIGHT_END': '#3498db',
    'DEATH': '#e74c3c',
    'NOMINATION': '#f39c12',
    'VOTE_RESULT': '#f39c12',
    'EXECUTION': '#e74c3c',
    'GAME_OVER': '#fff',
    'PRIVATE_INFO': '#1abc9c',
    'ABILITY': '#e67e22'
  };
  const color = typeColors[entry.type] || '#aaa';
  let msg = entry.message;
  if (entry.type === 'PRIVATE_INFO' && entry.data && entry.data.isFalse) {
    msg = `<span style="color:#e74c3c;">⚠️【假信息】</span> ${escapeHtml(entry.message)}`;
  } else {
    msg = escapeHtml(msg);
  }
  const div = document.createElement('div');
  div.style.cssText = `color:${color}; padding:2px 0;`;
  div.innerHTML = `<span style="color:#666;">[${entry.time}]</span> ${msg}`;
  logContainer.appendChild(div);
}

// ========== 角色总览 ==========
const ALL_ROLE_INFO = [
  // 村民
  { id: 'washerwoman', name: '洗衣妇', team: 'GOOD', category: '村民',
    ability: '首个夜晚，你得知两名玩家以及其中一名玩家的村民角色。',
    color: '#2ecc71' },
  { id: 'librarian', name: '图书管理员', team: 'GOOD', category: '村民',
    ability: '首个夜晚，你得知两名玩家以及其中一名玩家的外来者角色（若无外来者则获知此信息）。',
    color: '#2ecc71' },
  { id: 'investigator', name: '调查员', team: 'GOOD', category: '村民',
    ability: '首个夜晚，你得知两名玩家以及其中一名玩家的爪牙角色。',
    color: '#2ecc71' },
  { id: 'chef', name: '厨师', team: 'GOOD', category: '村民',
    ability: '首个夜晚，你得知邪恶玩家相邻的对数。',
    color: '#2ecc71' },
  { id: 'empath', name: '共情者', team: 'GOOD', category: '村民',
    ability: '每个夜晚，你得知你的左右存活邻居中有多少名邪恶玩家。',
    color: '#2ecc71' },
  { id: 'fortuneteller', name: '占卜师', team: 'GOOD', category: '村民',
    ability: '每个夜晚，选择两名玩家：你得知他们之中是否有恶魔。有一名善良玩家会被你当作恶魔（红鲱鱼）。',
    color: '#2ecc71' },
  { id: 'monk', name: '僧侣', team: 'GOOD', category: '村民',
    ability: '每个夜晚（首个夜晚除外），选择除你以外的一名玩家：该玩家今晚不会被恶魔杀害。',
    color: '#2ecc71' },
  { id: 'ravenkeeper', name: '守鸦人', team: 'GOOD', category: '村民',
    ability: '如果你在夜晚死亡，你被唤醒并选择一名玩家：你得知他的角色。',
    color: '#2ecc71' },
  { id: 'virgin', name: '圣女', team: 'GOOD', category: '村民',
    ability: '如果你首次被提名，提名你的玩家若是村民则立即死亡。',
    color: '#2ecc71' },
  { id: 'slayer', name: '杀手', team: 'GOOD', category: '村民',
    ability: '每局限一次，白天时可以公开选择一名玩家，如果是恶魔则恶魔死亡。',
    color: '#2ecc71' },
  { id: 'soldier', name: '士兵', team: 'GOOD', category: '村民',
    ability: '你不会被恶魔杀害。',
    color: '#2ecc71' },
  { id: 'mayor', name: '市长', team: 'GOOD', category: '村民',
    ability: '如果只剩三名玩家存活且你未被处决，你的阵营获胜。如果你在夜晚死亡，可能有其他玩家替你死去。',
    color: '#2ecc71' },
  { id: 'undertaker', name: '掘墓人', team: 'GOOD', category: '村民',
    ability: '每个夜晚（首个夜晚除外），你得知今天白天被处决玩家的角色。',
    color: '#2ecc71' },
  // 外来者
  { id: 'saint', name: '圣徒', team: 'GOOD', category: '外来者',
    ability: '如果你被处决，邪恶阵营获胜。',
    color: '#f39c12' },
  { id: 'butler', name: '管家', team: 'GOOD', category: '外来者',
    ability: '每个夜晚，选择一名玩家（非自己）：明天你只能在该玩家投赞成票时投赞成票。',
    color: '#f39c12' },
  { id: 'drunk', name: '酒鬼', team: 'GOOD', category: '外来者',
    ability: '你不知道自己是酒鬼。你以为自己是一个村民角色，但实际上你没有技能，你的信息是不可靠的。',
    color: '#f39c12' },
  { id: 'recluse', name: '隐士', team: 'GOOD', category: '外来者',
    ability: '你可能被登记为邪恶阵营、爪牙或恶魔。你可能在夜晚死亡，即使没人想杀你。',
    color: '#f39c12' },
  // 爪牙
  { id: 'poisoner', name: '下毒者', team: 'EVIL', category: '爪牙',
    ability: '每个夜晚，选择一名玩家：该玩家今晚和明天中毒，技能异常或失效。',
    color: '#e74c3c' },
  { id: 'scarletwoman', name: '红唇女郎', team: 'EVIL', category: '爪牙',
    ability: '如果恶魔死亡时存活玩家数≥5，你成为新恶魔。',
    color: '#e74c3c' },
  { id: 'baron', name: '男爵', team: 'EVIL', category: '爪牙',
    ability: '有两名额外的外来者在场（因此少两名村民）。',
    color: '#e74c3c' },
  { id: 'spy', name: '间谍', team: 'EVIL', category: '爪牙',
    ability: '每个夜晚，你查看恶魔魔典（得知所有玩家身份）。你可能被登记为善良阵营、村民或外来者。',
    color: '#e74c3c' },
  // 恶魔
  { id: 'imp', name: '小恶魔', team: 'EVIL', category: '恶魔',
    ability: '每个夜晚（除首夜），选择一名玩家将其杀害。首夜得知爪牙和3个不在场身份。',
    color: '#e74c3c' }
];

function openRoleOverview() {
  const panel = document.getElementById('roleOverviewPanel');
  if (!panel) return;
  panel.style.display = 'block';

  // 按分类渲染
  const categories = {
    '村民': 'roTownsfolk',
    '外来者': 'roOutsider',
    '爪牙': 'roMinion',
    '恶魔': 'roDemon'
  };

  for (const [cat, containerId] of Object.entries(categories)) {
    const container = document.getElementById(containerId);
    if (!container) continue;
    const roles = ALL_ROLE_INFO.filter(r => r.category === cat);
    container.innerHTML = roles.map(r => {
      const teamLabel = r.team === 'GOOD' ? '善良阵营' : '邪恶阵营';
      const teamBg = r.team === 'GOOD' ? 'rgba(46,204,113,0.2)' : 'rgba(231,76,60,0.2)';
      return `<div class="role-card">
        <div class="role-card-name" style="color:${r.color};">${r.name}</div>
        <div class="role-card-team" style="background:${teamBg}; color:${r.color};">${teamLabel}</div>
        <div class="role-card-desc">${r.ability}</div>
      </div>`;
    }).join('');
  }
}

function closeRoleOverview() {
  document.getElementById('roleOverviewPanel').style.display = 'none';
}

// ========== 自定义角色分配（测试用） ==========
// 角色分类（与服务端 game-config.js 保持一致）
const ROLE_CATEGORY = {
  // 村民
  washerwoman: 'townsfolk', librarian: 'townsfolk', investigator: 'townsfolk', chef: 'townsfolk',
  empath: 'townsfolk', fortuneteller: 'townsfolk', monk: 'townsfolk', ravenkeeper: 'townsfolk',
  virgin: 'townsfolk', slayer: 'townsfolk', soldier: 'townsfolk', mayor: 'townsfolk',
  undertaker: 'townsfolk',
  // 外来者
  saint: 'outsider', butler: 'outsider', drunk: 'outsider', recluse: 'outsider',
  // 爪牙
  poisoner: 'minion', scarletwoman: 'minion', baron: 'minion', spy: 'minion',
  // 恶魔
  imp: 'demon'
};

// 人数配置表：[玩家数, 村民, 外来者, 爪牙, 恶魔]
const ROLE_COMPOSITION_TABLE = [
  [5, 3, 0, 1, 1], [6, 3, 1, 1, 1], [7, 5, 0, 1, 1], [8, 5, 1, 1, 1],
  [9, 5, 2, 1, 1], [10, 7, 0, 2, 1], [11, 7, 1, 2, 1], [12, 7, 2, 2, 1],
  [13, 9, 0, 3, 1], [14, 9, 1, 3, 1], [15, 9, 2, 3, 1]
];

function getComp(playerCount, hasBaron) {
  const entry = ROLE_COMPOSITION_TABLE.find(c => c[0] === playerCount);
  if (!entry) return { townsfolk: 3, outsider: 0, minion: 1, demon: 1 };
  let t = entry[1], o = entry[2];
  if (hasBaron) { t -= 2; o += 2; }
  return { townsfolk: t, outsider: o, minion: entry[3], demon: entry[4] };
}

// 验证自定义角色配置，返回 { valid: boolean, errors: string[], comp: object, counts: object }
function validateCustomRoles(customRoleMap, playerCount) {
  const assigned = Object.values(customRoleMap).filter(r => r);
  const errors = [];

  // 1. 重复角色检测
  const roleCount = {};
  assigned.forEach(r => { roleCount[r] = (roleCount[r] || 0) + 1; });
  const duplicates = Object.entries(roleCount).filter(([, c]) => c > 1).map(([r]) => r);
  if (duplicates.length > 0) {
    const dupNames = duplicates.map(r => CUSTOM_ROLE_OPTIONS.find(o => o.id === r)?.name || r).join('、');
    errors.push(`存在重复角色：${dupNames}`);
  }

  // 2. 确定是否有男爵
  const hasBaron = assigned.includes('baron');
  const comp = getComp(playerCount, hasBaron);

  // 3. 按类别统计已指定角色
  const counts = { townsfolk: 0, outsider: 0, minion: 0, demon: 0 };
  assigned.forEach(r => {
    const cat = ROLE_CATEGORY[r];
    if (cat) counts[cat]++;
  });

  // 4. 检查各类别是否超限
  if (counts.demon > comp.demon) {
    errors.push(`恶魔最多 ${comp.demon} 名，已指定 ${counts.demon} 名`);
  }
  if (counts.minion > comp.minion) {
    errors.push(`爪牙最多 ${comp.minion} 名${hasBaron ? '' : '（不含男爵）'}，已指定 ${counts.minion} 名`);
  }
  if (counts.outsider > comp.outsider) {
    errors.push(`外来者最多 ${comp.outsider} 名${hasBaron ? '（含男爵加成）' : ''}，已指定 ${counts.outsider} 名`);
  }
  if (counts.townsfolk > comp.townsfolk) {
    errors.push(`村民最多 ${comp.townsfolk} 名${hasBaron ? '（男爵-2）' : ''}，已指定 ${counts.townsfolk} 名`);
  }

  // 5. 检查剩余空位是否足够填充必选角色
  const remaining = playerCount - assigned.length;
  const needDemon = Math.max(0, comp.demon - counts.demon);
  const needMinion = Math.max(0, comp.minion - counts.minion);
  const needOutsider = Math.max(0, comp.outsider - counts.outsider);
  const needTownsfolk = Math.max(0, comp.townsfolk - counts.townsfolk);
  const totalNeed = needDemon + needMinion + needOutsider + needTownsfolk;
  if (totalNeed > remaining) {
    errors.push(`剩余 ${remaining} 个空位不足以填满配置（还需 ${totalNeed} 个角色位置）`);
  }

  return {
    valid: errors.length === 0,
    errors,
    comp,
    counts,
    needs: { demon: needDemon, minion: needMinion, outsider: needOutsider, townsfolk: needTownsfolk, total: totalNeed },
    remaining,
    hasBaron
  };
}

const CUSTOM_ROLE_OPTIONS = [
  { id: '', name: '随机分配', color: '#888' },
  // 村民
  { id: 'washerwoman', name: '洗衣妇（村民）', color: '#2ecc71' },
  { id: 'librarian', name: '图书管理员（村民）', color: '#2ecc71' },
  { id: 'investigator', name: '调查员（村民）', color: '#2ecc71' },
  { id: 'chef', name: '厨师（村民）', color: '#2ecc71' },
  { id: 'empath', name: '共情者（村民）', color: '#2ecc71' },
  { id: 'fortuneteller', name: '占卜师（村民）', color: '#2ecc71' },
  { id: 'monk', name: '僧侣（村民）', color: '#2ecc71' },
  { id: 'ravenkeeper', name: '守鸦人（村民）', color: '#2ecc71' },
  { id: 'virgin', name: '圣女（村民）', color: '#2ecc71' },
  { id: 'slayer', name: '杀手（村民）', color: '#2ecc71' },
  { id: 'soldier', name: '士兵（村民）', color: '#2ecc71' },
  { id: 'mayor', name: '市长（村民）', color: '#2ecc71' },
  { id: 'undertaker', name: '掘墓人（村民）', color: '#2ecc71' },
  // 外来者
  { id: 'saint', name: '圣徒（外来者）', color: '#f39c12' },
  { id: 'butler', name: '管家（外来者）', color: '#f39c12' },
  { id: 'drunk', name: '酒鬼（外来者）', color: '#f39c12' },
  { id: 'recluse', name: '隐士（外来者）', color: '#f39c12' },
  // 爪牙
  { id: 'poisoner', name: '下毒者（爪牙）', color: '#e74c3c' },
  { id: 'scarletwoman', name: '红唇女郎（爪牙）', color: '#e74c3c' },
  { id: 'baron', name: '男爵（爪牙）', color: '#e74c3c' },
  { id: 'spy', name: '间谍（爪牙）', color: '#e74c3c' },
  // 恶魔
  { id: 'imp', name: '小恶魔（恶魔）', color: '#c0392b' }
];

function openCustomRolePanel() {
  const panel = $('customRolePanel');
  if (!panel) return;
  panel.style.display = 'block';
  renderCustomRoleList();
}

function closeCustomRolePanel() {
  $('customRolePanel').style.display = 'none';
}

function renderCustomRoleList() {
  const container = $('customRoleList');
  if (!container || !currentState) return;
  const seated = (currentState.players || []).filter(p => p.seat !== -1).sort((a, b) => a.seat - b.seat);
  if (seated.length === 0) {
    container.innerHTML = '<p style="color:#888; text-align:center; padding:20px;">暂无入座玩家</p>';
    return;
  }

  const playerCount = seated.length;

  // 统计已选角色，标注重复
  const usedRoles = {};
  seated.forEach(p => {
    const r = customRoleMap[p.seat];
    if (r) usedRoles[r] = (usedRoles[r] || 0) + 1;
  });

  // 实时验证
  const v = validateCustomRoles(customRoleMap, playerCount);

  let html = '';
  seated.forEach(p => {
    const currentVal = customRoleMap[p.seat] || '';
    const isDuplicate = currentVal && usedRoles[currentVal] > 1;
    const borderColor = isDuplicate ? '#e74c3c' : (currentVal ? '#2ecc71' : 'rgba(255,255,255,0.1)');
    html += `<div style="display:flex; align-items:center; padding:8px 12px; margin-bottom:6px; background:rgba(0,0,0,0.3); border-radius:6px; border-left:3px solid ${borderColor};">
      <span style="width:50px; color:#d4af37; font-weight:bold;">${p.seat+1}号</span>
      <span style="flex:1; color:#fff; margin-right:10px;">${escapeHtml(p.name)}${p.isBot ? ' 🤖' : ''}</span>
      <select onchange="setCustomRole(${p.seat}, this.value)" style="background:#1a1a2e; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:4px; padding:4px 8px; min-width:180px; font-size:13px;">
        ${CUSTOM_ROLE_OPTIONS.map(opt =>
          `<option value="${opt.id}" ${currentVal === opt.id ? 'selected' : ''} style="color:${opt.color};">${opt.name}</option>`
        ).join('')}
      </select>
    </div>`;
  });

  // 配置概览面板
  const baronTag = v.hasBaron ? ' <span style="color:#e74c3c;">(男爵在场: 村民-2, 外来者+2)</span>' : '';
  html += `<div style="margin-top:10px; padding:10px; background:rgba(52,73,94,0.4); border-radius:6px; font-size:12px;">
    <div style="color:#d4af37; font-weight:bold; margin-bottom:6px;">当前人数配置 (${playerCount}人)${baronTag}</div>
    <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:6px;">
      <span style="color:#2ecc71;">村民: ${v.counts.townsfolk}/${v.comp.townsfolk}</span>
      <span style="color:#f39c12;">外来者: ${v.counts.outsider}/${v.comp.outsider}</span>
      <span style="color:#e74c3c;">爪牙: ${v.counts.minion}/${v.comp.minion}</span>
      <span style="color:#c0392b;">恶魔: ${v.counts.demon}/${v.comp.demon}</span>
    </div>
    <div style="color:#aaa;">
      已指定 ${Object.values(customRoleMap).filter(r=>r).length} 个，剩余 ${v.remaining} 个空位
      ${v.valid && v.remaining > 0 ? `（还需自动分配：村民${v.needs.townsfolk}、外来者${v.needs.outsider}、爪牙${v.needs.minion}、恶魔${v.needs.demon}）` : ''}
    </div>
  </div>`;

  // 错误提示
  if (!v.valid) {
    html += `<div style="margin-top:8px; padding:10px; background:rgba(231,76,60,0.15); border:1px solid rgba(231,76,60,0.4); border-radius:6px;">
      <div style="color:#e74c3c; font-weight:bold; margin-bottom:4px;">⚠️ 配置有误：</div>
      ${v.errors.map(e => `<div style="color:#e74c3c; font-size:12px;">• ${e}</div>`).join('')}
    </div>`;
  }

  container.innerHTML = html;

  // 更新确认按钮状态
  const confirmBtn = document.getElementById('customRoleConfirmBtn');
  if (confirmBtn) {
    confirmBtn.disabled = !v.valid;
    confirmBtn.style.opacity = v.valid ? '1' : '0.5';
    confirmBtn.style.cursor = v.valid ? 'pointer' : 'not-allowed';
  }
}

function setCustomRole(seat, roleId) {
  if (roleId) {
    customRoleMap[seat] = roleId;
  } else {
    delete customRoleMap[seat];
  }
  renderCustomRoleList();
}

function applyCustomRoles() {
  const seated = (currentState.players || []).filter(p => p.seat !== -1);
  const playerCount = seated.length;
  const assigned = Object.values(customRoleMap).filter(r => r).length;

  if (assigned === 0) {
    // 没有指定任何角色，关闭自定义模式
    customRoleMode = false;
    closeCustomRolePanel();
    if (currentState) renderCenter(currentState);
    showToast('未设置自定义角色，将随机分配');
    return;
  }

  // 验证配置
  const v = validateCustomRoles(customRoleMap, playerCount);
  if (!v.valid) {
    showToast('配置有误：' + v.errors[0]);
    return;
  }

  customRoleMode = true;
  closeCustomRolePanel();
  if (currentState) renderCenter(currentState);
  showToast(`已设置 ${assigned} 个自定义角色，剩余 ${v.remaining} 个将按配置自动补全`);
}

function clearCustomRoles() {
  customRoleMap = {};
  customRoleMode = false;
  renderCustomRoleList();
}

// ========== 移动端适配 ==========
function toggleMobileChat() {
  const chatArea = document.querySelector('.chat-area');
  if (!chatArea) return;
  chatArea.classList.toggle('mobile-open');

}

// 点击遮罩关闭移动端聊天
document.addEventListener('click', (e) => {
  if (window.innerWidth > 768) return;
  const chatArea = document.querySelector('.chat-area');
  const backdrop = document.getElementById('mobileChatBackdrop');
  if (!chatArea || !chatArea.classList.contains('mobile-open')) return;
  // 只有点击遮罩才关闭
  if (backdrop && backdrop.contains(e.target)) {
    chatArea.classList.remove('mobile-open');
  }
});

// 监听窗口大小变化，重置移动端状态
window.addEventListener('resize', () => {
  if (window.innerWidth > 768) {
    const chatArea = document.querySelector('.chat-area');
    if (chatArea) chatArea.classList.remove('mobile-open');
  }
});
