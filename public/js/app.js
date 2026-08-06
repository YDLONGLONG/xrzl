// 血染钟楼前端主逻辑 - 单页应用
let socket;
let currentState = null;
let myId = null;
let myRoomId = null;
let myName = null;
let nightSelectedTargets = [];
let nightCanSelectCount = 0;
let nightSelectType = 'player';
let nightCanSkip = false;
let nightSelectedRoleId = null;
let currentChatChannel = 'public';
let selectedNominateTarget = null;
let whisperTargetId = null; // 当前私聊对象ID
let isGodView = false;
let godState = null;
let isReconnecting = false;
let reconnectAttempts = 0;
let hasLeftRoom = false;
let _nightDebugClicks = 0;
let _nightDebugTimer = null;

// ========== 初始化 ==========
window.addEventListener('DOMContentLoaded', () => {
  socket = io({ reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: 30 });
  initSocketEvents();
  checkReconnectInfo();
  
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

  // 初始化拖拽分隔条
  initResizers();

  // 夜晚遮罩调试：连续点击10次强制打开上帝视角
  const nightOverlay = $('nightOverlay');
  if (nightOverlay) {
    nightOverlay.addEventListener('click', (e) => {
      // 不在夜晚阶段（active状态）就忽略，点的是内部按钮也忽略
      if (!nightOverlay.classList.contains('active')) return;
      if (e.target.closest('button')) return;
      if (!currentState) return;
      const phase = currentState.phase;
      const isNightPhase = phase === 'FIRST_NIGHT' || phase === 'NIGHT' || phase === 'NIGHT_WAKE';
      if (!isNightPhase) return;

      _nightDebugClicks++;
      if (_nightDebugTimer) clearTimeout(_nightDebugTimer);
      _nightDebugTimer = setTimeout(() => { _nightDebugClicks = 0; }, 2000);

      const remain = 10 - _nightDebugClicks;
      if (remain > 0 && remain <= 3) {
        showToast(`再点${remain}下打开上帝视角调试`, 800);
      }

      if (_nightDebugClicks >= 10) {
        _nightDebugClicks = 0;
        if (_nightDebugTimer) clearTimeout(_nightDebugTimer);
        showToast('🔧 夜晚调试模式', 1000);
        // 强制打开上帝视角登录（不检查gameStarted和其他限制）
        $('godPanel').style.display = 'block';
        $('godLoginForm').style.display = 'block';
        $('godContent').style.display = 'none';
        $('godLoginError').style.display = 'none';
        $('godPassword').value = '';
        setTimeout(() => $('godPassword').focus(), 100);
      }
    });
  }
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
    if (hasLeftRoom) return;
    console.log('已连接到服务器');
    updateConnStatus('connected');
    // 如果之前有会话，尝试重连
    if (isReconnecting || (myRoomId && myName)) {
      doReconnect();
    }
  });

  socket.on('disconnect', () => {
    if (hasLeftRoom) return;
    console.log('与服务器断开连接');
    updateConnStatus('disconnected');
    if (myRoomId && myName) {
      showToast('与服务器断开，正在尝试重新连接...');
      isReconnecting = true;
    }
  });

  socket.on('reconnect_attempt', (attemptNumber) => {
    if (hasLeftRoom) return;
    updateConnStatus('connecting');
  });

  socket.on('connect_error', (error) => {
    if (hasLeftRoom) return;
    console.log('连接错误:', error);
    updateConnStatus('disconnected');
  });

  socket.on('room:created', ({ roomId, playerId }) => {
    if (hasLeftRoom) return;
    hasLeftRoom = false;
    myId = playerId;
    myRoomId = roomId;
    clearReconnectInfo();
    saveSession();
    showGameView();
  });

  socket.on('room:joined', ({ roomId, playerId }) => {
    if (hasLeftRoom) return;
    hasLeftRoom = false;
    myId = playerId;
    myRoomId = roomId;
    clearReconnectInfo();
    saveSession();
    showGameView();
  });

  socket.on('room:reconnected', ({ roomId, playerId, gameStarted }) => {
    if (hasLeftRoom) return;
    myId = playerId;
    myRoomId = roomId;
    isReconnecting = false;
    clearReconnectInfo();
    saveSession();
    showGameView();
    showToast('重新连接成功！');
    // 关闭可能打开的断线遮罩
    const overlay = $('disconnectOverlay');
    if (overlay) overlay.style.display = 'none';
  });

  socket.on('room:playerDisconnected', ({ name }) => {
    if (hasLeftRoom) return;
    showToast(`玩家 ${name} 已断线，AI将托管其行动`);
  });

  socket.on('room:playerReconnected', ({ name }) => {
    if (hasLeftRoom) return;
    showToast(`玩家 ${name} 已重新连接`);
  });

  socket.on('room:stateUpdate', (state) => {
    if (hasLeftRoom) return;
    const prevScript = currentState && currentState.script;
    currentState = state;
    // 房主才显示设置按钮
    const settingsBtn = $('settingsBtn');
    if (settingsBtn) {
      settingsBtn.style.display = state.isHost ? 'inline-block' : 'none';
    }
    renderGameState(state);
    // 如果角色总览面板已打开，重新渲染以反映剧本切换
    const roPanel = document.getElementById('roleOverviewPanel');
    if (roPanel && roPanel.style.display !== 'none') openRoleOverview();
    // 剧本切换时：概率面板若已打开，重载配置和 META（服务端会重置 probConfig）
    if (prevScript && prevScript !== state.script) {
      const probPanel = document.getElementById('probSettingsPanel');
      if (probPanel && probPanel.style.display !== 'none' && state.probConfig) {
        _probConfigDraft = JSON.parse(JSON.stringify(state.probConfig));
        _probConfigMeta = state.probConfigMeta;
        _probBackupAdvanced = null;
        _renderProbSettingsUI();
      }
    }
  });

  socket.on('game:stateUpdate', (state) => {
    if (hasLeftRoom) return;
    currentState = state;
    // 房主才显示设置按钮
    const settingsBtn = $('settingsBtn');
    if (settingsBtn) {
      settingsBtn.style.display = state.isHost ? 'inline-block' : 'none';
    }
    renderGameState(state);
    // 如果角色总览面板已打开，重新渲染以反映剧本切换
    const roPanel = document.getElementById('roleOverviewPanel');
    if (roPanel && roPanel.style.display !== 'none') openRoleOverview();
  });

  socket.on('room:error', ({ message }) => {
    if (hasLeftRoom) return;
    showToast(message);
    // 重连失败时清除失效的重连信息
    if (message.includes('房间不存在') || message.includes('游戏已开始')) {
      const card = $('reconnectCard');
      if (card && card.style.display !== 'none') {
        clearReconnectInfo();
        checkReconnectInfo();
      }
    }
  });

  // 概率设置相关事件
  socket.on('room:probConfig', (data) => {
    if (hasLeftRoom) return;
    renderProbSettings(data.config, data.meta, data.mode);
  });
  socket.on('room:probConfigSaved', () => {
    if (hasLeftRoom) return;
    showToast('概率设置已保存');
    closeProbSettings();
  });

  socket.on('room:kicked', ({ message }) => {
    if (hasLeftRoom) return;
    showToast(message || '你已被踢出房间');
    backToHome();
  });

  socket.on('game:over', (data) => {
    if (hasLeftRoom) return;
    showGameOver(data);
  });

  socket.on('night:wake', (data) => {
    if (hasLeftRoom) return;
    showNightWake(data);
  });

  socket.on('night:actionAck', (data) => {
    if (hasLeftRoom) return;
    if (data.success) hideNightOverlay();
  });

  socket.on('game:votingStarted', (data) => {
    if (hasLeftRoom) return;
    showVotingPanel(data);
  });

  socket.on('game:voteUpdate', (data) => {
    if (hasLeftRoom) return;
    updateVoteDisplay(data);
  });

  socket.on('game:voteResult', (data) => {
    if (hasLeftRoom) return;
    showVoteResult(data);
  });

  socket.on('game:nominationStarted', (data) => {
    if (hasLeftRoom) return;
    showNominationStarted(data);
  });

  socket.on('game:executionResult', (data) => {
    if (hasLeftRoom) return;
    showExecutionResult(data);
  });

  socket.on('game:abilityUsed', (data) => {
    if (hasLeftRoom) return;
    showAbilityUsed(data);
  });

  socket.on('chat:message', (msg) => {
    if (hasLeftRoom) return;
    addChatMessage(msg);
  });

  // AI 小助手事件
  socket.on('ai:start', ({ id, playerName }) => {
    isAiThinking = true;
    aiPendingMessages[id] = { content: '', playerName, chunks: [] };
    renderChatMessages();
  });

  socket.on('ai:chunk', ({ id, chunk }) => {
    if (!aiPendingMessages[id]) return;
    aiPendingMessages[id].content += chunk;
    renderChatMessages();
  });

  socket.on('ai:done', ({ id }) => {
    const pending = aiPendingMessages[id];
    if (pending) {
      aiChatHistory.push({ role: 'assistant', content: pending.content });
      aiChatHistory = aiChatHistory.slice(-20);
      // 将 AI 消息转为普通聊天消息存入 chatMessages
      chatMessages.push({
        id: 'ai_msg_' + id,
        fromId: 'ai_assistant',
        fromName: '小染 AI',
        fromSeat: -1,
        isDead: false,
        isAi: true,
        content: pending.content,
        channel: 'public',
        timestamp: Date.now()
      });
      delete aiPendingMessages[id];
      renderChatMessages();
    }
    isAiThinking = false;
  });

  socket.on('ai:error', ({ message }) => {
    isAiThinking = false;
    aiPendingMessages = {};
    showToast(message || 'AI请求失败');
    renderChatMessages();
  });

  socket.on('player:died', (data) => {
    if (hasLeftRoom) return;
    showPlayerDied(data);
  });

  // 上帝视角事件
  socket.on('god:loginResult', (data) => {
    if (hasLeftRoom) return;
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
    if (hasLeftRoom) return;
    godState = state;
    renderGodView();
  });

  socket.on('god:actionLog', (entry) => {
    if (hasLeftRoom) return;
    if (godState) {
      godState.actionLog.push(entry);
      if (godState.actionLog.length > 200) godState.actionLog.shift();
      appendGodLogEntry(entry);
    }
  });

  socket.on('god:playerUpdate', (playerData) => {
    if (hasLeftRoom) return;
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
    if (hasLeftRoom) return;
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

// ========== 三栏拖拽调整宽度 ==========
const RESIZE_STORAGE_KEY = 'xrzl_col_widths';
const RESIZE_CONFIG = {
  left: { min: 120, max: 400, default: 200, cssVar: '--left-col-width' },
  right: { min: 200, max: 500, default: 280, cssVar: '--right-col-width' }
};

let _resizerState = { active: null, startX: 0, startWidth: 0 };

function initResizers() {
  applySavedWidths();
  setupResizer('resizerLeft', 'left');
  setupResizer('resizerRight', 'right');
}

function applySavedWidths() {
  try {
    const saved = localStorage.getItem(RESIZE_STORAGE_KEY);
    if (!saved) return;
    const widths = JSON.parse(saved);
    const container = $('gameView');
    if (!container) return;
    if (widths.left) {
      container.style.setProperty('--left-col-width', widths.left + 'px');
    }
    if (widths.right) {
      container.style.setProperty('--right-col-width', widths.right + 'px');
    }
  } catch(e) {
    console.warn('读取列宽失败:', e);
  }
}

function saveWidth(side, width) {
  try {
    const saved = localStorage.getItem(RESIZE_STORAGE_KEY);
    const widths = saved ? JSON.parse(saved) : {};
    widths[side] = width;
    localStorage.setItem(RESIZE_STORAGE_KEY, JSON.stringify(widths));
  } catch(e) {}
}

function setupResizer(elId, side) {
  const resizer = $(elId);
  if (!resizer) return;
  const config = RESIZE_CONFIG[side];

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (window.innerWidth < 768) return;
    _resizerState.active = side;
    _resizerState.startX = e.clientX;

    const container = $('gameView');
    const currentWidth = parseInt(getComputedStyle(container).getPropertyValue(config.cssVar)) || config.default;
    _resizerState.startWidth = currentWidth;

    resizer.classList.add('resizing');
    document.body.classList.add('resizing-active');

    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeEnd);
  });
}

function onResizeMove(e) {
  const side = _resizerState.active;
  if (!side) return;
  const config = RESIZE_CONFIG[side];
  const container = $('gameView');
  if (!container) return;

  let delta = e.clientX - _resizerState.startX;
  if (side === 'right') delta = -delta;

  let newWidth = _resizerState.startWidth + delta;
  newWidth = Math.max(config.min, Math.min(config.max, newWidth));

  container.style.setProperty(config.cssVar, newWidth + 'px');
}

function onResizeEnd() {
  const side = _resizerState.active;
  if (!side) return;

  const config = RESIZE_CONFIG[side];
  const container = $('gameView');
  if (container) {
    const currentWidth = parseInt(getComputedStyle(container).getPropertyValue(config.cssVar)) || config.default;
    saveWidth(side, currentWidth);
  }

  document.querySelectorAll('.resizer').forEach(r => r.classList.remove('resizing'));
  document.body.classList.remove('resizing-active');

  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeEnd);

  _resizerState.active = null;
}

// ========== 连接状态 ==========
function updateConnStatus(status) {
  const dot = $('connStatusDot');
  const text = $('connStatusText');
  if (!dot || !text) return;

  dot.className = 'conn-dot';
  switch (status) {
    case 'connected':
      dot.classList.add('conn-connected');
      text.textContent = '已连接';
      text.style.color = '#2ecc71';
      break;
    case 'disconnected':
      dot.classList.add('conn-disconnected');
      text.textContent = '已断开';
      text.style.color = '#e74c3c';
      break;
    case 'connecting':
    default:
      dot.classList.add('conn-connecting');
      text.textContent = '连接中...';
      text.style.color = '#f39c12';
      break;
  }
}

// ========== 视图切换 ==========
function showGameView() {
  $('homeView').style.display = 'none';
  $('gameView').style.display = 'grid';
  $('gameOverPanel').style.display = 'none';
}

function backToHome() {
  if (hasLeftRoom) return;
  hasLeftRoom = true;

  const wasInGame = currentState && currentState.gameStarted && currentState.phase !== 'GAME_OVER';
  const savedRoomId = myRoomId;
  const savedName = myName;

  if (myRoomId && socket && socket.connected) {
    socket.emit('room:leave');
  }

  // 游戏中离开：保存重连信息
  if (wasInGame && savedRoomId && savedName) {
    try {
      sessionStorage.setItem('reconnect_room', savedRoomId);
      sessionStorage.setItem('reconnect_name', savedName);
      sessionStorage.setItem('reconnect_time', Date.now().toString());
    } catch(e) {}
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
  aiChatHistory = [];
  aiPendingMessages = {};
  isAiThinking = false;
  customRoleMode = false;
  customRoleMap = {};
  isGodView = false;
  godState = null;
  isReconnecting = false;

  $('homeView').style.display = 'flex';
  $('gameView').style.display = 'none';
  $('gameOverPanel').style.display = 'none';
  $('godPanel').style.display = 'none';
  $('createName').value = '';
  $('joinRoomId').value = '';
  $('joinName').value = '';

  checkReconnectInfo();

  setTimeout(() => {
    hasLeftRoom = false;
  }, 300);
}

// ========== 首页操作 ==========
function checkReconnectInfo() {
  const card = $('reconnectCard');
  if (!card) return;
  try {
    const roomId = sessionStorage.getItem('reconnect_room');
    const name = sessionStorage.getItem('reconnect_name');
    const time = sessionStorage.getItem('reconnect_time');
    if (!roomId || !name) {
      card.style.display = 'none';
      return;
    }
    // 重连信息过期（服务端RECONNECT_TIMEOUT是3分钟，这里留5分钟余量）
    if (time && Date.now() - parseInt(time) > 5 * 60 * 1000) {
      clearReconnectInfo();
      card.style.display = 'none';
      return;
    }
    $('reconnectInfo').innerHTML = `房间码：<b style="color:#f39c12;">${roomId}</b>　昵称：<b style="color:#f39c12;">${escapeHtml(name)}</b>`;
    card.style.display = 'block';
  } catch(e) {
    card.style.display = 'none';
  }
}

function clearReconnectInfo() {
  try {
    sessionStorage.removeItem('reconnect_room');
    sessionStorage.removeItem('reconnect_name');
    sessionStorage.removeItem('reconnect_time');
  } catch(e) {}
}

function reconnectRoom() {
  const roomId = sessionStorage.getItem('reconnect_room');
  const name = sessionStorage.getItem('reconnect_name');
  if (!roomId || !name) {
    clearReconnectInfo();
    checkReconnectInfo();
    return;
  }
  hasLeftRoom = false;
  myName = name;
  myRoomId = roomId;
  $('joinError').textContent = '';
  socket.emit('room:join', { roomId, playerName: name, isReconnect: true });
}

function createRoom() {
  const name = $('createName').value.trim();
  if (!name) {
    showError('请输入昵称', 'createError');
    return;
  }
  hasLeftRoom = false;
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
  hasLeftRoom = false;
  myName = name;
  socket.emit('room:join', { roomId, playerName: name });
}

async function leaveRoom() {
  if (hasLeftRoom) return;
  const ok = await showConfirm('确定要离开房间吗？', { type: 'warning', title: '离开房间', confirmText: '离开', cancelText: '取消' });
  if (ok) {
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
    const v = validateCustomRoles(customRoleMap, seatedPlayers.length, currentState.script || 'tb');
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

function setScript(scriptId) {
  socket.emit('room:setScript', { scriptId });
}

async function kickPlayer(pid) {
  const p = currentState && currentState.players ? currentState.players.find(x => x.id === pid) : null;
  if (!p) return;
  const name = p.name + (p.isBot ? '(机器人)' : '');
  const ok = await showConfirm(`确定要将 ${name} 踢出房间吗？`, { type: 'warning', title: '踢出玩家' });
  if (!ok) return;
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
  $('headerRoomId').title = '点击复制房间号';
  $('headerRoomId').style.cursor = 'pointer';
  $('headerRoomId').onclick = () => {
    const roomId = state.roomId || myRoomId;
    if (roomId) {
      copyToClipboard(roomId);
      showToast('房间号已复制');
    }
  };

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
    const currentScript = state.script || 'tb';
    const scriptList = state.scriptList || [{ id: 'tb', name: '灾祸之酿' }, { id: 'bmr', name: '黯月初升' }];

    // 构建剧本卡片
    const scriptCardsHtml = scriptList.map(s => {
      const info = SCRIPT_INFO[s.id] || { icon: '📜', desc: '', color: '#888', nameEn: '' };
      const isActive = s.id === currentScript;
      const cursor = isHost ? 'cursor:pointer;' : 'cursor:default; opacity:0.85;';
      const onClickAttr = isHost ? `onclick="setScript('${s.id}')"` : '';
      const borderColor = isActive ? info.color : 'rgba(255,255,255,0.1)';
      const bgGrad = isActive
        ? `linear-gradient(145deg, ${info.color}1a 0%, ${info.color}08 40%, rgba(255,255,255,0.02) 100%)`
        : 'linear-gradient(145deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.01) 100%)';
      const shadow = isActive
        ? `0 4px 24px ${info.color}33, inset 0 1px 0 rgba(255,255,255,0.08)`
        : '0 2px 12px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.05)';
      const textColor = isActive ? info.color : '#e8e8e8';
      return `<div ${onClickAttr} class="script-card" style="border:1px solid ${borderColor}; background:${bgGrad}; box-shadow:${shadow}; ${cursor} transition:all 0.3s cubic-bezier(0.4, 0, 0.2, 1);">
        <div class="script-card-highlight" style="position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg, transparent, ${info.color}66, transparent); opacity:${isActive ? '1' : '0.3'};"></div>
        <div class="script-card-head">
          <div class="script-icon" style="width:40px; height:40px; border-radius:10px; background:${isActive ? info.color + '22' : 'rgba(255,255,255,0.06)'}; display:flex; align-items:center; justify-content:center; font-size:1.5em; flex-shrink:0; transition:all 0.3s;">${info.icon}</div>
          <div class="script-card-titles">
            <div class="script-card-name" style="font-weight:700; color:${textColor}; font-size:15px; letter-spacing:0.3px;">${s.name}</div>
            <div class="script-card-en" style="font-size:11px; color:#999; font-weight:400; letter-spacing:0.5px; margin-top:2px;">${info.nameEn}</div>
          </div>
          ${isActive ? `<div class="script-card-check" style="width:22px; height:22px; border-radius:50%; background:${info.color}; display:flex; align-items:center; justify-content:center; font-size:12px; color:#1a1a2e; font-weight:bold; box-shadow:0 0 10px ${info.color}88;">✓</div>` : ''}
        </div>
        <div class="script-card-desc" style="font-size:12px; color:${isActive ? '#bbb' : '#777'}; line-height:1.5; transition:color 0.3s;">${info.desc}</div>
      </div>`;
    }).join('');

    html = `<div class="lobby-content" style="text-align:center;">
      <h2 style="color:#d4af37; margin-bottom:14px;">游戏大厅</h2>
      <div class="script-list">${scriptCardsHtml}</div>
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
        const defNom = state.nominations && state.nominations.length > 0 ? state.nominations[state.nominations.length - 1] : null;
        const defNominator = defNom ? state.players.find(p => p.id === defNom.nominatorId) : null;
        const defNominee = defNom ? state.players.find(p => p.id === defNom.nomineeId) : null;
        const nominatorText = defNominator ? `${defNominator.seat+1}号 ${defNominator.name}` : '?';
        const nomineeText = defNominee ? `${defNominee.seat+1}号 ${defNominee.name}` : '?';
        if (state.currentDefensePlayerId === myId) {
          html = '<div style="color:#e74c3c;">⚖️ 你被提名了！请辩护</div>';
          html += `<div style="margin-top:8px; font-size:0.9em; color:#bbb;">提名者：<span style="color:#f39c12;">${nominatorText}</span></div>`;
          html += '<div style="margin-top:10px;">辩护完毕后点击按钮进入投票</div>';
          showAction = true;
          $('actionTitle').textContent = '辩护';
          $('selectedTargets').innerHTML = '';
          $('actionButtons').innerHTML = `<button class="btn btn-primary" onclick="endDefense()">辩护完毕</button>`;
        } else {
          const def = state.players.find(p => p.id === state.currentDefensePlayerId);
          html = `<div style="color:#f39c12;">⚖️ ${def ? def.seat+1+'号 '+def.name : ''} 正在辩护...</div>`;
          html += `<div style="margin-top:8px; font-size:0.9em; color:#bbb;">提名者：<span style="color:#f39c12;">${nominatorText}</span></div>`;
        }
        break;

      case 'VOTING':
        html = '<div style="color:#e74c3c;">🗳️ 投票中</div>';
        const curNom = state.nominations ? state.nominations[state.nominations.length-1] : null;
        const nominee = curNom ? state.players.find(p => p.id === curNom.nomineeId) : null;
        const nominator = curNom ? state.players.find(p => p.id === curNom.nominatorId) : null;
        if (nominee) {
          html += `<div style="margin-top:10px; font-size:1.2em;">是否处决 ${nominee.seat+1}号 ${nominee.name}？</div>`;
          if (nominator) {
            html += `<div style="margin-top:6px; font-size:0.9em; color:#bbb;">提名者：<span style="color:#f39c12;">${nominator.seat+1}号 ${nominator.name}</span></div>`;
          }
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
          // 已投票：显示当前选择 + 撤回投票按钮（还有人未投时可撤回）
          const voteLabel = myVote === true
            ? '<span style="color:#2ecc71; font-weight:bold;">✅ 已投赞成</span>'
            : '<span style="color:#e74c3c; font-weight:bold;">❌ 已投反对</span>';
          if (hasUnvoted) {
            $('actionButtons').innerHTML = `
              <div style="text-align:center; margin-bottom:8px;">${voteLabel}</div>
              <button class="btn btn-sm btn-warning" onclick="revokeVote()" style="width:100%;">↩️ 撤回投票</button>
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
    const infoList = state.privateInfoHistory && state.privateInfoHistory.length > 0 ? state.privateInfoHistory : (state.privateInfo ? [state.privateInfo] : []);
    if (infoList.length > 0) {
      // 按天分组
      const byDay = {};
      infoList.forEach(info => {
        const d = info.day !== undefined ? info.day : 0;
        if (!byDay[d]) byDay[d] = [];
        byDay[d].push(info);
      });
      const days = Object.keys(byDay).map(Number).sort((a,b) => a - b);

      let infoHtml = '';
      days.forEach(day => {
        const dayLabel = day === 0 ? '首夜' : `第${day}夜`;
        infoHtml += `<div style="margin-bottom:6px;">
          <div style="color:#d4af37; font-size:0.8em; margin-bottom:4px; opacity:0.8;">${dayLabel}</div>`;
        byDay[day].forEach(info => {
          infoHtml += `<div style="color:#f0d78c; line-height:1.5; font-size:0.9em; margin-bottom:3px;">· ${escapeHtml(info.message).replace(/\n/g, '<br>')}</div>`;
        });
        infoHtml += '</div>';
      });

      html += `<div style="margin-top:15px; padding:12px; background:rgba(212,175,55,0.08); border-left:3px solid #d4af37; border-radius:4px;">
        <div style="color:#d4af37; font-size:0.85em; margin-bottom:8px; letter-spacing:1px; display:flex; justify-content:space-between; align-items:center;">
          <span>📜 你的信息</span>
          <span style="font-size:0.85em; opacity:0.6;">共 ${infoList.length} 条</span>
        </div>
        ${infoHtml}
      </div>`;
    }
  }

  msg.className = 'center-message ' + msgClass;
  msg.innerHTML = html;
  actionPanel.style.display = showAction || (state.phase === 'DEFENSE' && state.currentDefensePlayerId === myId) || state.phase === 'VOTING' ? 'block' : 'none';
  confirmBar.style.display = showConfirm ? 'block' : 'none';
  const bottomVisible = (actionPanel.style.display === 'block') || (confirmBar.style.display === 'block');
  const centerBottom = document.querySelector('.center-bottom');
  if (centerBottom) {
    centerBottom.style.display = bottomVisible ? 'block' : 'none';
  }

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
      .sort((a, b) => a.seat - b.seat)
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
  if (role.id === 'slayer' && me.isAlive &&
      (state.phase === 'DAY_DISCUSSION' || state.phase === 'NOMINATION_PHASE')) {
    const slayerUsed = state.privateInfoHistory && state.privateInfoHistory.some(
      info => info.type === 'slayer'
    );
    if (!slayerUsed) {
      slayerBtn.style.display = 'block';
    } else {
      slayerBtn.style.display = 'none';
    }
  } else {
    slayerBtn.style.display = 'none';
  }

  const gossipBtn = $('gossipBtn');
  const todayGossipUsed = state.privateInfoHistory && state.privateInfoHistory.some(
    info => info.type === 'gossip' && info.day === state.dayCount
  );
  if (role.id === 'gossip' && me.isAlive && !todayGossipUsed &&
      (state.phase === 'DAY_DISCUSSION' || state.phase === 'NOMINATION_PHASE')) {
    gossipBtn.style.display = 'block';
  } else {
    gossipBtn.style.display = 'none';
  }

  const moonchildBtn = $('moonchildBtn');
  const pendingMoonchild = state.myAbilityState && state.myAbilityState.pendingMoonchildSelect;
  if (role.id === 'moonchild' && pendingMoonchild &&
      (state.phase === 'DAY_DAWN' || state.phase === 'DAY_DISCUSSION' || state.phase === 'NOMINATION_PHASE' || state.phase === 'EXECUTION' || state.phase === 'VOTING' || state.phase === 'DEFENSE')) {
    moonchildBtn.style.display = 'block';
  } else {
    moonchildBtn.style.display = 'none';
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
  const skipBtn = $('nightSkipBtn');

  overlay.classList.add('active', 'wake');
  text.textContent = `你的回合：${data.role}`;
  subtext.innerHTML = (data.message || '').replace(/\n/g, '<br>');
  
  nightSelectedTargets = [];
  nightSelectedRoleId = null;
  nightSelectType = data.selectType || 'player';
  nightCanSkip = data.canSkip || false;
  const canSelectCount = data.canSelectCount || 0;
  nightCanSelectCount = canSelectCount;
  const excludeSelf = data.excludeSelf || false;
  const selectDead = data.selectDead || false;
  let nightPlayerAndRoleStep = 'player';
  let nightSelectedPlayerForRole = null;

  selectArea.innerHTML = '';
  selectArea.style.cssText = '';

  if (nightSelectType === 'info') {
    confirmBtn.style.display = 'block';
    confirmBtn.disabled = false;
    confirmBtn.textContent = '确认';
    skipBtn.style.display = 'none';
    return;
  }

  function updateConfirmState() {
    if (nightSelectType === 'role') {
      confirmBtn.disabled = !nightSelectedRoleId;
    } else if (nightSelectType === 'playerAndRole') {
      const hasPlayer = nightSelectedTargets.length === 1;
      const hasRole = !!nightSelectedRoleId;
      confirmBtn.disabled = !(hasPlayer && hasRole);
      confirmBtn.textContent = (hasPlayer && hasRole) ? '确认选择' : (hasPlayer ? '请选择角色' : '请选择一名玩家');
    } else {
      confirmBtn.disabled = nightSelectedTargets.length !== (canSelectCount || 1);
    }
  }

  function renderPlayerButtons(includeDead) {
    const players = currentState.players.filter(p => {
      if (excludeSelf && p.id === myId) return false;
      if (p.seat === -1) return false;
      if (!includeDead && !p.isAlive) return false;
      return true;
    });

    players.forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'night-player-btn';
      if (p.isDead) btn.classList.add('dead-selectable');
      if (nightSelectedTargets.includes(p.id)) btn.classList.add('selected');
      btn.textContent = `${p.seat + 1}号 ${p.name}${p.isDead ? ' (死者)' : ''}`;
      btn.dataset.pid = p.id;
      btn.onclick = () => {
        const idx = nightSelectedTargets.indexOf(p.id);
        if (idx >= 0) {
          nightSelectedTargets.splice(idx, 1);
          btn.classList.remove('selected');
          nightSelectedPlayerForRole = null;
          nightSelectedRoleId = null;
          if (nightSelectType === 'playerAndRole') {
            nightPlayerAndRoleStep = 'player';
            renderPlayerAndRole();
          }
        } else {
          document.querySelectorAll('.night-player-btn.selected').forEach(b => b.classList.remove('selected'));
          nightSelectedTargets = [p.id];
          btn.classList.add('selected');
          nightSelectedPlayerForRole = p.id;
          if (nightSelectType === 'playerAndRole') {
            nightPlayerAndRoleStep = 'role';
            renderPlayerAndRole();
          }
        }
        updateConfirmState();
      };
      selectArea.appendChild(btn);
    });
  }

  function renderRoleButtons(onConfirm) {
    if (!data.selectRoles) return;
    const roleHint = document.createElement('div');
    roleHint.style.cssText = 'color:#d4af37;margin:12px 0 8px;font-size:14px;';
    roleHint.textContent = '猜测该玩家的角色：';
    selectArea.appendChild(roleHint);

    data.selectRoles.forEach(r => {
      const btn = document.createElement('button');
      btn.className = `night-role-btn ${(r.category || '').toLowerCase()}`;
      if (nightSelectedRoleId === r.id) btn.classList.add('selected');
      btn.textContent = r.name;
      btn.dataset.rid = r.id;
      btn.title = r.team === 'GOOD' ? '善良阵营' : '邪恶阵营';
      btn.onclick = () => {
        document.querySelectorAll('.night-role-btn.selected').forEach(b => b.classList.remove('selected'));
        nightSelectedRoleId = r.id;
        btn.classList.add('selected');
        updateConfirmState();
      };
      selectArea.appendChild(btn);
    });
  }

  function renderPlayerAndRole() {
    selectArea.innerHTML = '';
    selectArea.style.cssText = 'display:flex;gap:12px;max-width:900px;width:100%;max-height:50vh;overflow-y:auto;';

    const playerSection = document.createElement('div');
    playerSection.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;';
    const playerTitle = document.createElement('div');
    playerTitle.style.cssText = 'color:#3498db;margin-bottom:6px;font-size:13px;font-weight:bold;display:flex;align-items:center;gap:6px;flex-shrink:0;';
    playerTitle.innerHTML = '<span style="display:inline-block;width:18px;height:18px;background:#3498db;border-radius:50%;color:#fff;text-align:center;line-height:18px;font-size:11px;">1</span>选择玩家';
    playerSection.appendChild(playerTitle);
    const playerGrid = document.createElement('div');
    playerGrid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:5px;overflow-y:auto;padding-right:4px;';
    playerGrid.className = 'player-select-grid';
    const players = currentState.players.filter(p => {
      if (excludeSelf && p.id === myId) return false;
      if (p.seat === -1) return false;
      if (p.isDead) return false;
      return true;
    });
    players.forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'night-player-btn';
      if (nightSelectedTargets.includes(p.id)) btn.classList.add('selected');
      btn.style.cssText = 'padding:6px 4px;font-size:12px;min-height:36px;';
      btn.textContent = `${p.seat + 1}号`;
      btn.title = p.name;
      btn.dataset.pid = p.id;
      btn.onclick = () => {
        document.querySelectorAll('.player-select-grid .night-player-btn.selected').forEach(b => b.classList.remove('selected'));
        nightSelectedTargets = [p.id];
        nightSelectedPlayerForRole = p.id;
        btn.classList.add('selected');
        nightSelectedRoleId = null;
        document.querySelectorAll('.role-select-grid .night-role-btn.selected').forEach(b => b.classList.remove('selected'));
        const selectedHint = roleSection.querySelector('.role-selected-hint');
        if (selectedHint) selectedHint.textContent = `${p.seat+1}号${p.name}`;
        updateConfirmState();
      };
      playerGrid.appendChild(btn);
    });
    playerSection.appendChild(playerGrid);
    selectArea.appendChild(playerSection);

    const divider = document.createElement('div');
    divider.style.cssText = 'width:1px;background:rgba(255,255,255,0.15);flex-shrink:0;';
    selectArea.appendChild(divider);

    const roleSection = document.createElement('div');
    roleSection.style.cssText = 'flex:1.5;min-width:0;display:flex;flex-direction:column;';
    const roleTitle = document.createElement('div');
    roleTitle.style.cssText = 'color:#d4af37;margin-bottom:6px;font-size:13px;font-weight:bold;display:flex;align-items:center;gap:6px;flex-shrink:0;';
    roleTitle.innerHTML = '<span style="display:inline-block;width:18px;height:18px;background:#d4af37;border-radius:50%;color:#000;text-align:center;line-height:18px;font-size:11px;">2</span>猜测角色';
    roleSection.appendChild(roleTitle);

    const hint = document.createElement('div');
    hint.className = 'role-selected-hint';
    hint.style.cssText = 'color:#888;font-size:11px;margin-bottom:6px;flex-shrink:0;';
    const selectedP = nightSelectedTargets.length > 0 ? currentState.players.find(p=>p.id===nightSelectedTargets[0]) : null;
    hint.textContent = selectedP ? `${selectedP.seat+1}号${selectedP.name}` : '请先选玩家';
    roleSection.appendChild(hint);

    const roleGrid = document.createElement('div');
    roleGrid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(70px,1fr));gap:4px;overflow-y:auto;padding-right:4px;';
    roleGrid.className = 'role-select-grid';
    if (data.selectRoles) {
      data.selectRoles.forEach(r => {
        const btn = document.createElement('button');
        btn.className = `night-role-btn ${(r.category || '').toLowerCase()}`;
        if (nightSelectedRoleId === r.id) btn.classList.add('selected');
        btn.style.cssText = 'padding:5px 3px;font-size:11px;min-height:32px;';
        btn.textContent = r.name;
        btn.dataset.rid = r.id;
        btn.title = (r.team === 'GOOD' ? '善良阵营' : '邪恶阵营') + ' - ' + r.name;
        btn.onclick = () => {
          if (nightSelectedTargets.length === 0) {
            showToast('请先选择一名玩家');
            return;
          }
          document.querySelectorAll('.role-select-grid .night-role-btn.selected').forEach(b => b.classList.remove('selected'));
          nightSelectedRoleId = r.id;
          btn.classList.add('selected');
          updateConfirmState();
        };
        roleGrid.appendChild(btn);
      });
    }
    roleSection.appendChild(roleGrid);
    selectArea.appendChild(roleSection);
  }

  if (nightSelectType === 'role' && data.selectRoles) {
    data.selectRoles.forEach(r => {
      const btn = document.createElement('button');
      btn.className = `night-role-btn ${(r.category || '').toLowerCase()}`;
      btn.textContent = r.name;
      btn.dataset.rid = r.id;
      btn.title = r.team === 'GOOD' ? '善良阵营' : '邪恶阵营';
      btn.onclick = () => {
        document.querySelectorAll('.night-role-btn.selected').forEach(b => b.classList.remove('selected'));
        nightSelectedRoleId = r.id;
        btn.classList.add('selected');
        updateConfirmState();
      };
      selectArea.appendChild(btn);
    });
    confirmBtn.style.display = 'block';
    confirmBtn.disabled = true;
    confirmBtn.textContent = '确认选择';
  } else if (nightSelectType === 'playerAndRole') {
    renderPlayerAndRole();
    confirmBtn.style.display = 'block';
    confirmBtn.disabled = true;
    confirmBtn.textContent = '请选择一名玩家';
  } else if (canSelectCount > 0) {
    renderPlayerButtons(selectDead);
    confirmBtn.style.display = 'block';
    confirmBtn.disabled = true;
    confirmBtn.textContent = '确认行动';
  } else {
    confirmBtn.style.display = 'block';
    confirmBtn.disabled = false;
    confirmBtn.textContent = '确认';
  }

  skipBtn.style.display = nightCanSkip ? 'block' : 'none';
}

function toggleNightRole(rid, btn) {
  if (nightSelectedRoleId === rid) {
    nightSelectedRoleId = null;
    btn.classList.remove('selected');
  } else {
    document.querySelectorAll('.night-role-btn.selected').forEach(b => b.classList.remove('selected'));
    nightSelectedRoleId = rid;
    btn.classList.add('selected');
  }
  $('nightConfirmBtn').disabled = !nightSelectedRoleId;
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

  const neededCount = getNeededSelectCount();
  $('nightConfirmBtn').disabled = nightSelectedTargets.length !== neededCount;
}

function getNeededSelectCount() {
  return nightCanSelectCount || 1;
}

function submitNightAction() {
  if (nightSelectType === 'role') {
    if (!nightSelectedRoleId) {
      showToast('请选择一个角色');
      return;
    }
    socket.emit('night:action', { roleId: nightSelectedRoleId });
    return;
  }

  if (nightSelectType === 'playerAndRole') {
    if (nightSelectedTargets.length !== 1) {
      showToast('请选择一名玩家');
      return;
    }
    if (!nightSelectedRoleId) {
      showToast('请猜测该玩家的角色');
      return;
    }
    socket.emit('night:action', { targets: nightSelectedTargets, roleId: nightSelectedRoleId });
    return;
  }

  const neededCount = getNeededSelectCount();
  if (nightSelectedTargets.length > 0 && nightSelectedTargets.length !== neededCount) {
    showToast(`请选择${neededCount}名玩家`);
    return;
  }

  socket.emit('night:action', { targets: nightSelectedTargets });
}

function skipNightAction() {
  socket.emit('night:action', { skip: true });
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
  const skipBtn = $('nightSkipBtn');

  overlay.classList.add('active');
  overlay.classList.remove('wake');
  text.textContent = '夜幕降临';
  subtext.textContent = '等待其他玩家行动...';
  selectArea.innerHTML = '';
  confirmBtn.style.display = 'none';
  skipBtn.style.display = 'none';
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
async function nominatePlayer(targetId) {
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
  const ok = await showConfirm(`确定提名 ${target.seat+1}号 ${target.name} 吗？`, { title: '提名确认' });
  if (ok) {
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

// 撤回投票
function revokeVote() {
  socket.emit('day:revokeVote');
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

async function useSlayerAbility() {
  const players = currentState.players.filter(p => p.isAlive && p.seat !== -1 && p.id !== myId);
  const selectedId = await showPlayerSelect('杀手技能：选择要击杀的玩家', players, { type: 'warning', confirmText: '选择' });
  if (selectedId) {
    const target = players.find(p => p.id === selectedId);
    if (target) {
      const ok = await showConfirm(`确定对 ${target.seat+1}号 ${target.name} 使用杀手技能吗？每局只能使用一次。`, { type: 'warning', title: '杀手技能', confirmText: '确认击杀' });
      if (ok) {
        socket.emit('day:useAbility', { abilityName: 'slayer', targetId: selectedId });
      }
    }
  }
}

async function useGossipAbility() {
  const statement = await showTextInput('造谣者：发表公开声明', {
    placeholder: '输入你的声明（2-200字）...',
    description: '规则：今晚裁判会判断你的声明是否为真。若声明为真且你未中毒/醉酒，今晚一名玩家会死亡。',
    maxLength: 200,
    minLength: 2,
    multiline: true,
    type: 'warning',
    confirmText: '发表声明',
    cancelText: '取消'
  });
  if (statement) {
    socket.emit('day:useAbility', { abilityName: 'gossip', statement: statement });
  }
}

async function useMoonchildAbility() {
  const players = currentState.players.filter(p => p.isAlive && p.seat !== -1);
  const selectedId = await showPlayerSelect('月之子：公开选择一名玩家', players, { type: 'info', confirmText: '公开选择' });
  if (selectedId) {
    const target = players.find(p => p.id === selectedId);
    if (target) {
      const ok = await showConfirm(`确定选择 ${target.seat+1}号 ${target.name} 吗？所有人都会看到你的选择。如果TA是善良的，今晚TA会死亡。`, { type: 'info', title: '月之子选择', confirmText: '确认选择' });
      if (ok) {
        socket.emit('day:useAbility', { abilityName: 'moonchild', targetId: selectedId });
      }
    }
  }
}

function showPlayerSelect(title, players, options = {}) {
  return new Promise((resolve) => {
    const type = options.type || 'default';
    const confirmText = options.confirmText || '确定';
    const selected = { id: null };

    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const playerButtons = players.map(p =>
      `<button class="slayer-player-btn" data-pid="${p.id}">${p.seat+1}号 ${p.name}</button>`
    ).join('');
    overlay.innerHTML = `
      <div class="confirm-dialog confirm-type-${type}" style="min-width:340px;max-width:500px;">
        <div class="confirm-title">${title}</div>
        <div class="confirm-input-area" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:6px;max-height:50vh;overflow-y:auto;">
          ${playerButtons}
        </div>
        <div class="confirm-buttons">
          <button class="confirm-btn confirm-cancel">取消</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = (result) => {
      overlay.classList.add('confirm-closing');
      setTimeout(() => { overlay.remove(); resolve(result); }, 200);
    };

    overlay.querySelectorAll('.slayer-player-btn').forEach(btn => {
      btn.style.cssText = 'padding:8px 6px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:6px;color:#e0e0e0;cursor:pointer;font-size:13px;font-family:inherit;transition:all 0.15s;';
      btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(231,76,60,0.3)'; btn.style.borderColor = 'rgba(231,76,60,0.6)'; });
      btn.addEventListener('mouseleave', () => {
        if (!btn.classList.contains('psel')) {
          btn.style.background = 'rgba(255,255,255,0.08)';
          btn.style.borderColor = 'rgba(255,255,255,0.15)';
        }
      });
      btn.addEventListener('click', () => { close(btn.dataset.pid); });
    });

    overlay.querySelector('.confirm-cancel').addEventListener('click', () => close(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });

    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } };
    document.addEventListener('keydown', onKey);

    requestAnimationFrame(() => overlay.classList.add('confirm-show'));
  });
}

function showAbilityUsed(data) {
  let msg = '';
  if (data.abilityName === 'slayer') {
    if (data.result.killed) {
      msg = `${data.fromName} 使用杀手技能击杀了恶魔！`;
    } else {
      msg = `${data.fromName} 使用杀手技能，但无事发生。`;
    }
  } else if (data.abilityName === 'gossip') {
    msg = `${data.fromName} 发表了公开声明`;
  }
  if (msg) showToast(msg);
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
let aiChatHistory = [];      // AI 对话历史（用于上下文）
let aiPendingMessages = {};   // 正在接收的 AI 消息 { id: { content, playerName } }
let isAiThinking = false;     // AI 正在响应中
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

  // 检测 AI 小助手触发：@小染 / @AI / @ai
  const aiMatch = content.match(/^@(?:小染|AI|ai)\s+(.+)/);
  if (aiMatch && currentChatChannel === 'public') {
    const aiMessage = aiMatch[1].trim();
    if (!aiMessage) return;
    if (isAiThinking) {
      showToast('小染正在回复中，请稍候...');
      return;
    }

    // 先显示用户的消息（带 @小染 前缀）
    const userMsg = {
      id: Date.now() + Math.random(),
      fromId: myId,
      fromName: myName || '我',
      fromSeat: (currentState && currentState.mySeat !== undefined) ? currentState.mySeat : -1,
      isDead: false,
      content: content,
      channel: 'public',
      timestamp: Date.now()
    };
    chatMessages.push(userMsg);
    renderChatMessages();

    // 记录到 AI 历史
    aiChatHistory.push({ role: 'user', content: aiMessage });
    aiChatHistory = aiChatHistory.slice(-20);

    // 发送给后端
    socket.emit('ai:chat', {
      message: aiMessage,
      history: aiChatHistory.filter(h => h.role === 'user' || h.role === 'assistant')
    });

    input.value = '';
    return;
  }

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

// 插入 @小染 触发前缀
function insertAiTrigger() {
  const input = $('chatInput');
  const current = input.value.trim();
  if (current.startsWith('@小染') || current.startsWith('@AI') || current.startsWith('@ai')) {
    input.focus();
    return;
  }
  input.value = '@小染 ' + current;
  input.focus();
  // 光标移到末尾
  input.setSelectionRange(input.value.length, input.value.length);
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
    // AI 消息特殊渲染
    if (msg.isAi) {
      return `<div class="chat-msg ai-msg">
        <span class="msg-sender ai-sender">🤖 小染 AI:</span>
        <span class="ai-content">${escapeHtml(msg.content)}</span>
      </div>`;
    }

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

  // 渲染正在接收的 AI 流式消息
  if (currentChatChannel === 'public') {
    const pendingHtml = Object.values(aiPendingMessages).map(p => {
      const displayContent = p.content || '思考中...';
      const cursor = p.content ? '' : '<span class="ai-thinking-dots">●●●</span>';
      return `<div class="chat-msg ai-msg ai-msg-pending">
        <span class="msg-sender ai-sender">🤖 小染 AI:</span>
        <span class="ai-content">${escapeHtml(displayContent)}${cursor}</span>
      </div>`;
    }).join('');
    container.innerHTML += pendingHtml;
  }

  // 自动滚动到底部
  container.scrollTop = container.scrollHeight;

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
    'LOBBY': '大厅', 'FIRST_NIGHT': '首夜', 'NIGHT_WAKE': '夜晚唤醒',
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

  // 夜晚队列调试信息（判断流程卡住用）
  if (gs.nightQueue && gs.nightQueue.length > 0) {
    const queue = gs.nightQueue;
    const idx = gs.currentNightIndex ?? -1;
    let debugHtml = '<div style="margin-top:12px; padding:10px; background:rgba(231,76,60,0.08); border:1px solid rgba(231,76,60,0.25); border-radius:6px;">';
    debugHtml += `<div style="color:#e74c3c; font-weight:bold; margin-bottom:6px;">🔍 夜晚流程调试</div>`;
    debugHtml += `<div><strong>队列进度：</strong>${idx >= 0 ? idx + 1 : 0} / ${queue.length} （索引：${idx}）</div>`;
    if (idx >= 0 && idx < queue.length) {
      const current = queue[idx];
      const cp = players.find(p => p.id === current.playerId);
      debugHtml += `<div style="color:#f39c12; margin-top:4px;"><strong>当前等待：</strong>${current.roleId}${current.isDrunk?'(酒鬼假身份)':''}${current.isFakeDemon?'(假恶魔)':''} → ${cp?cp.seat+1+'号 '+cp.name:'未知玩家'}</div>`;
      if (cp && cp.isBot !== undefined) {
        debugHtml += `<div style="color:#aaa; font-size:0.9em;">玩家状态：${cp.isAlive?'存活':'💀死亡'} | ${cp.isBot?'🤖机器人':'👤真人'} | ${cp.isConnected?'✅在线':'❌断线'}</div>`;
      }
    } else if (idx >= queue.length) {
      debugHtml += `<div style="color:#2ecc71; margin-top:4px;"><strong>状态：</strong>夜晚队列已全部执行完毕，等待进入天亮/结算</div>`;
    }
    if (gs.pendingRavenkeeper) {
      const rp = players.find(p => p.id === gs.pendingRavenkeeper);
      debugHtml += `<div style="color:#9b59b6; margin-top:4px;"><strong>待处理守鸦人：</strong>${rp?rp.seat+1+'号 '+rp.name:gs.pendingRavenkeeper}</div>`;
    }
    // 完整队列列表
    debugHtml += `<div style="margin-top:8px;"><strong>完整队列：</strong><div style="margin-top:4px; font-size:0.9em; max-height:180px; overflow-y:auto; padding:6px; background:rgba(0,0,0,0.2); border-radius:4px;">`;
    queue.forEach((item, i) => {
      const p = players.find(pp => pp.id === item.playerId);
      const doneTag = i < idx ? '✅ ' : (i === idx ? '👉 ' : '⏳ ');
      const statusColor = i < idx ? 'color:#888;' : (i === idx ? 'color:#f1c40f; font-weight:bold;' : '');
      const extraTags = [];
      if (item.isDrunk) extraTags.push('酒鬼');
      if (item.isFakeDemon) extraTags.push('假恶魔');
      const extra = extraTags.length > 0 ? ` <span style="color:#e67e22;">(${extraTags.join('/')})</span>` : '';
      debugHtml += `<div style="${statusColor} line-height:1.6;">${doneTag}[${i}] ${item.roleId}${extra} → ${p?p.seat+1+'号 '+p.name:'?'}</div>`;
    });
    debugHtml += `</div></div></div>`;
    $('godStatus').innerHTML += debugHtml;
  }

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
    const hist = p.privateInfoHistory && p.privateInfoHistory.length > 0 ? p.privateInfoHistory : (p.privateInfo ? [p.privateInfo] : []);
    if (hist.length > 0) {
      const latest = hist[hist.length - 1];
      const falseStyle = latest.isFalse ? 'color:#e74c3c;' : 'color:#f0d78c;';
      infoCell = `<span style="${falseStyle} font-size:12px;" title="${escapeHtml(latest.message)}">${escapeHtml(latest.message).substring(0, 30)}${latest.message.length > 30 ? '...' : ''}</span>
        <span style="color:#888; font-size:11px;">(${hist.length}条)</span>`;
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
  const infoHist = p.privateInfoHistory && p.privateInfoHistory.length > 0 ? p.privateInfoHistory : (p.privateInfo ? [p.privateInfo] : []);
  if (infoHist.length > 0) {
    // 按天分组
    const byDay = {};
    infoHist.forEach(info => {
      const d = info.day !== undefined ? info.day : 0;
      if (!byDay[d]) byDay[d] = [];
      byDay[d].push(info);
    });
    const days = Object.keys(byDay).map(Number).sort((a,b) => a - b);
    let dayHtml = '';
    days.forEach(day => {
      const dayLabel = day === 0 ? '第一夜' : `第${day}夜`;
      dayHtml += `<div style="margin-bottom:3px;"><span style="color:#d4af37; font-size:11px; opacity:0.7;">${dayLabel}</span></div>`;
      byDay[day].forEach(info => {
        const falseMark = info.isFalse 
          ? '<span style="color:#e74c3c; font-weight:bold; font-size:11px;"> ⚠️假</span>' 
          : '<span style="color:#2ecc71; font-size:11px;"> ✓</span>';
        dayHtml += `<div style="font-size:11.5px; line-height:1.4; color:${info.isFalse ? '#e74c3c' : '#f0d78c'}; margin-left:10px; margin-bottom:2px;">· ${escapeHtml(info.message)}${falseMark}</div>`;
      });
    });
    infoHtml = `<div style="margin-left:20px; margin-top:3px; padding:6px 8px; background:rgba(0,0,0,0.2); border-radius:3px;">
      <div style="color:#d4af37; font-size:11px; margin-bottom:3px;">💬 信息（${infoHist.length}条）</div>
      ${dayHtml}
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

function formatProbInfo(pi) {
  if (!pi) return '';
  const probPct = (pi.probability * 100).toFixed(1);
  const threshPct = (pi.threshold * 100).toFixed(1);
  
  let resultText, resultColor;
  if (pi.type === 'red_herring' || pi.type === 'balance_favor') {
    resultText = pi.result ? '✅ 偏袒生效' : '❌ 偏袒未触发';
  } else if (pi.description && pi.description.includes('中毒正确信息')) {
    resultText = pi.result ? '✅ 给了正确信息' : '❌ 给了假信息';
  } else if (pi.type === 'mayor_save') {
    resultText = pi.result ? '✅ 替死成功' : '❌ 替死失败';
  } else {
    resultText = pi.result ? '✅ 命中' : '❌ 未命中';
  }
  resultColor = pi.result ? '#2ecc71' : '#e74c3c';
  
  let scenarioText = '';
  if (pi.scenario === 'good_weak') scenarioText = '好人弱势（帮好人）';
  else if (pi.scenario === 'evil_weak') scenarioText = '邪恶弱势（帮邪恶）';
  else if (pi.scenario === 'balanced') scenarioText = '局势均衡';
  else if (pi.scenario === 'disabled') scenarioText = '已禁用';
  else if (pi.scenario === 'good_weak_favor_minion') scenarioText = '好人弱势（帮好人）→ 红鲱鱼选爪牙';
  else if (pi.scenario === 'evil_weak_favor_good') scenarioText = '邪恶弱势（帮邪恶）→ 红鲱鱼选强好人';
  else if (pi.scenario === 'random') scenarioText = '纯随机';
  else if (pi.scenario && pi.scenario.endsWith('_fallback')) scenarioText = '偏袒未触发 → 回退随机';
  else scenarioText = pi.scenario || '未知';
  
  let extraInfo = '';
  if (pi.baseProbability !== undefined) {
    extraInfo += `<div>基础概率：<span style="color:#f0d78c;">${(pi.baseProbability * 100).toFixed(1)}%</span></div>`;
  }
  if (pi.goodWeakThreshold !== undefined) {
    extraInfo += `<div>好人弱势阈值：${(pi.goodWeakThreshold * 100).toFixed(0)}%</div>`;
  }
  if (pi.evilWeakThreshold !== undefined) {
    extraInfo += `<div>邪恶弱势阈值：${(pi.evilWeakThreshold * 100).toFixed(0)}%</div>`;
  }
  if (pi.selectedName) {
    extraInfo += `<div>选中玩家：${pi.selectedName}</div>`;
  }
  
  return `<div style="margin-left:20px; margin-top:4px; padding:6px 10px; background:rgba(0,0,0,0.25); border-radius:4px; border-left:2px solid #d4af37; font-size:12px; color:#ccc; line-height:1.6;">
    <div><span style="color:#d4af37;">📊 ${pi.description || '概率事件'}</span></div>
    <div>局势：${scenarioText}（平衡分：${pi.balanceScore !== undefined ? pi.balanceScore.toFixed(3) : 'N/A'}）</div>
    <div>概率：<span style="color:#f0d78c; font-weight:bold;">${probPct}%</span>（阈值：${threshPct}%）</div>
    ${extraInfo}
    <div>结果：<span style="color:${resultColor}; font-weight:bold;">${resultText}</span></div>
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
    'ABILITY': '#e67e22',
    'CUSTOM_ASSIGN': '#d4af37'
  };
  const color = typeColors[entry.type] || '#aaa';
  let msg = entry.message;
  if (entry.type === 'PRIVATE_INFO' && entry.data && entry.data.isFalse) {
    msg = `<span style="color:#e74c3c;">⚠️【假信息】</span> ${escapeHtml(entry.message)}`;
  } else {
    msg = escapeHtml(msg);
  }

  let probHtml = '';
  if (entry.data) {
    const probInfos = [];
    if (entry.data.probInfo) probInfos.push(entry.data.probInfo);
    if (entry.data.correctProbInfo) probInfos.push(entry.data.correctProbInfo);
    probHtml = probInfos.map(pi => formatProbInfo(pi)).join('');
  }

  const div = document.createElement('div');
  div.style.cssText = `color:${color}; padding:2px 0; line-height:1.5;`;
  div.innerHTML = `<span style="color:#666;">[${entry.time}]</span> ${msg}${probHtml}`;
  logContainer.appendChild(div);
}

// ========== 角色总览 ==========
const ALL_ROLE_INFO = [
  // TB 村民
  { id: 'washerwoman', name: '洗衣妇', team: 'GOOD', category: '村民', script: 'tb',
    ability: '首个夜晚，你得知两名玩家以及其中一名玩家的村民角色。',
    color: '#2ecc71' },
  { id: 'librarian', name: '图书管理员', team: 'GOOD', category: '村民', script: 'tb',
    ability: '首个夜晚，你得知两名玩家以及其中一名玩家的外来者角色（若无外来者则获知此信息）。',
    color: '#2ecc71' },
  { id: 'investigator', name: '调查员', team: 'GOOD', category: '村民', script: 'tb',
    ability: '首个夜晚，你得知两名玩家以及其中一名玩家的爪牙角色。',
    color: '#2ecc71' },
  { id: 'chef', name: '厨师', team: 'GOOD', category: '村民', script: 'tb',
    ability: '首个夜晚，你得知邪恶玩家相邻的对数。',
    color: '#2ecc71' },
  { id: 'empath', name: '共情者', team: 'GOOD', category: '村民', script: 'tb',
    ability: '每个夜晚，你得知你的左右存活邻居中有多少名邪恶玩家。',
    color: '#2ecc71' },
  { id: 'fortuneteller', name: '占卜师', team: 'GOOD', category: '村民', script: 'tb',
    ability: '每个夜晚，选择两名玩家：你得知他们之中是否有恶魔。有一名善良玩家会被你当作恶魔（红鲱鱼）。',
    color: '#2ecc71' },
  { id: 'monk', name: '僧侣', team: 'GOOD', category: '村民', script: 'tb',
    ability: '每个夜晚（首个夜晚除外），选择除你以外的一名玩家：该玩家今晚不会被恶魔杀害。',
    color: '#2ecc71' },
  { id: 'ravenkeeper', name: '守鸦人', team: 'GOOD', category: '村民', script: 'tb',
    ability: '如果你在夜晚死亡，你被唤醒并选择一名玩家：你得知他的角色。',
    color: '#2ecc71' },
  { id: 'virgin', name: '圣女', team: 'GOOD', category: '村民', script: 'tb',
    ability: '如果你首次被提名，提名你的玩家若是村民则立即死亡。',
    color: '#2ecc71' },
  { id: 'slayer', name: '杀手', team: 'GOOD', category: '村民', script: 'tb',
    ability: '每局限一次，白天时可以公开选择一名玩家，如果是恶魔则恶魔死亡。',
    color: '#2ecc71' },
  { id: 'soldier', name: '士兵', team: 'GOOD', category: '村民', script: 'tb',
    ability: '你不会被恶魔杀害。',
    color: '#2ecc71' },
  { id: 'mayor', name: '市长', team: 'GOOD', category: '村民', script: 'tb',
    ability: '如果只剩三名玩家存活且你未被处决，你的阵营获胜。如果你在夜晚死亡，可能有其他玩家替你死去。',
    color: '#2ecc71' },
  { id: 'undertaker', name: '掘墓人', team: 'GOOD', category: '村民', script: 'tb',
    ability: '每个夜晚（首个夜晚除外），你得知今天白天被处决玩家的角色。',
    color: '#2ecc71' },
  // TB 外来者
  { id: 'saint', name: '圣徒', team: 'GOOD', category: '外来者', script: 'tb',
    ability: '如果你被处决，邪恶阵营获胜。',
    color: '#f39c12' },
  { id: 'butler', name: '管家', team: 'GOOD', category: '外来者', script: 'tb',
    ability: '每个夜晚，选择一名玩家（非自己）：明天你只能在该玩家投赞成票时投赞成票。',
    color: '#f39c12' },
  { id: 'drunk', name: '酒鬼', team: 'GOOD', category: '外来者', script: 'tb',
    ability: '你不知道自己是酒鬼。你以为自己是一个村民角色，但实际上你没有技能，你的信息是不可靠的。',
    color: '#f39c12' },
  { id: 'recluse', name: '隐士', team: 'GOOD', category: '外来者', script: 'tb',
    ability: '你可能被登记为邪恶阵营、爪牙或恶魔。你可能在夜晚死亡，即使没人想杀你。',
    color: '#f39c12' },
  // TB 爪牙
  { id: 'poisoner', name: '下毒者', team: 'EVIL', category: '爪牙', script: 'tb',
    ability: '每个夜晚，选择一名玩家：该玩家今晚和明天中毒，技能异常或失效。',
    color: '#e74c3c' },
  { id: 'scarletwoman', name: '红唇女郎', team: 'EVIL', category: '爪牙', script: 'tb',
    ability: '如果恶魔死亡时存活玩家数≥5，你成为新恶魔。',
    color: '#e74c3c' },
  { id: 'baron', name: '男爵', team: 'EVIL', category: '爪牙', script: 'tb',
    ability: '有两名额外的外来者在场（因此少两名村民）。',
    color: '#e74c3c' },
  { id: 'spy', name: '间谍', team: 'EVIL', category: '爪牙', script: 'tb',
    ability: '每个夜晚，你查看恶魔魔典（得知所有玩家身份）。你可能被登记为善良阵营、村民或外来者。',
    color: '#e74c3c' },
  // TB 恶魔
  { id: 'imp', name: '小恶魔', team: 'EVIL', category: '恶魔', script: 'tb',
    ability: '每个夜晚（除首夜），选择一名玩家将其杀害。首夜得知爪牙和3个不在场身份。',
    color: '#e74c3c' },
  // BMR 村民
  { id: 'grandmother', name: '祖母', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '首夜得知一名善良玩家及其角色（作为你的"孙子"）；若孙子被恶魔杀死，你也会死亡。',
    color: '#2ecc71' },
  { id: 'sailor', name: '水手', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '每个夜晚，选择一名存活玩家，你或该玩家醉酒直到下一个黄昏；水手不会死亡。',
    color: '#2ecc71' },
  { id: 'maid', name: '侍女', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '每个夜晚，选择除自己外的两名存活玩家，得知他们中有几人在当晚因自身能力被唤醒。',
    color: '#2ecc71' },
  { id: 'exorcist', name: '驱魔人', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '每个夜晚，选择一名玩家（不能与上夜相同），若选中恶魔：恶魔得知驱魔人是谁，该恶魔能力失效。',
    color: '#2ecc71' },
  { id: 'innkeeper', name: '旅店老板', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '第二夜起，选择两名玩家，他们当晚不会死亡，但其中一人会醉酒到下一个黄昏。',
    color: '#2ecc71' },
  { id: 'gambler', name: '赌徒', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '第二夜起，选择一名玩家并猜测其角色，猜错则赌徒死亡。',
    color: '#2ecc71' },
  { id: 'gossip', name: '造谣者', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '每个白天可公开发表一个声明，若声明为真，当晚一名玩家死亡。',
    color: '#2ecc71' },
  { id: 'courtier', name: '侍臣', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '每局游戏限一次在夜晚时，选择一个角色：如果该角色在场，该角色之一从当晚开始醉酒三天三夜。',
    color: '#2ecc71' },
  { id: 'professor', name: '教授', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '选择一名死亡玩家，若该玩家是镇民则复活（一次性能力）。',
    color: '#2ecc71' },
  { id: 'bard', name: '吟游诗人', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '当一名爪牙死于处决时，除了你以外的所有其他玩家醉酒直到明天黄昏。',
    color: '#2ecc71' },
  { id: 'tealady', name: '茶艺师', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '如果与你邻近的两名存活的玩家是善良的，他们不会死亡。',
    color: '#2ecc71' },
  { id: 'pacifist', name: '和平主义者', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '被处决的善良玩家可能不会死亡。',
    color: '#2ecc71' },
  { id: 'fool', name: '弄臣', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '当你首次将要死亡时，你不会死亡。',
    color: '#2ecc71' },
  // BMR 外来者
  { id: 'tinker', name: '修补匠', team: 'GOOD', category: '外来者', script: 'bmr',
    ability: '可能会在夜晚死亡（由说书人决定）。',
    color: '#f39c12' },
  { id: 'moonchild', name: '月之子', team: 'GOOD', category: '外来者', script: 'bmr',
    ability: '当你得知你死亡时，你要公开选择一名存活的玩家。如果他是善良的，在当晚他会死亡。',
    color: '#f39c12' },
  { id: 'lunatic', name: '莽夫', team: 'GOOD', category: '外来者', script: 'bmr',
    ability: '每个夜晚，首个使用其自身能力选择了你的玩家会醉酒直到下个黄昏。你会转变为他的阵营。',
    color: '#f39c12' },
  { id: 'madman', name: '疯子', team: 'GOOD', category: '外来者', script: 'bmr',
    ability: '你以为你是一个恶魔，但其实你不是。恶魔知道你是疯子以及你在每个夜晚选择了哪些玩家。',
    color: '#f39c12' },
  // BMR 爪牙
  { id: 'godfather', name: '教父', team: 'EVIL', category: '爪牙', script: 'bmr',
    ability: '在你的首个夜晚，你会得知有哪些外来者角色在场。如果有外来者在白天死亡，你会在当晚被唤醒并且你要选择一名玩家：他死亡。在场时人数配置会变动外来者+1或-1。',
    color: '#e74c3c' },
  { id: 'devilsadvocate', name: '魔鬼代言人', team: 'EVIL', category: '爪牙', script: 'bmr',
    ability: '每个夜晚，选择一名存活玩家（与上个夜晚不同）：如果该玩家明天白天被处决则不会死。',
    color: '#e74c3c' },
  { id: 'assassin', name: '刺客', team: 'EVIL', category: '爪牙', script: 'bmr',
    ability: '在夜晚时，选择一名玩家杀死（一次性能力），无论什么情况选择的玩家都会死亡。',
    color: '#e74c3c' },
  { id: 'mastermind', name: '主谋', team: 'EVIL', category: '爪牙', script: 'bmr',
    ability: '如果恶魔因为死于处决而因此导致游戏结束时，再额外进行一个夜晚和一个白天。在那个白天如果有玩家被处决，他的阵营落败。',
    color: '#e74c3c' },
  // BMR 恶魔
  { id: 'zombuul', name: '僵怖', team: 'EVIL', category: '恶魔', script: 'bmr',
    ability: '每个夜晚，若白天无人死亡，选择一名玩家杀死。当你首次死亡后，你仍存活，但是会被当作死亡。',
    color: '#c0392b' },
  { id: 'pukka', name: '普卡', team: 'EVIL', category: '恶魔', script: 'bmr',
    ability: '每个夜晚，选择一名玩家中毒，上一夜被毒的玩家在当晚死亡并恢复健康。',
    color: '#c0392b' },
  { id: 'shabaloth', name: '沙巴洛斯', team: 'EVIL', category: '恶魔', script: 'bmr',
    ability: '每个夜晚，选择两名玩家杀死；你上个夜晚选择过且当前死亡的玩家之一可能会被你反刍（复活）。',
    color: '#c0392b' },
  { id: 'po', name: '珀', team: 'EVIL', category: '恶魔', script: 'bmr',
    ability: '每个夜晚，你可以选择一名玩家：他死亡。如果你上次选择时没有选择任何玩家，当晚你要选择三名玩家：他们死亡。',
    color: '#c0392b' }
];

// 剧本信息映射（用于卡片显示和角色总览标题）
const SCRIPT_INFO = {
  tb: { id: 'tb', name: '灾祸之酿', nameEn: 'Trouble Brewing', icon: '🍺', color: '#d4af37',
        desc: '新手友好，推荐入门' },
  bmr: { id: 'bmr', name: '黯月初升', nameEn: 'Bad Moon Rising', icon: '🌑', color: '#9b59b6',
         desc: '进阶剧本，更多恶魔' }
};

function openRoleOverview() {
  const panel = document.getElementById('roleOverviewPanel');
  if (!panel) return;
  panel.style.display = 'block';

  // 根据当前剧本过滤角色
  const scriptId = (currentState && currentState.script) || 'tb';
  const info = SCRIPT_INFO[scriptId] || { icon: '📜', name: '角色总览', nameEn: '', color: '#3498db' };
  const rolesForScript = ALL_ROLE_INFO.filter(r => r.script === scriptId);

  // 更新标题
  const titleEl = document.getElementById('roleOverviewTitle');
  if (titleEl) {
    titleEl.innerHTML = `<span style="font-size:1.1em;">${info.icon}</span> ${info.name} <span style="font-size:0.75em; color:#888; font-weight:normal;">${info.nameEn}</span>`;
    titleEl.style.color = info.color;
  }

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
    const roles = rolesForScript.filter(r => r.category === cat);
    if (roles.length === 0) {
      container.innerHTML = '<div style="color:#666; font-size:12px; padding:8px; text-align:center;">本剧本无此类角色</div>';
      continue;
    }
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
  // TB 村民
  washerwoman: 'townsfolk', librarian: 'townsfolk', investigator: 'townsfolk', chef: 'townsfolk',
  empath: 'townsfolk', fortuneteller: 'townsfolk', monk: 'townsfolk', ravenkeeper: 'townsfolk',
  virgin: 'townsfolk', slayer: 'townsfolk', soldier: 'townsfolk', mayor: 'townsfolk',
  undertaker: 'townsfolk',
  // TB 外来者
  saint: 'outsider', butler: 'outsider', drunk: 'outsider', recluse: 'outsider',
  // TB 爪牙
  poisoner: 'minion', scarletwoman: 'minion', baron: 'minion', spy: 'minion',
  // TB 恶魔
  imp: 'demon',
  // BMR 村民
  grandmother: 'townsfolk', sailor: 'townsfolk', maid: 'townsfolk', exorcist: 'townsfolk',
  innkeeper: 'townsfolk', gambler: 'townsfolk', gossip: 'townsfolk', courtier: 'townsfolk',
  professor: 'townsfolk', bard: 'townsfolk', tealady: 'townsfolk', pacifist: 'townsfolk',
  fool: 'townsfolk',
  // BMR 外来者
  tinker: 'outsider', moonchild: 'outsider', lunatic: 'outsider', madman: 'outsider',
  // BMR 爪牙
  godfather: 'minion', devilsadvocate: 'minion', assassin: 'minion', mastermind: 'minion',
  // BMR 恶魔
  zombuul: 'demon', pukka: 'demon', shabaloth: 'demon', po: 'demon'
};

// 角色所属剧本映射（用于按剧本过滤角色选项）
const ROLE_SCRIPT_MAP = {
  // TB
  washerwoman: 'tb', librarian: 'tb', investigator: 'tb', chef: 'tb', empath: 'tb',
  fortuneteller: 'tb', monk: 'tb', ravenkeeper: 'tb', virgin: 'tb', slayer: 'tb',
  soldier: 'tb', mayor: 'tb', undertaker: 'tb', saint: 'tb', butler: 'tb', drunk: 'tb',
  recluse: 'tb', poisoner: 'tb', scarletwoman: 'tb', baron: 'tb', spy: 'tb', imp: 'tb',
  // BMR
  grandmother: 'bmr', sailor: 'bmr', maid: 'bmr', exorcist: 'bmr', innkeeper: 'bmr',
  gambler: 'bmr', gossip: 'bmr', courtier: 'bmr', professor: 'bmr', bard: 'bmr',
  tealady: 'bmr', pacifist: 'bmr', fool: 'bmr', tinker: 'bmr', moonchild: 'bmr',
  lunatic: 'bmr', madman: 'bmr', godfather: 'bmr', devilsadvocate: 'bmr', assassin: 'bmr',
  mastermind: 'bmr', zombuul: 'bmr', pukka: 'bmr', shabaloth: 'bmr', po: 'bmr'
};

// 人数配置表：[玩家数, 村民, 外来者, 爪牙, 恶魔]
const ROLE_COMPOSITION_TABLE = [
  [5, 3, 0, 1, 1], [6, 3, 1, 1, 1], [7, 5, 0, 1, 1], [8, 5, 1, 1, 1],
  [9, 5, 2, 1, 1], [10, 7, 0, 2, 1], [11, 7, 1, 2, 1], [12, 7, 2, 2, 1],
  [13, 9, 0, 3, 1], [14, 9, 1, 3, 1], [15, 9, 2, 3, 1]
];

function getComp(playerCount, hasSetupChar, scriptId) {
  const entry = ROLE_COMPOSITION_TABLE.find(c => c[0] === playerCount);
  if (!entry) return { townsfolk: 3, outsider: 0, minion: 1, demon: 1 };
  let t = entry[1], o = entry[2];
  const setupType = (scriptId === 'bmr') ? 'godfather' : 'baron';
  if (hasSetupChar) {
    if (setupType === 'baron') {
      t -= 2; o += 2;
    } else if (setupType === 'godfather') {
      // 教父：外来者±1（服务端随机），前端使用基准值显示
      // 验证时单独允许 ±1 的容差
    }
  }
  return { townsfolk: t, outsider: o, minion: entry[3], demon: entry[4], setupType };
}

// 验证自定义角色配置，返回 { valid: boolean, errors: string[], comp: object, counts: object }
function validateCustomRoles(customRoleMap, playerCount, scriptId) {
  const script = scriptId || 'tb';
  const setupCharId = (script === 'bmr') ? 'godfather' : 'baron';
  const setupCharName = (script === 'bmr') ? '教父' : '男爵';
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

  // 2. 确定是否有 setup 角色（TB:男爵 / BMR:教父）
  const hasSetupChar = assigned.includes(setupCharId);
  const comp = getComp(playerCount, hasSetupChar, script);

  // 3. 按类别统计已指定角色
  const counts = { townsfolk: 0, outsider: 0, minion: 0, demon: 0 };
  assigned.forEach(r => {
    const cat = ROLE_CATEGORY[r];
    if (cat) counts[cat]++;
  });

  // 4. 检查各类别是否超限
  // 对于教父，允许 ±1 容差（实际由服务端随机决定）
  const outsiderTolerance = (hasSetupChar && comp.setupType === 'godfather') ? 1 : 0;
  const maxOutsider = comp.outsider + outsiderTolerance;
  const maxTownsfolk = comp.townsfolk + outsiderTolerance;

  if (counts.demon > comp.demon) {
    errors.push(`恶魔最多 ${comp.demon} 名，已指定 ${counts.demon} 名`);
  }
  if (counts.minion > comp.minion) {
    errors.push(`爪牙最多 ${comp.minion} 名${hasSetupChar ? '' : `（不含${setupCharName}）`}，已指定 ${counts.minion} 名`);
  }
  if (counts.outsider > maxOutsider) {
    errors.push(`外来者最多 ${maxOutsider} 名${hasSetupChar ? `（含${setupCharName}${comp.setupType === 'godfather' ? '±1' : '加成'}）` : ''}，已指定 ${counts.outsider} 名`);
  }
  if (counts.townsfolk > maxTownsfolk) {
    errors.push(`村民最多 ${maxTownsfolk} 名${hasSetupChar ? `（${setupCharName}${comp.setupType === 'godfather' ? '±1' : '-2'}）` : ''}，已指定 ${counts.townsfolk} 名`);
  }

  // 5. 检查剩余空位是否足够填充必选角色
  const remaining = playerCount - assigned.length;
  const needDemon = Math.max(0, comp.demon - counts.demon);
  const needMinion = Math.max(0, comp.minion - counts.minion);
  const needOutsider = Math.max(0, maxOutsider - counts.outsider);
  const needTownsfolk = Math.max(0, maxTownsfolk - counts.townsfolk);
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
    hasSetupChar,
    setupCharId,
    setupCharName
  };
}

const CUSTOM_ROLE_OPTIONS = [
  { id: '', name: '随机分配', color: '#888' },
  // TB 村民
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
  // TB 外来者
  { id: 'saint', name: '圣徒（外来者）', color: '#f39c12' },
  { id: 'butler', name: '管家（外来者）', color: '#f39c12' },
  { id: 'drunk', name: '酒鬼（外来者）', color: '#f39c12' },
  { id: 'recluse', name: '隐士（外来者）', color: '#f39c12' },
  // TB 爪牙
  { id: 'poisoner', name: '下毒者（爪牙）', color: '#e74c3c' },
  { id: 'scarletwoman', name: '红唇女郎（爪牙）', color: '#e74c3c' },
  { id: 'baron', name: '男爵（爪牙）', color: '#e74c3c' },
  { id: 'spy', name: '间谍（爪牙）', color: '#e74c3c' },
  // TB 恶魔
  { id: 'imp', name: '小恶魔（恶魔）', color: '#c0392b' },
  // BMR 村民
  { id: 'grandmother', name: '祖母（村民）', color: '#2ecc71' },
  { id: 'sailor', name: '水手（村民）', color: '#2ecc71' },
  { id: 'maid', name: '侍女（村民）', color: '#2ecc71' },
  { id: 'exorcist', name: '驱魔人（村民）', color: '#2ecc71' },
  { id: 'innkeeper', name: '旅店老板（村民）', color: '#2ecc71' },
  { id: 'gambler', name: '赌徒（村民）', color: '#2ecc71' },
  { id: 'gossip', name: '造谣者（村民）', color: '#2ecc71' },
  { id: 'courtier', name: '侍臣（村民）', color: '#2ecc71' },
  { id: 'professor', name: '教授（村民）', color: '#2ecc71' },
  { id: 'bard', name: '吟游诗人（村民）', color: '#2ecc71' },
  { id: 'tealady', name: '茶艺师（村民）', color: '#2ecc71' },
  { id: 'pacifist', name: '和平主义者（村民）', color: '#2ecc71' },
  { id: 'fool', name: '弄臣（村民）', color: '#2ecc71' },
  // BMR 外来者
  { id: 'tinker', name: '修补匠（外来者）', color: '#f39c12' },
  { id: 'moonchild', name: '月之子（外来者）', color: '#f39c12' },
  { id: 'lunatic', name: '莽夫（外来者）', color: '#f39c12' },
  { id: 'madman', name: '疯子（外来者）', color: '#f39c12' },
  // BMR 爪牙
  { id: 'godfather', name: '教父（爪牙）', color: '#e74c3c' },
  { id: 'devilsadvocate', name: '魔鬼代言人（爪牙）', color: '#e74c3c' },
  { id: 'assassin', name: '刺客（爪牙）', color: '#e74c3c' },
  { id: 'mastermind', name: '主谋（爪牙）', color: '#e74c3c' },
  // BMR 恶魔
  { id: 'zombuul', name: '僵怖（恶魔）', color: '#c0392b' },
  { id: 'pukka', name: '普卡（恶魔）', color: '#c0392b' },
  { id: 'shabaloth', name: '沙巴洛斯（恶魔）', color: '#c0392b' },
  { id: 'po', name: '珀（恶魔）', color: '#c0392b' }
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
  const scriptId = currentState.script || 'tb';

  // 统计已选角色，标注重复
  const usedRoles = {};
  seated.forEach(p => {
    const r = customRoleMap[p.seat];
    if (r) usedRoles[r] = (usedRoles[r] || 0) + 1;
  });

  // 实时验证
  const v = validateCustomRoles(customRoleMap, playerCount, scriptId);

  // 按剧本过滤角色选项
  const filteredOptions = CUSTOM_ROLE_OPTIONS.filter(opt => !opt.id || ROLE_SCRIPT_MAP[opt.id] === scriptId);

  let html = '';
  seated.forEach(p => {
    const currentVal = customRoleMap[p.seat] || '';
    // 如果当前选中的角色不属于当前剧本，保留显示但标记
    const currentOpt = CUSTOM_ROLE_OPTIONS.find(o => o.id === currentVal);
    const isWrongScript = currentVal && currentOpt && ROLE_SCRIPT_MAP[currentVal] !== scriptId;
    const isDuplicate = currentVal && usedRoles[currentVal] > 1;
    const borderColor = isDuplicate ? '#e74c3c' : (currentVal ? (isWrongScript ? '#f39c12' : '#2ecc71') : 'rgba(255,255,255,0.1)');
    html += `<div style="display:flex; align-items:center; padding:8px 12px; margin-bottom:6px; background:rgba(0,0,0,0.3); border-radius:6px; border-left:3px solid ${borderColor};">
      <span style="width:50px; color:#d4af37; font-weight:bold;">${p.seat+1}号</span>
      <span style="flex:1; color:#fff; margin-right:10px;">${escapeHtml(p.name)}${p.isBot ? ' 🤖' : ''}</span>
      <select onchange="setCustomRole(${p.seat}, this.value)" style="background:#1a1a2e; color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:4px; padding:4px 8px; min-width:180px; font-size:13px;">
        ${filteredOptions.map(opt =>
          `<option value="${opt.id}" ${currentVal === opt.id ? 'selected' : ''} style="color:${opt.color};">${opt.name}</option>`
        ).join('')}
      </select>
    </div>`;
  });

  // 配置概览面板
  const setupTag = v.hasSetupChar ? ` <span style="color:#e74c3c;">(${v.setupCharName}在场${v.comp.setupType === 'godfather' ? ': 外来者±1' : ': 村民-2, 外来者+2'})</span>` : '';
  html += `<div style="margin-top:10px; padding:10px; background:rgba(52,73,94,0.4); border-radius:6px; font-size:12px;">
    <div style="color:#d4af37; font-weight:bold; margin-bottom:6px;">当前人数配置 (${playerCount}人)${setupTag}</div>
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
  const v = validateCustomRoles(customRoleMap, playerCount, currentState.script || 'tb');
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

// ========== 概率设置面板 ==========
let _probConfigDraft = null;
let _probConfigMeta = null;
let _probBackupAdvanced = null; // 切到标准模式前备份高级模式的配置
let _probMode = 'standard'; // 'standard' | 'advanced'
let _probShowAdvanced = false; // 已废弃（高级权重面板已移除），保留声明以兼容

// 偏袒强度映射（前端版，与后端 prob-config.js 中 applyFavorStrength 逻辑一致）
function applyFavorStrength(cfg, strength) {
  const s = Math.max(0, Math.min(1, strength));
  const b = cfg.balance;
  b.baseFavor = s;
  b.maxFavor = s;
  b.favorMultiplier = 0;
  b.mayorSaveBase = 0.5;
  b.mayorSaveBonus = 0.5 * s;
  b.mayorSavePenalty = 0.5 * s;
  b.goodWeakThreshold = -0.2;
  b.evilWeakThreshold = 0.3;
  b.favorStrength = s;
}

// 获取标准模式配置（前端版，与后端 getStandardProbConfig(scriptId) 一致）
function getStandardConfig(scriptId) {
  const script = scriptId || (currentState && currentState.script) || 'tb';
  const TB_FIXED = {
    recluse_evil: 0.5, recluse_minion: 0.5, recluse_demon: 0.5, recluse_outsider: 0.5,
    spy_good_chef: 0.5, spy_good_empath: 0.5, spy_not_minion: 0.5,
    spy_as_townsfolk: 0.5, spy_as_outsider: 0.5
  };
  const BMR_FIXED = {
    // 修补匠夜晚死亡概率、和平主义者拯救概率已由平衡系统自动控制，不再在此配置
    // 疯子/莽夫获得假恶魔身份为角色固有机制，已移除
    gossip_true_statement: 0.4
  };
  const BOT = { bot_nominate: 0.30, bot_evil_vote_yes: 0.7, bot_good_vote_yes: 0.5 };
  const scriptFixed = (script === 'bmr') ? BMR_FIXED : TB_FIXED;
  const cfg = {
    ...BOT,
    ...scriptFixed,
    balance: {
      baseFavor: 1.0, maxFavor: 1.0, favorMultiplier: 1.0,
      mayorSaveBase: 0.5, mayorSaveBonus: 0.5, mayorSavePenalty: 0.5,
      goodWeakThreshold: -0.2, evilWeakThreshold: 0.3,
      redHerringFavorMinion: true, redHerringFavorGood: true,
      favorStrength: 1.0
    },
    balanceWeights: {
      numbersAdvantage: 0.3, deadEvil: 0.2, deadGood: -0.15,
      keyRolesAlive: 0.15, demonSafety: 0.1
    }
  };
  applyFavorStrength(cfg, 1.0);
  return cfg;
}

// 按点路径取值
function _getCfgVal(cfg, keyPath) {
  const parts = keyPath.split('.');
  let v = cfg;
  for (const p of parts) {
    if (v == null) return undefined;
    v = v[p];
  }
  return v;
}

function _setCfgVal(cfg, keyPath, val) {
  const parts = keyPath.split('.');
  let obj = cfg;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!obj[parts[i]]) obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  obj[parts[parts.length - 1]] = val;
}

function openProbSettings() {
  if (!currentState || !currentState.isHost) {
    showToast('只有房主可以打开设置');
    return;
  }
  if (currentState.probConfig && currentState.probConfigMeta) {
    _probConfigDraft = JSON.parse(JSON.stringify(currentState.probConfig));
    _probConfigMeta = currentState.probConfigMeta;
    // 使用服务器保存的模式，默认标准
    const savedMode = currentState.probMode;
    _probMode = (savedMode === 'advanced') ? 'advanced' : 'standard';
    _updateModeButtons();
    _renderProbSettingsUI();
  } else {
    socket.emit('room:getProbConfig');
  }
  $('probSettingsPanel').style.display = 'block';
  const gameStarted = currentState && currentState.gameStarted;
  $('probSaveBtn').disabled = !!gameStarted;
  $('probResetBtn').disabled = !!gameStarted;
  $('probSaveBtn').style.opacity = gameStarted ? '0.5' : '1';
  $('probResetBtn').style.opacity = gameStarted ? '0.5' : '1';
}

function closeProbSettings() {
  $('probSettingsPanel').style.display = 'none';
}

// 应用标准模式预设
function _applyStandardPreset() {
  if (!_probConfigDraft) return;
  const std = getStandardConfig();
  // 深拷贝标准配置到draft
  Object.assign(_probConfigDraft, JSON.parse(JSON.stringify(std)));
}

function setProbMode(mode) {
  if (mode === _probMode) return;
  if (mode === 'standard') {
    // 切到标准模式：先备份当前高级配置
    _probBackupAdvanced = JSON.parse(JSON.stringify(_probConfigDraft));
    _applyStandardPreset();
  } else {
    // 切回高级模式：恢复备份，若无备份则用标准配置作为起点
    if (_probBackupAdvanced) {
      _probConfigDraft = JSON.parse(JSON.stringify(_probBackupAdvanced));
    } else {
      _probConfigDraft = getStandardConfig();
    }
  }
  _probMode = mode;
  _updateModeButtons();
  _renderProbSettingsUI();
}

// resetProbConfig 中的 _probShowAdvanced 重置已移除（高级权重面板不再显示）

function _updateModeButtons() {
  const btnS = $('probModeStandard');
  const btnA = $('probModeAdvanced');
  const desc = $('probModeDesc');
  if (_probMode === 'standard') {
    btnS.style.background = 'linear-gradient(135deg,#f39c12,#e67e22)';
    btnS.style.color = '#fff';
    btnS.style.fontWeight = 'bold';
    btnA.style.background = 'rgba(255,255,255,0.08)';
    btnA.style.color = '#ccc';
    btnA.style.fontWeight = 'normal';
    desc.innerHTML = '<b style="color:#f9e79f;">📊 标准模式（默认）：</b>角色技能干扰概率使用平衡预设值（部分为100%），偏袒系统<b>必帮弱方</b>，中毒/醉酒/酒鬼信息与BMR修补匠/和平主义者概率<b>由平衡系统自动处理</b>，适合快速开始游戏。';
  } else {
    btnS.style.background = 'rgba(255,255,255,0.08)';
    btnS.style.color = '#ccc';
    btnS.style.fontWeight = 'normal';
    btnA.style.background = 'linear-gradient(135deg,#3498db,#2980b9)';
    btnA.style.color = '#fff';
    btnA.style.fontWeight = 'bold';
    desc.innerHTML = '<b style="color:#85c1e9;">🔧 高级模式：</b>可自由调节固定概率与Bot行为。平衡偏袒系统<b>始终内置启用</b>（偏袒强度、权重、信息真伪判断均不可调），适合想自定义概率体验的玩家。';
  }
}

function renderProbSettings(config, meta, mode) {
  _probConfigDraft = JSON.parse(JSON.stringify(config));
  _probConfigMeta = meta;
  // 使用服务器保存的模式，默认标准
  _probMode = (mode === 'advanced') ? 'advanced' : 'standard';
  _updateModeButtons();
  _renderProbSettingsUI();
}

// 格式化概率显示
function _fmtProb(v) {
  if (v === 1) return '<b style="color:#2ecc71;">100%</b>';
  if (v === 0) return '<b style="color:#e74c3c;">0%</b>';
  return '<b style="color:#f9e79f;">' + Math.round(v * 100) + '%</b>';
}

// 格式化Bot行为概率（非0/50/100的固定值）
function _fmtBotProb(v) {
  return '<b style="color:#f9e79f;">' + Math.round(v * 100) + '%</b>';
}

function _renderProbSettingsUI() {
  const config = _probConfigDraft;
  const meta = _probConfigMeta;
  if (!config || !meta) return;
  const container = $('probSettingsContent');
  const isStandard = _probMode === 'standard';

  if (isStandard) {
    // ===== 标准模式UI：只读展示，显示实际概率值 =====
    let html = '';

    // 角色技能干扰概率
    html += `<div style="background:rgba(46,204,113,0.08); border:1px solid rgba(46,204,113,0.3); border-radius:8px; padding:15px; margin-bottom:12px;">
      <h3 style="color:#2ecc71; margin-bottom:10px; font-size:1.05em;">🎯 角色技能干扰概率（预设值）</h3>
      <p style="color:#888; font-size:12px; margin-bottom:10px;">隐士/间谍的干扰登记概率使用标准50%随机。</p>
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:6px;">`;
    meta.forEach(cat => {
      if (cat.category === '角色技能干扰概率') {
        cat.items.forEach(item => {
          const v = _getCfgVal(config, item.key);
          html += `<div style="color:#bbb; font-size:12px; padding:5px 10px; background:rgba(255,255,255,0.03); border-radius:4px;">
            <span style="color:#2ecc71;">●</span> ${item.label}：${_fmtProb(v)}
          </div>`;
        });
      }
    });
    html += `</div></div>`;

    // BMR 专属：修补匠/和平主义者概率（平衡系统自动处理）
    if ((currentState && currentState.script === 'bmr')) {
      html += `<div style="background:rgba(230,126,34,0.08); border:1px solid rgba(230,126,34,0.3); border-radius:8px; padding:15px; margin-bottom:12px;">
        <h3 style="color:#e67e22; margin-bottom:10px; font-size:1.05em;">🔧 修补匠 / 和平主义者（平衡系统自动处理）</h3>
        <div style="color:#ccc; font-size:13px; line-height:1.8; padding:8px 4px;">
          <div style="margin-bottom:4px;"><span style="color:#e67e22;">●</span> 修补匠夜晚死亡概率、和平主义者拯救善良被处决者概率<b style="color:#f9e79f;">由平衡系统自动决定</b></div>
          <div style="margin-bottom:4px;"><span style="color:#e67e22;">●</span> 概率随平衡分数自动调整：</div>
          <div style="padding-left:20px; color:#aaa; font-size:12px;">
            · 好人弱势时 → 修补匠<b style="color:#2ecc71;">降低死亡</b>，和平主义者<b style="color:#2ecc71;">提高拯救</b>（帮好人保人）<br>
            · 邪恶弱势时 → 修补匠<b style="color:#e74c3c;">提高死亡</b>，和平主义者<b style="color:#e74c3c;">降低拯救</b>（帮邪恶削减好人）<br>
            · 局势均衡时 → 使用基础概率
          </div>
        </div>
      </div>`;
    }

    // 酒鬼/中毒信息
    html += `<div style="background:rgba(230,126,34,0.08); border:1px solid rgba(230,126,34,0.3); border-radius:8px; padding:15px; margin-bottom:12px;">
      <h3 style="color:#e67e22; margin-bottom:10px; font-size:1.05em;">🍺 酒鬼 / 中毒信息（平衡系统自动处理）</h3>
      <div style="color:#ccc; font-size:13px; line-height:1.8; padding:8px 4px;">
        <div style="margin-bottom:4px;"><span style="color:#e67e22;">●</span> 中毒、醉酒、酒鬼玩家获得的信息真伪<b style="color:#f9e79f;">由平衡系统自动判断</b></div>
        <div style="margin-bottom:4px;"><span style="color:#e67e22;">●</span> 信息真伪与方向均由<b style="color:#f9e79f;">平衡偏袒系统自动决定</b>：</div>
        <div style="padding-left:20px; color:#aaa; font-size:12px;">
          · 好人弱势时 → <b style="color:#2ecc71;">可能获得真信息</b>（帮好人调查），假信息指向<b style="color:#e74c3c;">邪恶/恶魔</b><br>
          · 邪恶弱势时 → <b style="color:#e74c3c;">保持假信息</b>（误导好人），假信息指向<b style="color:#2ecc71;">善良/无恶魔</b><br>
          · 局势均衡时 → 假信息，方向随机
        </div>
      </div>
    </div>`;

    // Bot行为
    html += `<div style="background:rgba(52,152,219,0.08); border:1px solid rgba(52,152,219,0.3); border-radius:8px; padding:15px; margin-bottom:12px;">
      <h3 style="color:#3498db; margin-bottom:10px; font-size:1.05em;">🤖 Bot 行为（预设值）</h3>
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:6px;">`;
    meta.forEach(cat => {
      if (cat.category === 'Bot 行为') {
        cat.items.forEach(item => {
          const v = _getCfgVal(config, item.key);
          html += `<div style="color:#bbb; font-size:12px; padding:5px 10px; background:rgba(255,255,255,0.03); border-radius:4px;">
            <span style="color:#3498db;">●</span> ${item.label}：${_fmtBotProb(v)}
          </div>`;
        });
      }
    });
    html += `</div></div>`;

    // 平衡偏袒系统（全部内置启用，仅展示说明）
    html += `<div style="background:rgba(52,152,219,0.1); border:2px solid rgba(52,152,219,0.4); border-radius:8px; padding:15px; margin-bottom:12px;">
      <h3 style="color:#5dade2; margin-bottom:12px; font-size:1.1em;">⚖️ 平衡偏袒系统</h3>

      <div style="background:rgba(46,204,113,0.06); border:1px solid rgba(46,204,113,0.2); border-radius:6px; padding:10px; margin-bottom:12px;">
        <div style="color:#2ecc71; font-size:12px; line-height:1.6;">
          <b>✓ 内置启用（不可调节）：</b><br>
          · 偏袒强度 = 100%（必帮弱方）<br>
          · 中毒/醉酒信息真伪由平衡系统自动判断<br>
          · 干扰项偏向弱势方<br>
          · 平衡权重自动计算
        </div>
      </div>

      <div style="background:rgba(0,0,0,0.15); border-radius:6px; padding:12px; margin-top:12px;">
        <div style="color:#f9e79f; font-size:12px; font-weight:bold; margin-bottom:6px;">📐 平衡分数计算公式</div>
        <div style="color:#aaa; font-size:11px; line-height:1.7; font-family:monospace;">
          分数 = (存活好人 − 存活恶魔×2 − 存活爪牙×1.5) / 存活人数 × 0.90<br>
          &emsp;+ 已死邪恶 × 0.20 − 已死好人 × 0.15<br>
          &emsp;+ 关键角色存活奖励（信息位+0.1,僧侣+0.1,杀手+0.05）<br>
          <span style="color:#888;">→ 结果范围 [-1, 1]，负数=邪恶优势，正数=好人优势</span>
        </div>
        <div style="color:#f9e79f; font-size:12px; font-weight:bold; margin:8px 0 6px;">📊 偏袒判定（偏袒强度=100%）</div>
        <div style="color:#aaa; font-size:11px; line-height:1.7; font-family:monospace;">
          偏袒概率 = min(|分数| × 1.0 + 1.0, 1.0) = 100%<br>
          <span style="color:#888;">→ 好人弱势(分数&lt;-0.20)：必触发偏袒帮好人</span><br>
          <span style="color:#888;">→ 邪恶弱势(分数&gt;0.30)：必触发偏袒帮邪恶（误导好人）</span><br>
          <span style="color:#888;">→ 局势均衡(-0.20≤分数≤0.30)：50%概率偏向任一方向</span>
        </div>
      </div>
    </div>`;

    container.innerHTML = html;
    return;
  }

  // ===== 高级模式UI =====
  let html = '';

  // 角色技能干扰概率
  html += `<div style="background:rgba(255,255,255,0.05); border:1px solid rgba(52,152,219,0.2); border-radius:8px; padding:15px; margin-bottom:12px;">
    <h3 style="color:#5dade2; margin-bottom:12px; font-size:1.05em; border-bottom:1px solid rgba(52,152,219,0.2); padding-bottom:6px;">🎯 角色技能干扰概率</h3>`;
  meta.forEach(cat => {
    if (cat.category === '角色技能干扰概率') {
      cat.items.forEach(item => {
        const val = _getCfgVal(config, item.key);
        const v = (val !== undefined) ? val : item.default;
        html += `<div style="display:flex; align-items:center; margin-bottom:8px; gap:10px; flex-wrap:wrap;">
          <label style="color:#ddd; min-width:200px; flex:1; font-size:12px;">${item.label}</label>
          <input type="range" data-pkey="${item.key}" min="${item.min}" max="${item.max}" step="${item.step}" value="${v}"
            oninput="onProbSliderInput(this)" onchange="onProbChanged(this)"
            style="flex:2; min-width:150px; accent-color:#3498db;" />
          <span class="prob-val-label" data-pkey-label="${item.key}" style="color:#85c1e9; font-weight:bold; min-width:50px; text-align:right; font-size:12px;">${Math.round(v * 100)}%</span>
        </div>`;
      });
    }
  });
  html += `</div>`;

  // BMR 专属：修补匠/和平主义者概率（平衡系统自动处理）
  if ((currentState && currentState.script === 'bmr')) {
    html += `<div style="background:rgba(230,126,34,0.08); border:1px solid rgba(230,126,34,0.3); border-radius:8px; padding:15px; margin-bottom:12px;">
      <h3 style="color:#e67e22; margin-bottom:10px; font-size:1.05em;">🔧 修补匠 / 和平主义者（平衡系统自动处理）</h3>
      <div style="color:#ccc; font-size:13px; line-height:1.8; padding:8px 4px;">
        <div style="margin-bottom:4px;"><span style="color:#e67e22;">●</span> 修补匠夜晚死亡概率、和平主义者拯救善良被处决者概率<b style="color:#f9e79f;">由平衡系统自动决定</b></div>
        <div style="margin-bottom:4px;"><span style="color:#e67e22;">●</span> 概率随平衡分数自动调整：</div>
        <div style="padding-left:20px; color:#aaa; font-size:12px;">
          · 好人弱势时 → 修补匠<b style="color:#2ecc71;">降低死亡</b>，和平主义者<b style="color:#2ecc71;">提高拯救</b>（帮好人保人）<br>
          · 邪恶弱势时 → 修补匠<b style="color:#e74c3c;">提高死亡</b>，和平主义者<b style="color:#e74c3c;">降低拯救</b>（帮邪恶削减好人）<br>
          · 局势均衡时 → 使用基础概率
        </div>
      </div>
    </div>`;
  }

  // 酒鬼/中毒信息（说明，无滑块）
  html += `<div style="background:rgba(230,126,34,0.08); border:1px solid rgba(230,126,34,0.3); border-radius:8px; padding:15px; margin-bottom:12px;">
    <h3 style="color:#e67e22; margin-bottom:10px; font-size:1.05em;">🍺 酒鬼 / 中毒信息（平衡系统自动处理）</h3>
    <div style="color:#ccc; font-size:13px; line-height:1.8; padding:8px 4px;">
      <div style="margin-bottom:4px;"><span style="color:#e67e22;">●</span> 中毒、醉酒、酒鬼玩家获得的信息真伪<b style="color:#f9e79f;">由平衡系统自动判断</b></div>
      <div style="margin-bottom:4px;"><span style="color:#e67e22;">●</span> 信息真伪与方向均由<b style="color:#f9e79f;">平衡偏袒系统自动决定</b>：</div>
      <div style="padding-left:20px; color:#aaa; font-size:12px;">
        · 好人弱势时 → <b style="color:#2ecc71;">可能获得真信息</b>（帮好人调查），假信息指向<b style="color:#e74c3c;">邪恶/恶魔</b><br>
        · 邪恶弱势时 → <b style="color:#e74c3c;">保持假信息</b>（误导好人），假信息指向<b style="color:#2ecc71;">善良/无恶魔</b><br>
        · 局势均衡时 → 假信息，方向随机
      </div>
    </div>
  </div>`;

  // Bot行为
  html += `<div style="background:rgba(255,255,255,0.05); border:1px solid rgba(52,152,219,0.2); border-radius:8px; padding:15px; margin-bottom:12px;">
    <h3 style="color:#5dade2; margin-bottom:12px; font-size:1.05em; border-bottom:1px solid rgba(52,152,219,0.2); padding-bottom:6px;">🤖 Bot 行为</h3>`;
  meta.forEach(cat => {
    if (cat.category === 'Bot 行为') {
      cat.items.forEach(item => {
        const val = _getCfgVal(config, item.key);
        const v = (val !== undefined) ? val : item.default;
        html += `<div style="display:flex; align-items:center; margin-bottom:8px; gap:10px; flex-wrap:wrap;">
          <label style="color:#ddd; min-width:200px; flex:1; font-size:12px;">${item.label}</label>
          <input type="range" data-pkey="${item.key}" min="${item.min}" max="${item.max}" step="${item.step}" value="${v}"
            oninput="onProbSliderInput(this)" onchange="onProbChanged(this)"
            style="flex:2; min-width:150px; accent-color:#3498db;" />
          <span class="prob-val-label" data-pkey-label="${item.key}" style="color:#85c1e9; font-weight:bold; min-width:50px; text-align:right; font-size:12px;">${Math.round(v * 100)}%</span>
        </div>`;
      });
    }
  });
  html += `</div>`;

  // 平衡偏袒系统（全部内置启用，仅展示说明）
  html += `<div style="background:rgba(52,152,219,0.1); border:2px solid rgba(52,152,219,0.4); border-radius:8px; padding:15px; margin-bottom:12px;">
    <h3 style="color:#5dade2; margin-bottom:12px; font-size:1.1em;">⚖️ 平衡偏袒系统</h3>

    <div style="background:rgba(46,204,113,0.06); border:1px solid rgba(46,204,113,0.2); border-radius:6px; padding:10px; margin-bottom:12px;">
      <div style="color:#2ecc71; font-size:12px; line-height:1.6;">
        <b>✓ 内置启用（不可调节）：</b><br>
        · 偏袒强度 = 100%（必帮弱方）<br>
        · 中毒/醉酒信息真伪由平衡系统自动判断<br>
        · 干扰项偏向弱势方<br>
        · 平衡权重自动计算
      </div>
    </div>

    <div style="background:rgba(0,0,0,0.15); border-radius:6px; padding:12px; margin-top:12px;">
      <div style="color:#f9e79f; font-size:12px; font-weight:bold; margin-bottom:6px;">📐 平衡分数计算公式</div>
      <div style="color:#aaa; font-size:11px; line-height:1.7; font-family:monospace;">
        分数 = (存活好人 − 存活恶魔×2 − 存活爪牙×1.5) / 存活人数 × 0.90<br>
        &emsp;+ 已死邪恶 × 0.20 − 已死好人 × 0.15<br>
        &emsp;+ 关键角色存活奖励（信息位+0.1,僧侣+0.1,杀手+0.05）<br>
        <span style="color:#888;">→ 结果范围 [-1, 1]，负数=邪恶优势，正数=好人优势</span>
      </div>
      <div style="color:#f9e79f; font-size:12px; font-weight:bold; margin:8px 0 6px;">📊 偏袒判定（偏袒强度=100%）</div>
      <div style="color:#aaa; font-size:11px; line-height:1.7; font-family:monospace;">
        偏袒概率 = min(|分数| × 1.0 + 1.0, 1.0) = 100%<br>
        <span style="color:#888;">→ 好人弱势(分数&lt;-0.20)：必触发偏袒帮好人</span><br>
        <span style="color:#888;">→ 邪恶弱势(分数&gt;0.30)：必触发偏袒帮邪恶（误导好人）</span><br>
        <span style="color:#888;">→ 局势均衡(-0.20≤分数≤0.30)：50%概率偏向任一方向</span>
      </div>
    </div>
  </div>`;

  container.innerHTML = html;
}

function onProbSliderInput(el) {
  const key = el.getAttribute('data-pkey');
  const val = parseFloat(el.value);
  const label = document.querySelector(`[data-pkey-label="${key}"]`);
  if (label) {
    label.textContent = Math.round(val * 100) + '%';
  }
}

function onProbChanged(el) {
  const key = el.getAttribute('data-pkey');
  let val;
  if (el.type === 'checkbox') {
    val = el.checked;
  } else {
    val = parseFloat(el.value);
  }
  _setCfgVal(_probConfigDraft, key, val);
}

function saveProbConfig() {
  if (!_probConfigDraft) return;
  if (currentState && currentState.gameStarted) {
    showToast('游戏已开始，无法修改设置');
    return;
  }
  if (_probMode === 'standard') {
    _applyStandardPreset();
  }
  socket.emit('room:setProbConfig', { config: _probConfigDraft, mode: _probMode });
}

async function resetProbConfig() {
  if (currentState && currentState.gameStarted) {
    showToast('游戏已开始，无法重置设置');
    return;
  }
  const ok = await showConfirm('确定恢复默认概率设置吗？（将切换回标准模式）', { title: '重置设置' });
  if (!ok) return;
  _probMode = 'standard';
  _probBackupAdvanced = null;
  _updateModeButtons();
  socket.emit('room:resetProbConfig');
}

// ========== 历史记录功能 ==========
function openHistoryPanel() {
  const panel = $('historyPanel');
  if (!panel) return;
  panel.style.display = 'block';
  closeHistoryDetail();
  loadHistoryList();
}

function closeHistoryPanel() {
  const panel = $('historyPanel');
  if (panel) panel.style.display = 'none';
}

function closeHistoryDetail() {
  $('historyList').style.display = 'block';
  $('historyDetail').style.display = 'none';
  $('historyBackBtn').style.display = 'none';
  $('historyTitle').textContent = '📜 历史记录';
}

function formatHistoryTime(date) {
  if (!date) return '未知时间';
  const d = new Date(date);
  return d.toLocaleString('zh-CN', { hour12: false });
}

async function loadHistoryList() {
  const container = $('historyListContent');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center; color:#aaa; padding:40px;">加载中...</div>';
  
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    if (!data.success) {
      container.innerHTML = `<div style="text-align:center; color:#e74c3c; padding:40px;">加载失败：${data.message || '未知错误'}</div>`;
      return;
    }
    const list = data.history || [];
    if (list.length === 0) {
      container.innerHTML = '<div style="text-align:center; color:#aaa; padding:60px;">暂无历史记录，完成一局游戏后会显示在这里</div>';
      return;
    }
    
    let html = '';
    list.forEach(h => {
      const winnerColor = h.winner === 'GOOD' ? '#2ecc71' : '#e74c3c';
      const winnerText = h.winner === 'GOOD' ? '善良阵营获胜' : '邪恶阵营获胜';
      const endedTime = formatHistoryTime(h.endedAt);
      
      // 计算游戏时长
      let durationText = '';
      if (h.startedAt && h.endedAt) {
        const duration = new Date(h.endedAt) - new Date(h.startedAt);
        const mins = Math.floor(duration / 60000);
        if (mins >= 60) {
          durationText = `${Math.floor(mins/60)}小时${mins%60}分钟`;
        } else if (mins > 0) {
          durationText = `${mins}分钟`;
        }
      }

      const goodPlayers = h.players.filter(p => p.team === 'GOOD').sort((a,b) => a.seat - b.seat);
      const evilPlayers = h.players.filter(p => p.team === 'EVIL').sort((a,b) => a.seat - b.seat);
      const aliveCount = h.players.filter(p => p.isAlive).length;
      const botCount = h.players.filter(p => p.isBot).length;

      // 按座位排序的所有玩家
      const allPlayers = [...h.players].sort((a,b) => a.seat - b.seat);

      // 生成玩家标签
      function playerTag(p) {
        const color = p.team === 'GOOD' ? '#2ecc71' : '#e74c3c';
        const aliveIcon = p.isAlive ? '' : ' <span style="opacity:0.5;">☠</span>';
        const botIcon = p.isBot ? ' <span style="font-size:10px; color:#888;">🤖</span>' : '';
        return `<span style="display:inline-block; background:rgba(0,0,0,0.25); border:1px solid ${color}55; border-radius:4px; padding:2px 6px; margin:2px; font-size:12px; color:${color};">${p.seat+1}号 ${escapeHtml(p.name)} <span style="opacity:0.7;">(${escapeHtml(p.roleName)})</span>${aliveIcon}${botIcon}</span>`;
      }
      
      html += `<div style="background:rgba(0,0,0,0.3); border:1px solid rgba(52,152,219,0.3); border-radius:8px; padding:15px; margin-bottom:12px; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.borderColor='#3498db';this.style.background='rgba(52,152,219,0.1)'" onmouseout="this.style.borderColor='rgba(52,152,219,0.3)';this.style.background='rgba(0,0,0,0.3)'" onclick="viewHistoryDetail('${h.id}')">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
          <div style="font-size:1.2em; font-weight:bold;">
            <span style="color:${winnerColor};">${winnerText}</span>
          </div>
          <div style="color:#888; font-size:13px;">${endedTime}</div>
        </div>
        <div style="color:#aaa; font-size:13px; margin-bottom:8px;">${escapeHtml(h.winReason || '')}</div>
        <div style="display:flex; gap:15px; flex-wrap:wrap; color:#aaa; font-size:12px; margin-bottom:10px;">
          <span>👥 ${h.playerCount}人${botCount > 0 ? `（${botCount}AI）` : ''}</span>
          ${durationText ? `<span>⏱ ${durationText}</span>` : ''}
          <span>💀 ${aliveCount}人存活</span>
        </div>
        <div style="margin-top:6px;">
          <div style="font-size:12px; margin-bottom:4px;">
            <span style="color:#2ecc71;">善良阵营</span>
            <span style="color:#666; margin-left:4px;">（${goodPlayers.length}人）</span>
          </div>
          <div>${goodPlayers.map(playerTag).join('')}</div>
        </div>
        <div style="margin-top:8px;">
          <div style="font-size:12px; margin-bottom:4px;">
            <span style="color:#e74c3c;">邪恶阵营</span>
            <span style="color:#666; margin-left:4px;">（${evilPlayers.length}人）</span>
          </div>
          <div>${evilPlayers.map(playerTag).join('')}</div>
        </div>
      </div>`;
    });
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div style="text-align:center; color:#e74c3c; padding:40px;">加载失败：${e.message}</div>`;
  }
}

async function viewHistoryDetail(historyId) {
  const container = $('historyDetailContent');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center; color:#aaa; padding:40px;">加载中...</div>';
  $('historyList').style.display = 'none';
  $('historyDetail').style.display = 'block';
  $('historyBackBtn').style.display = 'inline-block';
  $('historyTitle').textContent = '📜 游戏详情';
  
  try {
    const res = await fetch(`/api/history/${historyId}`);
    const data = await res.json();
    if (!data.success) {
      container.innerHTML = `<div style="text-align:center; color:#e74c3c; padding:40px;">加载失败：${data.message || '未知错误'}</div>`;
      return;
    }
    const h = data.data;
    
    const winnerColor = h.winner === 'GOOD' ? '#2ecc71' : '#e74c3c';
    const winnerText = h.winner === 'GOOD' ? '善良阵营获胜' : '邪恶阵营获胜';
    
    let html = `
      <div style="background:rgba(0,0,0,0.3); border-radius:8px; padding:20px; margin-bottom:20px;">
        <div style="font-size:1.5em; font-weight:bold; color:${winnerColor}; margin-bottom:10px;">${winnerText}</div>
        <div style="color:#aaa; margin-bottom:10px;">${h.winReason}</div>
        <div style="color:#888; font-size:13px;">开始时间：${formatHistoryTime(h.startedAt)} | 结束时间：${formatHistoryTime(h.endedAt)} | 玩家数：${h.playerCount}</div>
      </div>
      
      <div style="background:rgba(0,0,0,0.3); border-radius:8px; padding:15px; margin-bottom:20px;">
        <h3 style="color:#d4af37; margin-bottom:12px;">👥 玩家角色</h3>
        <table style="width:100%; border-collapse:collapse;">
          <thead>
            <tr style="border-bottom:1px solid rgba(255,255,255,0.2);">
              <th style="padding:8px; text-align:left; color:#aaa;">座位</th>
              <th style="padding:8px; text-align:left; color:#aaa;">昵称</th>
              <th style="padding:8px; text-align:left; color:#aaa;">角色</th>
              <th style="padding:8px; text-align:left; color:#aaa;">阵营</th>
              <th style="padding:8px; text-align:left; color:#aaa;">状态</th>
            </tr>
          </thead>
          <tbody>
            ${h.players.sort((a,b) => a.seat - b.seat).map(p => {
              const teamColor = p.team === 'GOOD' ? '#2ecc71' : '#e74c3c';
              const teamText = p.team === 'GOOD' ? '善良' : '邪恶';
              const statusText = p.isAlive ? '存活' : '死亡';
              const statusColor = p.isAlive ? '#2ecc71' : '#888';
              const botMark = p.isBot ? ' 🤖' : '';
              return `<tr style="border-bottom:1px solid rgba(255,255,255,0.08);">
                <td style="padding:8px;">${p.seat+1}号</td>
                <td style="padding:8px;">${p.name}${botMark}</td>
                <td style="padding:8px; font-weight:bold;">${p.roleName}</td>
                <td style="padding:8px; color:${teamColor};">${teamText}</td>
                <td style="padding:8px; color:${statusColor};">${statusText}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      
      <div style="background:rgba(0,0,0,0.3); border-radius:8px; padding:15px;">
        <h3 style="color:#d4af37; margin-bottom:12px;">📋 行动日志</h3>
        <div id="historyActionLog" style="max-height:600px; overflow-y:auto; font-family:monospace; font-size:13px; line-height:1.8; background:rgba(0,0,0,0.3); padding:10px; border-radius:4px;">
          ${(h.actionLog || []).map(entry => {
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
              'ABILITY': '#e67e22',
              'CUSTOM_ASSIGN': '#d4af37'
            };
            const color = typeColors[entry.type] || '#aaa';
            let msg = entry.message;
            if (entry.type === 'PRIVATE_INFO' && entry.data && entry.data.isFalse) {
              msg = `<span style="color:#e74c3c;">⚠️【假信息】</span> ${escapeHtml(entry.message)}`;
            } else {
              msg = escapeHtml(msg);
            }
            
            let probHtml = '';
            if (entry.data) {
              const probInfos = [];
              if (entry.data.probInfo) probInfos.push(entry.data.probInfo);
              if (entry.data.correctProbInfo) probInfos.push(entry.data.correctProbInfo);
              probHtml = probInfos.map(pi => formatProbInfo(pi)).join('');
            }
            
            return `<div style="color:${color}; padding:2px 0;">
              <span style="color:#666;">[${entry.time}]</span> ${msg}${probHtml}
            </div>`;
          }).join('')}
        </div>
      </div>
    `;
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div style="text-align:center; color:#e74c3c; padding:40px;">加载失败：${e.message}</div>`;
  }
}

