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
let nightPeeked = false;        // 夜间行动时是否临时收起遮罩查看局势
let currentChatChannel = 'public';
let selectedNominateTarget = null;
let whisperTargetId = null; // 当前私聊对象ID
let isGodView = false;
let godState = null;
let isReconnecting = false;
let reconnectAttempts = 0;
let pendingManualJoin = false; // 是否由用户手动点击“加入房间”触发
let hasLeftRoom = false;
let gossipPending = false;      // 造谣者声明等待裁判判定中（期间禁止重复发动）
let gossipPendingTimer = null;  // 等待兜底定时器（服务端长时间无响应时恢复可点击）
let gossipRetryStatement = '';  // 判定服务异常导致失败的声明原文，重新发动时自动回填

// ========== 请求按钮 loading（防止请求未完成时重复点击） ==========
// 所有网络请求都经 socket.emit 发出。这里统一拦截 emit：
// 发起请求的按钮立即进入 loading 态并被禁用，收到对应的服务端响应后恢复，
// 服务端无响应时由兜底定时器恢复，避免按钮永久卡死。
const REQUEST_RELEASE_MAP = {
  'room:create': ['room:created', 'room:stateUpdate', 'room:error'],
  'room:join': ['room:joined', 'room:reconnected', 'room:error'],
  'room:leave': ['room:stateUpdate'],
  'room:seat': ['room:stateUpdate', 'room:error'],
  'room:toggleReady': ['room:stateUpdate', 'room:error'],
  'room:addBot': ['room:stateUpdate', 'room:error'],
  'room:setScript': ['room:stateUpdate', 'room:error'],
  'room:kick': ['room:stateUpdate', 'room:error'],
  'game:start': ['game:stateUpdate', 'room:stateUpdate', 'room:error'],
  'game:confirm': ['game:stateUpdate', 'room:stateUpdate', 'room:error'],
  'night:action': ['game:stateUpdate', 'room:stateUpdate', 'room:error'],
  'day:nominates': ['game:stateUpdate', 'room:stateUpdate', 'room:error'],
  'day:endDefense': ['game:stateUpdate', 'room:stateUpdate', 'room:error'],
  'day:vote': ['game:stateUpdate', 'game:voteUpdate', 'room:error'],
  'day:revokeVote': ['game:stateUpdate', 'game:voteUpdate', 'room:error'],
  'day:endVoting': ['game:stateUpdate', 'room:stateUpdate', 'room:error'],
  'day:useAbility': ['game:stateUpdate', 'gossip:result', 'room:stateUpdate', 'room:error'],
  'chat:send': ['chat:message', 'room:error'],
  'chat:announce': ['chat:message', 'room:error'],
  'chat:recall': ['chat:recall', 'room:error'],
  'chat:danmaku': ['chat:danmaku', 'room:error'],
  'ai:chat': ['ai:start', 'ai:error', 'room:error'],
  'god:login': ['god:loginResult', 'room:error'],
  'god:logout': ['god:logoutResult'],
  'room:getProbConfig': ['room:probConfig', 'room:error'],
  'room:setProbConfig': ['room:probConfigSaved', 'room:stateUpdate', 'room:error'],
  'room:resetProbConfig': ['room:probConfigSaved', 'room:stateUpdate', 'room:error'],
};
const LOADING_MIN_MS = 320;    // loading 最短展示时长，避免闪烁
const LOADING_MAX_MS = 8000;   // 兜底时长：服务端无响应时自动恢复按钮
let _loadingClickEl = null;    // 本次点击的按钮
let _loadingEmitOverride = null; // 异步流程中显式指定的按钮
let _loadingSeq = 0;
const _pendingLoadings = new Map();

// 记录点击来源元件：仅在同一次点击的同步流程中有效，避免误绑后续的自动请求
document.addEventListener('click', (e) => {
  const el = e.target && e.target.closest
    ? e.target.closest('button, .game-seat, .script-card')
    : null;
  _loadingClickEl = el;
  setTimeout(() => { if (_loadingClickEl === el) _loadingClickEl = null; }, 0);
}, true);

// 异步流程（如确认弹窗）中需在函数入口先记下按钮，再于 emit 时显式传入
function getLoadingClickTarget() {
  return _loadingEmitOverride || _loadingClickEl;
}

function startButtonLoading(el, requestEvent) {
  if (!el || !el.classList || !el.isConnected) return;
  if (el.dataset.loading === '1' || el.dataset.noLoading === '1') return;
  const record = {
    id: ++_loadingSeq,
    el,
    request: requestEvent,
    prevDisabled: el.tagName === 'BUTTON' ? !!el.disabled : null,
    releaseAt: Date.now() + LOADING_MIN_MS,
    timer: null,
    releaseTimer: null,
  };
  el.dataset.loading = '1';
  el.setAttribute('aria-busy', 'true');
  el.classList.add('is-loading');
  if (el.tagName === 'BUTTON') el.disabled = true;
  record.timer = setTimeout(() => finishButtonLoading(record), LOADING_MAX_MS);
  _pendingLoadings.set(record.id, record);
}

function releaseButtonLoading(record) {
  if (!_pendingLoadings.has(record.id) || record.releaseTimer) return;
  const wait = Math.max(0, record.releaseAt - Date.now());
  record.releaseTimer = setTimeout(() => finishButtonLoading(record), wait);
}

function finishButtonLoading(record) {
  if (!_pendingLoadings.has(record.id)) return;
  _pendingLoadings.delete(record.id);
  clearTimeout(record.timer);
  clearTimeout(record.releaseTimer);
  const el = record.el;
  if (!el || !el.classList) return;
  el.classList.remove('is-loading');
  el.removeAttribute('aria-busy');
  delete el.dataset.loading;
  if (el.tagName === 'BUTTON' && record.prevDisabled !== null) el.disabled = record.prevDisabled;
  // 白天技能按钮（学者/艺术家等）的「已使用」状态会在请求返回后变化，
  // loading 结束时按最新状态重算，避免把已经用掉的按钮恢复成可点击
  if (el.id && /(artist|savant|juggler|mutant|cerenovus|klutz)Btn$/.test(el.id)
      && typeof currentState !== 'undefined' && currentState) {
    try { renderRoleCard(currentState); } catch (e) { /* 页面未就绪时忽略 */ }
  }
}

function releaseAllButtonLoading() {
  Array.from(_pendingLoadings.values()).forEach(finishButtonLoading);
}

// 发送请求（可显式指定 loading 按钮）
function emitRequest(requestEvent, payload, el) {
  _loadingEmitOverride = el || null;
  try {
    return payload === undefined ? socket.emit(requestEvent) : socket.emit(requestEvent, payload);
  } finally {
    _loadingEmitOverride = null;
  }
}

function installRequestLoadingGuard() {
  const rawEmit = socket.emit.bind(socket);
  socket.emit = function (requestEvent, ...args) {
    const el = getLoadingClickTarget();
    if (el && REQUEST_RELEASE_MAP[requestEvent]) startButtonLoading(el, requestEvent);
    return rawEmit(requestEvent, ...args);
  };
  // 收到服务端响应 → 结束对应请求的 loading
  socket.onAny((incoming) => {
    if (_pendingLoadings.size === 0) return;
    Array.from(_pendingLoadings.values()).forEach((record) => {
      const releases = REQUEST_RELEASE_MAP[record.request];
      if (releases && releases.indexOf(incoming) !== -1) releaseButtonLoading(record);
    });
  });
  socket.on('disconnect', releaseAllButtonLoading);
  socket.on('connect_error', releaseAllButtonLoading);
}

// ========== 初始化 ==========
window.addEventListener('DOMContentLoaded', () => {
  socket = io({ reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: 30 });
  installRequestLoadingGuard();
  initSocketEvents();
  // 初始化语音模块
  VoiceManager.init(socket);
  checkReconnectInfo();
  // 进入系统：弹出昵称登录框
  showLoginModal();
  // 初始化中央聊天框（显示空状态提示）
  renderChatMessages();
  renderSessionList();
  updateChatInputVisibility();
  // 应用移动端成员/操作区收起状态
  applyMemberPanelCollapsed();
  
  // 回车提交
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
      // 断线状态已在顶部胶囊上体现，不再弹提示
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
    addSystemChatMessage(`已创建房间 ${roomId}，等待其他玩家加入`);
  });

  socket.on('room:joined', ({ roomId, playerId }) => {
    if (hasLeftRoom) return;
    hasLeftRoom = false;
    myId = playerId;
    myRoomId = roomId;
    pendingManualJoin = false;
    clearReconnectInfo();
    saveSession();
    showGameView();
    addSystemChatMessage(`已进入房间 ${roomId}`);
  });

  socket.on('room:reconnected', ({ roomId, playerId, gameStarted }) => {
    if (hasLeftRoom) return;
    myId = playerId;
    myRoomId = roomId;
    isReconnecting = false;
    pendingManualJoin = false;
    clearReconnectInfo();
    saveSession();
    showGameView();
    // 重连提示统一由服务端广播系统消息，避免重复
    // 关闭可能打开的断线遮罩
    const overlay = $('disconnectOverlay');
    if (overlay) overlay.style.display = 'none';
  });

  // 断线 / 重连：结果由服务端广播系统聊天消息展示
  // （见 server.js 的 handleDisconnect / room:leave / room:join）

  socket.on('room:stateUpdate', (state) => {
    if (hasLeftRoom) return;
    const prevScript = currentState && currentState.script;
    // 房间动态（玩家加入/离开、游戏开始）→ 系统消息
    diffRoomDynamics(currentState, state);
    currentState = state;
    renderGameState(state);
    // 如果角色总览面板已打开，重新渲染以反映剧本切换
    const roPanel = document.getElementById('roleOverviewPanel');
    if (roPanel && roPanel.style.display !== 'none') renderRoleOverview();
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
    renderGameState(state);
    // 如果角色总览面板已打开，重新渲染以反映剧本切换
    const roPanel = document.getElementById('roleOverviewPanel');
    if (roPanel && roPanel.style.display !== 'none') renderRoleOverview();
  });

  socket.on('room:error', ({ message }) => {
    if (hasLeftRoom) return;
    const roomMissing = message.includes('房间不存在');
    if (roomMissing) {
      // 「房间不存在」不再弹提示：仅手动加入时写进表单错误位，重连失败时静默
      if (pendingManualJoin) showError(message, 'joinError');
      pendingManualJoin = false;
    } else {
      showToast(message);
    }
    // 重连失败时清除失效的重连信息
    if (roomMissing || message.includes('游戏已开始')) {
      const card = $('reconnectCard');
      if (card && card.style.display !== 'none') {
        clearReconnectInfo();
        checkReconnectInfo();
      }
    }
  });

  // 造谣者声明结果：只发给造谣者本人（失败可重新发动，成功后按钮禁用）
  socket.on('gossip:result', ({ success, message, retryable, statement } = {}) => {
    if (hasLeftRoom) return;
    clearGossipPending();
    // 判定服务异常导致的失败：记住原文，玩家重新发动时自动回填
    gossipRetryStatement = (success || !retryable) ? '' : (statement || '');
    if (message) showToast(message);
    // 成功后由紧随其后的房间状态广播刷新（按钮变为「今日已发表」）；
    // 失败时服务端不会广播状态，需立即刷新以恢复可点击
    if (!success && currentState) renderGameState(currentState);
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
    playVictoryEffect(data.winEffect);
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

  // 天亮公布（死亡名单 / 平安夜）：月亮→太阳转场动画，结果在动画中央展示
  socket.on('game:dawnReport', (data) => {
    if (hasLeftRoom) return;
    const deaths = (data && data.deaths) || [];
    const body = deaths.length > 0
      ? '昨夜死亡：' + deaths.map(d => {
          const seat = Number.isInteger(d.seat) ? `${d.seat + 1}号 ` : '';
          return `${seat}${d.name || ''}`.trim();
        }).filter(Boolean).join('、')
      : '平安夜，无人死亡';
    playPhaseTransition('day', '天亮了', body);
  });

  // 技能使用结果：已由服务端以聊天区消息展示（公聊气泡 / 系统消息），不再弹提示框

  socket.on('chat:message', (msg) => {
    if (hasLeftRoom) return;
    addChatMessage(msg);
  });

  // 消息撤回（不限时间）
  socket.on('chat:recall', ({ id }) => {
    if (hasLeftRoom) return;
    if (id === undefined || id === null) return;
    const target = chatMessages.find(m => String(m.id) === String(id));
    if (!target) return;
    target.recalled = true;
    target.content = '';
    delete target.image;
    renderChatMessages();
    renderSessionList();
  });

  // 弹幕（输入框 @弹幕 触发，广播给房间内所有玩家，不写入聊天记录）
  socket.on('chat:danmaku', (data) => {
    if (hasLeftRoom) return;
    showDanmaku(data);
  });

  // AI 小助手事件
  socket.on('ai:start', ({ id, playerName }) => {
    isAiThinking = true;
    // 记录触发本次请求的本地消息，便于撤回时配对
    aiPendingMessages[id] = { content: '', playerName, chunks: [], triggerId: lastAiUserMsgId };
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
      const aiMsgId = 'ai_msg_' + id;
      // 将 AI 消息转为普通聊天消息存入 chatMessages
      chatMessages.push({
        id: aiMsgId,
        fromId: 'ai_assistant',
        fromName: '小染 AI',
        fromSeat: -1,
        isDead: false,
        isAi: true,
        content: pending.content,
        channel: 'public',
        timestamp: Date.now(),
        // 与触发它的本地消息配对
        aiTriggerId: pending.triggerId
      });
      // 反向记录，便于从本地消息定位这条回复
      const trigger = chatMessages.find(m => m.id === pending.triggerId);
      if (trigger) trigger.aiReplyId = aiMsgId;
      delete aiPendingMessages[id];
      renderChatMessages();
    }
    isAiThinking = false;
    lastAiUserMsgId = null;
  });

  socket.on('ai:error', ({ message }) => {
    isAiThinking = false;
    aiPendingMessages = {};
    // 失败同样以聊天气泡呈现，不用提示框
    const errId = 'ai_err_' + Date.now() + Math.random();
    chatMessages.push({
      id: errId,
      fromId: 'ai_assistant',
      fromName: '小染 AI',
      fromSeat: -1,
      isDead: false,
      isAi: true,
      content: message || '抱歉，我暂时无法回答，请稍后再试。',
      channel: 'public',
      timestamp: Date.now(),
      aiTriggerId: lastAiUserMsgId
    });
    const trigger = chatMessages.find(m => m.id === lastAiUserMsgId);
    if (trigger) trigger.aiReplyId = errId;
    lastAiUserMsgId = null;
    renderChatMessages();
  });

  // 玩家死亡：已由服务端广播系统聊天消息（见 src/game/DeathManager.js）

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
      // 合并后的显示行会变化，统一重建；原本就在底部时自动跟随最新日志
      renderGodLog();
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
    $('godLoginForm').style.display = 'flex';
    $('godPassword').value = '';
    $('godLoginError').style.display = 'none';
    $('godBtn').style.background = 'rgba(155,89,182,0.1)';
    $('godBtn').style.color = '#8E44AD';
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

// ========== 连接状态（显示在房间号左侧） ==========
function updateConnStatus(status) {
  const wrap = $('topConn');
  const dot = $('connStatusDotTop');
  const text = $('connStatusTextTop');
  if (!dot || !text) return;

  if (wrap) {
    wrap.classList.remove('is-connected', 'is-disconnected', 'is-connecting');
    wrap.classList.add(
      status === 'connected' ? 'is-connected'
        : status === 'disconnected' ? 'is-disconnected'
        : 'is-connecting'
    );
  }
  dot.className = 'conn-dot';
  switch (status) {
    case 'connected':
      dot.classList.add('conn-connected');
      text.textContent = '已连接';
      break;
    case 'disconnected':
      dot.classList.add('conn-disconnected');
      text.textContent = '已断开';
      break;
    case 'connecting':
    default:
      dot.classList.add('conn-connecting');
      text.textContent = '连接中...';
      break;
  }
}

// ========== 视图切换 ==========
function showGameView() {
  // 兜底：自动重连成功时关闭登录框
  const loginModal = $('loginModal');
  if (loginModal) loginModal.style.display = 'none';
  updateRailAvatar();
  // 左侧：隐藏大厅表单，显示房间信息 + 会话列表
  const lobby = $('homeView');
  const roomPanel = $('roomPanel');
  if (lobby) lobby.style.display = 'none';
  if (roomPanel) roomPanel.style.display = 'flex';
  // 右侧区域：仅加入房间后显示；成员与操作区默认展开（不沿用上次的收起状态）
  memberPanelCollapsed = false;
  applyMemberPanelCollapsed();
  const gameView = $('gameView');
  if (gameView) gameView.style.display = 'grid';
  // 右侧成员与操作区：PC 端仅在主房间（公聊）会话显示
  updateMemberPanelVisibility();
  // 顶部右侧操作（上帝视角 / 退出群聊）：仅房间内显示
  const headerActions = $('headerActions');
  if (headerActions) headerActions.style.display = 'flex';
  $('gameOverPanel').style.display = 'none';
  updateChatInputVisibility();
}

function backToHome() {
  if (hasLeftRoom) return;
  hasLeftRoom = true;
  clearGossipPending();
  gossipRetryStatement = '';
  // 夜晚遮罩（含「查看局势」收起态）一并复位，避免残留浮动按钮
  hideNightOverlay();

  // 离开语音频道
  if (VoiceManager.isJoined) {
    VoiceManager.leave();
  }

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
  // 重置昼夜转场相关的状态，避免下一局沿用上一局阶段造成误播动画
  lastRenderedPhase = null;
  lastExecutionInfo = null;
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
  customGfDelta = 1;
  isGodView = false;
  godState = null;
  isReconnecting = false;
  roleInfoHtml = '';
  systemMessageHtml = '';
  systemMessageClass = '';
  const cmEl = $('centerMessage');
  if (cmEl) { cmEl.innerHTML = ''; cmEl.style.display = 'none'; }
  const cmBtn = $('cmToggle');
  if (cmBtn) cmBtn.style.display = 'none';

  // 清空顶部栏信息（当前聊天对象 / 天数 / 阶段 / 人数配置）
  const chatTargetEl = $('headerChatTarget');
  if (chatTargetEl) chatTargetEl.textContent = '';
  const dayCountEl = $('headerDayCount');
  if (dayCountEl) dayCountEl.textContent = '';
  const phaseEl = $('headerPhase');
  if (phaseEl) {
    phaseEl.textContent = '';
    phaseEl.className = 'phase-badge';
    phaseEl.style.display = 'none';
  }
  const roomCompEl = $('headerRoomComp');
  if (roomCompEl) roomCompEl.innerHTML = '';

  // 左侧：恢复大厅表单，隐藏房间信息/会话列表
  const lobbyEl = $('homeView');
  const roomPanelEl = $('roomPanel');
  if (lobbyEl) lobbyEl.style.display = 'flex';
  if (roomPanelEl) roomPanelEl.style.display = 'none';
  // 右侧区域：回到大厅时隐藏
  const memberPanelEl = $('memberPanel');
  if (memberPanelEl) memberPanelEl.style.display = 'none';
  const scriptPanelEl = $('scriptPanel');
  if (scriptPanelEl) {
    scriptPanelEl.style.display = 'none';
    scriptPanelEl.innerHTML = '';
  }
  const gv = $('gameView');
  if (gv) {
    gv.classList.remove('with-member');
    gv.style.display = 'grid';
  }
  $('gameOverPanel').style.display = 'none';
  $('godPanel').style.display = 'none';
  systemMessageHtml = '';
  systemMessageClass = '';
  renderChatMessages();
  $('joinRoomId').value = '';

  updateChatInputVisibility();

  // 顶部右侧操作按钮：无房间时隐藏
  const headerActionsEl = $('headerActions');
  if (headerActionsEl) headerActionsEl.style.display = 'none';

  // 回到首页：连接状态恢复为默认展示
  const topConnEl = $('topConn');
  if (topConnEl) topConnEl.style.display = '';

  checkReconnectInfo();

  setTimeout(() => {
    hasLeftRoom = false;
  }, 300);
}

// ========== 登录（昵称） ==========
const LOGIN_NAME_KEY = 'xrzl_login_name';

function getLoginName() {
  try { return localStorage.getItem(LOGIN_NAME_KEY) || ''; } catch (e) { return ''; }
}

// 左侧栏头像：显示当前昵称的首字符
function updateRailAvatar() {
  const el = $('railAvatar');
  if (!el) return;
  const name = (myName || getLoginName() || '').trim();
  // 用 Array.from 兼容 emoji 等代理对字符
  el.textContent = name ? Array.from(name)[0] : '血';
}

// 进入系统时弹出昵称登录框
function showLoginModal() {
  const modal = $('loginModal');
  if (!modal) return;
  updateRailAvatar();
  const input = $('loginName');
  const saved = getLoginName();
  if (input && saved) input.value = saved;
  const err = $('loginError');
  if (err) err.classList.remove('show');
  modal.style.display = 'flex';
  setTimeout(() => { if (input) input.focus(); }, 60);
}

function confirmLogin() {
  const input = $('loginName');
  const name = (input && input.value ? input.value : '').trim();
  if (!name) {
    const err = $('loginError');
    if (err) err.classList.add('show');
    if (input) input.focus();
    return;
  }
  try { localStorage.setItem(LOGIN_NAME_KEY, name); } catch (e) {}
  myName = name;
  updateRailAvatar();
  const modal = $('loginModal');
  if (modal) modal.style.display = 'none';
  showToast(`欢迎，${name}`, 'success');
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
    $('reconnectInfo').innerHTML = `房间码：<b style="color:#FF9500;">${roomId}</b>　昵称：<b style="color:#FF9500;">${escapeHtml(name)}</b>`;
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

// ========== 通用确认弹窗 ==========
let _wxConfirmHandler = null;

function showWxConfirm(message, onOk, okText) {
  const panel = $('wxConfirm');
  if (!panel) {
    if (window.confirm(message)) { if (onOk) onOk(); }
    return;
  }
  const textEl = $('wxConfirmText');
  if (textEl) textEl.textContent = message;
  const okBtn = $('wxConfirmOk');
  if (okBtn) {
    okBtn.textContent = okText || '确定';
    okBtn.onclick = () => {
      const fn = _wxConfirmHandler;
      closeWxConfirm();
      if (fn) fn();
    };
  }
  _wxConfirmHandler = onOk || null;
  panel.style.display = 'flex';
}

function closeWxConfirm() {
  const panel = $('wxConfirm');
  if (panel) panel.style.display = 'none';
  _wxConfirmHandler = null;
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

// 是否存在可重新连接的游戏房间
function hasPendingReconnect() {
  const card = $('reconnectCard');
  return !!(card && card.style.display !== 'none');
}

// 放弃重连：清空本地记录
function abandonReconnect() {
  clearReconnectInfo();
  checkReconnectInfo();
}

function createRoom() {
  const originEl = getLoadingClickTarget();
  const name = getLoginName() || myName || '';
  if (!name) {
    showLoginModal();
    showError('请先输入昵称', 'createError');
    return;
  }
  if (hasPendingReconnect()) {
    showWxConfirm(
      '你还有一个可以重新连接的游戏房间，创建新房间将放弃该对局。确定继续吗？',
      () => doCreateRoom(name, originEl),
      '放弃并创建'
    );
    return;
  }
  doCreateRoom(name, originEl);
}

function doCreateRoom(name, originEl) {
  abandonReconnect();
  hasLeftRoom = false;
  myName = name;
  emitRequest('room:create', { playerName: name }, originEl);
}

function joinRoom() {
  const originEl = getLoadingClickTarget();
  const roomId = $('joinRoomId').value.trim().toUpperCase();
  const name = getLoginName() || myName || '';
  if (!roomId || roomId.length !== 4) {
    showError('请输入4位房间码', 'joinError');
    return;
  }
  if (!name) {
    showError('请输入昵称', 'joinError');
    return;
  }
  if (hasPendingReconnect()) {
    showWxConfirm(
      '你还有一个可以重新连接的游戏房间，加入其他房间将放弃该对局。确定继续吗？',
      () => doJoinRoom(roomId, name, originEl),
      '放弃并加入'
    );
    return;
  }
  doJoinRoom(roomId, name, originEl);
}

function doJoinRoom(roomId, name, originEl) {
  abandonReconnect();
  hasLeftRoom = false;
  pendingManualJoin = true;
  myName = name;
  emitRequest('room:join', { roomId, playerName: name }, originEl);
}

async function leaveRoom() {
  if (hasLeftRoom) return;
  const ok = await showConfirm('确定要退出群聊吗？', { type: 'warning', title: '退出群聊', confirmText: '退出', cancelText: '取消' });
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
let customGfDelta = 1;       // 教父「外来者±1」方向：1 = 外来者+1/村民-1，-1 = 外来者-1/村民+1

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
    // 教父在场时把「外来者±1」的方向一并下发给服务端，保证与前端校验一致
    socket.emit('game:start', {
      customRoles: roleAssignments,
      godfatherDelta: customGfDelta
    });
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
  const originEl = getLoadingClickTarget();
  const p = currentState && currentState.players ? currentState.players.find(x => x.id === pid) : null;
  if (!p) return;
  const name = p.name + (p.isBot ? '(机器人)' : '');
  const ok = await showConfirm(`确定要将 ${name} 踢出房间吗？`, { type: 'warning', title: '踢出玩家' });
  if (!ok) return;
  emitRequest('room:kick', { targetId: pid }, originEl);
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

// actualComp：开局后服务端下发的真实配比（含方古/亡灵法师等设置修正），优先使用
function getCompHTML(playerCount, actualComp) {
  const comp = (actualComp && typeof actualComp.outsider === 'number')
    ? actualComp
    : ROLE_COMPOSITION_MAP[playerCount];
  if (!comp) return '';
  const badges = [];
  if (comp.townsfolk > 0) badges.push(`<span class="comp-badge comp-townsfolk">👤${comp.townsfolk}村民</span>`);
  if (comp.outsider > 0) badges.push(`<span class="comp-badge comp-outsider">❓${comp.outsider}外来者</span>`);
  if (comp.minion > 0) badges.push(`<span class="comp-badge comp-minion">🗡️${comp.minion}爪牙</span>`);
  if (comp.demon > 0) badges.push(`<span class="comp-badge comp-demon">👿${comp.demon}恶魔</span>`);
  return badges.join('');
}

// ========== 游戏状态渲染 ==========
let lastRenderedPhase = null;
function renderGameState(state) {
  if (!state) return;
  if (state.phase !== lastRenderedPhase) {
    const prevPhase = lastRenderedPhase;
    lastRenderedPhase = state.phase;
    handlePhaseChange(prevPhase, state.phase);
  }
  updateHeader(state);
  renderSeats(state);
  renderCenter(state);
  renderScriptPanel(state);
  renderRoleCard(state);
  if (state.players) updateWhisperTargets(state.players);
  renderSessionList();
  handleNightOverlay(state);
}

function updateHeader(state) {
  // 显示角色数量配置
  const playerCount = state.players ? state.players.filter(p => p.seat !== -1).length : 0;
  const compEl = $('headerRoomComp');
  const compHTML = getCompHTML(playerCount, state.composition);
  const compPlayers = state.players ? state.players.length : 0;
  compEl.innerHTML = compHTML ? `<span class="comp-players">${compPlayers}人</span>${compHTML}` : '';
  
  let dayTextHTML = '';
  let phaseText = '';
  let phaseClass = 'phase-lobby';

  // 顶部天数徽标只显示当前阶段对应的时间：夜晚显示夜数，白天显示天数
  const isNightPhase = state.phase === 'FIRST_NIGHT' || state.phase === 'NIGHT' || state.phase === 'NIGHT_WAKE';
  if (isNightPhase) {
    dayTextHTML = `<span class="dc-night">${state.nightCount === 0 ? '首夜' : `第${state.nightCount}夜`}</span>`;
  } else if (state.gameStarted && state.phase !== 'LOBBY') {
    dayTextHTML = `<span class="dc-day">第${state.dayCount > 0 ? state.dayCount : 1}天</span>`;
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

  $('headerDayCount').innerHTML = dayTextHTML;
  const phaseBadge = $('headerPhase');
  phaseBadge.textContent = phaseText;
  phaseBadge.className = 'phase-badge ' + phaseClass;
  // 大厅阶段不显示阶段徽章；顶部中间改为展示当前会话对象
  // 用 inline-flex 与头部胶囊样式一致，保证文字水平+垂直居中
  phaseBadge.style.display = (!state.gameStarted || state.phase === 'LOBBY' || !phaseText) ? 'none' : 'inline-flex';
  updateHeaderChatTarget();
}

// 顶部中间：动态显示当前聊天对象（房间名 / 私聊对象）
function updateHeaderChatTarget() {
  const el = $('headerChatTarget');
  if (!el) return;
  let label = '';
  let value = '';
  if (currentChatChannel === 'whisper') {
    const target = (currentState && currentState.players)
      ? currentState.players.find(p => p.id === whisperTargetId) : null;
    label = '私聊';
    value = target
      ? `${target.seat >= 0 ? (target.seat + 1) + '号 ' : ''}${target.name}`
      : '未选择';
  } else if (currentChatChannel === 'dead') {
    value = '死者频道';
  } else {
    const roomId = (currentState && currentState.roomId) || myRoomId || '';
    if (roomId) {
      label = '房间';
      value = roomId;
    } else {
      value = '游戏房间';
    }
  }
  el.innerHTML = label
    ? `<span class="ct-label">${escapeHtml(label)}</span><span class="ct-value">${escapeHtml(value)}</span>`
    : `<span class="ct-value">${escapeHtml(value)}</span>`;
}

// 有聊天对象（已进入房间 / 已选择私聊对象）时才显示底部输入框
function updateChatInputVisibility() {
  const area = $('chatInputArea');
  if (!area) return;
  const inRoom = !!myRoomId;
  const hasTarget = currentChatChannel === 'whisper' ? !!whisperTargetId : true;
  const visible = inRoom && hasTarget;
  area.style.display = visible ? 'flex' : 'none';
  // 📢 公开公告按钮：仅主房间（公聊）可用，并受当前剧本限制
  updateAnnounceButtonVisibility();
  // 输入区不可用、或切到非公聊会话时收起 @ 功能面板
  if (!visible || currentChatChannel !== 'public') closeAtSuggest();
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
      if (p.isHost) markHtml += '<span class="seat-mark" style="color:#07C160;">房主</span>';
      if (state.gameStarted && p.voteToken > 0 && isDead) markHtml += '<span class="seat-mark" style="color:#10AEFF;">余1票</span>';
      if (!state.gameStarted && p.isReady) markHtml += '<span class="seat-mark good">已准备</span>';
      if (p.isConnected === false) markHtml += '<span class="seat-mark" style="color:#F5822B; background:rgba(245,130,43,0.15);">断线</span>';

      // 白天可以提名任意座位（包括死亡玩家）：死者同样可被提名，
      // 僵怖这类"被当作死亡但仍存活"的角色因此仍能被再次处决。
      // 但发起提名的必须是存活玩家：死亡玩家（含被当作死亡的僵怖）不能发起提名。
      const canNominate = (state.phase === 'DAY_DISCUSSION' || state.phase === 'NOMINATION_PHASE') &&
                          state.gameStarted && me && me.isAlive && !me.isDead;
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
      html += `<div class="game-seat" onclick="sitDown(${i})" title="点击入座">
        <div class="seat-num">${i+1}</div>
        <div class="seat-name" style="color:#B2B2B2;">空位</div>
      </div>`;
    }
    // 游戏开始后空座位不显示
  }
  container.innerHTML = html;
}

// 中央剧本选择（仅大厅阶段显示）
function renderScriptPanel(state) {
  const panel = $('scriptPanel');
  if (!panel) return;
  if (!state || state.gameStarted) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }
  const isHost = state.hostId === myId;
  const currentScript = state.script || 'tb';
  const scriptList = state.scriptList || [
    { id: 'tb', name: '灾祸之酿' }, { id: 'bmr', name: '黯月初升' }, { id: 'snv', name: '紫罗兰教派' }
  ];

  const cardsHtml = scriptList.map(s => {
    const info = SCRIPT_INFO[s.id] || { icon: '📜', desc: '', color: '#888', nameEn: '' };
    const isActive = s.id === currentScript;
    const cursor = isHost ? 'cursor:pointer;' : 'cursor:default; opacity:0.85;';
    const onClickAttr = isHost ? `onclick="setScript('${s.id}')"` : '';
    const borderColor = isActive ? info.color : 'rgba(0,0,0,0.06)';
    const bgGrad = isActive
      ? `linear-gradient(145deg, ${info.color}1a 0%, ${info.color}08 40%, rgba(0,0,0,0.015) 100%)`
      : 'linear-gradient(145deg, rgba(0,0,0,0.025) 0%, rgba(0,0,0,0.01) 100%)';
    const shadow = isActive
      ? `0 4px 24px ${info.color}33, inset 0 1px 0 rgba(0,0,0,0.05)`
      : '0 2px 12px rgba(0,0,0,0.05), inset 0 1px 0 rgba(0,0,0,0.03)';
    const textColor = isActive ? info.color : '#191919';
    return `<div ${onClickAttr} class="script-card" style="border:1px solid ${borderColor}; background:${bgGrad}; box-shadow:${shadow}; ${cursor} transition:all 0.3s cubic-bezier(0.4, 0, 0.2, 1);">
      <div class="script-card-highlight" style="position:absolute; top:0; left:0; right:0; height:1px; background:linear-gradient(90deg, transparent, ${info.color}66, transparent); opacity:${isActive ? '1' : '0.3'};"></div>
      <div class="script-card-head">
        <div class="script-icon" style="width:32px; height:32px; border-radius:8px; background:${isActive ? info.color + '22' : 'rgba(0,0,0,0.04)'}; display:flex; align-items:center; justify-content:center; font-size:1.15em; flex-shrink:0; transition:all 0.3s;">${info.icon}</div>
        <div class="script-card-titles">
          <div class="script-card-name" style="font-weight:600; color:${textColor}; font-size:14px; letter-spacing:0.3px;">${s.name}</div>
          <div class="script-card-en" style="font-size:10.5px; color:#8c8c8c; font-weight:400; letter-spacing:0.5px; margin-top:2px;">${info.nameEn}</div>
        </div>
        ${isActive ? `<div class="script-card-check" style="width:18px; height:18px; border-radius:50%; background:${info.color}; display:flex; align-items:center; justify-content:center; font-size:11px; color:#fff; font-weight:bold; flex-shrink:0;">✓</div>` : ''}
      </div>
      <div class="script-card-desc" style="font-size:11.5px; color:${isActive ? '#4f4f4f' : '#8c8c8c'}; line-height:1.5; transition:color 0.3s;">${info.desc}</div>
    </div>`;
  }).join('');

  panel.style.display = 'block';
  panel.innerHTML = `<div class="script-list">${cardsHtml}</div>`;
}

// 中央系统信息（游戏状态 / 操作提示）
let systemMessageHtml = '';
let systemMessageClass = '';
// 我的身份信息（HTML）
let roleInfoHtml = '';

// 组装中央系统信息区（我的身份 + 当前状态）
function renderCenterMessage() {
  const el = $('centerMessage');
  if (!el) return;
  const btn = $('cmToggle');
  const hideAll = () => {
    el.innerHTML = '';
    el.style.display = 'none';
    if (btn) btn.style.display = 'none';
  };
  // 未加入房间时不显示该区域
  if (!myRoomId) return hideAll();
  const parts = [];
  if (roleInfoHtml) parts.push(roleInfoHtml);
  if (systemMessageHtml) {
    parts.push(`<div class="system-status ${systemMessageClass}">${systemMessageHtml}</div>`);
  }
  if (parts.length === 0) return hideAll();
  // 用 flex 保持左右并排（勿用 block，会覆盖 CSS 的 flex 布局）
  el.style.display = 'flex';
  el.innerHTML = parts.join('');
  if (btn) btn.style.display = 'flex';
  applyCenterMessageCollapsed();
  positionCmToggle();
}

// ========== 系统信息区收起 / 展开 ==========
let centerMessageCollapsed = (() => {
  try { return localStorage.getItem('xrzl_cm_collapsed') === '1'; } catch (e) { return false; }
})();

function applyCenterMessageCollapsed() {
  const el = $('centerMessage');
  const btn = $('cmToggle');
  if (el) el.classList.toggle('collapsed', centerMessageCollapsed);
  if (btn) {
    btn.classList.toggle('collapsed', centerMessageCollapsed);
    btn.title = centerMessageCollapsed ? '展开信息区' : '收起信息区';
  }
}

function toggleCenterMessage() {
  centerMessageCollapsed = !centerMessageCollapsed;
  try { localStorage.setItem('xrzl_cm_collapsed', centerMessageCollapsed ? '1' : '0'); } catch (e) {}
  applyCenterMessageCollapsed();
}

// 白天提名列表（含每次提名的投票结果）：
// 讨论与提名已合并为同一阶段，讨论界面直接展示今日提名
function buildDayNominationsHtml(state) {
  if (!state.nominations || state.nominations.length === 0) return '';
  let html = '<div style="margin-top:8px;">今日提名：</div><div class="ss-grid">';
  html += state.nominations.map(n => {
    const nom = state.players.find(p => p.id === n.nominatorId);
    const nm = state.players.find(p => p.id === n.nomineeId);
    let resultHtml = '';
    if (n.resolved) {
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
        ? `<span style="color:#07C160; font-weight:bold;">✅ 通过 (${n.voteCount}票)</span>`
        : `<span style="color:#FA5151; font-weight:bold;">❌ 未通过 (${n.voteCount}票)</span>`;
      resultHtml = `<div style="margin:6px 0 8px 0; padding:8px 10px; background:rgba(0,0,0,0.04); border-radius:6px; border-left:3px solid ${n.passed ? '#07C160' : '#FA5151'};">
        <div style="margin-bottom:4px;">${passTag}</div>
        <div style="font-size:0.85em; line-height:1.6;">
          <div><span style="color:#07C160;">✅ 赞成(${yesVoters.length})：</span><span style="color:#4f4f4f;">${yesVoters.map(p => `${p.seat+1}号`).join(' ') || '—'}</span></div>
          <div><span style="color:#FA5151;">❌ 反对(${noVoters.length})：</span><span style="color:#4f4f4f;">${noVoters.map(p => `${p.seat+1}号`).join(' ') || '—'}</span></div>
          ${abstain.length > 0 ? `<div><span style="color:#999999;">⏳ 未投票(${abstain.length})：</span><span style="color:#999999;">${abstain.map(p => `${p.seat+1}号`).join(' ')}</span></div>` : ''}
        </div>
      </div>`;
    } else {
      resultHtml = ' <span style="color:#FF9500;">⏳ 投票中</span>';
    }
    return `<div style="font-size:0.95em;">
      <div>${nom ? nom.seat+1 : '?'}号提名 <strong>${nm ? nm.seat+1 : '?'}号 ${nm ? escapeHtml(nm.name) : ''}</strong></div>
      ${resultHtml}
    </div>`;
  }).join('') + '</div>';
  return html;
}

function renderCenter(state) {
  const actionPanel = $('actionPanel');
  const confirmBar = $('confirmBar');
  // 非结束阶段：重置胜利特效去重标记，便于下一局重新播放
  if (state.phase !== 'GAME_OVER') shownVictoryEffect = null;
  // 公开公告按钮随当前剧本动态显隐
  updateAnnounceButtonVisibility();
  
  let html = '';
  let msgClass = '';
  let showAction = false;
  let showConfirm = false;

  if (!state.gameStarted) {
    const me = state.players?.find(p => p.id === myId);
    const seatedCount = (state.players || []).filter(p => p.seat !== -1).length;
    const isHost = state.hostId === myId;
    // 大厅阶段不在聊天框内显示状态卡片（相关信息由中央剧本区 / 成员区呈现）
    html = '';

    showAction = true;
    $('actionTitle').textContent = '操作';

    // 大厅操作按钮：两个一行
    // 第一行 添加机器人 / 准备，第二行 自定义角色 / 开始游戏
    const lobbyButtons = [];
    if (isHost) {
      lobbyButtons.push({ cls: 'btn-warning', label: '+ 添加机器人', action: 'addBot()' });
    }
    if (me && me.seat !== -1) {
      lobbyButtons.push({
        cls: me.isReady ? 'btn-secondary' : 'btn-success',
        label: me.isReady ? '取消准备' : '准备',
        action: 'toggleReady()',
      });
    }
    if (isHost) {
      const customCount = Object.values(customRoleMap).filter(r => r).length;
      lobbyButtons.push({
        cls: customRoleMode ? 'btn-info' : 'btn-secondary',
        label: customRoleMode ? `🎭 自定义角色(${customCount})` : '🎭 自定义角色',
        action: 'openCustomRolePanel()',
      });
      const allReady = (state.players || []).filter(p => p.seat !== -1).every(p => p.isReady);
      lobbyButtons.push({
        cls: 'btn-primary',
        label: '开始游戏',
        action: 'startGame()',
        disabled: seatedCount < 5 || !allReady,
      });
    }

    $('selectedTargets').innerHTML = '';
    if (!lobbyButtons.length) {
      $('actionButtons').innerHTML = '';
    } else {
      // 数量为单数时，最后一个按钮占满整行，避免右侧留空
      const lastIdx = lobbyButtons.length - 1;
      const buttonsHtml = lobbyButtons.map((b, i) => {
        const span = (lobbyButtons.length % 2 === 1 && i === lastIdx) ? ' span-2' : '';
        const dis = b.disabled ? ' disabled' : '';
        return `<button class="btn btn-sm ${b.cls}${span}" onclick="${b.action}"${dis}>${b.label}</button>`;
      }).join('');
      $('actionButtons').innerHTML = `<div class="lobby-action-grid">${buttonsHtml}</div>`;
    }
  } else {
    switch(state.phase) {
      case 'FIRST_NIGHT': case 'NIGHT':
        msgClass = 'night';
        html = '<div style="color:#9b59b6;">🌙 夜幕降临</div>';
        if (state.isYourTurn) {
          html += '<div style="margin-top:10px; color:#FF9500;">正在等待你的行动...</div>';
        } else {
          html += '<div style="margin-top:10px; color:#999999;">等待其他玩家行动...</div>';
        }
        break;

      case 'NIGHT_WAKE':
        msgClass = 'night';
        html = state.isYourTurn
          ? '<div style="color:#9b59b6;">🌙 你的回合</div>'
          : '<div style="color:#9b59b6;">🌙 夜幕降临</div><div style="margin-top:10px; color:#999999;">等待其他玩家行动...</div>';
        break;

      case 'DAY_DAWN':
        msgClass = 'dawn';
        html = '<div style="color:#FF9500;">☀️ 天亮了</div>';
        if (state.deathsToAnnounce && state.deathsToAnnounce.length > 0) {
          html += '<div style="margin-top:8px;">昨晚死亡的玩家：</div>';
          html += `<div class="ss-row">${state.deathsToAnnounce.map(d =>
            `<span class="ss-chip dead">${d.seat+1}号 ${escapeHtml(d.name)}</span>`
          ).join('')}</div>`;
        } else {
          html += '<div style="margin-top:8px; color:#06AD56;">平安夜，无人死亡</div>';
        }
        // 天亮自动进入白天，无需全员确认
        html += '<div style="margin-top:10px; color:#999999; font-size:0.9em;">即将自动进入白天...</div>';
        break;

      case 'DAY_DISCUSSION':
        msgClass = '';
        html = `<div>💬 自由讨论 / 提名 - 第${state.dayCount}天</div>`;
        html += '<div style="margin-top:10px; color:#7f7f7f; font-size:0.9em;">点击右侧玩家可提名；全员确认后立即结算处决</div>';
        html += buildDayNominationsHtml(state);
        showConfirm = true;
        break;

      case 'NOMINATION_PHASE':
        // 兼容旧存档/旧广播：提名已并入白天讨论阶段
        msgClass = '';
        html = `<div>💬 自由讨论 / 提名 - 第${state.dayCount}天</div>`;
        html += buildDayNominationsHtml(state);
        showConfirm = true;
        break;

      case 'DEFENSE':
        const defNom = state.nominations && state.nominations.length > 0 ? state.nominations[state.nominations.length - 1] : null;
        const defNominator = defNom ? state.players.find(p => p.id === defNom.nominatorId) : null;
        const defNominee = defNom ? state.players.find(p => p.id === defNom.nomineeId) : null;
        const nominatorText = defNominator ? `${defNominator.seat+1}号 ${defNominator.name}` : '?';
        const nomineeText = defNominee ? `${defNominee.seat+1}号 ${defNominee.name}` : '?';
        if (state.currentDefensePlayerId === myId) {
          html = '<div style="color:#FA5151;">⚖️ 你被提名了！请辩护</div>';
          html += `<div style="margin-top:8px; font-size:0.9em; color:#666666;">提名者：<span style="color:#FF9500;">${nominatorText}</span></div>`;
          html += '<div style="margin-top:10px;">辩护完毕后点击按钮进入投票</div>';
          showAction = true;
          $('actionTitle').textContent = '辩护';
          $('selectedTargets').innerHTML = '';
          $('actionButtons').innerHTML = `<button class="btn btn-primary" onclick="endDefense()">辩护完毕</button>`;
        } else {
          const def = state.players.find(p => p.id === state.currentDefensePlayerId);
          html = `<div style="color:#FF9500;">⚖️ ${def ? def.seat+1+'号 '+def.name : ''} 正在辩护...</div>`;
          html += `<div style="margin-top:8px; font-size:0.9em; color:#666666;">提名者：<span style="color:#FF9500;">${nominatorText}</span></div>`;
        }
        break;

      case 'VOTING':
        html = '<div style="color:#FA5151;">🗳️ 投票中</div>';
        const curNom = state.nominations ? state.nominations[state.nominations.length-1] : null;
        const nominee = curNom ? state.players.find(p => p.id === curNom.nomineeId) : null;
        const nominator = curNom ? state.players.find(p => p.id === curNom.nominatorId) : null;
        if (nominee) {
          html += `<div style="margin-top:10px; font-size:1.2em;">是否处决 ${nominee.seat+1}号 ${nominee.name}？</div>`;
          if (nominator) {
            html += `<div style="margin-top:6px; font-size:0.9em; color:#666666;">提名者：<span style="color:#FF9500;">${nominator.seat+1}号 ${nominator.name}</span></div>`;
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
            ? '<span style="color:#07C160; font-weight:bold;">✅ 已投赞成</span>'
            : '<span style="color:#FA5151; font-weight:bold;">❌ 已投反对</span>';
          if (hasUnvoted) {
            $('actionButtons').innerHTML = `
              <div style="text-align:center; margin-bottom:8px;">${voteLabel}</div>
              <button class="btn btn-sm btn-warning" onclick="revokeVote()" style="width:100%;">↩️ 撤回投票</button>
            `;
          } else {
            $('actionButtons').innerHTML = `<div style="text-align:center;">${voteLabel}<br><span style="color:#7f7f7f; font-size:0.85em;">投票即将结束...</span></div>`;
          }
        } else {
          // 未投票：显示投票按钮
          // 管家：主人尚未投赞成时禁用「赞成」（判定由服务端下发，含中毒豁免）
          const butlerBlocked = !!(state.myAbilityState && state.myAbilityState.butlerYesBlocked);
          $('actionButtons').innerHTML = `
            <button class="btn btn-success vote-btn yes" onclick="castVote(true)" ${butlerBlocked ? 'disabled' : ''}>赞成处决</button>
            <button class="btn btn-danger vote-btn no" onclick="castVote(false)">反对</button>
            ${butlerBlocked ? '<div style="text-align:center; margin-top:8px; color:#FF9500; font-size:0.85em;">你是管家，需主人先投赞成后才能赞成</div>' : ''}
          `;
        }
        break;

      case 'EXECUTION':
        // 处决自动结算：动画播放完毕后自动进入夜晚，无需确认
        html = '<div>⚰️ 处决中...</div>';
        html += '<div style="margin-top:10px; color:#7f7f7f; font-size:0.9em;">处决结果揭晓后自动进入夜晚</div>';
        break;

      case 'GAME_OVER':
        if (state.winner === 'GOOD') {
          msgClass = 'victory-good';
          html = '<div style="font-size:1.5em;">🎉 善良阵营胜利！</div>';
        } else {
          msgClass = 'victory-evil';
          html = '<div style="font-size:1.5em;">💀 邪恶阵营胜利！</div>';
        }
        html += `<div style="margin-top:10px; color:#7f7f7f;">${state.winReason || ''}</div>`;
        showAction = true;
        $('actionTitle').textContent = '游戏结束';
        $('selectedTargets').innerHTML = '';
        $('actionButtons').innerHTML = `<button class="btn btn-primary btn-sm" onclick="backToHome()">返回大厅</button>`;
        if (state.allRoles) showGameOverRoles(state.allRoles);
        playVictoryEffect(state.winEffect);
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
        infoHtml += `<div style="min-width:0;">
          <div style="color:#07C160; font-size:0.8em; margin-bottom:4px; opacity:0.8;">${dayLabel}</div>
          <div class="ss-grid" style="margin-top:0;">`;
        byDay[day].forEach(info => {
          // 多行信息用独立卡片承载，避免多条信息连在一起难以分辨
        infoHtml += `<div style="color:#0FA958; line-height:1.5; font-size:0.85em; padding:6px 9px; background:rgba(0,0,0,0.03); border-radius:4px; white-space:pre-wrap;">${escapeHtml(info.message).replace(/\n/g, '<br>')}</div>`;
        });
        infoHtml += '</div></div>';
      });

      html += `<div class="ss-block" style="padding:10px 12px; background:rgba(7,193,96,0.08); border-left:3px solid #07C160; border-radius:4px;">
        <div style="color:#07C160; font-size:0.85em; margin-bottom:6px; letter-spacing:1px; display:flex; justify-content:space-between; align-items:center;">
          <span>📜 你的信息</span>
          <span style="font-size:0.85em; opacity:0.6;">共 ${infoList.length} 条</span>
        </div>
        <div class="ss-grid" style="margin-top:0;">${infoHtml}</div>
      </div>`;
    }
  }

  // 系统状态 / 操作说明 → 渲染到中央系统信息区
  systemMessageHtml = html;
  systemMessageClass = msgClass;
  renderCenterMessage();
  actionPanel.style.display = showAction || (state.phase === 'DEFENSE' && state.currentDefensePlayerId === myId) || state.phase === 'VOTING' ? 'block' : 'none';
  confirmBar.style.display = showConfirm ? 'block' : 'none';

  if (showConfirm) {
    const confirmed = state.confirmedCount || 0;
    const total = state.totalNeeded || 1;
    const pct = Math.min((confirmed / total) * 100, 100);
    $('confirmText').textContent = `确认进度: ${confirmed}/${total}`;
    $('confirmProgressFill').style.width = pct + '%';
    // 白天阶段确认即结束讨论并执行处决
    const confirmBtn = $('confirmBtn');
    if (confirmBtn) {
      confirmBtn.textContent = state.phase === 'DAY_DISCUSSION' || state.phase === 'NOMINATION_PHASE'
        ? '结束讨论并执行处决'
        : '我已准备好，进入下一阶段';
    }

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

// 生成「我的身份」信息卡片 HTML
function buildRoleInfoHtml(state, role, me) {
  if (!role || !me) return '';
  const isGood = role.team === 'GOOD';
  const teamText = isGood ? '善良阵营' : '邪恶阵营';
  const seatText = me.seat >= 0 ? `${me.seat + 1}号 ` : '';

  let html = `<div class="my-role-card${isGood ? '' : ' evil'}">
    <div class="my-role-head">
      <span class="my-role-icon${isGood ? '' : ' evil'}">${isGood ? '善' : '恶'}</span>
      <span class="my-role-name">${escapeHtml(role.name)}</span>
      <span class="my-role-team${isGood ? '' : ' evil'}">${teamText}</span>
      <span class="my-role-seat">${escapeHtml(seatText + me.name)}</span>
    </div>`;

  if (role.abilityDesc) {
    html += `<div class="my-role-desc">${escapeHtml(role.abilityDesc)}</div>`;
  }
  if (state.evilTeam && role.team === 'EVIL') {
    const mates = state.evilTeam
      .filter(p => p.id !== myId)
      .map(p => `${p.seat + 1}号${p.name}【${p.roleName}】`)
      .join('、');
    if (mates) html += `<div class="my-role-teammates">队友：${escapeHtml(mates)}</div>`;
    if (state.notInPlay && role.category === 'DEMON') {
      html += `<div class="my-role-teammates">不在场身份：${escapeHtml(state.notInPlay.join('、'))}</div>`;
    }
  }
  return html + '</div>';
}

function renderRoleCard(state) {
  const card = $('roleCard');
  const me = state.players?.find(p => p.id === myId);
  
  if (!state.yourRole || !me) {
    card.style.display = 'none';
    return;
  }

  // 底部身份卡不再展示：身份信息展示在中央系统信息区
  card.style.display = 'none';
  roleInfoHtml = buildRoleInfoHtml(state, state.yourRole, me);
  
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
    // 技能整局限一次：已使用后按钮保留可见，但文字改为「已使用」并禁用
    const slayerUsed = !!(state.myAbilityState && state.myAbilityState.usedDayAbility);
    slayerBtn.style.display = 'block';
    slayerBtn.textContent = slayerUsed ? '杀手：已使用' : '杀手：击杀恶魔';
    slayerBtn.disabled = slayerUsed;
    slayerBtn.classList.toggle('disabled', slayerUsed);
  } else {
    slayerBtn.style.display = 'none';
    slayerBtn.disabled = false;
    slayerBtn.textContent = '杀手：击杀恶魔';
    slayerBtn.classList.remove('disabled');
  }

  const gossipBtn = $('gossipBtn');
  const todayGossipUsed = state.privateInfoHistory && state.privateInfoHistory.some(
    info => info.type === 'gossip' && info.day === state.dayCount
  );
  if (role.id === 'gossip' && me.isAlive &&
      (state.phase === 'DAY_DISCUSSION' || state.phase === 'NOMINATION_PHASE')) {
    // 判定中 / 今天已成功发表 → 禁用；发表失败（裁判判定服务不可用）后恢复可点击
    const gossipDisabled = gossipPending || todayGossipUsed;
    gossipBtn.style.display = 'block';
    gossipBtn.disabled = gossipDisabled;
    gossipBtn.classList.toggle('disabled', gossipDisabled);
    if (gossipPending) {
      // 请求进行中：旋转圈 + 文案提示，避免玩家误以为无响应
      gossipBtn.innerHTML = '<span class="btn-loading-spinner"></span>造谣者：判定中...';
    } else {
      gossipBtn.textContent = todayGossipUsed ? '造谣者：今日已发表' : '造谣者：发表声明';
    }
  } else {
    gossipBtn.style.display = 'none';
    gossipBtn.disabled = false;
    gossipBtn.classList.remove('disabled');
    gossipBtn.textContent = '造谣者：发表声明';
  }

  const moonchildBtn = $('moonchildBtn');
  const pendingMoonchild = state.myAbilityState && state.myAbilityState.pendingMoonchildSelect;
  if (role.id === 'moonchild' && pendingMoonchild &&
      (state.phase === 'DAY_DAWN' || state.phase === 'DAY_DISCUSSION' || state.phase === 'NOMINATION_PHASE' || state.phase === 'EXECUTION' || state.phase === 'VOTING' || state.phase === 'DEFENSE')) {
    moonchildBtn.style.display = 'block';
  } else {
    moonchildBtn.style.display = 'none';
  }

  // ===== 紫罗兰教派白天技能 =====
  const myAbility = state.myAbilityState || {};
  const isDayActionPhase = state.phase === 'DAY_DISCUSSION' || state.phase === 'NOMINATION_PHASE';

  // 艺术家：每局限一次
  const artistBtn = $('artistBtn');
  if (artistBtn) {
    const artistUsed = !!myAbility.artistUsed;
    const artistPending = !!myAbility.artistPendingAnswer;
    const artistLocked = artistUsed || artistPending;
    if (role.id === 'artist' && me.isAlive && isDayActionPhase) {
      artistBtn.style.display = 'block';
      artistBtn.textContent = artistUsed
        ? '艺术家：已使用'
        : (artistPending ? '艺术家：等待说书人回答…' : '艺术家：向说书人提问');
      artistBtn.disabled = artistLocked;
      artistBtn.classList.toggle('disabled', artistLocked);
    } else {
      artistBtn.style.display = 'none';
      artistBtn.disabled = false;
      artistBtn.classList.remove('disabled');
      artistBtn.textContent = '艺术家：向说书人提问';
    }
  }

  // 学者：每天一次
  const savantBtn = $('savantBtn');
  if (savantBtn) {
    const savantAsked = !!myAbility.savantAskedToday;
    const savantPending = !!myAbility.savantPendingAnswer;
    const savantLocked = savantAsked || savantPending;
    if (role.id === 'savant' && me.isAlive && isDayActionPhase) {
      savantBtn.style.display = 'block';
      savantBtn.textContent = savantAsked
        ? '学者：今日已提问'
        : (savantPending ? '学者：等待说书人回答…' : '学者：提问两个问题');
      savantBtn.disabled = savantLocked;
      savantBtn.classList.toggle('disabled', savantLocked);
    } else {
      savantBtn.style.display = 'none';
      savantBtn.disabled = false;
      savantBtn.classList.remove('disabled');
      savantBtn.textContent = '学者：提问两个问题';
    }
  }

  // 杂耍艺人：仅首个白天可公开猜测（一次性选完，提交后禁用）
  const jugglerBtn = $('jugglerBtn');
  if (jugglerBtn) {
    const jugglerDone = !!myAbility.jugglerDone;
    if (role.id === 'juggler' && me.isAlive && state.dayCount === 1 && isDayActionPhase) {
      jugglerBtn.style.display = 'block';
      jugglerBtn.textContent = jugglerDone
        ? '杂耍艺人：已公开猜测'
        : '杂耍艺人：猜角色（最多5个）';
      jugglerBtn.disabled = jugglerDone;
      jugglerBtn.classList.toggle('disabled', jugglerDone);
    } else {
      jugglerBtn.style.display = 'none';
      jugglerBtn.disabled = false;
      jugglerBtn.classList.remove('disabled');
      jugglerBtn.textContent = '杂耍艺人：猜角色';
    }
  }

  // 变种人：每天可公开声称外来者
  const mutantBtn = $('mutantBtn');
  if (mutantBtn) {
    mutantBtn.style.display = (role.id === 'mutant' && me.isAlive && isDayActionPhase) ? 'block' : 'none';
  }

  // 洗脑宣告：被洗脑的玩家（任意角色）当天必须公开声称指定角色
  const cerenovusBtn = $('cerenovusBtn');
  if (cerenovusBtn) {
    if (myAbility.cerenovusClaimRole) {
      cerenovusBtn.style.display = 'block';
      cerenovusBtn.textContent = `洗脑宣告：我是${myAbility.cerenovusClaimRole}`;
    } else {
      cerenovusBtn.style.display = 'none';
      cerenovusBtn.textContent = '洗脑宣告';
    }
  }

  // 傻瓜：死亡后公开选择一名存活玩家
  const klutzBtn = $('klutzBtn');
  if (klutzBtn) {
    const klutzPhases = ['DAY_DAWN', 'DAY_DISCUSSION', 'NOMINATION_PHASE', 'EXECUTION', 'VOTING', 'DEFENSE'];
    const showKlutz = role.id === 'klutz' && !!myAbility.pendingKlutzSelect && klutzPhases.includes(state.phase);
    klutzBtn.style.display = showKlutz ? 'block' : 'none';
  }

  const deadTab = $('deadChatTab');
  if (deadTab) deadTab.style.display = me.isDead ? 'block' : 'none';

  // 身份技能按钮栏（右栏）
  const abilityBar = $('roleAbilityBar');
  if (abilityBar) {
    const abilityButtons = [slayerBtn, gossipBtn, moonchildBtn,
      $('artistBtn'), $('savantBtn'), $('jugglerBtn'),
      $('mutantBtn'), $('cerenovusBtn'), $('klutzBtn')];
    const anyShown = abilityButtons.some(b => b && b.style.display === 'block');
    abilityBar.style.display = anyShown ? 'flex' : 'none';
  }

  renderCenterMessage();
  renderSessionList();
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
  // 轮到自己行动：总是先展开行动面板，并显示「查看局势」入口
  setNightPeek(false);
  const peekBtn = $('nightPeekBtn');
  if (peekBtn) peekBtn.style.display = 'flex';
  text.textContent = `你的回合：${data.role}`;
  subtext.innerHTML = (data.message || '').replace(/\n/g, '<br>');
  
  nightSelectedTargets = [];
  nightSelectedRoleId = null;
  nightSelectType = data.selectType || 'player';
  // 纯信息类（如间谍查看魔典）左对齐并允许滚动，长文本更易阅读
  subtext.classList.toggle('info-list', nightSelectType === 'info');
  nightCanSkip = data.canSkip || false;
  // 跳过按钮文案可按角色定制（如小恶魔为「空刀」）
  skipBtn.textContent = data.skipLabel || '跳过/不使用';
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
        if (nightSelectType === 'playerAndRole') {
          // 猜角色玩法（如赌徒）：只需一名玩家 + 一个角色
          const idx = nightSelectedTargets.indexOf(p.id);
          if (idx >= 0) {
            nightSelectedTargets.splice(idx, 1);
            btn.classList.remove('selected');
            nightSelectedPlayerForRole = null;
            nightSelectedRoleId = null;
            nightPlayerAndRoleStep = 'player';
            renderPlayerAndRole();
          } else {
            document.querySelectorAll('.night-player-btn.selected').forEach(b => b.classList.remove('selected'));
            nightSelectedTargets = [p.id];
            btn.classList.add('selected');
            nightSelectedPlayerForRole = p.id;
            nightPlayerAndRoleStep = 'role';
            renderPlayerAndRole();
          }
          updateConfirmState();
          return;
        }
        // 普通选人：按 canSelectCount 支持多选（如占卜师需选两名玩家）
        toggleNightTarget(p.id, btn);
        updateConfirmState();
      };
      selectArea.appendChild(btn);
    });
  }

  function renderRoleButtons(onConfirm) {
    if (!data.selectRoles) return;
    const roleHint = document.createElement('div');
    roleHint.style.cssText = 'color:#07C160;margin:12px 0 8px;font-size:14px;';
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
    playerTitle.style.cssText = 'color:#10AEFF;margin-bottom:6px;font-size:13px;font-weight:bold;display:flex;align-items:center;gap:6px;flex-shrink:0;';
    playerTitle.innerHTML = '<span style="display:inline-block;width:18px;height:18px;background:#10AEFF;border-radius:50%;color:#191919;text-align:center;line-height:18px;font-size:11px;">1</span>选择玩家';
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
    divider.style.cssText = 'width:1px;background:rgba(0,0,0,0.09);flex-shrink:0;';
    selectArea.appendChild(divider);

    const roleSection = document.createElement('div');
    roleSection.style.cssText = 'flex:1.5;min-width:0;display:flex;flex-direction:column;';
    const roleTitle = document.createElement('div');
    roleTitle.style.cssText = 'color:#07C160;margin-bottom:6px;font-size:13px;font-weight:bold;display:flex;align-items:center;gap:6px;flex-shrink:0;';
    roleTitle.innerHTML = '<span style="display:inline-block;width:18px;height:18px;background:#07C160;border-radius:50%;color:#000;text-align:center;line-height:18px;font-size:11px;">2</span>猜测角色';
    roleSection.appendChild(roleTitle);

    const hint = document.createElement('div');
    hint.className = 'role-selected-hint';
    hint.style.cssText = 'color:#8c8c8c;font-size:11px;margin-bottom:6px;flex-shrink:0;';
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
  setNightPeek(false);
}

// 夜间行动时临时收起遮罩，便于查看当前局势（角色信息 / 聊天 / 座位等）
function setNightPeek(peek) {
  const overlay = $('nightOverlay');
  const fab = $('nightPeekFab');
  nightPeeked = !!peek;
  if (overlay) overlay.classList.toggle('peeked', nightPeeked);
  if (fab) fab.style.display = nightPeeked ? 'flex' : 'none';
}

function toggleNightPeek() {
  const overlay = $('nightOverlay');
  if (!overlay) return;
  // 收起后再次点击（浮动按钮）恢复行动面板
  if (!nightPeeked && !overlay.classList.contains('active')) return;
  setNightPeek(!nightPeeked);
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
  // 查看局势只在自己的行动回合可用，等待阶段恢复整屏遮罩
  setNightPeek(false);
  const peekBtn = $('nightPeekBtn');
  if (peekBtn) peekBtn.style.display = 'none';
  text.textContent = '夜幕降临';
  subtext.classList.remove('info-list');
  subtext.textContent = '等待其他玩家行动...';
  selectArea.innerHTML = '';
  confirmBtn.style.display = 'none';
  skipBtn.style.display = 'none';
}

function handleNightOverlay(state) {
  if (state.isNight && state.phase !== 'GAME_OVER') {
    const overlay = $('nightOverlay');
    if (state.isYourTurn && state.phase === 'NIGHT_WAKE') {
      // 正常由 night:wake 事件唤起 showNightWake；若刷新/掉线重连漏收了该事件，
      // 用状态里缓存的唤醒信息补出行动面板，避免页面一直停在「等待其他玩家行动」。
      if (!overlay.classList.contains('wake') && state.nightWake) {
        showNightWake(state.nightWake);
      }
    } else if (!state.isYourTurn) {
      showWaitingNight();
    }
  } else {
    hideNightOverlay();
  }
}

// ========== 白天交互 ==========
async function nominatePlayer(targetId) {
  const originEl = getLoadingClickTarget();
  const phase = currentState.phase;
  if (phase !== 'DAY_DISCUSSION' && phase !== 'NOMINATION_PHASE') {
    showToast('现在不是提名时间');
    return;
  }
  const me = currentState.players.find(p => p.id === myId);
  if (!me) {
    showToast('你不在游戏中');
    return;
  }
  // 死亡玩家不能发起提名（死后投票标记仅用于投票）
  if (!me.isAlive || me.isDead) {
    showToast('死亡玩家不能发起提名');
    return;
  }
  const target = currentState.players.find(p => p.id === targetId);
  if (!target) return;
  const deadHint = target.isDead ? '（该玩家已死亡）' : '';
  const ok = await showConfirm(`确定提名 ${target.seat+1}号 ${target.name}${deadHint} 吗？`, { title: '提名确认' });
  if (ok) {
    emitRequest('day:nominates', { targetId }, originEl);
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
  // 管家：主人未投赞成时不能投赞成（服务端同样会拦截）
  if (vote && currentState.myAbilityState && currentState.myAbilityState.butlerYesBlocked) {
    showToast('你是管家，需主人先投赞成后才能赞成');
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

// 处决动画：仅在真正有人被处决时播放（平安日 / 平票 / 被拯救 / 免死均不播放）
let executionEffectTimer = null;
let lastExecutionInfo = null;
function showExecutionResult(data) {
  if (!data) return;
  // 记录本次处决结果，供「处决结束 → 入夜」的转场动画展示
  lastExecutionInfo = data;
  if (!data.executedId) return;
  playExecutionEffect(data);
}

function hideExecutionEffectNow() {
  const overlay = $('executionEffect');
  if (!overlay) return;
  if (executionEffectTimer) {
    clearTimeout(executionEffectTimer);
    executionEffectTimer = null;
  }
  overlay.classList.remove('active', 'hiding');
}

function playExecutionEffect(data) {
  const overlay = $('executionEffect');
  if (!overlay) return;
  const nameEl = $('executionEffectName');
  if (nameEl) {
    const seat = Number.isInteger(data.seat) ? `${data.seat + 1}号 ` : '';
    nameEl.textContent = `${seat}${data.name || ''} 被处决`;
  }
  // 重置后再添加，确保连续处决时动画能重新播放
  overlay.classList.remove('active', 'hiding');
  void overlay.offsetWidth;
  overlay.classList.add('active');
  if (executionEffectTimer) clearTimeout(executionEffectTimer);
  executionEffectTimer = setTimeout(() => {
    executionEffectTimer = null;
    overlay.classList.add('hiding');
    setTimeout(() => overlay.classList.remove('active', 'hiding'), 480);
  }, 2600);
}

// ========== 昼夜转场动画 ==========
// direction: 'day' 天亮（月亮落山、太阳升起顶替）| 'night' 入夜（太阳落山、月亮升起顶替）
// 天体固定悬在天空同一位置，旧的沉入地平线，新的从地平线下升起，结果文案随后在中央显示
const PHASE_TRANSITION_ANIM_MS = 2200;   // 天体落山/升起动画时长（与 CSS 保持一致）
const PHASE_TRANSITION_FADE_MS = 420;    // 整层淡出时长
const PHASE_TRANSITION_HOLD_MS = { day: 1500, night: 900 }; // 动画结束后停留观看结果的时长
let phaseTransitionTimers = [];
function clearPhaseTransitionTimers() {
  phaseTransitionTimers.forEach(t => clearTimeout(t));
  phaseTransitionTimers = [];
}

function playPhaseTransition(direction, title, body) {
  const overlay = $('phaseTransition');
  if (!overlay) return;
  // 与处决动画可能时间重叠，先收掉处决特效，避免两层动画叠在一起
  hideExecutionEffectNow();
  clearPhaseTransitionTimers();

  const titleEl = $('phaseTransitionTitle');
  const bodyEl = $('phaseTransitionBody');
  if (titleEl) titleEl.textContent = title || '';
  if (bodyEl) bodyEl.textContent = body || '';

  const isNight = direction === 'night';
  overlay.classList.remove('active', 'to-day', 'to-night', 'leaving');
  void overlay.offsetWidth; // 强制重排，保证连续两次转场动画都能重新播放
  overlay.classList.add('active', isNight ? 'to-night' : 'to-day');

  // 动画播放完先停留一段时间展示结果，再整层淡出
  const hold = isNight ? PHASE_TRANSITION_HOLD_MS.night : PHASE_TRANSITION_HOLD_MS.day;
  phaseTransitionTimers.push(setTimeout(() => {
    overlay.classList.add('leaving');
    phaseTransitionTimers.push(setTimeout(() => {
      overlay.classList.remove('active', 'to-day', 'to-night', 'leaving');
      phaseTransitionTimers = [];
    }, PHASE_TRANSITION_FADE_MS));
  }, PHASE_TRANSITION_ANIM_MS + hold));
}

const DAY_PHASES = ['DAY_DAWN', 'DAY_DISCUSSION', 'NOMINATION_PHASE', 'DEFENSE', 'VOTING', 'EXECUTION'];
function handlePhaseChange(prevPhase, nextPhase) {
  if (!prevPhase) return; // 首次渲染 / 断线重连时不播放
  // 白天结束（处决/平安日/平票）进入夜晚：太阳 → 月亮
  // 入夜后可能立刻唤醒玩家（NIGHT_WAKE），因此两种情况都算进入夜晚
  if (DAY_PHASES.includes(prevPhase) && (nextPhase === 'NIGHT' || nextPhase === 'NIGHT_WAKE' || nextPhase === 'FIRST_NIGHT')) {
    playPhaseTransition('night', '夜幕降临', buildExecutionSummary());
  }
  if (nextPhase === 'DAY_DAWN') {
    // 天亮动画由 game:dawnReport 驱动（需要死亡名单），这里只重置上一次的处决结果
    lastExecutionInfo = null;
  }
}

function buildExecutionSummary() {
  const info = lastExecutionInfo;
  if (!info) return '今日无人被处决';
  if (info.executedId) {
    const seat = Number.isInteger(info.seat) ? `${info.seat + 1}号 ` : '';
    return `${seat}${info.name || ''} 被处决`;
  }
  return info.message || '今日无人被处决';
}

function confirmPhase() {
  socket.emit('game:confirm');
}

async function useSlayerAbility() {
  const originEl = getLoadingClickTarget();
  const players = currentState.players.filter(p => p.isAlive && p.seat !== -1 && p.id !== myId);
  const selectedId = await showPlayerSelect('杀手技能：选择要击杀的玩家', players, { type: 'warning', confirmText: '选择' });
  if (selectedId) {
    const target = players.find(p => p.id === selectedId);
    if (target) {
      const ok = await showConfirm(`确定对 ${target.seat+1}号 ${target.name} 使用杀手技能吗？每局只能使用一次。`, { type: 'warning', title: '杀手技能', confirmText: '确认击杀' });
      if (ok) {
        emitRequest('day:useAbility', { abilityName: 'slayer', targetId: selectedId }, originEl);
      }
    }
  }
}

async function useGossipAbility() {
  if (gossipPending) return; // 等待裁判判定结果期间不可重复发动
  const originEl = getLoadingClickTarget();
  const retryStatement = gossipRetryStatement;
  const statement = await showTextInput('造谣者：发表公开声明', {
    placeholder: '输入你的声明（2-200字）...',
    description: retryStatement
      ? '上次声明因裁判判定服务异常未能发表，已自动填入原文，可直接重新发表。<br>规则：今晚裁判会判断你的声明是否为真。若声明为真且你未中毒/醉酒，今晚一名玩家会死亡。'
      : '规则：今晚裁判会判断你的声明是否为真。若声明为真且你未中毒/醉酒，今晚一名玩家会死亡。',
    defaultValue: retryStatement,
    maxLength: 200,
    minLength: 2,
    multiline: true,
    type: 'warning',
    confirmText: '发表声明',
    cancelText: '取消'
  });
  if (statement) {
    startGossipPending();
    emitRequest('day:useAbility', { abilityName: 'gossip', statement: statement }, originEl);
  }
}

// 声明提交后进入「判定中」：按钮禁用，由服务端下发的 gossip:result 决定恢复或保持禁用
function startGossipPending() {
  gossipPending = true;
  if (gossipPendingTimer) clearTimeout(gossipPendingTimer);
  gossipPendingTimer = setTimeout(() => {
    gossipPendingTimer = null;
    if (!gossipPending) return;
    gossipPending = false;
    if (currentState) renderGameState(currentState);
  }, 30000);
  if (currentState) renderGameState(currentState);
}

function clearGossipPending() {
  gossipPending = false;
  if (gossipPendingTimer) {
    clearTimeout(gossipPendingTimer);
    gossipPendingTimer = null;
  }
}

async function useMoonchildAbility() {
  const originEl = getLoadingClickTarget();
  const players = currentState.players.filter(p => p.isAlive && p.seat !== -1);
  const selectedId = await showPlayerSelect('月之子：公开选择一名玩家', players, { type: 'info', confirmText: '公开选择' });
  if (selectedId) {
    const target = players.find(p => p.id === selectedId);
    if (target) {
      const ok = await showConfirm(`确定选择 ${target.seat+1}号 ${target.name} 吗？所有人都会看到你的选择。如果TA是善良的，今晚TA会死亡。`, { type: 'info', title: '月之子选择', confirmText: '确认选择' });
      if (ok) {
        emitRequest('day:useAbility', { abilityName: 'moonchild', targetId: selectedId }, originEl);
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
      btn.style.cssText = 'padding:8px 6px;background:rgba(0,0,0,0.05);border:1px solid rgba(0,0,0,0.09);border-radius:6px;color:#191919;cursor:pointer;font-size:13px;font-family:inherit;transition:all 0.15s;';
      btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(250,81,81,0.3)'; btn.style.borderColor = 'rgba(250,81,81,0.6)'; });
      btn.addEventListener('mouseleave', () => {
        if (!btn.classList.contains('psel')) {
          btn.style.background = 'rgba(0,0,0,0.05)';
          btn.style.borderColor = 'rgba(0,0,0,0.09)';
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

// 角色选择弹窗（杂耍艺人猜角色等）
function showRoleSelect(title, roles, options = {}) {
  return new Promise((resolve) => {
    const type = options.type || 'info';
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    const buttons = roles.map(r =>
      `<button class="slayer-player-btn" data-rid="${r.id}" title="${r.team === 'GOOD' ? '善良阵营' : '邪恶阵营'}">${r.name}</button>`
    ).join('');
    overlay.innerHTML = `
      <div class="confirm-dialog confirm-type-${type}" style="min-width:340px;max-width:520px;">
        <div class="confirm-title">${title}</div>
        <div class="confirm-input-area" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:6px;max-height:50vh;overflow-y:auto;">
          ${buttons}
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
      btn.style.cssText = 'padding:8px 6px;background:rgba(0,0,0,0.05);border:1px solid rgba(0,0,0,0.09);border-radius:6px;color:#191919;cursor:pointer;font-size:13px;font-family:inherit;transition:all 0.15s;';
      btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(7,193,96,0.25)'; btn.style.borderColor = 'rgba(7,193,96,0.6)'; });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'rgba(0,0,0,0.05)';
        btn.style.borderColor = 'rgba(0,0,0,0.09)';
      });
      btn.addEventListener('click', () => close(btn.dataset.rid));
    });

    overlay.querySelector('.confirm-cancel').addEventListener('click', () => close(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });

    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } };
    document.addEventListener('keydown', onKey);

    requestAnimationFrame(() => overlay.classList.add('confirm-show'));
  });
}

// ========== 紫罗兰教派：白天技能 ==========
async function useArtistAbility() {
  const originEl = getLoadingClickTarget();
  // 上次裁判服务失败时，自动回填上次的问题，避免重新输入
  const last = (currentState && currentState.myAbilityState && currentState.myAbilityState.artistLastQuestion) || '';
  const question = await showTextInput('艺术家：向说书人提问', {
    placeholder: '输入一个是非题（例如：3号是恶魔吗？）',
    description: last
      ? '上次提问未能送达说书人（裁判服务不可用），已为你填回上次的问题，可直接重试。'
      : '每局游戏限一次。说书人会给出真实答案（混沌在场时答案会被反转）。',
    defaultValue: last,
    maxLength: 120, minLength: 2, multiline: false,
    type: 'success', confirmText: '向说书人提问'
  });
  if (question) {
    emitRequest('day:useAbility', { abilityName: 'artist', extra: question }, originEl);
  }
}

async function useSavantAbility() {
  const originEl = getLoadingClickTarget();
  // 上次裁判服务失败时，自动回填上次的问题，避免重新输入
  const last = (currentState && currentState.myAbilityState && currentState.myAbilityState.savantLastQuestions) || null;
  // 两个问题在同一个弹窗里填写，避免分两步输入
  const questions = await showDoubleTextInput('学者：向说书人提问', {
    labels: ['第一个问题', '第二个问题'],
    placeholders: ['例如：3号是恶魔吗？', '例如：7号是爪牙吗？'],
    description: last
      ? '上次提问未能送达说书人（裁判服务不可用），已为你填回上次的问题，可直接重试。'
      : '每天可以私下问两个是非题，你会得到一个真话和一个假话（你不会知道哪个是真）。',
    defaultValues: last || ['', ''],
    maxLength: 120, minLength: 2,
    type: 'success', confirmText: '提交两个问题'
  });
  if (!questions) return;
  emitRequest('day:useAbility', { abilityName: 'savant', extra: questions }, originEl);
}

async function useJugglerAbility() {
  const originEl = getLoadingClickTarget();
  if (currentState && currentState.myAbilityState && currentState.myAbilityState.jugglerDone) {
    showToast('你本局已经公开猜测过了');
    return;
  }
  const guesses = await showJugglerGuessesDialog('杂耍艺人：公开猜测', {
    description: '一次性选完要公开猜测的玩家与角色（最多5名），提交后整批猜测会一起公布给你看到的所有人。'
  });
  if (!guesses || guesses.length === 0) return;
  emitRequest('day:useAbility', {
    abilityName: 'juggler',
    extra: { guesses: guesses.map(g => ({ targetId: g.targetId, roleId: g.roleId })) }
  }, originEl);
}

// 杂耍艺人：一次性选择整批「玩家 + 角色」猜测（真实技能与公开公告伪装共用同一套选择方式）
function showJugglerGuessesDialog(title, options = {}) {
  const MAX = 5;
  const players = ((currentState && currentState.players) || [])
    .filter(p => p.seat !== -1 && p.isAlive)
    .sort((a, b) => a.seat - b.seat);
  const scriptId = (currentState && currentState.script) || 'tb';
  const roles = ALL_ROLE_INFO.filter(r => r.script === scriptId)
    .map(r => ({ id: r.id, name: r.name, team: r.team }));

  return new Promise((resolve) => {
    if (players.length === 0 || roles.length === 0) { resolve(null); return; }

    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog confirm-type-info" style="min-width:380px;max-width:540px;">
        <div class="confirm-title">${title}</div>
        ${options.description ? `<div class="confirm-message" style="margin-bottom:10px;font-size:13px;color:#7f7f7f;">${escapeHtml(options.description)}</div>` : ''}
        <div class="jg-rows" style="max-height:46vh;overflow-y:auto;"></div>
        <button class="confirm-btn jg-add" style="width:100%;margin-bottom:10px;">+ 添加一条猜测</button>
        <div class="confirm-buttons">
          <button class="confirm-btn confirm-cancel">取消</button>
          <button class="confirm-btn confirm-ok">确定</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const rowsWrap = overlay.querySelector('.jg-rows');
    const addBtn = overlay.querySelector('.jg-add');
    const selStyle = 'flex:1;min-width:0;padding:6px;border-radius:6px;border:1px solid rgba(0,0,0,0.12);background:#fff;color:#191919;font-size:13px;font-family:inherit;';

    const buildRow = () => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:6px;';
      const playerSel = document.createElement('select');
      playerSel.className = 'jg-player';
      playerSel.style.cssText = selStyle;
      playerSel.innerHTML = players
        .map(p => `<option value="${p.id}">${p.seat + 1}号 ${escapeHtml(p.name)}</option>`).join('');
      const roleSel = document.createElement('select');
      roleSel.className = 'jg-role';
      roleSel.style.cssText = selStyle;
      roleSel.innerHTML = roles
        .map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
      const delBtn = document.createElement('button');
      delBtn.className = 'confirm-btn';
      delBtn.textContent = '✕';
      delBtn.style.cssText = 'padding:4px 8px;';
      delBtn.addEventListener('click', () => { row.remove(); syncAdd(); });
      row.append(playerSel, roleSel, delBtn);
      return row;
    };
    const syncAdd = () => { addBtn.style.display = rowsWrap.children.length >= MAX ? 'none' : ''; };

    rowsWrap.appendChild(buildRow());
    syncAdd();
    addBtn.addEventListener('click', () => {
      if (rowsWrap.children.length >= MAX) return;
      rowsWrap.appendChild(buildRow());
      syncAdd();
    });

    const close = (result) => {
      overlay.classList.add('confirm-closing');
      setTimeout(() => { overlay.remove(); resolve(result); }, 200);
    };

    overlay.querySelector('.confirm-cancel').addEventListener('click', () => close(null));
    overlay.querySelector('.confirm-ok').addEventListener('click', () => {
      const picked = [];
      const seen = new Set();
      for (const row of Array.from(rowsWrap.children)) {
        const pid = row.querySelector('.jg-player').value;
        const rid = row.querySelector('.jg-role').value;
        if (!pid || !rid) { showToast('每条猜测都要选择玩家与角色'); return; }
        if (seen.has(pid)) { showToast('同一名玩家只能猜一次'); return; }
        seen.add(pid);
        const p = players.find(x => x.id === pid);
        const r = roles.find(x => x.id === rid);
        if (!p || !r) { showToast('选择无效'); return; }
        picked.push({ targetId: p.id, roleId: r.id, seat: p.seat, name: p.name, roleName: r.name });
      }
      if (picked.length === 0) { showToast('请至少选择一条猜测'); return; }
      picked.sort((a, b) => a.seat - b.seat);
      close(picked);
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });

    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } };
    document.addEventListener('keydown', onKey);
    const origRemove = overlay.remove.bind(overlay);
    overlay.remove = function () { document.removeEventListener('keydown', onKey); origRemove(); };

    requestAnimationFrame(() => overlay.classList.add('confirm-show'));
  });
}

// 杂耍艺人猜测文案：真实公开公告与伪装公告逐字一致
function formatJugglerGuesses(list) {
  return (list || []).map(g => `${g.seat + 1}号 ${g.name} 是${g.roleName}`).join('、');
}

async function useMutantAbility() {
  const originEl = getLoadingClickTarget();
  const ok = await showConfirm('你将公开声称自己是外来者（疯狂）。你可能因此被处决。', {
    type: 'warning', title: '变种人', confirmText: '公开声称'
  });
  if (ok) {
    emitRequest('day:useAbility', { abilityName: 'mutant' }, originEl);
  }
}

function useCerenovusClaim() {
  const roleName = currentState && currentState.myAbilityState && currentState.myAbilityState.cerenovusClaimRole;
  if (!roleName) return;
  emitRequest('day:useAbility', { abilityName: 'cerenovus_claim' }, getLoadingClickTarget());
}

async function useKlutzAbility() {
  const originEl = getLoadingClickTarget();
  const players = currentState.players.filter(p => p.isAlive && p.seat !== -1);
  const targetId = await showPlayerSelect('傻瓜：公开选择一名存活玩家', players, { type: 'danger' });
  if (!targetId) return;
  const target = players.find(p => p.id === targetId);
  const ok = await showConfirm(
    `确定选择 ${target.seat + 1}号 ${target.name} 吗？如果他是邪恶阵营，善良阵营将立即落败。`,
    { type: 'danger', title: '傻瓜选择', confirmText: '确认选择' }
  );
  if (ok) {
    emitRequest('day:useAbility', { abilityName: 'klutz', targetId }, originEl);
  }
}

// 说明：技能使用与玩家死亡的结果不再由客户端弹提示框，
// 统一由服务端广播为聊天区消息（公聊气泡 / 系统消息），便于回看。

// ========== 聊天 ==========
let aiChatHistory = [];      // AI 对话历史（用于上下文）
let aiPendingMessages = {};   // 正在接收的 AI 消息 { id: { content, playerName } }
let isAiThinking = false;     // AI 正在响应中
let lastAiUserMsgId = null;   // 最近一条触发 AI 的本地消息 id（用于撤回配对）
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
  // 同步左侧会话列表的未读红点
  renderSessionList();
}

function renderWhisperPlayerList() {
  // 私聊对象列表已合并到左侧会话列表中
  renderSessionList();
}

// ========== 左侧会话列表（房间 / 死者 / 私聊） ==========
// ========== 身份标记（本机推理记录，仅自己可见，存 localStorage） ==========
// 结构：{ [roomId]: { [playerId]: { roleId, name, color, short } } }
const IDENTITY_MARKS_KEY = 'xrzl_identity_marks';
let identityMarks = (() => {
  try { return JSON.parse(localStorage.getItem(IDENTITY_MARKS_KEY)) || {}; } catch (e) { return {}; }
})();
let identityMarkTargetId = null;

function getIdentityMark(pid) {
  const roomId = (currentState && currentState.roomId) || myRoomId || '';
  if (!roomId || !pid) return null;
  return (identityMarks[roomId] || {})[pid] || null;
}

function setIdentityMark(pid, mark) {
  const roomId = (currentState && currentState.roomId) || myRoomId || '';
  if (!roomId || !pid) return;
  if (!identityMarks[roomId]) identityMarks[roomId] = {};
  if (mark) identityMarks[roomId][pid] = mark;
  else delete identityMarks[roomId][pid];
  try { localStorage.setItem(IDENTITY_MARKS_KEY, JSON.stringify(identityMarks)); } catch (e) {}
  renderSessionList();
}

// 角色显示名去掉「（村民）」这类分类后缀
function getRoleShortName(opt) {
  return String((opt && opt.name) || '').replace(/（[^）]*）\s*$/, '');
}

// #RRGGBB → rgba(r,g,b,a)，用于标记标签的浅色底与描边
function hexToRgba(hex, alpha) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return `rgba(0, 0, 0, ${alpha})`;
  const n = parseInt(h, 16);
  if (isNaN(n)) return `rgba(0, 0, 0, ${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function openIdentityMarkPanel(pid) {
  const p = ((currentState && currentState.players) || []).find(x => x.id === pid);
  if (!p) return;
  identityMarkTargetId = pid;
  const title = $('identityMarkTitle');
  if (title) title.textContent = `标记身份：${p.seat >= 0 ? (p.seat + 1) + '号 ' : ''}${p.name}`;
  renderIdentityMarkOptions();
  const panel = $('identityMarkPanel');
  if (panel) panel.style.display = 'flex';
}

function closeIdentityMarkPanel() {
  const panel = $('identityMarkPanel');
  if (panel) panel.style.display = 'none';
  identityMarkTargetId = null;
}

// 按当前剧本列出角色，分村民 / 外来者 / 爪牙 / 恶魔四组
function renderIdentityMarkOptions() {
  const box = $('identityMarkOptions');
  if (!box) return;
  const scriptId = (currentState && currentState.script) || 'tb';
  const current = getIdentityMark(identityMarkTargetId);
  const groups = [
    { key: 'townsfolk', name: '村民', color: '#07C160' },
    { key: 'outsider', name: '外来者', color: '#FF9500' },
    { key: 'minion', name: '爪牙', color: '#FA5151' },
    { key: 'demon', name: '恶魔', color: '#E64340' }
  ];
  const roles = CUSTOM_ROLE_OPTIONS.filter(o => o.id && ROLE_SCRIPT_MAP[o.id] === scriptId);

  let html = '';
  groups.forEach(g => {
    const list = roles.filter(r => ROLE_CATEGORY[r.id] === g.key);
    if (list.length === 0) return;
    html += `<div class="im-group">
      <div class="im-group-title" style="color:${g.color}">${g.name}</div>
      <div class="im-role-list">${list.map(r => {
        const name = getRoleShortName(r);
        const active = current && current.roleId === r.id ? ' active' : '';
        return `<button type="button" class="im-role-btn${active}" style="--im-color:${r.color}" onclick="pickIdentityMark('${r.id}')">${escapeHtml(name)}</button>`;
      }).join('')}</div>
    </div>`;
  });
  box.innerHTML = html || '<div class="im-empty">没有匹配的角色</div>';
}

function pickIdentityMark(roleId) {
  const opt = CUSTOM_ROLE_OPTIONS.find(o => o.id === roleId);
  if (!opt) return;
  const pid = identityMarkTargetId;
  const name = getRoleShortName(opt);
  setIdentityMark(pid, { roleId, name, color: opt.color });
  closeIdentityMarkPanel();
}

function clearIdentityMark() {
  const pid = identityMarkTargetId;
  if (!pid) return;
  setIdentityMark(pid, null);
  closeIdentityMarkPanel();
}

function renderSessionList() {
  const container = $('sessionList');
  if (!container) return;
  const state = currentState;
  const players = (state && state.players) ? state.players : [];
  const roomId = (state && state.roomId) || myRoomId || '';

  const lastOf = (ch) => {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const m = chatMessages[i];
      // 已并入配对撤回提示的消息不作为预览来源
      if (m.mergedRecalled) continue;
      if (ch === 'public' && m.channel === 'public') return m;
      if (ch === 'dead' && m.channel === 'dead') return m;
    }
    return null;
  };
  const previewText = (m, fallback) => {
    if (!m) return fallback;
    const who = m.fromId === myId ? '我' : (m.fromName || '');
    // 已撤回的消息正文被清空，预览显示撤回提示而不是“xx：”
    if (m.recalled) {
      const extras = Array.isArray(m.recalledExtra) ? m.recalledExtra : [];
      const whoText = [who || '对方', ...extras].join(' 和 ');
      return `${whoText} 撤回了一条消息`;
    }
    const text = String(m.content || '').replace(/\s+/g, ' ').slice(0, 40);
    return who ? `${who}：${text}` : text;
  };
  const badge = (n) => (n > 0 ? `<span class="wx-session-badge">${n > 99 ? '99+' : n}</span>` : '');

  let html = '';
  html += `<div class="wx-session-item ${currentChatChannel === 'public' ? 'active' : ''}" onclick="selectSession('public')">
    <div class="wx-avatar room">🏠</div>
    <div class="wx-session-body">
      <div class="wx-session-title">${escapeHtml(roomId ? '房间 ' + roomId : '游戏房间')}</div>
      <div class="wx-session-preview">${escapeHtml(previewText(lastOf('public'), '游戏大厅 · 公聊'))}</div>
    </div>
    ${badge(unreadPublic)}
  </div>`;

  const me = players.find(p => p.id === myId);
  // 死者频道仅在自己出局后才出现（其他玩家出局与我无关）
  if (me && me.isDead) {
    html += `<div class="wx-session-item ${currentChatChannel === 'dead' ? 'active' : ''}" onclick="selectSession('dead')">
      <div class="wx-avatar dead">💀</div>
      <div class="wx-session-body">
        <div class="wx-session-title">死者频道</div>
        <div class="wx-session-preview">${escapeHtml(previewText(lastOf('dead'), '仅死者可见'))}</div>
      </div>
      ${badge(unreadDead)}
    </div>`;
  }

  players.filter(p => p.id !== myId && p.seat !== -1).forEach(p => {
    const isActive = currentChatChannel === 'whisper' && whisperTargetId === p.id;
    let last = null;
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const m = chatMessages[i];
      if (m.channel === 'whisper' && (m.fromId === p.id || m.toId === p.id)) { last = m; break; }
    }
    // 头像可点击标记身份（阻止冒泡，避免同时切换会话）
    const mark = getIdentityMark(p.id);
    const markChip = mark
      ? `<span class="wx-session-mark" style="color:${mark.color}; background:${hexToRgba(mark.color, 0.12)}; border-color:${hexToRgba(mark.color, 0.38)}" title="已标记：${escapeHtml(mark.name)}">${escapeHtml(mark.name)}</span>`
      : '';
    const avatarTitle = mark ? `已标记：${mark.name}（点击修改）` : '点击标记身份';
    html += `<div class="wx-session-item ${isActive ? 'active' : ''}" onclick="selectSession('whisper','${p.id}')">
      <div class="wx-avatar markable${p.isDead ? ' dead' : ''}" onclick="event.stopPropagation(); openIdentityMarkPanel('${p.id}')" title="${escapeHtml(avatarTitle)}">${p.seat + 1}</div>
      <div class="wx-session-body">
        <div class="wx-session-title">${escapeHtml(p.name)}${p.isBot ? ' 🤖' : ''}</div>
        <div class="wx-session-preview">${escapeHtml(previewText(last, '点击开始私聊'))}</div>
      </div>
      ${markChip}
      ${badge(unreadWhispers[p.id] || 0)}
    </div>`;
  });

  container.innerHTML = html;
}

// PC 端：右侧「座位列表 + 操作面板」只在主房间（公聊）会话中显示
// 移动端由 moveMobilePanelsIntoChat 搬移/还原，这里不干预
function updateMemberPanelVisibility() {
  const member = $('memberPanel');
  const gameView = $('gameView');
  if (!member) return;
  // 未加入房间：整体不显示，聊天区独占宽度
  if (!myRoomId) {
    member.style.display = 'none';
    if (gameView) gameView.classList.remove('with-member');
    return;
  }
  if (isMobileView()) {
    member.style.display = 'flex';
    return;
  }
  const show = currentChatChannel === 'public';
  member.style.display = show ? 'flex' : 'none';
  // with-member 决定 grid 是否保留右侧那一列
  if (gameView) gameView.classList.toggle('with-member', show);
}

// 切换会话（左栏点击）
function selectSession(channel, pid) {
  const input = $('chatInput');
  if (channel === 'whisper') {
    currentChatChannel = 'whisper';
    whisperTargetId = pid || null;
    if (pid) clearUnreadForWhisper(pid);
    const target = (currentState && currentState.players)
      ? currentState.players.find(p => p.id === pid) : null;
    if (input) input.placeholder = target ? `私聊 ${target.name}...` : '选择左侧联系人开始私聊';
  } else if (channel === 'dead' || channel === 'public') {
    currentChatChannel = channel;
    whisperTargetId = null;
    clearUnreadForChannel(channel);
    if (input) input.placeholder = channel === 'dead' ? '死者频道（仅死者可见）...' : '输入消息... @小染 问AI、@弹幕 发弹幕';
  } else {
    currentChatChannel = 'public';
    whisperTargetId = null;
  }

  document.querySelectorAll('.chat-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.channel === currentChatChannel);
  });
  renderChatMessages();
  renderSessionList();
  updateChatTabBadges();
  updateHeaderChatTarget();
  updateChatInputVisibility();
  // PC 端：右侧成员与操作区仅在主房间（公聊）显示
  updateMemberPanelVisibility();
  // 移动端：选中会话后进入聊天页
  if (isMobileView()) openMobileChat();
}

// 兼容旧调用入口
function switchChatChannel(channel) {
  if (channel === 'voice') return;
  selectSession(channel, channel === 'whisper' ? whisperTargetId : null);
}

function showWhisperPanel() {
  // 私聊对象选择已由左侧会话列表承担
  renderSessionList();
  showToast('请在左侧会话列表中选择私聊对象');
}

function selectWhisperTarget(pid) {
  selectSession('whisper', pid);
}

function sendChat() {
  const input = $('chatInput');
  const content = input.value.trim();
  // 有待发送图片时，允许不带文字直接发送
  if (!content && !pendingChatImage) return;

  // 检测 AI 小助手触发：@小染 / @AI / @ai
  const aiMatch = content.match(/^@(?:小染|AI|ai)\s+(.+)/);
  // 只有主房间（公聊）才能呼叫小染，私聊与死者频道不支持
  if (aiMatch && currentChatChannel !== 'public') {
    showToast('只有主房间内才能呼叫小染 AI');
    return;
  }
  if (aiMatch && !pendingChatImage) {
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
      timestamp: Date.now(),
      // 该消息只在本地存在（不经过服务端 chat 通道），撤回时走本地逻辑
      localOnly: true
    };
    chatMessages.push(userMsg);
    lastAiUserMsgId = userMsg.id;
    renderChatMessages();

    // 记录到 AI 历史
    aiChatHistory.push({ role: 'user', content: aiMessage });
    aiChatHistory = aiChatHistory.slice(-20);

    // 发送给后端（附带频道，服务端据此校验仅主房间可用）
    socket.emit('ai:chat', {
      message: aiMessage,
      history: aiChatHistory.filter(h => h.role === 'user' || h.role === 'assistant'),
      channel: 'public'
    });

    input.value = '';
    return;
  }

  // 检测弹幕触发：@弹幕 <内容>（仅主房间公聊可用，弹幕不写入聊天记录）
  const danmakuMatch = content.match(/^@弹幕[\s\u3000]+(.+)/);
  if (danmakuMatch && !pendingChatImage) {
    if (currentChatChannel !== 'public') {
      showToast('只有主房间内才能发送弹幕');
      return;
    }
    const danmakuText = danmakuMatch[1].trim();
    if (!danmakuText) return;
    if (danmakuText.length > 60) {
      showToast('弹幕最多 60 个字');
      return;
    }
    socket.emit('chat:danmaku', { text: danmakuText });
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

  // 组装载荷：可带图片（图片消息正文用 [图片] 占位）
  const payload = {
    content: content || (pendingChatImage ? '[图片]' : ''),
    channel: currentChatChannel,
    targetId
  };
  if (pendingChatImage) {
    const now = Date.now();
    if (now - lastChatImageAt < 3000) { showToast('发送图片过于频繁，请稍候'); return; }
    lastChatImageAt = now;
    payload.image = pendingChatImage;
  }

  socket.emit('chat:send', payload);
  input.value = '';
  clearPendingChatImage();
}

// ========== 聊天图片（粘贴发送） ==========
// 客户端先等比缩放 + JPEG 压缩，再以 base64 传输，显著降低带宽与内存占用
const CHAT_IMAGE_MAX_DIM = 720;             // 最长边像素上限
const CHAT_IMAGE_QUALITY = 0.62;            // JPEG 压缩质量
const CHAT_IMAGE_MAX_CHARS = 300 * 1024;    // 压缩后 base64 字符数上限
let lastChatImageAt = 0;                    // 发送节流

// 将图片文件压缩为 dataURL（等比缩放，不裁剪）
function compressChatImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, CHAT_IMAGE_MAX_DIM / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
      const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve({ dataUrl: canvas.toDataURL('image/jpeg', CHAT_IMAGE_QUALITY), w, h });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解析失败')); };
    img.src = url;
  });
}

// 待发送的图片（粘贴后先预览，确认发送才真正发出）
let pendingChatImage = null;

// 粘贴事件：命中图片则拦截默认粘贴，进入待发送预览
function handleChatPaste(e) {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) {
      const file = it.getAsFile();
      if (file) {
        e.preventDefault();
        stageChatImage(file);
        return;
      }
    }
  }
}

// 压缩后放入待发送预览，不直接发送
async function stageChatImage(file) {
  if (!myRoomId) { showToast('请先加入房间'); return; }
  try {
    const { dataUrl, w, h } = await compressChatImage(file);
    if (dataUrl.length > CHAT_IMAGE_MAX_CHARS) {
      showToast('图片过大，请裁剪后重试');
      return;
    }
    pendingChatImage = { data: dataUrl, w, h };
    renderPendingChatImage();
    const input = $('chatInput');
    if (input) input.focus();
  } catch (err) {
    showToast('图片处理失败，请重试');
  }
}

function renderPendingChatImage() {
  const box = $('chatImagePreview');
  const img = $('chatImagePreviewImg');
  if (!box) return;
  if (pendingChatImage) {
    if (img) img.src = pendingChatImage.data;
    box.style.display = 'flex';
  } else {
    if (img) img.removeAttribute('src');
    box.style.display = 'none';
  }
}

function clearPendingChatImage() {
  pendingChatImage = null;
  renderPendingChatImage();
}

// 撤回消息（不限时间，仅能撤回自己的消息）
// @小染 的触发消息只在本地存在，走本地撤回并连带撤回 AI 回复
function recallMessage(id) {
  const msg = chatMessages.find(m => String(m.id) === String(id));
  if (msg && msg.localOnly) {
    recallLocalMessagePair(msg);
    return;
  }
  socket.emit('chat:recall', { id });
}

function recallLocalMessagePair(msg) {
  msg.recalled = true;
  msg.content = '';
  delete msg.image;
  // 连带撤回该消息触发的 AI 回复，并把两条撤回提示合并为一条
  const reply = chatMessages.find(m => String(m.id) === String(msg.aiReplyId));
  if (reply) {
    reply.recalled = true;
    reply.content = '';
    delete reply.image;
    // 标记为已合并，不再单独渲染撤回通知
    reply.mergedRecalled = true;
    msg.recalledExtra = ['小染'];
  }
  renderChatMessages();
  renderSessionList();
}

// 点击图片放大预览
function openChatImage(el) {
  const img = el && el.querySelector('img');
  if (!img) return;
  let mask = $('chatImageMask');
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'chatImageMask';
    mask.className = 'chat-image-mask';
    mask.innerHTML = '<img alt="图片预览">';
    mask.onclick = () => { mask.style.display = 'none'; };
    document.body.appendChild(mask);
  }
  const big = mask.querySelector('img');
  if (big) big.src = img.src;
  mask.style.display = 'flex';
}

// ========== 输入框 @ 功能选择 ==========
// 在输入框中打出 @ 时弹出面板列出可用功能，支持点击选择与 ↑↓ + 回车选择
const AT_SUGGEST_ITEMS = [
  { key: '@小染', icon: '🤖', desc: '向小染 AI 提问' },
  { key: '@弹幕', icon: '💬', desc: '发送匿名弹幕' }
];
let _atSuggestItems = [];   // 当前展示的候选项
let _atSuggestIndex = 0;    // 高亮项下标

function updateAtSuggest() {
  const input = $('chatInput');
  const panel = $('atSuggest');
  if (!input || !panel) return;

  // 仅主房间（公聊）提供 @ 功能
  if (currentChatChannel !== 'public') { closeAtSuggest(); return; }

  const pos = input.selectionStart;
  if (pos === null || pos === undefined) { closeAtSuggest(); return; }

  // 仅在输入框中只存在一个 @ 时提示；已有多个 @（如 @@ / 正文里再打 @）不再弹出
  if ((input.value.match(/@/g) || []).length > 1) { closeAtSuggest(); return; }

  // 匹配光标前最后一个「@片段」：@ 后不含空格，否则视为已开始输入正文，不再提示
  const before = input.value.slice(0, pos);
  const m = before.match(/@([^\s@]*)$/);
  if (!m) { closeAtSuggest(); return; }

  const query = m[1];
  const items = AT_SUGGEST_ITEMS.filter(it => it.key.slice(1).startsWith(query));
  if (items.length === 0) { closeAtSuggest(); return; }

  _atSuggestItems = items;
  _atSuggestIndex = 0;

  panel.innerHTML = items.map((it, i) => `
    <div class="at-suggest-item${i === 0 ? ' active' : ''}" data-at-index="${i}"
      onmousedown="event.preventDefault()" onclick="applyAtSuggest(${i})">
      <span class="at-suggest-icon">${it.icon}</span>
      <span class="at-suggest-label">${escapeHtml(it.key)}</span>
      <span class="at-suggest-desc">${escapeHtml(it.desc)}</span>
    </div>`).join('');
  panel.style.display = 'block';
}

function closeAtSuggest() {
  const panel = $('atSuggest');
  if (panel) panel.style.display = 'none';
  _atSuggestItems = [];
  _atSuggestIndex = 0;
}

// 失焦后延迟收起，保证面板项的点击先被处理
function scheduleCloseAtSuggest() {
  setTimeout(closeAtSuggest, 150);
}

function moveAtSuggest(step) {
  if (_atSuggestItems.length === 0) return;
  _atSuggestIndex = (_atSuggestIndex + step + _atSuggestItems.length) % _atSuggestItems.length;
  const panel = $('atSuggest');
  if (!panel) return;
  panel.querySelectorAll('.at-suggest-item').forEach((el, i) => {
    el.classList.toggle('active', i === _atSuggestIndex);
  });
}

function applyAtSuggest(index) {
  const input = $('chatInput');
  const item = _atSuggestItems[index === undefined ? _atSuggestIndex : index];
  if (!input || !item) return;

  const pos = input.selectionStart;
  const before = input.value.slice(0, pos);
  const m = before.match(/@([^\s@]*)$/);
  if (!m) { closeAtSuggest(); return; }

  // 用完整功能名替换已输入的 @片段，并补一个空格便于继续输入内容
  const head = before.slice(0, before.length - m[0].length);
  input.value = head + item.key + ' ' + input.value.slice(pos);
  const caret = head.length + item.key.length + 1;
  input.focus();
  input.setSelectionRange(caret, caret);
  closeAtSuggest();
}

// 输入框键盘事件：@ 面板打开时接管方向键 / 回车 / Esc，否则回车发送
function handleChatInputKeydown(e) {
  const panel = $('atSuggest');
  const open = panel && panel.style.display !== 'none' && _atSuggestItems.length > 0;
  if (open) {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveAtSuggest(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveAtSuggest(-1); return; }
    if (e.key === 'Enter') { e.preventDefault(); applyAtSuggest(); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeAtSuggest(); return; }
  }
  if (e.key === 'Enter') sendChat();
}

// 系统消息 / 房间动态（统一显示在中央聊天框）
function addSystemChatMessage(text) {
  if (!text) return;
  chatMessages.push({
    id: 'sys-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    fromId: 'system',
    fromName: '系统',
    fromSeat: -1,
    isDead: false,
    isSystem: true,
    content: text,
    channel: 'public',
    timestamp: Date.now()
  });
  renderChatMessages();
  renderSessionList();
}

// 对比房间状态，生成房间动态系统消息
function diffRoomDynamics(prev, next) {
  if (!next || !Array.isArray(next.players)) return;
  if (!prev || !Array.isArray(prev.players)) return;
  // 用昵称作为稳定标识：玩家重连会换 socket id，按 id 对比会误报「离开 + 加入」
  // （房间内昵称唯一，服务端会拒绝重复昵称）
  const prevNames = new Set(prev.players.map(p => p.name));
  const nextNames = new Set(next.players.map(p => p.name));
  next.players.forEach(p => {
    if (!prevNames.has(p.name) && p.id !== myId) addSystemChatMessage(`${p.name} 加入了房间`);
  });
  prev.players.forEach(p => {
    if (!nextNames.has(p.name) && p.id !== myId) addSystemChatMessage(`${p.name} 离开了房间`);
  });
  if (!prev.gameStarted && next.gameStarted) {
    addSystemChatMessage('游戏开始，系统已分配身份');
  }
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

// ========== 弹幕 ==========
// 输入框以「@弹幕 内容」发送，匿名广播给房间内所有玩家，在聊天区从右向左滚动。
// 弹幕只是即时视觉提示：不进入 chatMessages，因此不影响会话列表预览与未读计数。
const DANMAKU_TRACK_COUNT = 7;   // 轨道数（纵向均分，避免弹幕相互重叠）
const DANMAKU_SPEED = 110;       // 滚动速度（px/秒）
let _danmakuTrackAt = [];        // 各轨道最近使用时间，用于挑选空闲轨道

function showDanmaku(d) {
  if (!d || !d.text) return;
  // 仅主房间（公聊）会话展示弹幕
  if (currentChatChannel !== 'public') return;
  const layer = $('danmakuLayer');
  if (!layer) return;

  const el = document.createElement('div');
  el.className = 'danmaku-item';
  // 匿名弹幕：只展示内容本身，不暴露发送者；textContent 天然防注入
  el.textContent = d.text;

  // 挑选最久未使用的轨道，尽量错开同屏弹幕
  const layerH = layer.clientHeight || 0;
  const trackH = Math.max(26, Math.round((layerH * 0.75) / DANMAKU_TRACK_COUNT));
  let track = 0;
  let oldest = Infinity;
  for (let i = 0; i < DANMAKU_TRACK_COUNT; i++) {
    const at = _danmakuTrackAt[i] || 0;
    if (at < oldest) { oldest = at; track = i; }
  }
  _danmakuTrackAt[track] = Date.now();
  el.style.top = `${6 + track * trackH}px`;

  layer.appendChild(el);

  // 滚动距离 = 容器宽度 + 自身宽度；速度恒定，长弹幕自动延长滚动时间
  const layerW = layer.clientWidth || 0;
  const elW = el.offsetWidth || 0;
  const distance = layerW + elW + 24;
  const duration = Math.max(5, Math.min(16, distance / DANMAKU_SPEED));
  el.style.setProperty('--danmaku-distance', `${distance}px`);
  el.style.animationDuration = `${duration}s`;

  const remove = () => el.remove();
  el.addEventListener('animationend', remove);
  // 兜底清理：动画被中断时也不会残留节点
  setTimeout(remove, Math.round((duration + 1) * 1000));
}

// 格式化聊天时间（HH:MM）
function formatChatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function renderChatMessages() {
  const container = $('chatMessages');
  const visible = chatMessages.filter(m => {
    // 系统消息 / 房间动态只在公聊（房间）中显示，不出现在私聊与死者频道
    if (m.isSystem) return currentChatChannel === 'public';
    // 兼容游戏内消息（type 字段）与大厅消息（channel 字段）
    const ch = m.channel || m.type;
    if (currentChatChannel === 'public') return ch === 'public';
    if (currentChatChannel === 'dead') return ch === 'dead';
    if (currentChatChannel === 'whisper') {
      if (ch !== 'whisper') return false;
      // 只显示与当前私聊对象的对话
      if (whisperTargetId) {
        return m.fromId === whisperTargetId || m.toId === whisperTargetId ||
               (m.fromId === myId && m.toId === whisperTargetId);
      }
      return true; // 未选择对象时显示所有私聊
    }
    return false;
  });

  if (visible.length === 0 && Object.keys(aiPendingMessages).length === 0) {
    const emptyText = myRoomId
      ? '暂无消息，在下方输入框开始聊天吧'
      : '创建或加入房间后，游戏动态与聊天会显示在这里';
    container.innerHTML = `<div class="chat-empty">${emptyText}</div>`;
    return;
  }

  container.innerHTML = visible.map(msg => {
    // 系统消息 / 房间动态
    if (msg.isSystem) {
      return `<div class="chat-msg system"><span>${escapeHtml(msg.content)}</span></div>`;
    }
    // 已合并到配对消息的撤回提示中，不再单独渲染
    if (msg.mergedRecalled) return '';
    // 已撤回的消息 → 居中灰色提示（微信风格，不保留头像与气泡）
    if (msg.recalled) {
      const seatText = msg.fromSeat >= 0 ? `${msg.fromSeat + 1}号 ` : '';
      const who = msg.fromId === myId ? '你' : `${seatText}${msg.fromName || '对方'}`;
      // 合并撤回时附带的其他发送者（如：你 和 小染 撤回了一条消息）
      const extra = Array.isArray(msg.recalledExtra) ? msg.recalledExtra : [];
      const whoText = [who, ...extra].join(' 和 ');
      return `<div class="chat-msg recalled-system"><span>${escapeHtml(whoText)} 撤回了一条消息</span></div>`;
    }
    // AI 小助手消息：与普通聊天气泡同构，仅头像与气泡配色不同
    if (msg.isAi) {
      const aiTime = formatChatTime(msg.timestamp);
      return `<div class="chat-msg">
        <div class="msg-col">
          <div class="msg-name">小染</div>
          <div class="msg-avatar ai-avatar">🤖</div>
        </div>
        <div class="msg-main">
          <div class="msg-time-line">${aiTime ? `<span class="msg-time">${aiTime}</span>` : ''}</div>
          <div class="msg-row">
            <div class="msg-bubble ai-bubble">${escapeHtml(msg.content)}</div>
          </div>
        </div>
      </div>`;
    }

    const isSelf = msg.fromId === myId;
    const msgCh = msg.channel || msg.type;
    const privateClass = msgCh === 'whisper' ? 'private' : '';
    const avatarLabel = msg.fromSeat >= 0 ? (msg.fromSeat + 1) : '?';
    const timeStr = formatChatTime(msg.timestamp);
    // 昵称不显示座位号
    const nameText = isSelf ? '我' : (msg.fromName || '');
    // 图片消息：只接受 data:image/ 前缀，避免注入
    const imgData = (msg.image && typeof msg.image.data === 'string' && /^data:image\//.test(msg.image.data))
      ? msg.image.data : '';
    const imgHtml = imgData
      ? `<div class="msg-image" onclick="openChatImage(this)"><img src="${imgData}" alt="图片" loading="lazy"${msg.image.w ? ` width="${msg.image.w}" height="${msg.image.h}"` : ''}></div>`
      : '';
    // 撤回按钮：仅自己的消息可撤回（不限时间），与气泡同行显示
    const recallHtml = isSelf ? `<span class="msg-recall" onclick="recallMessage('${msg.id}')">撤回</span>` : '';
    const textHtml = (imgData && msg.content === '[图片]') ? '' : escapeHtml(msg.content || '');
    return `<div class="chat-msg ${privateClass}${isSelf ? ' self' : ''}">
      <div class="msg-col">
        <div class="msg-name${msg.isDead ? ' dead' : ''}">${escapeHtml(nameText)}</div>
        <div class="msg-avatar${msg.isDead ? ' dead' : ''}">${avatarLabel}</div>
      </div>
      <div class="msg-main">
        <div class="msg-time-line">${timeStr ? `<span class="msg-time">${timeStr}</span>` : ''}</div>
        <div class="msg-row">
          <div class="msg-bubble">${imgHtml}${textHtml}</div>
          ${recallHtml}
        </div>
      </div>
    </div>`;
  }).join('');

  // 渲染正在接收的 AI 流式消息（同样使用气泡）
  if (currentChatChannel === 'public') {
    const pendingHtml = Object.values(aiPendingMessages).map(p => {
      const displayContent = p.content || '思考中';
      const cursor = p.content ? '' : '<span class="ai-thinking-dots">●●●</span>';
      return `<div class="chat-msg" data-ai-pending="1">
        <div class="msg-col">
          <div class="msg-name">小染</div>
          <div class="msg-avatar ai-avatar">🤖</div>
        </div>
        <div class="msg-main">
          <div class="msg-time-line"></div>
          <div class="msg-row">
            <div class="msg-bubble ai-bubble">${escapeHtml(displayContent)}${cursor}</div>
          </div>
        </div>
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
    list.innerHTML = '<div style="color:#8c8c8c; font-size:12px;">暂无其他玩家</div>';
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

// ========== 专属胜利特效 ==========
// 配色随胜方（后端 winEffect.winner）：GOOD 绿色，EVIL 红色。
// 文案注册表：type → { message }，文案可用 {占位符}，由后端 winEffect.params 填充。
// 新增一种结束动画的步骤：
//   1) 后端在对应结局的 endGame(winner, reason, effectType, effectParams) 处传入新的 type；
//   2) 在此登记该 type 的文案（不登记则回退到本局 winReason）。
// 已登记：
//   slayer_demon_kill  恶魔被杀手公开击杀（后端自动推导，见 VictoryChecker.resolveWinEffect）
//   mayor_three_alive  市长三人局（仅剩三人且市长存活）
//   saint_executed     圣徒被处决（{roleName} = 提名圣徒者的角色名）
//   mastermind_good    主谋额外白天·善良胜
//   mastermind_evil    主谋额外白天·邪恶胜
// hiddenTitle：动画顶部的「隐藏结局：xx」说明，未登记则顶部不显示
const VICTORY_EFFECTS = {
  slayer_demon_kill: { hiddenTitle: '恶魔被杀手公开击杀', message: '恶魔，你逃不掉的！' },
  mayor_three_alive: { hiddenTitle: '市长三人局', message: '山穷水复临崖近，三人成虎破终局' },
  saint_executed: { hiddenTitle: '圣徒被处决', message: '我名{roleName}，请求你的原谅' },
  mastermind_good: { hiddenTitle: '主谋额外白天', message: '你选择了正义' },
  mastermind_evil: { hiddenTitle: '主谋额外白天', message: '你又下了一层地狱' }
};

// 用 winEffect.params 填充文案里的 {占位符}；缺少对应值时保留占位符原样
function renderVictoryText(template, params) {
  if (!template || !params) return template || '';
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    (params[key] !== undefined && params[key] !== null) ? String(params[key]) : match
  );
}

// 后端在 endGame 时下发 winEffect；
// 同一次结算（同一特效 + 同一目标）只播放一次，避免状态广播时反复重播。
// 不设置自动关闭：动画一直停留，需玩家点击任意处手动关闭。
let shownVictoryEffect = null;

function playVictoryEffect(effect) {
  if (!effect || !effect.type) return;
  const key = effect.type + ':' + (effect.demonId || '');
  if (shownVictoryEffect === key) return;
  shownVictoryEffect = key;

  const overlay = $('victoryEffect');
  const text = $('victoryEffectText');
  if (!overlay || !text) return;

  const preset = VICTORY_EFFECTS[effect.type] || {};
  text.textContent = renderVictoryText(
    effect.message || preset.message || (currentState && currentState.winReason) || '游戏结束',
    effect.params
  );

  // 顶部说明：隐藏结局：xx（仅登记了 hiddenTitle 的特殊结局显示）
  const subtitle = $('victoryEffectSubtitle');
  if (subtitle) {
    const hiddenTitle = preset.hiddenTitle ? renderVictoryText(preset.hiddenTitle, effect.params) : '';
    subtitle.textContent = hiddenTitle ? `隐藏结局：${hiddenTitle}` : '';
  }

  // 配色随胜方：GOOD 绿色，EVIL 红色（无胜方信息时按红色处理）
  const winner = effect.winner || (currentState && currentState.winner) || null;
  overlay.classList.remove('good', 'evil');
  overlay.classList.add(winner === 'GOOD' ? 'good' : 'evil');

  overlay.classList.remove('hiding');
  overlay.classList.add('active');
}

function hideVictoryEffect() {
  const overlay = $('victoryEffect');
  if (!overlay || !overlay.classList.contains('active')) return;
  overlay.classList.add('hiding');
  setTimeout(() => overlay.classList.remove('active', 'hiding'), 450);
}

function showGameOverRoles(allRoles) {
  const panel = $('gameOverPanel');
  const isGood = currentState.winner === 'GOOD';

  // 结算数据未变化时不重复渲染，避免入场动画重播
  const signature = `${currentState.winner}|${allRoles.map(p => `${p.seat}:${p.roleId || p.roleName}:${p.isAlive ? 1 : 0}`).join(',')}`;
  if (panel.style.display === 'block' && panel.dataset.signature === signature) return;
  panel.dataset.signature = signature;

  panel.style.display = 'block';
  panel.classList.toggle('good', isGood);
  panel.classList.toggle('evil', !isGood);

  const title = $('gameOverTitle');
  const reason = $('gameOverReason');
  const emblem = $('gameOverEmblem');

  title.textContent = isGood ? '善良阵营胜利' : '邪恶阵营胜利';
  if (emblem) emblem.textContent = isGood ? '🏆' : '💀';
  reason.textContent = currentState.winReason || '';

  // 结算统计：双方存活人数 + 游戏天数
  const aliveGood = allRoles.filter(p => p.team === 'GOOD' && p.isAlive).length;
  const aliveEvil = allRoles.filter(p => p.team !== 'GOOD' && p.isAlive).length;
  const stats = $('gameOverStats');
  if (stats) {
    stats.innerHTML = `
      <div class="go-stat">
        <div class="go-stat-value good">${aliveGood}</div>
        <div class="go-stat-label">善良存活</div>
      </div>
      <div class="go-stat">
        <div class="go-stat-value evil">${aliveEvil}</div>
        <div class="go-stat-label">邪恶存活</div>
      </div>
      <div class="go-stat">
        <div class="go-stat-value">${currentState.dayCount || 0}</div>
        <div class="go-stat-label">游戏天数</div>
      </div>
    `;
  }

  const count = $('gameOverRolesCount');
  if (count) count.textContent = `共 ${allRoles.length} 名玩家`;

  const tbody = $('rolesRevealBody');
  tbody.innerHTML = allRoles
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((p, i) => `
      <tr class="${p.isAlive ? '' : 'is-dead'}" style="--go-i:${i}">
        <td><span class="go-seat">${p.seat + 1}</span></td>
        <td><span class="go-player">${escapeHtml(p.name)}</span>${p.isBot ? '<span class="go-bot-tag">机器人</span>' : ''}</td>
        <td><span class="go-role-name">${p.roleName}</span></td>
        <td><span class="go-team-chip ${p.team === 'GOOD' ? 'good' : 'evil'}">${p.team === 'GOOD' ? '善良' : '邪恶'}</span></td>
        <td><span class="go-status ${p.isAlive ? 'alive' : 'dead'}">${p.isAlive ? '存活' : '阵亡'}</span></td>
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
  $('godPanel').style.display = 'flex';
  $('godLoginForm').style.display = 'flex';
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

  updateGodPlayers();

  // 游戏状态（通俗化的结构化展示，详见 buildGodStatusHtml）
  $('godStatus').innerHTML = buildGodStatusHtml(gs);

  // 渲染行动日志（内部会合并同类事件并保留滚动位置）
  renderGodLog();
}

// ========== 上帝视角：游戏状态（通俗化展示） ==========
// 阶段名 + 一句白话说明，替代原来只显示阶段代码的做法
const GOD_PHASE_INFO = {
  LOBBY: ['大厅', '等待房主开始游戏'],
  FIRST_NIGHT: ['首夜', '所有人依次使用首夜技能'],
  NIGHT: ['夜晚', '角色轮流使用夜间技能'],
  NIGHT_WAKE: ['夜晚', '角色轮流使用夜间技能'],
  DAY_DAWN: ['天亮', '公布昨夜的死亡情况'],
  DAY_DISCUSSION: ['白天讨论', '玩家自由发言，可以发起提名'],
  NOMINATION_PHASE: ['白天提名', '玩家可以提名要处决的人'],
  DEFENSE: ['辩护', '被提名的人正在为自己辩解'],
  VOTING: ['投票', '所有人投票决定是否处决'],
  EXECUTION: ['处决', '正在结算处决结果'],
  GAME_OVER: ['游戏结束', '本局已分出胜负']
};

// 「3号 小明」这类座位+昵称，最直观的玩家指代方式
function godSeatName(p) {
  return p ? `${p.seat + 1}号 ${escapeHtml(p.name)}` : '未知玩家';
}

// 角色 id → 中文角色名（服务端下发映射，避免显示 imp / fortuneteller 这类内部名）
function godRoleLabel(gs, roleId) {
  if (!roleId) return '';
  const map = (gs && gs.roleNames) || {};
  if (map[roleId]) return map[roleId];
  const p = ((gs && gs.players) || []).find(x => x.roleId === roleId);
  return p && p.roleName ? p.roleName : roleId;
}

function buildGodStatusHtml(gs) {
  const players = (gs.players || []).slice().sort((a, b) => a.seat - b.seat);
  const seated = players.filter(p => p.seat >= 0);
  const alive = seated.filter(p => p.isAlive);
  const dead = seated.filter(p => !p.isAlive);
  const goodAlive = alive.filter(p => p.team === 'GOOD').length;
  const evilAlive = alive.filter(p => p.team === 'EVIL').length;

  const [phaseName, phaseDesc] = GOD_PHASE_INFO[gs.phase] || [gs.phase || '—', ''];
  let timeText = '';
  if (gs.phase === 'FIRST_NIGHT') timeText = '第 1 夜';
  else if (gs.phase === 'NIGHT' || gs.phase === 'NIGHT_WAKE') timeText = `第 ${gs.nightCount} 夜`;
  else if (gs.phase !== 'LOBBY' && gs.phase !== 'GAME_OVER') timeText = `第 ${Math.max(gs.dayCount || 0, 1)} 天`;

  let html = `<div class="god-overview">
    <div class="god-ov"><span class="god-ov-label">当前阶段</span><span class="god-ov-value">${phaseName}${timeText ? ' · ' + timeText : ''}</span></div>
    <div class="god-ov"><span class="god-ov-label">存活人数</span><span class="god-ov-value">${alive.length} / ${seated.length}</span></div>
    <div class="god-ov"><span class="god-ov-label">阵营存活</span><span class="god-ov-value"><i class="god-dot good"></i>善良 ${goodAlive}<i class="god-dot evil"></i>邪恶 ${evilAlive}</span></div>
  </div>`;
  if (phaseDesc) html += `<div class="god-now">${phaseName}：${phaseDesc}</div>`;

  // 正在进行：谁在做什么
  const nowList = [];
  if (gs.currentWakePlayerId) {
    const wp = players.find(p => p.id === gs.currentWakePlayerId);
    if (wp) nowList.push(`🌙 轮到 <b>${godSeatName(wp)}</b> 行动（身份：${escapeHtml(wp.roleName)}）`);
  }
  if (gs.currentDefensePlayerId) {
    const dp = players.find(p => p.id === gs.currentDefensePlayerId);
    if (dp) nowList.push(`🗣 <b>${godSeatName(dp)}</b> 正在辩护`);
  }
  const activeNom = (gs.nominations || []).find(n => !n.resolved);
  if (activeNom) {
    const nomP = players.find(p => p.id === activeNom.nominatorId);
    const nmP = players.find(p => p.id === activeNom.nomineeId);
    nowList.push(`🗳 <b>${godSeatName(nomP)}</b> 提名了 <b>${godSeatName(nmP)}</b>，正在投票`);
  }
  if (gs.pendingRavenkeeper) {
    const rp = players.find(p => p.id === gs.pendingRavenkeeper);
    if (rp) nowList.push(`🐦 守鸦人 <b>${godSeatName(rp)}</b> 死亡后正在选择要查验的玩家`);
  }
  if (nowList.length) {
    html += `<div class="god-section"><div class="god-sec-title">⏳ 正在进行</div>${nowList.map(t => `<div class="god-line">${t}</div>`).join('')}</div>`;
  }

  // 今晚已完成的行动
  const nightActs = Object.entries(gs.nightActions || {});
  if (nightActs.length) {
    html += `<div class="god-section"><div class="god-sec-title">🌙 今晚已完成的行动</div><ul class="god-list">`;
    nightActs.forEach(([roleId, a]) => {
      const roleLabel = escapeHtml(godRoleLabel(gs, roleId));
      const ids = [];
      const push = id => { if (id && ids.indexOf(id) === -1) ids.push(id); };
      if (a) {
        push(a.targetId);
        ['targets', 'targetIds'].forEach(k => { if (Array.isArray(a[k])) a[k].forEach(push); });
      }
      const targets = ids.map(id => players.find(p => p.id === id)).filter(Boolean).map(godSeatName);
      const skipped = !!(a && a.skip === true) || targets.length === 0;
      const detail = skipped
        ? '<span class="god-muted">➜ 今晚没有选择目标（跳过）</span>'
        : `➜ 选择了 <b>${targets.join('、')}</b>`;
      html += `<li><span class="god-act-role">${roleLabel}</span>${detail}</li>`;
    });
    html += `</ul></div>`;
  }

  // 今日提名与投票
  const noms = gs.nominations || [];
  if (noms.length) {
    html += `<div class="god-section"><div class="god-sec-title">🗳 今日提名与投票</div>`;
    noms.forEach(n => {
      const nomP = players.find(p => p.id === n.nominatorId);
      const nmP = players.find(p => p.id === n.nomineeId);
      let pill = '<span class="god-tag pending">投票中</span>';
      if (n.resolved) {
        pill = n.passed
          ? `<span class="god-tag pass">通过 · ${n.voteCount} 票</span>`
          : `<span class="god-tag fail">未通过 · ${n.voteCount} 票</span>`;
      }
      const cv = n.currentVotes || {};
      const yes = [], no = [], abstain = [];
      players.forEach(p => {
        if (p.seat < 0) return;
        if (!p.isAlive && !(p.voteToken > 0)) return; // 已出局且没有余票的人不参与
        if (cv[p.id] === true) yes.push(p.seat + 1);
        else if (cv[p.id] === false) no.push(p.seat + 1);
        else abstain.push(p.seat + 1);
      });
      const seatText = arr => (arr.length ? arr.map(s => `${s}号`).join(' ') : '—');
      html += `<div class="god-nom">
        <div class="god-nom-head">${godSeatName(nomP)} 提名 ${godSeatName(nmP)} ${pill}</div>
        <div class="god-nom-detail">
          <span class="god-yes">赞成 ${yes.length}：</span>${seatText(yes)}
          <span class="god-divider">｜</span>
          <span class="god-no">反对 ${no.length}：</span>${seatText(no)}
          ${abstain.length ? `<span class="god-divider">｜</span><span class="god-muted">未投 ${abstain.length}：</span>${seatText(abstain)}` : ''}
        </div>
      </div>`;
    });
    html += `</div>`;
  }

  // 已出局玩家及其身份
  if (dead.length) {
    html += `<div class="god-section"><div class="god-sec-title">💀 已出局（${dead.length} 人）</div><div class="god-line">${
      dead.map(p => `${godSeatName(p)}（${escapeHtml(p.roleName)} · ${p.team === 'GOOD' ? '善良' : '邪恶'}）`).join('、')
    }</div></div>`;
  }

  // 胜负结果
  if (gs.winner) {
    const isGood = gs.winner === 'GOOD';
    html += `<div class="god-result ${isGood ? 'good' : 'evil'}">
      <div class="god-result-title">${isGood ? '🎉 善良阵营获胜' : '💀 邪恶阵营获胜'}</div>
      ${gs.winReason ? `<div class="god-result-reason">${escapeHtml(gs.winReason)}</div>` : ''}
    </div>`;
  }

  // 技术信息（默认折叠，给排查流程用）
  if (gs.nightQueue && gs.nightQueue.length > 0) html += buildGodNightQueueHtml(gs, players);
  return html;
}

// 夜晚执行队列：默认折叠，角色 id 一律翻成中文
function buildGodNightQueueHtml(gs, players) {
  const queue = gs.nightQueue || [];
  const idx = gs.currentNightIndex ?? -1;
  const doneCount = Math.max(0, Math.min(idx, queue.length));
  let html = `<details class="god-debug"><summary>🔧 技术信息：夜晚执行队列（已完成 ${doneCount} / ${queue.length}）</summary><div class="god-debug-body">`;
  if (idx >= 0 && idx < queue.length) {
    const cur = queue[idx];
    const cp = players.find(p => p.id === cur.playerId);
    const tags = [];
    if (cur.isDrunk) tags.push('酒鬼假身份');
    if (cur.isFakeDemon) tags.push('假恶魔');
    html += `<div class="god-line">👉 当前等待：<b>${godSeatName(cp)}</b> · ${escapeHtml(godRoleLabel(gs, cur.roleId))}${tags.length ? `（${tags.join(' / ')}）` : ''}</div>`;
    if (cp) {
      html += `<div class="god-muted">${cp.isAlive ? '存活' : '已死亡'} · ${cp.isBot ? '机器人' : '真人'} · ${cp.isConnected === false ? '断线' : '在线'}</div>`;
    }
  } else if (idx >= queue.length) {
    html += `<div class="god-line">✅ 本夜队列已全部执行完毕，等待进入天亮结算</div>`;
  }
  if (gs.pendingRavenkeeper) {
    const rp = players.find(p => p.id === gs.pendingRavenkeeper);
    html += `<div class="god-line">🐦 待处理守鸦人：<b>${godSeatName(rp)}</b></div>`;
  }
  html += `<div class="god-queue">`;
  queue.forEach((item, i) => {
    const p = players.find(pp => pp.id === item.playerId);
    const mark = i < idx ? '✅' : (i === idx ? '👉' : '⏳');
    const cls = i < idx ? 'done' : (i === idx ? 'current' : 'todo');
    const tags = [];
    if (item.isDrunk) tags.push('酒鬼');
    if (item.isFakeDemon) tags.push('假恶魔');
    html += `<div class="god-queue-item ${cls}">${mark} ${godSeatName(p)} · ${escapeHtml(godRoleLabel(gs, item.roleId))}${tags.length ? `（${tags.join('/')}）` : ''}</div>`;
  });
  html += `</div></div></details>`;
  return html;
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
    const statusColor = p.isAlive ? '#07C160' : '#888';
    let marks = [];
    if (p.isPoisoned) marks.push('<span style="color:#9b59b6;">中毒</span>');
    if (p.isProtected) marks.push('<span style="color:#10AEFF;">守护</span>');
    if (p.isDrunk) marks.push('<span style="color:#F5822B;">醉酒</span>');
    if (p.isBot) marks.push('<span style="color:#8c8c8c;">AI</span>');
    if (p.isConnected === false) marks.push('<span style="color:#F5822B;">断线</span>');
    if (p.voteToken > 0 && p.isDead) marks.push('<span style="color:#10AEFF;">余1票</span>');
    const teamColor = p.team === 'GOOD' ? '#07C160' : '#FA5151';
    const teamText = p.team === 'GOOD' ? '善良' : '邪恶';
    let infoCell = '<span style="color:#b2b2b2;">-</span>';
    const hist = p.privateInfoHistory && p.privateInfoHistory.length > 0 ? p.privateInfoHistory : (p.privateInfo ? [p.privateInfo] : []);
    if (hist.length > 0) {
      const latest = hist[hist.length - 1];
      const falseStyle = latest.isFalse ? 'color:#FA5151;' : 'color:#0FA958;';
      // 表格单元格只显示第一行摘要（完整内容用 title 悬浮查看），避免多行信息被挤成一串
      const firstLine = String(latest.message || '').split('\n')[0];
      // 学者：悬浮提示里带上「哪一问是真/假」
      const savantNote = (latest.type === 'savant' && Array.isArray(latest.savantTruth))
        ? '｜' + (latest.questions || []).map((q, i) =>
          `${i === 0 ? '①' : '②'}${(latest.answers || [])[i] ? '是' : '否'}(${latest.savantTruth[i] ? '真话' : '假话'})`).join(' ')
        : '';
      infoCell = `<span style="${falseStyle} font-size:12px;" title="${escapeHtml(latest.message + savantNote)}">${escapeHtml(firstLine).substring(0, 30)}${firstLine.length > 30 ? '...' : ''}</span>
        <span style="color:#8c8c8c; font-size:11px;">(${hist.length}条)</span>`;
    }
    return `<tr style="border-bottom:1px solid rgba(0,0,0,0.03); opacity:${p.isAlive?1:0.5};">
      <td style="padding:8px;">${p.seat+1}</td>
      <td style="padding:8px;">${escapeHtml(p.name)}</td>
      <td style="padding:8px; color:#07C160; font-weight:bold;">${p.roleName}</td>
      <td style="padding:8px; color:${teamColor};">${teamText}</td>
      <td style="padding:8px; color:${statusColor};">${statusText}</td>
      <td style="padding:8px;">${marks.join(' ')}</td>
      <td style="padding:8px; max-width:300px; line-height:1.4;">${infoCell}</td>
    </tr>`;
  }).join('');
}

function renderGodPlayer(p, team) {
  const color = team === 'good' ? '#07C160' : '#FA5151';
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
      dayHtml += `<div style="margin-bottom:3px;"><span style="color:#07C160; font-size:11px; opacity:0.7;">${dayLabel}</span></div>`;
      byDay[day].forEach(info => {
        // 学者：逐条标注哪一问是真话、哪一问是假话（仅上帝视角有 savantTruth）
        if (info.type === 'savant' && Array.isArray(info.savantTruth)) {
          const rows = (info.questions || []).map((q, i) => {
            const ans = (info.answers || [])[i] ? '是' : '否';
            const isTrueAnswer = !!info.savantTruth[i];
            const tag = isTrueAnswer
              ? '<span style="color:#0FA958; font-weight:bold; font-size:11px;">真话</span>'
              : '<span style="color:#FA5151; font-weight:bold; font-size:11px;">假话</span>';
            return `<div style="margin-left:14px;">问：${escapeHtml(q)}　答：${ans} ${tag}</div>`;
          }).join('');
          dayHtml += `<div style="font-size:11.5px; line-height:1.6; color:#576b95; margin-left:10px; margin-bottom:6px;">
            · 学者向说书人提问${info.savantVortox ? '（混沌在场：两问均为假话）' : '（一真一假）'}${rows}</div>`;
          return;
        }
        const falseMark = info.isFalse 
          ? '<span style="color:#FA5151; font-weight:bold; font-size:11px;"> ⚠️假</span>' 
          : '<span style="color:#07C160; font-size:11px;"> ✓</span>';
        dayHtml += `<div style="font-size:11.5px; line-height:1.5; color:${info.isFalse ? '#FA5151' : '#0FA958'}; margin-left:10px; margin-bottom:6px; white-space:pre-wrap;">· ${escapeHtml(info.message).replace(/\n/g, '<br>')}${falseMark}</div>`;
      });
    });
    infoHtml = `<div style="margin-left:20px; margin-top:3px; padding:6px 8px; background:rgba(0,0,0,0.035); border-radius:3px;">
      <div style="color:#07C160; font-size:11px; margin-bottom:3px;">💬 信息（${infoHist.length}条）</div>
      ${dayHtml}
    </div>`;
  }
  return `<div style="padding:6px 0; border-bottom:1px solid rgba(0,0,0,0.03); ${deadStyle}">
    <span style="color:#8c8c8c;">${p.seat+1}号</span>
    <span style="color:${color}; font-weight:bold; margin-left:5px;">${escapeHtml(p.name)}</span>
    <span style="color:#07C160; margin-left:8px;">【${p.roleName}】</span>
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
  resultColor = pi.result ? '#07C160' : '#FA5151';
  
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
    extraInfo += `<div>基础概率：<span style="color:#0FA958;">${(pi.baseProbability * 100).toFixed(1)}%</span></div>`;
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
  
  return `<div style="margin-left:20px; margin-top:4px; padding:6px 10px; background:rgba(0,0,0,0.04); border-radius:4px; border-left:2px solid #07C160; font-size:12px; color:#4f4f4f; line-height:1.6;">
    <div><span style="color:#07C160;">📊 ${pi.description || '概率事件'}</span></div>
    <div>局势：${scenarioText}（平衡分：${pi.balanceScore !== undefined ? pi.balanceScore.toFixed(3) : 'N/A'}）</div>
    <div>概率：<span style="color:#0FA958; font-weight:bold;">${probPct}%</span>（阈值：${threshPct}%）</div>
    ${extraInfo}
    <div>结果：<span style="color:${resultColor}; font-weight:bold;">${resultText}</span></div>
  </div>`;
}

// ========== 上帝视角 · 行动日志渲染 ==========
// 类型 → 图标 / 短标签 / 主色（左侧色条与类型标签用）
const GOD_LOG_TYPE_META = {
  'ROLE_ASSIGN':   { icon: '🎭', label: '身份分配', color: '#07C160' },
  'CUSTOM_ASSIGN': { icon: '🎭', label: '自定义配置', color: '#07C160' },
  'GAME_START':    { icon: '🎬', label: '开局', color: '#191919' },
  'NIGHT_WAKE':    { icon: '🌙', label: '夜晚唤醒', color: '#9B59B6' },
  'NIGHT_ACTION':  { icon: '🌙', label: '夜间行动', color: '#9B59B6' },
  'NIGHT_END':     { icon: '🌅', label: '夜晚结算', color: '#10AEFF' },
  'DEATH':         { icon: '💀', label: '死亡', color: '#FA5151' },
  'NOMINATION':    { icon: '🗳️', label: '提名', color: '#FF9500' },
  'VOTE_RESULT':   { icon: '📊', label: '投票', color: '#FF9500' },
  'EXECUTION':     { icon: '⚖️', label: '处决', color: '#FA5151' },
  'ABILITY':       { icon: '✨', label: '技能', color: '#F5822B' },
  'PRIVATE_INFO':  { icon: '📜', label: '私密信息', color: '#00B578' },
  'GAME_OVER':     { icon: '🏁', label: '结束', color: '#191919' }
};
const GOD_LOG_TYPE_DEFAULT = { icon: '•', label: '记录', color: '#8C8C8C' };

// 日志分组：首夜·第N夜 / 第N天 / 结算（开局配置不再展示）
function godLogGroupOf(entry) {
  const type = entry.type || '';
  if (type === 'GAME_OVER') {
    return { key: 'over', kind: 'over', icon: '🏁', label: '结算' };
  }
  if (String(entry.phase || '').includes('NIGHT')) {
    const n = Number(entry.night) || 0;
    return { key: `n${n}`, kind: 'night', icon: '🌙', label: n <= 0 ? '首夜' : `第 ${n} 夜` };
  }
  // 首夜信息（恶魔/爪牙/酒鬼身份等）在开局阶段就已下发，旧日志里 phase 可能仍是 LOBBY，
  // 统一归入首夜，避免出现「白天」分组
  if ((Number(entry.day) || 0) <= 0 && (Number(entry.night) || 0) <= 0) {
    return { key: 'n0', kind: 'night', icon: '🌙', label: '首夜' };
  }
  const d = Number(entry.day) || 0;
  return { key: `d${d}`, kind: 'day', icon: '☀️', label: d <= 0 ? '白天' : `第 ${d} 天` };
}

// 渲染上下文：上帝视角实时日志默认取 godState.players；
// 历史记录详情页渲染时临时注入该局的玩家列表，复用同一套渲染逻辑。
let godLogPlayersOverride = null;
function godLogPlayers() {
  return godLogPlayersOverride || (godState && godState.players) || [];
}

// 当前渲染行对应的历史快照（日志写入时的角色/存活状态）。
// 日志是历史数据：早期行必须显示当时的角色与生死，而不是对局结束后的最终状态。
let godLogRowStates = null;

// 取玩家信息：历史快照优先，缺失字段回退到当前玩家列表（兼容旧存档）
function godLogPlayerInfo(playerId) {
  const snap = godLogRowStates && godLogRowStates[playerId];
  const p = godLogPlayers().find(x => x.id === playerId);
  if (!snap && !p) return null;
  const pick = (snapKey, curKey) => {
    if (snap && snap[snapKey] !== undefined) return snap[snapKey];
    return p ? p[curKey] : undefined;
  };
  return {
    id: playerId,
    seat: pick('seat', 'seat'),
    name: pick('name', 'name'),
    roleName: pick('roleName', 'roleName'),
    team: pick('team', 'team'),
    category: pick('category', 'category'),
    isAlive: snap && snap.alive !== undefined ? snap.alive : (p ? p.isAlive : undefined)
  };
}

// 玩家徽标：座位号 + 昵称 + 角色，按阵营着色，死亡者置灰
function godLogPlayerChip(playerId) {
  const p = godLogPlayerInfo(playerId);
  if (!p || p.seat < 0 || p.seat === undefined) return '';
  const teamCls = p.team === 'EVIL' ? 'evil' : (p.team === 'GOOD' ? 'good' : '');
  const deadCls = p.isAlive === false ? ' dead' : '';
  const roleText = p.roleName ? `<i>${escapeHtml(p.roleName)}</i>` : '';
  const title = `${p.seat + 1}号 ${p.name}${p.roleName ? ' · ' + p.roleName : ''}${p.isAlive === false ? '（已死亡）' : ''}`;
  return `<span class="gl-chip ${teamCls}${deadCls}" title="${escapeHtml(title)}">`
    + `<b>${p.seat + 1}</b><span class="gl-chip-name">${escapeHtml(p.name)}</span>${roleText}</span>`;
}

// 需要判定为「发动者」的字段（其余玩家 id 视为被作用者）
const GOD_LOG_ACTOR_KEYS = ['playerId', 'nominatorId', 'acterId', 'pacifistId', 'lunaticId', 'executorId'];

// 从 data 中提取玩家 id，渲染「发动者 → 被作用者」流程
function godLogFlowHtml(entry) {
  const data = entry.data || {};
  const players = godLogPlayers();
  if (players.length === 0 && !godLogRowStates) return '';
  // 历史快照里的玩家 id 也要认作有效玩家（玩家列表可能已不含他们）
  const known = new Set(players.map(p => p.id));
  if (godLogRowStates) Object.keys(godLogRowStates).forEach(id => known.add(id));
  const ids = [];
  const addId = (v) => {
    if (typeof v === 'string' && known.has(v) && !ids.includes(v)) ids.push(v);
  };
  Object.keys(data).forEach(k => {
    const v = data[k];
    if (typeof v === 'string') {
      addId(v);
    } else if (Array.isArray(v)) {
      // 兼容 targets: ['id']、deaths: [{ playerId, ... }] 两种形态
      v.forEach(el => {
        if (typeof el === 'string') addId(el);
        else if (el && typeof el === 'object') { addId(el.playerId); addId(el.id); }
      });
    }
  });
  if (ids.length === 0) return '';

  let actorId = null;
  for (const k of GOD_LOG_ACTOR_KEYS) {
    if (known.has(data[k])) { actorId = data[k]; break; }
  }
  if (!actorId) actorId = ids[0];

  const parts = [];
  const actorChip = godLogPlayerChip(actorId);
  if (actorChip) parts.push(actorChip);
  const targets = ids.filter(id => id !== actorId);
  if (targets.length > 0) {
    parts.push('<span class="gl-arrow">→</span>');
    targets.forEach(id => {
      const chip = godLogPlayerChip(id);
      if (chip) parts.push(chip);
    });
  }
  return parts.join('');
}

// 行动行上的状态徽标：行动者当时是否醉酒/中毒（历史日志在写入时已快照）
const GOD_LOG_STATUS_TYPES = new Set(['NIGHT_ACTION', 'NIGHT_WAKE', 'ABILITY', 'PRIVATE_INFO']);
function godLogActorStatusHtml(row) {
  const st = row && row.data && row.data.actorStatus;
  if (!st || !GOD_LOG_STATUS_TYPES.has(row.type)) return '';
  const badges = [];
  if (st.poisoned) badges.push('<span class="gl-state poisoned">🧪 中毒</span>');
  if (st.drunk) badges.push('<span class="gl-state drunk">🍺 醉酒</span>');
  return badges.join('');
}

// 投票面板里的玩家小标签（座位 + 昵称，不重复角色名以免过于拥挤）
function godLogVoterChip(playerId) {
  const p = godLogPlayerInfo(playerId);
  if (!p) return '';
  return `<span class="gl-voter" title="${escapeHtml((p.seat + 1) + '号 ' + p.name)}"><b>${p.seat + 1}</b>${escapeHtml(p.name)}</span>`;
}

// 提名投票结果：通过/未通过 + 票数阈值 + 赞成/反对名单
function godLogVoteHtml(voteResult) {
  if (!voteResult) return '';
  const votes = Array.isArray(voteResult.votes) ? voteResult.votes : [];
  const yes = votes.filter(v => v && v.yes === true).map(v => v.playerId);
  const no = votes.filter(v => v && v.yes !== true).map(v => v.playerId);
  const countText = `${voteResult.voteCount}/${voteResult.threshold} 票`;
  const badge = voteResult.passed
    ? `<span class="gl-vote-badge pass">✅ 通过 ${countText}</span>`
    : `<span class="gl-vote-badge fail">❌ 未通过 ${countText}</span>`;
  const groups = [];
  if (yes.length > 0) {
    groups.push(`<span class="gl-vote-group"><i class="yes">赞成</i>${yes.map(godLogVoterChip).join('')}</span>`);
  }
  if (no.length > 0) {
    groups.push(`<span class="gl-vote-group"><i class="no">反对</i>${no.map(godLogVoterChip).join('')}</span>`);
  }
  return `<div class="gl-vote">${badge}${groups.join('')}</div>`;
}

// 消息内高亮「N号 昵称」与关键结果词，便于扫读
const GOD_LOG_RESULT_TERMS = [
  ['未通过', 'gl-kw-bad'], ['无事发生', 'gl-kw-bad'], ['击杀', 'gl-kw-bad'], ['被杀', 'gl-kw-bad'],
  ['死亡', 'gl-kw-bad'], ['处决', 'gl-kw-bad'], ['猜错', 'gl-kw-bad'], ['失败', 'gl-kw-bad'], ['为假', 'gl-kw-bad'],
  ['存活', 'gl-kw-good'], ['复活', 'gl-kw-good'], ['猜对', 'gl-kw-good'], ['成功', 'gl-kw-good'],
  ['为真', 'gl-kw-good'], ['通过', 'gl-kw-good'], ['拯救', 'gl-kw-good'], ['免疫', 'gl-kw-good'], ['守护', 'gl-kw-good'],
  ['中毒', 'gl-kw-warn'], ['醉酒', 'gl-kw-warn']
];
const GOD_LOG_RESULT_RE = new RegExp(GOD_LOG_RESULT_TERMS.map(t => t[0]).join('|'), 'g');

function highlightGodLogMessage(message) {
  let html = escapeHtml(String(message == null ? '' : message));

  // 座位 + 昵称高亮（如「3号 张三」）
  const players = godLogPlayers();
  players.forEach(p => {
    if (!p.name || p.seat < 0) return;
    const seat = p.seat + 1;
    const name = escapeHtml(p.name);
    [`${seat}号 ${name}`, `${seat}号${name}`].forEach(pat => {
      html = html.split(pat).join(`<span class="gl-ref"><b>${seat}</b>${name}</span>`);
    });
  });

  // 关键结果词高亮（单次扫描，长词优先，避免「未通过」被拆成「未」+「通过」）
  html = html.replace(GOD_LOG_RESULT_RE, (m) => {
    const hit = GOD_LOG_RESULT_TERMS.find(t => t[0] === m);
    return `<span class="${hit ? hit[1] : 'gl-kw-warn'}">${m}</span>`;
  });
  return html;
}

// 可以「吃掉」同一玩家后续私密信息的行动类日志
const GOD_LOG_INFO_MERGE_TYPES = new Set(['NIGHT_ACTION', 'NIGHT_WAKE', 'ABILITY', 'EXECUTION', 'DEATH']);

// 该玩家是否是恶魔（用于把恶魔的击杀行动并入夜晚死亡日志）
// 按日志当时快照的身份判断：中途可能发生恶魔转移（舞蛇人交换等）
function godLogIsDemon(playerId) {
  const p = godLogPlayerInfo(playerId);
  return !!(p && p.category === 'DEMON');
}

// 把原始日志折叠成「显示行」：同一次事件的多条记录合并为一行
// 合并后仍保留 row.time / row.type / row.data，供分组与状态判断使用
function buildGodLogRows(entries) {
  const rows = [];
  const lastOf = () => rows[rows.length - 1];

  entries.forEach(entry => {
    if (!entry) return;
    // 该条日志的玩家状态快照，供 godLogIsDemon 等判定使用（按当时身份/生死）
    godLogRowStates = entry.playerStates || null;
    // 开局配置（身份分配 / 开局提示）不再展示，身份可在玩家列表查看
    const type = entry.type || '';
    if (type === 'ROLE_ASSIGN' || type === 'CUSTOM_ASSIGN' || type === 'GAME_START') return;

    const last = lastOf();
    const data = entry.data || {};

    // 2) 夜晚唤醒 + 同一玩家的夜间行动 → 一行
    if (entry.type === 'NIGHT_ACTION' && last && last.__kind === 'nightWake'
      && last.data && last.data.playerId === data.playerId && last.night === entry.night) {
      rows[rows.length - 1] = { ...entry, __kind: 'nightAction' };
      return;
    }

    // 3) 纯信息角色：唤醒 + 紧随其后的私密信息 → 一行（信息默认折叠）
    if (entry.type === 'PRIVATE_INFO' && last && last.__kind === 'nightWake'
      && last.data && last.data.playerId === data.playerId) {
      rows[rows.length - 1] = { ...entry, __kind: 'nightInfo' };
      return;
    }

    // 3b) 同一玩家的「行动」+「收到信息」→ 一行（行动描述下附信息内容）
    if (entry.type === 'PRIVATE_INFO' && last && last.data && last.data.playerId
      && last.data.playerId === data.playerId && last.night === entry.night
      && last.day === entry.day && GOD_LOG_INFO_MERGE_TYPES.has(last.type)) {
      (last.mergedInfos = last.mergedInfos || []).push(entry);
      return;
    }

    // 4) 提名 + 该次提名的投票结果 → 一行（投票结果由专用面板呈现，不再拼接冗余文案）
    if (entry.type === 'VOTE_RESULT' && last && last.__kind === 'nomination'
      && last.data && last.data.nomineeId && last.data.nomineeId === data.nomineeId) {
      last.voteResult = data;
      return;
    }

    // 5) 夜晚结算 + 紧随其后的死亡 → 一行
    if (entry.type === 'DEATH' && last && last.__kind === 'nightEnd') {
      last.deathRows.push(entry);
      return;
    }

    if (entry.type === 'NIGHT_WAKE') { rows.push({ ...entry, __kind: 'nightWake' }); return; }
    if (entry.type === 'NOMINATION') { rows.push({ ...entry, __kind: 'nomination' }); return; }
    if (entry.type === 'NIGHT_END') {
      // 找出本夜恶魔（小恶魔等）的行动行，目标确实死亡时并入死亡行
      const demonRow = rows.slice().reverse().find(r =>
        r.type === 'NIGHT_ACTION' && r.night === entry.night
        && r.data && godLogIsDemon(r.data.playerId));
      rows.push({ ...entry, __kind: 'nightEnd', deathRows: [], demonRow: demonRow || null });
      return;
    }
    rows.push({ ...entry });
  });

  // 收尾：把「夜末 + 死亡」折叠成一条死亡行，并去掉被合并掉的「死亡玩家：…」冗余文案
  const out = rows.map(row => {
    // 每行渲染时切换到该行自己的历史状态快照
    godLogRowStates = row.playerStates || null;
    // 行动行追加同一玩家收到的信息（去掉重复的「X号 Y（角色）收到信息：」前缀）
    if (row.mergedInfos && row.mergedInfos.length > 0) {
      const base = row.mergeMessage !== undefined ? row.mergeMessage : row.message;
      const infoLines = row.mergedInfos.map(inf => {
        const text = (inf.data && inf.data.info) || inf.message || '';
        const falseMark = inf.data && inf.data.isFalse ? ' ⚠️【假信息】' : '';
        return `📜 ${text}${falseMark}`;
      });
      row.mergeMessage = [base, ...infoLines].join('\n');
    }

    if (row.__kind !== 'nightEnd') return row;

    if (!row.deathRows || row.deathRows.length === 0) {
      // 夜晚死亡通常在「夜晚结算」之前就已记录（DEATH 行在前），此时结算行自身已带死亡名单，
      // 只有确实无人死亡（data.deaths 为空）时才显示平安夜，避免把有死亡的夜晚误标为平安夜
      const nightDeaths = (row.data && row.data.deaths) || [];
      if (nightDeaths.length === 0) {
        row.mergeMessage = String(row.message || '').replace(/，?死亡玩家[:：].*$/, '，平安夜');
      }
      return row;
    }
    row.type = 'DEATH';
    // 死亡行的状态以「死亡那一刻」为准：合并各条死亡记录的快照
    row.playerStates = Object.assign(
      {},
      row.playerStates || {},
      ...(row.deathRows || []).map(d => d.playerStates || {})
    );
    godLogRowStates = row.playerStates;
    // 恶魔击杀成功时，把恶魔的行动并进这条死亡日志（原行动行不再单独显示）
    // 顺序按因果排列：先「杀害」再「死亡」
    const demonRow = row.demonRow;
    const demonTargets = (demonRow && demonRow.data && demonRow.data.targets) || [];
    const killedByDemon = demonRow
      && row.deathRows.some(d => d.data && demonTargets.includes(d.data.playerId));

    const lines = [];
    if (killedByDemon) {
      const demonLine = String(demonRow.message || '')
        .replace(/(夜晚)?行动[:：][ \t]*选择了/, '杀害了');
      lines.push(`👹 ${demonLine}`);
      demonRow.__drop = true;
    }
    // 分组表头已经标明是第几夜，「第N夜结束」不再重复
    row.deathRows.forEach(d => lines.push(d.message));

    row.mergeMessage = lines.join('\n');
    row.mergeFlowHtml = row.deathRows
      .map(d => godLogPlayerChip(d.data && d.data.playerId))
      .filter(Boolean).join('');
    return row;
  });

  godLogRowStates = null;
  return out.filter(r => !r.__drop);
}

// 已有「谁→谁」徽标时，去掉文案里重复的「N号 名字（角色）夜晚行动：」前缀
function stripGodLogPrefix(message, hasFlow) {
  const text = String(message == null ? '' : message);
  if (!hasFlow) return text;
  return text.replace(/^\d+号[ \t]*[^\s（(]+(（[^）]*）|\([^)]*\))?[ \t]*(夜晚)?行动[:：][ \t]*/, '');
}

// 长信息（如间谍魔典）默认折叠，只显示首行
function godLogMessageHtml(message) {
  const text = String(message == null ? '' : message);
  const lines = text.split('\n').filter(l => l.trim() !== '');
  if (text.length <= 160 && lines.length <= 4) return highlightGodLogMessage(text);

  const head = lines[0] || '';
  const rest = lines.slice(1).join('\n').trim() || text.slice(head.length).trim();
  return `<details class="gl-details"><summary>${highlightGodLogMessage(head)}<span class="gl-more"> …展开</span></summary>`
    + `<div class="gl-details-body">${highlightGodLogMessage(rest)}</div></details>`;
}

function appendGodLogRow(row, logContainer) {
  logContainer = logContainer || $('godActionLog');
  if (!logContainer) return;
  // 该行的角色/生死状态使用日志写入时的快照
  godLogRowStates = row.playerStates || null;

  // 分组表头（滚动时吸顶）
  const group = godLogGroupOf(row);
  if (logContainer.dataset.godGroup !== group.key) {
    logContainer.dataset.godGroup = group.key;
    const header = document.createElement('div');
    header.className = `gl-group gl-group-${group.kind}`;
    header.innerHTML = `<span class="gl-group-icon">${group.icon}</span><span>${group.label}</span>`;
    logContainer.appendChild(header);
  }

  const meta = GOD_LOG_TYPE_META[row.type] || GOD_LOG_TYPE_DEFAULT;
  const isFalseInfo = row.type === 'PRIVATE_INFO' && row.data && row.data.isFalse;
  const flow = (row.mergeFlowHtml !== undefined) ? row.mergeFlowHtml : godLogFlowHtml(row);
  let rawMessage = row.mergeMessage !== undefined ? row.mergeMessage : row.message;
  // 私密信息只保留信息正文，去掉「N号 名字（角色）收到信息：」前缀（徽标已有座位/名字）
  if (row.type === 'PRIVATE_INFO' && row.data && typeof row.data.info === 'string') {
    rawMessage = row.data.info;
  }
  let msgText = stripGodLogPrefix(rawMessage, !!flow);
  if (flow) {
    // 目标已经由徽标呈现，去掉纯「选择了 X」这类冗余描述（「选择了角色【X】」保留）
    const lines = msgText.split('\n');
    if (/^选择了(?!角色)/.test(lines[0].trim())) lines.shift();
    msgText = lines.join('\n');
  }
  const messageHtml = godLogMessageHtml(msgText);

  let probHtml = '';
  if (row.data) {
    const probInfos = [];
    if (row.data.probInfo) probInfos.push(row.data.probInfo);
    if (row.data.correctProbInfo) probInfos.push(row.data.correctProbInfo);
    probHtml = probInfos.map(pi => formatProbInfo(pi)).join('');
  }

  const statusHtml = godLogActorStatusHtml(row);
  const voteHtml = row.voteResult ? godLogVoteHtml(row.voteResult) : '';

  const el = document.createElement('div');
  el.className = 'gl-entry';
  el.style.setProperty('--gl-color', meta.color);
  el.innerHTML = `
    <div class="gl-head">
      <span class="gl-time">${escapeHtml(row.time || '')}</span>
      <span class="gl-type">${meta.icon} ${meta.label}</span>
      ${isFalseInfo ? '<span class="gl-false">⚠️ 假信息</span>' : ''}
      ${statusHtml}
      ${flow ? `<span class="gl-flow">${flow}</span>` : ''}
    </div>
    ${messageHtml ? `<div class="gl-msg">${messageHtml}</div>` : ''}
    ${voteHtml}
    ${probHtml}
  `;
  logContainer.appendChild(el);
  godLogRowStates = null;
}

// 把一份行动日志渲染进指定容器：
// 上帝视角实时日志与历史记录详情页共用同一套分组/合并/高亮/配色逻辑。
// players 为该局玩家列表（用于徽标、流程与高亮），渲染期间临时覆盖上下文。
function renderGodLogInto(container, entries, players) {
  if (!container) return;
  const prevOverride = godLogPlayersOverride;
  godLogPlayersOverride = players || null;
  try {
    container.innerHTML = '';
    container.dataset.godGroup = '';
    container.dataset.godRendered = '1';
    buildGodLogRows(entries || []).forEach(row => appendGodLogRow(row, container));
  } finally {
    godLogPlayersOverride = prevOverride;
    godLogRowStates = null;
  }
}

// 全量重建日志：内容变化（尤其是合并）时统一走这里，并保持滚动位置
function renderGodLog() {
  const container = $('godActionLog');
  if (!container) return;
  const firstRender = container.dataset.godRendered !== '1';
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
  const prevScrollTop = container.scrollTop;

  renderGodLogInto(container,
    (godState && godState.actionLog) || [],
    (godState && godState.players) || []);

  container.scrollTop = (firstRender || nearBottom) ? container.scrollHeight : prevScrollTop;
}

// ========== 角色总览 ==========
const ALL_ROLE_INFO = [
  // TB 村民
  { id: 'washerwoman', name: '洗衣妇', team: 'GOOD', category: '村民', script: 'tb',
    ability: '首个夜晚，你得知两名玩家以及其中一名玩家的村民角色。',
    color: '#07C160' },
  { id: 'librarian', name: '图书管理员', team: 'GOOD', category: '村民', script: 'tb',
    ability: '首个夜晚，你得知两名玩家以及其中一名玩家的外来者角色（若无外来者则获知此信息）。',
    color: '#07C160' },
  { id: 'investigator', name: '调查员', team: 'GOOD', category: '村民', script: 'tb',
    ability: '首个夜晚，你得知两名玩家以及其中一名玩家的爪牙角色。',
    color: '#07C160' },
  { id: 'chef', name: '厨师', team: 'GOOD', category: '村民', script: 'tb',
    ability: '首个夜晚，你得知邪恶玩家相邻的对数。',
    color: '#07C160' },
  { id: 'empath', name: '共情者', team: 'GOOD', category: '村民', script: 'tb',
    ability: '每个夜晚，你得知你的左右存活邻居中有多少名邪恶玩家。',
    color: '#07C160' },
  { id: 'fortuneteller', name: '占卜师', team: 'GOOD', category: '村民', script: 'tb',
    ability: '每个夜晚，选择两名玩家：你得知他们之中是否有恶魔。有一名善良玩家会被你当作恶魔（红鲱鱼）。',
    color: '#07C160' },
  { id: 'monk', name: '僧侣', team: 'GOOD', category: '村民', script: 'tb',
    ability: '每个夜晚（首个夜晚除外），选择除你以外的一名玩家：该玩家今晚不会被恶魔杀害。',
    color: '#07C160' },
  { id: 'ravenkeeper', name: '守鸦人', team: 'GOOD', category: '村民', script: 'tb',
    ability: '如果你在夜晚死亡，你被唤醒并选择一名玩家：你得知他的角色。',
    color: '#07C160' },
  { id: 'virgin', name: '圣女', team: 'GOOD', category: '村民', script: 'tb',
    ability: '如果你首次被提名，提名你的玩家若是村民则立即死亡。',
    color: '#07C160' },
  { id: 'slayer', name: '杀手', team: 'GOOD', category: '村民', script: 'tb',
    ability: '每局限一次，白天时可以公开选择一名玩家，如果是恶魔则恶魔死亡。',
    color: '#07C160' },
  { id: 'soldier', name: '士兵', team: 'GOOD', category: '村民', script: 'tb',
    ability: '你不会被恶魔杀害。',
    color: '#07C160' },
  { id: 'mayor', name: '市长', team: 'GOOD', category: '村民', script: 'tb',
    ability: '如果只剩三名玩家存活且你未被处决，你的阵营获胜。如果你在夜晚死亡，可能有其他玩家替你死去。',
    color: '#07C160' },
  { id: 'undertaker', name: '掘墓人', team: 'GOOD', category: '村民', script: 'tb',
    ability: '每个夜晚（首个夜晚除外），你得知今天白天被处决玩家的角色。',
    color: '#07C160' },
  // TB 外来者
  { id: 'saint', name: '圣徒', team: 'GOOD', category: '外来者', script: 'tb',
    ability: '如果你被处决，邪恶阵营获胜。',
    color: '#FF9500' },
  { id: 'butler', name: '管家', team: 'GOOD', category: '外来者', script: 'tb',
    ability: '每个夜晚，选择一名玩家（非自己）：明天你只能在该玩家投赞成票时投赞成票。',
    color: '#FF9500' },
  { id: 'drunk', name: '酒鬼', team: 'GOOD', category: '外来者', script: 'tb',
    ability: '你不知道自己是酒鬼。你以为自己是一个村民角色，但实际上你没有技能，你的信息是不可靠的。',
    color: '#FF9500' },
  { id: 'recluse', name: '隐士', team: 'GOOD', category: '外来者', script: 'tb',
    ability: '你可能被登记为邪恶阵营、爪牙或恶魔。你可能在夜晚死亡，即使没人想杀你。',
    color: '#FF9500' },
  // TB 爪牙
  { id: 'poisoner', name: '下毒者', team: 'EVIL', category: '爪牙', script: 'tb',
    ability: '每个夜晚，选择一名玩家：该玩家今晚和明天中毒，技能异常或失效。',
    color: '#FA5151' },
  { id: 'scarletwoman', name: '红唇女郎', team: 'EVIL', category: '爪牙', script: 'tb',
    ability: '如果恶魔死亡时存活玩家数≥5，你成为新恶魔。',
    color: '#FA5151' },
  { id: 'baron', name: '男爵', team: 'EVIL', category: '爪牙', script: 'tb',
    ability: '有两名额外的外来者在场（因此少两名村民）。',
    color: '#FA5151' },
  { id: 'spy', name: '间谍', team: 'EVIL', category: '爪牙', script: 'tb',
    ability: '每个夜晚，你查看恶魔魔典（得知所有玩家身份）。你可能被登记为善良阵营、村民或外来者。',
    color: '#FA5151' },
  // TB 恶魔
  { id: 'imp', name: '小恶魔', team: 'EVIL', category: '恶魔', script: 'tb',
    ability: '每个夜晚（除首夜），选择一名玩家将其杀害。首夜得知爪牙和3个不在场身份。',
    color: '#FA5151' },
  // BMR 村民
  { id: 'grandmother', name: '祖母', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '首夜得知一名善良玩家及其角色（作为你的"孙子"）；若孙子被恶魔杀死，你也会死亡。',
    color: '#07C160' },
  { id: 'sailor', name: '水手', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '每个夜晚，选择一名存活玩家，你或该玩家醉酒直到下一个黄昏；水手不会死亡。',
    color: '#07C160' },
  { id: 'maid', name: '侍女', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '每个夜晚，选择除自己外的两名存活玩家，得知他们中有几人在当晚因自身能力被唤醒。',
    color: '#07C160' },
  { id: 'exorcist', name: '驱魔人', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '每个夜晚，选择一名玩家（不能与上夜相同），若选中恶魔：恶魔得知驱魔人是谁，该恶魔能力失效。',
    color: '#07C160' },
  { id: 'innkeeper', name: '旅店老板', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '第二夜起，选择两名玩家，他们当晚不会死亡，但其中一人会醉酒到下一个黄昏。',
    color: '#07C160' },
  { id: 'gambler', name: '赌徒', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '第二夜起，选择一名玩家并猜测其角色，猜错则赌徒死亡。',
    color: '#07C160' },
  { id: 'gossip', name: '造谣者', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '每个白天可公开发表一个声明，若声明为真，当晚一名玩家死亡。',
    color: '#07C160' },
  { id: 'courtier', name: '侍臣', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '每局游戏限一次在夜晚时，选择一个角色：如果该角色在场，该角色之一从当晚开始醉酒三天三夜。',
    color: '#07C160' },
  { id: 'professor', name: '教授', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '选择一名死亡玩家，若该玩家是镇民则复活（一次性能力）。',
    color: '#07C160' },
  { id: 'bard', name: '吟游诗人', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '当一名爪牙死于处决时，除了你以外的所有其他玩家醉酒直到明天黄昏。',
    color: '#07C160' },
  { id: 'tealady', name: '茶艺师', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '如果与你邻近的两名存活的玩家是善良的，他们不会死亡。',
    color: '#07C160' },
  { id: 'pacifist', name: '和平主义者', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '被处决的善良玩家可能不会死亡。',
    color: '#07C160' },
  { id: 'fool', name: '弄臣', team: 'GOOD', category: '村民', script: 'bmr',
    ability: '当你首次将要死亡时，你不会死亡。',
    color: '#07C160' },
  // BMR 外来者
  { id: 'tinker', name: '修补匠', team: 'GOOD', category: '外来者', script: 'bmr',
    ability: '可能会在夜晚死亡（由说书人决定）。',
    color: '#FF9500' },
  { id: 'moonchild', name: '月之子', team: 'GOOD', category: '外来者', script: 'bmr',
    ability: '当你得知你死亡时，你要公开选择一名存活的玩家。如果他是善良的，在当晚他会死亡。',
    color: '#FF9500' },
  { id: 'lunatic', name: '莽夫', team: 'GOOD', category: '外来者', script: 'bmr',
    ability: '每个夜晚，首个使用其自身能力选择了你的玩家会醉酒直到下个黄昏。你会转变为他的阵营。',
    color: '#FF9500' },
  { id: 'madman', name: '疯子', team: 'GOOD', category: '外来者', script: 'bmr',
    ability: '你以为你是一个恶魔，但其实你不是。恶魔知道你是疯子以及你在每个夜晚选择了哪些玩家。',
    color: '#FF9500' },
  // BMR 爪牙
  { id: 'godfather', name: '教父', team: 'EVIL', category: '爪牙', script: 'bmr',
    ability: '在你的首个夜晚，你会得知有哪些外来者角色在场。如果有外来者在白天死亡，你会在当晚被唤醒并且你要选择一名玩家：他死亡。在场时人数配置会变动外来者+1或-1。',
    color: '#FA5151' },
  { id: 'devilsadvocate', name: '魔鬼代言人', team: 'EVIL', category: '爪牙', script: 'bmr',
    ability: '每个夜晚，选择一名存活玩家（与上个夜晚不同）：如果该玩家明天白天被处决则不会死。',
    color: '#FA5151' },
  { id: 'assassin', name: '刺客', team: 'EVIL', category: '爪牙', script: 'bmr',
    ability: '在夜晚时，选择一名玩家杀死（一次性能力），无论什么情况选择的玩家都会死亡。',
    color: '#FA5151' },
  { id: 'mastermind', name: '主谋', team: 'EVIL', category: '爪牙', script: 'bmr',
    ability: '如果恶魔因为死于处决而因此导致游戏结束时，再额外进行一个夜晚和一个白天。在那个白天如果有玩家被处决，他的阵营落败。',
    color: '#FA5151' },
  // BMR 恶魔
  { id: 'zombuul', name: '僵怖', team: 'EVIL', category: '恶魔', script: 'bmr',
    ability: '每个夜晚，若白天无人死亡，选择一名玩家杀死。当你首次死亡后，你仍存活，但是会被当作死亡。',
    color: '#E64340' },
  { id: 'pukka', name: '普卡', team: 'EVIL', category: '恶魔', script: 'bmr',
    ability: '每个夜晚，选择一名玩家中毒，上一夜被毒的玩家在当晚死亡并恢复健康。',
    color: '#E64340' },
  { id: 'shabaloth', name: '沙巴洛斯', team: 'EVIL', category: '恶魔', script: 'bmr',
    ability: '每个夜晚，选择两名玩家杀死；你上个夜晚选择过且当前死亡的玩家之一可能会被你反刍（复活）。',
    color: '#E64340' },
  { id: 'po', name: '珀', team: 'EVIL', category: '恶魔', script: 'bmr',
    ability: '每个夜晚，你可以选择一名玩家：他死亡。如果你上次选择时没有选择任何玩家，当晚你要选择三名玩家：他们死亡。',
    color: '#E64340' },
  // SNV 村民
  { id: 'clockmaker', name: '钟表匠', team: 'GOOD', category: '村民', script: 'snv',
    ability: '在你的首个夜晚，你得知恶魔与最近的爪牙之间隔了几名玩家。',
    color: '#07C160' },
  { id: 'dreamer', name: '入梦人', team: 'GOOD', category: '村民', script: 'snv',
    ability: '每个夜晚，选择除你以外的一名玩家：你得知一个善良角色和一个邪恶角色，其中一个是该玩家的角色。',
    color: '#07C160' },
  { id: 'snakecharmer', name: '舞蛇人', team: 'GOOD', category: '村民', script: 'snv',
    ability: '每个夜晚，选择一名存活玩家：如果你选中了恶魔，你与恶魔交换身份和阵营，且原恶魔从此中毒（永久）。',
    color: '#07C160' },
  { id: 'mathematician', name: '数学家', team: 'GOOD', category: '村民', script: 'snv',
    ability: '每个夜晚，你得知自拂晓起有多少名玩家的技能因其他角色的技能而未正常生效（中毒或醉酒）。',
    color: '#07C160' },
  { id: 'flowergirl', name: '花艺师', team: 'GOOD', category: '村民', script: 'snv',
    ability: '每个夜晚（首夜除外），你得知恶魔在今天是否投过票。',
    color: '#07C160' },
  { id: 'towncrier', name: '公告员', team: 'GOOD', category: '村民', script: 'snv',
    ability: '每个夜晚（首夜除外），你得知今天是否有爪牙发起过提名。',
    color: '#07C160' },
  { id: 'oracle', name: '神谕者', team: 'GOOD', category: '村民', script: 'snv',
    ability: '每个夜晚（首夜除外），你得知死亡玩家中有多少名是邪恶阵营。',
    color: '#07C160' },
  { id: 'savant', name: '学者', team: 'GOOD', category: '村民', script: 'snv',
    ability: '每个白天，你可以私下向说书人问两个是非题，你会得到一个真话和一个假话。',
    color: '#07C160' },
  { id: 'seamstress', name: '裁缝', team: 'GOOD', category: '村民', script: 'snv',
    ability: '每局游戏限一次，在夜晚时选择除你以外的两名玩家（可以是死亡玩家）：你得知他们是否属于同一阵营。',
    color: '#07C160' },
  { id: 'philosopher', name: '哲学家', team: 'GOOD', category: '村民', script: 'snv',
    ability: '每局游戏限一次，在夜晚时选择一个善良角色：你获得该角色的能力。如果该角色在场，该玩家醉酒直到你死亡。',
    color: '#07C160' },
  { id: 'artist', name: '艺术家', team: 'GOOD', category: '村民', script: 'snv',
    ability: '每局游戏限一次，在白天时私下向说书人提一个是非题，你会得到真实答案。',
    color: '#07C160' },
  { id: 'juggler', name: '杂耍艺人', team: 'GOOD', category: '村民', script: 'snv',
    ability: '在首个白天，你可以公开猜测至多5名玩家的角色。当晚，你得知你猜对了几个。',
    color: '#07C160' },
  { id: 'sage', name: '贤者', team: 'GOOD', category: '村民', script: 'snv',
    ability: '如果你被恶魔杀害，你得知两名玩家，其中一名是恶魔。',
    color: '#07C160' },
  // SNV 外来者
  { id: 'mutant', name: '变种人', team: 'GOOD', category: '外来者', script: 'snv',
    ability: '如果你公开声称自己是外来者（疯狂），你可能被处决。',
    color: '#FF9500' },
  { id: 'sweetheart', name: '心上人', team: 'GOOD', category: '外来者', script: 'snv',
    ability: '当你死亡时，一名玩家会永久醉酒。',
    color: '#FF9500' },
  { id: 'barber', name: '理发师', team: 'GOOD', category: '外来者', script: 'snv',
    ability: '如果你死亡，当晚恶魔可以选择两名玩家交换他们的身份（不能选恶魔，阵营不变）。',
    color: '#FF9500' },
  { id: 'klutz', name: '傻瓜', team: 'GOOD', category: '外来者', script: 'snv',
    ability: '当你得知你死亡时，你要公开选择一名存活玩家：如果他是邪恶的，你的阵营落败。',
    color: '#FF9500' },
  // SNV 爪牙
  { id: 'eviltwin', name: '邪恶双子', team: 'EVIL', category: '爪牙', script: 'snv',
    ability: '你与一名善良玩家互知身份。若善良的双子被处决，邪恶阵营获胜；若你被处决，善良阵营获胜。只要双子都存活，好人即使杀死恶魔也无法获胜。',
    color: '#FA5151' },
  { id: 'witch', name: '女巫', team: 'EVIL', category: '爪牙', script: 'snv',
    ability: '每个夜晚，选择一名玩家：如果他在明天发起了提名，他会立即死亡（提名仍然有效）。场上仅剩3名存活玩家时你失去此技能。',
    color: '#FA5151' },
  { id: 'cerenovus', name: '洗脑师', team: 'EVIL', category: '爪牙', script: 'snv',
    ability: '每个夜晚，选择一名玩家和一个善良角色：如果他明天没有公开声称自己是该角色，他会被处决。',
    color: '#FA5151' },
  { id: 'pithag', name: '坑巫', team: 'EVIL', category: '爪牙', script: 'snv',
    ability: '每个夜晚（首夜除外），选择一名玩家和一个不在场的角色：该玩家变成该角色（阵营不变）；若因此产生新恶魔，当晚死亡由说书人决定。',
    color: '#FA5151' },
  // SNV 恶魔
  { id: 'fanggu', name: '方古', team: 'EVIL', category: '恶魔', script: 'snv',
    ability: '每个夜晚（首夜除外），选择一名玩家杀害。方古首次杀死外来者时，该外来者变成邪恶的方古，你死亡。（设置修正：外来者+1）',
    color: '#E64340' },
  { id: 'vigormortis', name: '亡灵法师', team: 'EVIL', category: '恶魔', script: 'snv',
    ability: '每个夜晚（首夜除外），选择一名玩家杀害。被你杀害的爪牙保留技能，并使一名相邻村民中毒；当你死亡时，一名爪牙死亡。',
    color: '#E64340' },
  { id: 'nodashii', name: '黑暗之源', team: 'EVIL', category: '恶魔', script: 'snv',
    ability: '每个夜晚（首夜除外），选择一名玩家杀害。与你相邻的两名存活村民中毒。',
    color: '#E64340' },
  { id: 'vortox', name: '混沌', team: 'EVIL', category: '恶魔', script: 'snv',
    ability: '每个夜晚（首夜除外），选择一名玩家杀害。所有村民技能必定产出错误信息。如果今天无人被处决，邪恶阵营获胜。',
    color: '#E64340' }
];

// 剧本信息映射（用于卡片显示和角色总览标题）
const SCRIPT_INFO = {
  tb: { id: 'tb', name: '灾祸之酿', nameEn: 'Trouble Brewing', icon: '🍺', color: '#07C160',
        desc: '新手友好，推荐入门' },
  bmr: { id: 'bmr', name: '黯月初升', nameEn: 'Bad Moon Rising', icon: '🌑', color: '#9b59b6',
         desc: '进阶剧本，更多恶魔' },
  snv: { id: 'snv', name: '紫罗兰教派', nameEn: 'Sects & Violets', icon: '🟣', color: '#8e44ad',
         desc: '高难剧本，疯狂与变形' }
};

// ========== 公开公告（伪装用，不触发任何角色能力） ==========
// 按剧本列出可供伪装的公开角色，前缀与其真实公告格式保持一致
// inputType: text = 自由输入；player = 从当前房间存活玩家中选择
// TB 的杀手是白天公开技能（选择一名玩家），因此同样可以通过公告伪装
const ANNOUNCE_ROLE_PRESETS = [
  { id: 'slayer', name: '杀手', script: 'tb', inputType: 'player', prefix: '【杀手声明】我选择 ', maxLen: 60 },
  { id: 'gossip', name: '造谣者', script: 'bmr', inputType: 'text', prefix: '【造谣者声明】', placeholder: '例如：3号 是恶魔', maxLen: 120 },
  { id: 'moonchild', name: '月之子', script: 'bmr', inputType: 'player', prefix: '【月之子声明】我选择 ', maxLen: 60 },
  // 紫罗兰教派（宣称类技能，真伪公告格式一致）
  { id: 'mutant', name: '变种人', script: 'snv', inputType: 'text', prefix: '【变种人声明】我是外来者', placeholder: '变种人声明（内容固定）', maxLen: 40 },
  { id: 'cerenovus_claim', name: '洗脑宣告', script: 'snv', inputType: 'text', prefix: '【洗脑宣告】我是', placeholder: '例如：僧侣', maxLen: 40 },
  // 杂耍艺人：伪装时与真实技能一致，一次性选择玩家与角色（最多5条）
  { id: 'juggler', name: '杂耍艺人', script: 'snv', inputType: 'juggler', prefix: '【杂耍艺人猜测】', placeholder: '点击「发送公告」后一次性选择玩家与角色（最多5条）', maxLen: 120 },
  { id: 'klutz', name: '傻瓜', script: 'snv', inputType: 'player', prefix: '【傻瓜声明】我选择 ', maxLen: 60 }
];

// 当前剧本下可发起公告的角色（剧本内没有此类角色时返回空数组）
function getAvailableAnnouncePresets() {
  const scriptId = (currentState && currentState.script) || 'tb';
  return ANNOUNCE_ROLE_PRESETS.filter(p => p.script === scriptId);
}

// 根据当前剧本与所在频道动态显示 / 隐藏「公开公告」按钮
// 条件：当前剧本含公告角色（如黯月初升的造谣者 / 月之子）且处于主房间（公聊）
function updateAnnounceButtonVisibility() {
  const btn = document.querySelector('.announce-trigger-btn');
  if (!btn) return;
  const available = getAvailableAnnouncePresets().length > 0 && currentChatChannel === 'public';
  btn.style.display = available ? '' : 'none';
}

function openAnnouncePanel() {
  const panel = $('announcePanel');
  if (!panel) return;
  if (currentChatChannel !== 'public') {
    showToast('只有主房间内才能发起公开公告');
    return;
  }
  if (getAvailableAnnouncePresets().length === 0) {
    showToast('当前剧本没有可发起公告的角色');
    return;
  }
  renderAnnounceRoleOptions();
  const ta = $('announceText');
  if (ta) ta.value = '';
  renderAnnouncePlayerOptions();
  updateAnnouncePreview();
  panel.style.display = 'flex';
  setTimeout(() => { if (ta) ta.focus(); }, 80);
}

// inputType 为 player 的公告角色（杀手 / 月之子）：只能从当前房间存活玩家中选择
function renderAnnouncePlayerOptions() {
  const sel = $('announcePlayer');
  if (!sel) return;
  const players = ((currentState && currentState.players) || [])
    .filter(p => p.seat !== -1 && p.isAlive)
    .sort((a, b) => a.seat - b.seat);
  sel.innerHTML = players.length
    ? players.map(p => `<option value="${p.id}">${p.seat + 1}号 ${escapeHtml(p.name)}</option>`).join('')
    : '<option value="">（没有可选玩家）</option>';
}

// 取当前角色对应的公告正文
function getAnnounceTargetText() {
  const preset = getAnnouncePreset();
  if (preset.inputType === 'player') {
    const sel = $('announcePlayer');
    if (!sel || !sel.value) return '';
    const p = ((currentState && currentState.players) || []).find(x => x.id === sel.value);
    return p ? `${p.seat + 1}号 ${p.name}` : '';
  }
  const ta = $('announceText');
  return ta ? ta.value.trim() : '';
}

function closeAnnouncePanel() {
  const panel = $('announcePanel');
  if (panel) panel.style.display = 'none';
}

function getAnnouncePreset() {
  const sel = $('announceRole');
  const id = sel ? sel.value : '';
  const list = getAvailableAnnouncePresets();
  return list.find(p => p.id === id) || list[0];
}

function renderAnnounceRoleOptions() {
  const sel = $('announceRole');
  if (!sel) return;
  sel.innerHTML = getAvailableAnnouncePresets()
    .map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
    .join('');
}

function updateAnnouncePreview() {
  const preset = getAnnouncePreset();
  const ta = $('announceText');
  const prev = $('announcePreview');
  const cnt = $('announceCount');
  const textField = $('annTextField');
  const playerField = $('annPlayerField');
  const isPlayer = preset.inputType === 'player';
  // 杂耍艺人：与真实技能一致，用「玩家 + 角色」的一次性批量选择，不需要自由文本
  const isJuggler = preset.inputType === 'juggler';

  // 按角色切换输入方式：造谣者=自由文本，杀手 / 月之子=选择存活玩家，杂耍艺人=批量选择
  if (textField) textField.style.display = (isPlayer || isJuggler) ? 'none' : '';
  if (playerField) playerField.style.display = isPlayer ? '' : 'none';

  if (ta) {
    ta.maxLength = preset.maxLen;
    ta.placeholder = preset.placeholder || '';
    if (cnt) cnt.textContent = `${ta.value.length}/${preset.maxLen}`;
  }

  if (isJuggler) {
    if (prev) prev.textContent = `${preset.prefix}（发送时一次性选择玩家与角色，最多5条）`;
    return;
  }

  const body = getAnnounceTargetText();
  if (prev) prev.textContent = `${preset.prefix}${body || '……'}`;
}

async function sendAnnouncement() {
  const preset = getAnnouncePreset();
  // 公开公告仅能在主房间（公聊）发起（服务端同样校验）
  if (currentChatChannel !== 'public') {
    showToast('只有主房间内才能发起公开公告');
    closeAnnouncePanel();
    return;
  }

  // 杂耍艺人：与真实技能相同的批量选择，生成与真实公告逐字一致的文案
  if (preset.inputType === 'juggler') {
    const guesses = await showJugglerGuessesDialog('公开公告：杂耍艺人猜测', {
      description: '选择要冒充公布的猜测（与真实技能相同的选择方式，最多5条）。'
    });
    if (!guesses || guesses.length === 0) return;
    const text = formatJugglerGuesses(guesses);
    socket.emit('chat:announce', { roleId: preset.id, text, channel: currentChatChannel });
    closeAnnouncePanel();
    return;
  }

  const text = getAnnounceTargetText();
  if (!text) {
    showToast(preset.inputType === 'player' ? '请选择一名存活玩家' : '请输入公告内容');
    return;
  }
  socket.emit('chat:announce', { roleId: preset.id, text, channel: currentChatChannel });
  closeAnnouncePanel();
}

// 角色总览当前查看的剧本（可在弹窗内手动切换）
let _roScriptId = null;
// 移动端角色总览当前查看的阵营（桌面端四个阵营同时展示，不使用该状态）
let _roActiveCategory = '村民';

function openRoleOverview() {
  const panel = document.getElementById('roleOverviewPanel');
  if (!panel) return;
  panel.style.display = 'flex';
  // 默认展示当前房间使用的剧本
  _roScriptId = (currentState && currentState.script) || 'tb';
  renderRoleOverview();
}

// 弹窗内手动切换剧本查看
function switchRoleOverviewScript(scriptId) {
  if (!SCRIPT_INFO[scriptId]) return;
  _roScriptId = scriptId;
  renderRoleOverview();
}

// 移动端：切换查看的阵营（桌面端无此交互，四个阵营同时展示）
function switchRoleOverviewCategory(cat) {
  _roActiveCategory = cat;
  document.querySelectorAll('#roCatTabs .wx-ro-cat').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cat === cat);
  });
  applyRoleOverviewCategory();
}

function applyRoleOverviewCategory() {
  document.querySelectorAll('.wx-ro-cat-block').forEach(block => {
    block.classList.toggle('active', block.dataset.cat === _roActiveCategory);
  });
}

function renderRoleOverview() {
  const scriptId = _roScriptId || (currentState && currentState.script) || 'tb';
  const info = SCRIPT_INFO[scriptId] || { icon: '📜', name: '角色总览', nameEn: '', color: '#10AEFF' };
  const rolesForScript = ALL_ROLE_INFO.filter(r => r.script === scriptId);

  // 剧本切换按钮
  const tabsEl = document.getElementById('roScriptTabs');
  if (tabsEl) {
    tabsEl.innerHTML = Object.values(SCRIPT_INFO).map(s => {
      const active = s.id === scriptId ? ' active' : '';
      return `<button class="wx-ro-tab${active}" onclick="switchRoleOverviewScript('${s.id}')">${s.icon} ${s.name}</button>`;
    }).join('');
  }

  // 更新标题
  const titleEl = document.getElementById('roleOverviewTitle');
  if (titleEl) {
    titleEl.innerHTML = `<span style="font-size:1.1em;">${info.icon}</span> ${info.name} <span style="font-size:0.75em; color:#8c8c8c; font-weight:normal;">${info.nameEn}</span>`;
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
      container.innerHTML = '<div style="color:#999999; font-size:12px; padding:8px; text-align:center;">本剧本无此类角色</div>';
      continue;
    }
    container.innerHTML = roles.map(r => {
      const teamLabel = r.team === 'GOOD' ? '善良阵营' : '邪恶阵营';
      const teamBg = r.team === 'GOOD' ? 'rgba(7,193,96,0.2)' : 'rgba(250,81,81,0.2)';
      return `<div class="role-card">
        <div class="role-card-name" style="color:${r.color};">${r.name}</div>
        <div class="role-card-team" style="background:${teamBg}; color:${r.color};">${teamLabel}</div>
        <div class="role-card-desc">${r.ability}</div>
      </div>`;
    }).join('');
  }

  // 移动端：阵营切换按钮（含角色数量），并只显示当前选中的阵营
  const catTabsEl = document.getElementById('roCatTabs');
  if (catTabsEl) {
    catTabsEl.innerHTML = Object.entries(categories).map(([cat]) => {
      const count = rolesForScript.filter(r => r.category === cat).length;
      const active = cat === _roActiveCategory ? ' active' : '';
      return `<button class="wx-ro-cat${active}" data-cat="${cat}" onclick="switchRoleOverviewCategory('${cat}')">${cat} ${count}</button>`;
    }).join('');
  }
  applyRoleOverviewCategory();
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
  zombuul: 'demon', pukka: 'demon', shabaloth: 'demon', po: 'demon',
  // SNV 村民
  clockmaker: 'townsfolk', dreamer: 'townsfolk', snakecharmer: 'townsfolk',
  mathematician: 'townsfolk', flowergirl: 'townsfolk', towncrier: 'townsfolk',
  oracle: 'townsfolk', savant: 'townsfolk', seamstress: 'townsfolk',
  philosopher: 'townsfolk', artist: 'townsfolk', juggler: 'townsfolk', sage: 'townsfolk',
  // SNV 外来者
  mutant: 'outsider', sweetheart: 'outsider', barber: 'outsider', klutz: 'outsider',
  // SNV 爪牙
  eviltwin: 'minion', witch: 'minion', cerenovus: 'minion', pithag: 'minion',
  // SNV 恶魔
  fanggu: 'demon', vigormortis: 'demon', nodashii: 'demon', vortox: 'demon'
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
  mastermind: 'bmr', zombuul: 'bmr', pukka: 'bmr', shabaloth: 'bmr', po: 'bmr',
  // SNV
  clockmaker: 'snv', dreamer: 'snv', snakecharmer: 'snv', mathematician: 'snv',
  flowergirl: 'snv', towncrier: 'snv', oracle: 'snv', savant: 'snv', seamstress: 'snv',
  philosopher: 'snv', artist: 'snv', juggler: 'snv', sage: 'snv', mutant: 'snv',
  sweetheart: 'snv', barber: 'snv', klutz: 'snv', eviltwin: 'snv', witch: 'snv',
  cerenovus: 'snv', pithag: 'snv', fanggu: 'snv', vigormortis: 'snv', nodashii: 'snv',
  vortox: 'snv'
};

// 各剧本影响配比的角色（null 表示该剧本没有此类角色）
const SCRIPT_SETUP_CHAR = {
  tb: { id: 'baron', name: '男爵', type: 'baron' },
  bmr: { id: 'godfather', name: '教父', type: 'godfather' },
  snv: { id: null, name: '', type: null }
};

function getSetupChar(scriptId) {
  return SCRIPT_SETUP_CHAR[scriptId] || SCRIPT_SETUP_CHAR.tb;
}

// 人数配置表：[玩家数, 村民, 外来者, 爪牙, 恶魔]
const ROLE_COMPOSITION_TABLE = [
  [5, 3, 0, 1, 1], [6, 3, 1, 1, 1], [7, 5, 0, 1, 1], [8, 5, 1, 1, 1],
  [9, 5, 2, 1, 1], [10, 7, 0, 2, 1], [11, 7, 1, 2, 1], [12, 7, 2, 2, 1],
  [13, 9, 0, 3, 1], [14, 9, 1, 3, 1], [15, 9, 2, 3, 1]
];

// SNV 恶魔自带的配比修正（与后端 SNV_DEMON_SETUP_DELTA 保持一致）
const SNV_DEMON_SETUP_DELTA = { fanggu: 1, vigormortis: -1 };
const SNV_DEMON_SETUP_NAME = { fanggu: '方古', vigormortis: '亡灵法师' };

// gfDelta：教父「外来者±1」方向（1 / -1），默认取自定义面板当前选择
// demonId：已选恶魔（紫罗兰教派：方古 外来者+1、亡灵法师 外来者-1）
function getComp(playerCount, hasSetupChar, scriptId, gfDelta = customGfDelta, demonId = null) {
  const entry = ROLE_COMPOSITION_TABLE.find(c => c[0] === playerCount);
  if (!entry) return { townsfolk: 3, outsider: 0, minion: 1, demon: 1 };
  let t = entry[1], o = entry[2];
  const setupType = getSetupChar(scriptId).type;
  let effectiveDelta = null;
  if (hasSetupChar) {
    if (setupType === 'baron') {
      t -= 2; o += 2;
    } else if (setupType === 'godfather') {
      // 教父：外来者+1或-1（自定义模式下由房主明确选择，服务端按同一方向分配）
      let delta = (gfDelta === -1) ? -1 : 1;
      if (o + delta < 0) delta = 0;  // 基准外来者为 0 时 -1 无处可减，按不变化处理
      o += delta;
      t -= delta;
      effectiveDelta = delta;
    }
  }

  // 紫罗兰教派：恶魔的设置修正（与后端逻辑一致，基准外来者为 0 时不生效）
  let demonDelta = 0;
  if (scriptId === 'snv' && demonId && SNV_DEMON_SETUP_DELTA[demonId]) {
    demonDelta = SNV_DEMON_SETUP_DELTA[demonId];
    if (o + demonDelta < 0) demonDelta = 0;
    o += demonDelta;
    t -= demonDelta;
  }

  return {
    townsfolk: t,
    outsider: o,
    minion: entry[3],
    demon: entry[4],
    setupType,
    baseOutsider: entry[2],   // 基准外来者数：为 0 时无法 -1
    godfatherDelta: (hasSetupChar && setupType === 'godfather') ? ((gfDelta === -1) ? -1 : 1) : null,
    effectiveDelta,            // 实际生效的 ±1 方向（0 = 不变化）
    demonId: demonId || null,
    demonDelta                 // SNV 恶魔设置修正（0 = 不变化）
  };
}

// 验证自定义角色配置，返回 { valid: boolean, errors: string[], comp: object, counts: object }
function validateCustomRoles(customRoleMap, playerCount, scriptId, gfDelta = customGfDelta) {
  const script = scriptId || 'tb';
  const setupChar = getSetupChar(script);
  const setupCharId = setupChar.id;
  const setupCharName = setupChar.name;
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
  // 紫罗兰教派：按已选恶魔实时套用设置修正（方古 外来者+1 / 亡灵法师 外来者-1）
  const selectedDemonId = assigned.find(r => ROLE_CATEGORY[r] === 'demon') || null;
  const comp = getComp(playerCount, hasSetupChar, script, gfDelta, selectedDemonId);

  // 3. 按类别统计已指定角色
  const counts = { townsfolk: 0, outsider: 0, minion: 0, demon: 0 };
  assigned.forEach(r => {
    const cat = ROLE_CATEGORY[r];
    if (cat) counts[cat]++;
  });

  // 4. 检查各类别是否超限
  // 教父的「外来者±1」已在 getComp 中按房主选择的方向落到具体数值上，此处不再放宽
  const gfTag = (hasSetupChar && comp.setupType === 'godfather' && comp.effectiveDelta !== 0)
    ? `${setupCharName}外来者${comp.effectiveDelta > 0 ? '+1' : '-1'}`
    : '';
  // 方古/亡灵法师的设置修正提示（与后端一致）
  const demonTag = comp.demonDelta
    ? `${SNV_DEMON_SETUP_NAME[comp.demonId] || '恶魔'}外来者${comp.demonDelta > 0 ? '+1' : '-1'}`
    : '';
  const setupTag = [gfTag, demonTag].filter(Boolean).join('；');

  if (counts.demon > comp.demon) {
    errors.push(`恶魔最多 ${comp.demon} 名，已指定 ${counts.demon} 名`);
  }
  if (counts.minion > comp.minion) {
    const setupTag = (hasSetupChar || !setupCharName) ? '' : `（不含${setupCharName}）`;
    errors.push(`爪牙最多 ${comp.minion} 名${setupTag}，已指定 ${counts.minion} 名`);
  }
  if (counts.outsider > comp.outsider) {
    errors.push(`外来者最多 ${comp.outsider} 名${setupTag ? `（含${setupTag}）` : ''}，已指定 ${counts.outsider} 名`);
  }
  if (counts.townsfolk > comp.townsfolk) {
    errors.push(`村民最多 ${comp.townsfolk} 名${setupTag ? `（含${setupTag}）` : ''}，已指定 ${counts.townsfolk} 名`);
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
    hasSetupChar,
    setupCharId,
    setupCharName
  };
}

const CUSTOM_ROLE_OPTIONS = [
  { id: '', name: '随机分配', color: '#888' },
  // TB 村民
  { id: 'washerwoman', name: '洗衣妇（村民）', color: '#07C160' },
  { id: 'librarian', name: '图书管理员（村民）', color: '#07C160' },
  { id: 'investigator', name: '调查员（村民）', color: '#07C160' },
  { id: 'chef', name: '厨师（村民）', color: '#07C160' },
  { id: 'empath', name: '共情者（村民）', color: '#07C160' },
  { id: 'fortuneteller', name: '占卜师（村民）', color: '#07C160' },
  { id: 'monk', name: '僧侣（村民）', color: '#07C160' },
  { id: 'ravenkeeper', name: '守鸦人（村民）', color: '#07C160' },
  { id: 'virgin', name: '圣女（村民）', color: '#07C160' },
  { id: 'slayer', name: '杀手（村民）', color: '#07C160' },
  { id: 'soldier', name: '士兵（村民）', color: '#07C160' },
  { id: 'mayor', name: '市长（村民）', color: '#07C160' },
  { id: 'undertaker', name: '掘墓人（村民）', color: '#07C160' },
  // TB 外来者
  { id: 'saint', name: '圣徒（外来者）', color: '#FF9500' },
  { id: 'butler', name: '管家（外来者）', color: '#FF9500' },
  { id: 'drunk', name: '酒鬼（外来者）', color: '#FF9500' },
  { id: 'recluse', name: '隐士（外来者）', color: '#FF9500' },
  // TB 爪牙
  { id: 'poisoner', name: '下毒者（爪牙）', color: '#FA5151' },
  { id: 'scarletwoman', name: '红唇女郎（爪牙）', color: '#FA5151' },
  { id: 'baron', name: '男爵（爪牙）', color: '#FA5151' },
  { id: 'spy', name: '间谍（爪牙）', color: '#FA5151' },
  // TB 恶魔
  { id: 'imp', name: '小恶魔（恶魔）', color: '#E64340' },
  // BMR 村民
  { id: 'grandmother', name: '祖母（村民）', color: '#07C160' },
  { id: 'sailor', name: '水手（村民）', color: '#07C160' },
  { id: 'maid', name: '侍女（村民）', color: '#07C160' },
  { id: 'exorcist', name: '驱魔人（村民）', color: '#07C160' },
  { id: 'innkeeper', name: '旅店老板（村民）', color: '#07C160' },
  { id: 'gambler', name: '赌徒（村民）', color: '#07C160' },
  { id: 'gossip', name: '造谣者（村民）', color: '#07C160' },
  { id: 'courtier', name: '侍臣（村民）', color: '#07C160' },
  { id: 'professor', name: '教授（村民）', color: '#07C160' },
  { id: 'bard', name: '吟游诗人（村民）', color: '#07C160' },
  { id: 'tealady', name: '茶艺师（村民）', color: '#07C160' },
  { id: 'pacifist', name: '和平主义者（村民）', color: '#07C160' },
  { id: 'fool', name: '弄臣（村民）', color: '#07C160' },
  // BMR 外来者
  { id: 'tinker', name: '修补匠（外来者）', color: '#FF9500' },
  { id: 'moonchild', name: '月之子（外来者）', color: '#FF9500' },
  { id: 'lunatic', name: '莽夫（外来者）', color: '#FF9500' },
  { id: 'madman', name: '疯子（外来者）', color: '#FF9500' },
  // BMR 爪牙
  { id: 'godfather', name: '教父（爪牙）', color: '#FA5151' },
  { id: 'devilsadvocate', name: '魔鬼代言人（爪牙）', color: '#FA5151' },
  { id: 'assassin', name: '刺客（爪牙）', color: '#FA5151' },
  { id: 'mastermind', name: '主谋（爪牙）', color: '#FA5151' },
  // BMR 恶魔
  { id: 'zombuul', name: '僵怖（恶魔）', color: '#E64340' },
  { id: 'pukka', name: '普卡（恶魔）', color: '#E64340' },
  { id: 'shabaloth', name: '沙巴洛斯（恶魔）', color: '#E64340' },
  { id: 'po', name: '珀（恶魔）', color: '#E64340' },
  // SNV 村民
  { id: 'clockmaker', name: '钟表匠（村民）', color: '#07C160' },
  { id: 'dreamer', name: '入梦人（村民）', color: '#07C160' },
  { id: 'snakecharmer', name: '舞蛇人（村民）', color: '#07C160' },
  { id: 'mathematician', name: '数学家（村民）', color: '#07C160' },
  { id: 'flowergirl', name: '花艺师（村民）', color: '#07C160' },
  { id: 'towncrier', name: '公告员（村民）', color: '#07C160' },
  { id: 'oracle', name: '神谕者（村民）', color: '#07C160' },
  { id: 'savant', name: '学者（村民）', color: '#07C160' },
  { id: 'seamstress', name: '裁缝（村民）', color: '#07C160' },
  { id: 'philosopher', name: '哲学家（村民）', color: '#07C160' },
  { id: 'artist', name: '艺术家（村民）', color: '#07C160' },
  { id: 'juggler', name: '杂耍艺人（村民）', color: '#07C160' },
  { id: 'sage', name: '贤者（村民）', color: '#07C160' },
  // SNV 外来者
  { id: 'mutant', name: '变种人（外来者）', color: '#FF9500' },
  { id: 'sweetheart', name: '心上人（外来者）', color: '#FF9500' },
  { id: 'barber', name: '理发师（外来者）', color: '#FF9500' },
  { id: 'klutz', name: '傻瓜（外来者）', color: '#FF9500' },
  // SNV 爪牙
  { id: 'eviltwin', name: '邪恶双子（爪牙）', color: '#FA5151' },
  { id: 'witch', name: '女巫（爪牙）', color: '#FA5151' },
  { id: 'cerenovus', name: '洗脑师（爪牙）', color: '#FA5151' },
  { id: 'pithag', name: '坑巫（爪牙）', color: '#FA5151' },
  // SNV 恶魔
  { id: 'fanggu', name: '方古（恶魔）', color: '#E64340' },
  { id: 'vigormortis', name: '亡灵法师（恶魔）', color: '#E64340' },
  { id: 'nodashii', name: '黑暗之源（恶魔）', color: '#E64340' },
  { id: 'vortox', name: '混沌（恶魔）', color: '#E64340' }
];

function openCustomRolePanel() {
  const panel = $('customRolePanel');
  if (!panel) return;
  panel.style.display = 'flex';
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
    container.innerHTML = '<p style="color:#8c8c8c; text-align:center; padding:20px;">暂无入座玩家</p>';
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
    const borderColor = isDuplicate ? '#FA5151' : (currentVal ? (isWrongScript ? '#FF9500' : '#07C160') : 'rgba(0,0,0,0.06)');
    html += `<div style="display:flex; align-items:center; padding:8px 12px; margin-bottom:6px; background:rgba(0,0,0,0.05); border-radius:6px; border-left:3px solid ${borderColor};">
      <span style="width:50px; color:#07C160; font-weight:bold;">${p.seat+1}号</span>
      <span style="flex:1; color:#191919; margin-right:10px;">${escapeHtml(p.name)}${p.isBot ? ' 🤖' : ''}</span>
      <select onchange="setCustomRole(${p.seat}, this.value)" style="background:#ffffff; color:#191919; border:1px solid rgba(0,0,0,0.12); border-radius:4px; padding:4px 8px; min-width:180px; font-size:13px;">
        ${filteredOptions.map(opt =>
          `<option value="${opt.id}" ${currentVal === opt.id ? 'selected' : ''} style="color:${opt.color};">${opt.name}</option>`
        ).join('')}
      </select>
    </div>`;
  });

  // 教父「外来者±1」方向选择（切换后下方的配置概览同步刷新）
  const isGodfather = v.hasSetupChar && v.comp.setupType === 'godfather';
  if (isGodfather) {
    const delta = v.comp.godfatherDelta;           // 房主选择的方向（1 / -1）
    const noMinus = v.comp.baseOutsider <= 0;      // 基准外来者为 0 时 -1 等同不变化
    html += `<div style="margin-top:10px; padding:10px; background:rgba(250,81,81,0.08); border:1px solid rgba(250,81,81,0.25); border-radius:6px; font-size:12px;">
      <div style="color:#FA5151; font-weight:bold; margin-bottom:6px;">教父配置：外来者 +1 或 -1</div>
      <label style="cursor:pointer; color:#191919; margin-right:16px; white-space:nowrap;">
        <input type="radio" name="gfDeltaRadio" value="1" ${delta === 1 ? 'checked' : ''} onchange="setGodfatherDelta(1)">
        外来者 +1（村民 -1）
      </label>
      <label style="cursor:pointer; color:#191919; white-space:nowrap;">
        <input type="radio" name="gfDeltaRadio" value="-1" ${delta === -1 ? 'checked' : ''} onchange="setGodfatherDelta(-1)">
        外来者 -1（村民 +1）
      </label>
      ${noMinus ? '<div style="color:#8c8c8c; margin-top:4px;">当前人数下外来者基准为 0，选择 -1 时人数配置不变</div>' : ''}
    </div>`;
  }

  // 配置概览面板
  const setupTag = v.hasSetupChar
    ? ` <span style="color:#FA5151;">(${v.setupCharName}在场: ${v.comp.setupType === 'godfather'
        ? (v.comp.effectiveDelta === 1 ? '外来者+1, 村民-1'
          : v.comp.effectiveDelta === -1 ? '外来者-1, 村民+1'
          : '外来者±1 不生效（基准外来者为 0）')
        : '村民-2, 外来者+2'})</span>`
    : '';
  html += `<div style="margin-top:10px; padding:10px; background:rgba(0,0,0,0.08); border-radius:6px; font-size:12px;">
    <div style="color:#07C160; font-weight:bold; margin-bottom:6px;">当前人数配置 (${playerCount}人)${setupTag}</div>
    <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:6px;">
      <span style="color:#07C160;">村民: ${v.counts.townsfolk}/${v.comp.townsfolk}</span>
      <span style="color:#FF9500;">外来者: ${v.counts.outsider}/${v.comp.outsider}</span>
      <span style="color:#FA5151;">爪牙: ${v.counts.minion}/${v.comp.minion}</span>
      <span style="color:#E64340;">恶魔: ${v.counts.demon}/${v.comp.demon}</span>
    </div>
    <div style="color:#7f7f7f;">
      已指定 ${Object.values(customRoleMap).filter(r=>r).length} 个，剩余 ${v.remaining} 个空位
      ${v.valid && v.remaining > 0 ? `（还需自动分配：村民${v.needs.townsfolk}、外来者${v.needs.outsider}、爪牙${v.needs.minion}、恶魔${v.needs.demon}）` : ''}
    </div>
  </div>`;

  // 错误提示
  if (!v.valid) {
    html += `<div style="margin-top:8px; padding:10px; background:rgba(250,81,81,0.15); border:1px solid rgba(250,81,81,0.4); border-radius:6px;">
      <div style="color:#FA5151; font-weight:bold; margin-bottom:4px;">⚠️ 配置有误：</div>
      ${v.errors.map(e => `<div style="color:#FA5151; font-size:12px;">• ${e}</div>`).join('')}
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

// 教父「外来者±1」方向：切换后立即按新方向重算人数配置
function setGodfatherDelta(delta) {
  customGfDelta = (delta === -1) ? -1 : 1;
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
  customGfDelta = 1;
  renderCustomRoleList();
}

// ========== 移动端适配（微信式两页：会话列表 ↔ 聊天） ==========
const MOBILE_BREAKPOINT = 768;

function isMobileView() {
  return window.innerWidth <= MOBILE_BREAKPOINT;
}

// 聊天页标题：当前会话名称
function updateMobileChatTitle() {
  const el = $('mobileChatTitle');
  if (!el) return;
  let title = '聊天';
  if (currentChatChannel === 'dead') {
    title = '死者频道';
  } else if (currentChatChannel === 'whisper') {
    const target = (currentState && currentState.players)
      ? currentState.players.find(p => p.id === whisperTargetId) : null;
    title = target ? target.name : '私聊';
  } else {
    const roomId = (currentState && currentState.roomId) || myRoomId || '';
    title = roomId ? `房间 ${roomId}` : '游戏房间';
  }
  el.textContent = title;
}

// 移动端：把成员/操作区搬进聊天页，返回时还原到原位置
// （顶部信息栏保持在首页展示，不参与搬移）
function moveMobilePanelsIntoChat(open) {
  const chatArea = $('centerChat');
  const member = document.querySelector('.wx-member');
  if (!chatArea || !member) return;
  const inputArea = $('chatInputArea');

  if (open) {
    if (!member._mobileHome) {
      member._mobileHome = { parent: member.parentNode, next: member.nextSibling };
    }
    // 成员与操作区 → 输入栏之上
    if (inputArea && inputArea.parentNode === chatArea) {
      chatArea.insertBefore(member, inputArea);
    } else {
      chatArea.appendChild(member);
    }
  } else {
    const home = member._mobileHome;
    if (!home) return;
    if (home.next && home.next.parentNode === home.parent) {
      home.parent.insertBefore(member, home.next);
    } else {
      home.parent.appendChild(member);
    }
    delete member._mobileHome;
  }
}

// ========== 移动端：成员 / 操作区收起 - 展开 ==========
// 默认展开：不再记忆上次的收起状态，进入房间时始终显示成员与操作区
let memberPanelCollapsed = false;

function applyMemberPanelCollapsed() {
  const member = $('memberPanel');
  if (!member) return;
  const wasCollapsed = member.classList.contains('collapsed');
  // 收起瞬间记录滚动位置（收起后内容隐藏，浏览器会把滚动位置钳制为 0）
  if (memberPanelCollapsed && !wasCollapsed) member._scrollTop = member.scrollTop;
  member.classList.toggle('collapsed', memberPanelCollapsed);
  if (memberPanelCollapsed) {
    member.scrollTop = 0;
  } else if (!wasCollapsed && member._scrollTop) {
    // 展开时还原收起前的滚动位置
    const top = member._scrollTop;
    member.scrollTop = top;
    requestAnimationFrame(() => { member.scrollTop = top; });
  }
  const bar = $('memberCollapseBar');
  if (bar) bar.title = memberPanelCollapsed ? '展开成员与操作区' : '收起成员与操作区';
}

function toggleMemberPanel() {
  memberPanelCollapsed = !memberPanelCollapsed;
  applyMemberPanelCollapsed();
}

// 信息区收起按钮：移动端定位到聊天页导航栏之下
function positionCmToggle() {
  const btn = $('cmToggle');
  if (!btn) return;
  if (!isMobileView()) { btn.style.top = ''; return; }
  const chatArea = $('centerChat');
  if (!chatArea) return;
  const nav = chatArea.querySelector('.mobile-chat-nav');
  btn.style.top = ((nav ? nav.offsetHeight : 0) + 5) + 'px';
}

// 进入聊天页
function openMobileChat() {
  if (!isMobileView()) return;
  const container = $('gameView');
  if (!container) return;
  container.classList.add('mobile-chat-open');
  // 顶部信息栏与成员/操作区只在「房间」会话中显示
  moveMobilePanelsIntoChat(currentChatChannel === 'public');
  updateMobileChatTitle();
  positionCmToggle();
  applyMemberPanelCollapsed();
}

// 返回会话列表
function closeMobileChat() {
  const container = $('gameView');
  if (!container) return;
  container.classList.remove('mobile-chat-open');
  moveMobilePanelsIntoChat(false);
}

function toggleMobileChat() {
  const container = $('gameView');
  if (!container) return;
  const open = container.classList.toggle('mobile-chat-open');
  if (open) {
    moveMobilePanelsIntoChat(currentChatChannel === 'public');
    updateMobileChatTitle();
    positionCmToggle();
  } else {
    moveMobilePanelsIntoChat(false);
  }
}

// 回到桌面尺寸时退出聊天页状态并还原面板位置
window.addEventListener('resize', () => {
  if (isMobileView()) {
    // 切到移动端：恢复右栏供移动布局搬移使用
    updateMemberPanelVisibility();
    return;
  }
  const container = $('gameView');
  if (container && container.classList.contains('mobile-chat-open')) {
    container.classList.remove('mobile-chat-open');
    moveMobilePanelsIntoChat(false);
  }
  // 切到桌面端：按当前会话重新决定右栏显隐
  updateMemberPanelVisibility();
});

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
  // baseFavor 固定 0：强度只控制斜率，prob = min(|score| * s, 1)
  b.baseFavor = 0;
  b.maxFavor = 1;
  b.favorMultiplier = s;
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
    // 造谣者声明真伪由 AI 裁判判定，Bot 不会主动发表声明，原 gossip_true_statement 已移除
  };
  const BOT = { bot_nominate: 0, bot_evil_vote_yes: 0.5, bot_good_vote_yes: 0.5 };
  const scriptFixed = (script === 'bmr') ? BMR_FIXED : TB_FIXED;
  const cfg = {
    ...BOT,
    ...scriptFixed,
    balance: {
      baseFavor: 0, maxFavor: 1.0, favorMultiplier: 1.0,
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
  $('probSettingsPanel').style.display = 'flex';
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
    btnS.style.background = 'linear-gradient(135deg,#FF9500,#F5822B)';
    btnS.style.color = '#fff';
    btnS.style.fontWeight = 'bold';
    btnA.style.background = 'rgba(0,0,0,0.05)';
    btnA.style.color = '#ccc';
    btnA.style.fontWeight = 'normal';
    desc.innerHTML = '<b style="color:#0FA958;">📊 标准模式（默认）：</b>角色技能干扰概率使用平衡预设值（部分为100%），偏袒系统<b>必帮弱方</b>，中毒/醉酒/酒鬼信息与BMR修补匠/和平主义者概率<b>由平衡系统自动处理</b>，适合快速开始游戏。';
  } else {
    btnS.style.background = 'rgba(0,0,0,0.05)';
    btnS.style.color = '#ccc';
    btnS.style.fontWeight = 'normal';
    btnA.style.background = 'linear-gradient(135deg,#10AEFF,#0E93D6)';
    btnA.style.color = '#fff';
    btnA.style.fontWeight = 'bold';
    desc.innerHTML = '<b style="color:#7ECBF0;">🔧 高级模式：</b>可自由调节固定概率与Bot行为。平衡偏袒系统<b>始终内置启用</b>（偏袒强度、权重、信息真伪判断均不可调），适合想自定义概率体验的玩家。';
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
  if (v === 1) return '<b style="color:#07C160;">100%</b>';
  if (v === 0) return '<b style="color:#FA5151;">0%</b>';
  return '<b style="color:#0FA958;">' + Math.round(v * 100) + '%</b>';
}

// 格式化Bot行为概率（非0/50/100的固定值）
function _fmtBotProb(v) {
  return '<b style="color:#0FA958;">' + Math.round(v * 100) + '%</b>';
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

    // 角色技能干扰概率（当前剧本无此类干扰项时整块不显示）
    const interfereItems = [];
    meta.forEach(cat => {
      if (cat.category === '角色技能干扰概率') interfereItems.push(...cat.items);
    });
    if (interfereItems.length > 0) {
      html += `<div style="background:rgba(7,193,96,0.08); border:1px solid rgba(7,193,96,0.3); border-radius:8px; padding:15px; margin-bottom:12px;">
        <h3 style="color:#07C160; margin-bottom:10px; font-size:1.05em;">🎯 角色技能干扰概率（预设值）</h3>
        <p style="color:#8c8c8c; font-size:12px; margin-bottom:10px;">隐士/间谍的干扰登记概率使用标准50%随机。</p>
        <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:6px;">`;
      interfereItems.forEach(item => {
        const v = _getCfgVal(config, item.key);
        html += `<div style="color:#666666; font-size:12px; padding:5px 10px; background:rgba(0,0,0,0.02); border-radius:4px;">
          <span style="color:#07C160;">●</span> ${item.label}：${_fmtProb(v)}
        </div>`;
      });
      html += `</div></div>`;
    }

    // BMR 专属：修补匠/和平主义者概率（平衡系统自动处理）
    if ((currentState && currentState.script === 'bmr')) {
      html += `<div style="background:rgba(245,130,43,0.08); border:1px solid rgba(245,130,43,0.3); border-radius:8px; padding:15px; margin-bottom:12px;">
        <h3 style="color:#F5822B; margin-bottom:10px; font-size:1.05em;">🔧 修补匠 / 和平主义者（平衡系统自动处理）</h3>
        <div style="color:#4f4f4f; font-size:13px; line-height:1.8; padding:8px 4px;">
          <div style="margin-bottom:4px;"><span style="color:#F5822B;">●</span> 修补匠夜晚死亡概率、和平主义者拯救善良被处决者概率<b style="color:#0FA958;">由平衡系统自动决定</b></div>
          <div style="margin-bottom:4px;"><span style="color:#F5822B;">●</span> 概率随平衡分数自动调整：</div>
          <div style="padding-left:20px; color:#7f7f7f; font-size:12px;">
            · 好人弱势时 → 修补匠<b style="color:#07C160;">降低死亡</b>，和平主义者<b style="color:#07C160;">提高拯救</b>（帮好人保人）<br>
            · 邪恶弱势时 → 修补匠<b style="color:#FA5151;">提高死亡</b>，和平主义者<b style="color:#FA5151;">降低拯救</b>（帮邪恶削减好人）<br>
            · 局势均衡时 → 使用基础概率
          </div>
        </div>
      </div>`;
    }

    // 酒鬼/中毒信息
    html += `<div style="background:rgba(245,130,43,0.08); border:1px solid rgba(245,130,43,0.3); border-radius:8px; padding:15px; margin-bottom:12px;">
      <h3 style="color:#F5822B; margin-bottom:10px; font-size:1.05em;">🍺 酒鬼 / 中毒信息（平衡系统自动处理）</h3>
      <div style="color:#4f4f4f; font-size:13px; line-height:1.8; padding:8px 4px;">
        <div style="margin-bottom:4px;"><span style="color:#F5822B;">●</span> 中毒、醉酒、酒鬼玩家获得的信息真伪<b style="color:#0FA958;">由平衡系统自动判断</b></div>
        <div style="margin-bottom:4px;"><span style="color:#F5822B;">●</span> 信息真伪与方向均由<b style="color:#0FA958;">平衡偏袒系统自动决定</b>：</div>
        <div style="padding-left:20px; color:#7f7f7f; font-size:12px;">
          · 好人弱势时 → <b style="color:#07C160;">可能获得真信息</b>（帮好人调查），假信息指向<b style="color:#FA5151;">邪恶/恶魔</b><br>
          · 邪恶弱势时 → <b style="color:#FA5151;">保持假信息</b>（误导好人），假信息指向<b style="color:#07C160;">善良/无恶魔</b><br>
          · 局势均衡时 → 假信息，方向随机
        </div>
      </div>
    </div>`;

    // Bot行为
    html += `<div style="background:rgba(16,174,255,0.08); border:1px solid rgba(16,174,255,0.3); border-radius:8px; padding:15px; margin-bottom:12px;">
      <h3 style="color:#10AEFF; margin-bottom:10px; font-size:1.05em;">🤖 Bot 行为（预设值）</h3>
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:6px;">`;
    meta.forEach(cat => {
      if (cat.category === 'Bot 行为') {
        cat.items.forEach(item => {
          const v = _getCfgVal(config, item.key);
          html += `<div style="color:#666666; font-size:12px; padding:5px 10px; background:rgba(0,0,0,0.02); border-radius:4px;">
            <span style="color:#10AEFF;">●</span> ${item.label}：${_fmtBotProb(v)}
          </div>`;
        });
      }
    });
    html += `</div></div>`;

    // 平衡偏袒系统（全部内置启用，仅展示说明）
    html += `<div style="background:rgba(16,174,255,0.1); border:2px solid rgba(16,174,255,0.4); border-radius:8px; padding:15px; margin-bottom:12px;">
      <h3 style="color:#4FC3F7; margin-bottom:12px; font-size:1.1em;">⚖️ 平衡偏袒系统</h3>

      <div style="background:rgba(7,193,96,0.06); border:1px solid rgba(7,193,96,0.2); border-radius:6px; padding:10px; margin-bottom:12px;">
        <div style="color:#07C160; font-size:12px; line-height:1.6;">
          <b>✓ 内置启用（不可调节）：</b><br>
          · 偏袒强度 = 100%（必帮弱方）<br>
          · 中毒/醉酒信息真伪由平衡系统自动判断<br>
          · 干扰项偏向弱势方<br>
          · 平衡权重自动计算
        </div>
      </div>

      <div style="background:rgba(0,0,0,0.03); border-radius:6px; padding:12px; margin-top:12px;">
        <div style="color:#0FA958; font-size:12px; font-weight:bold; margin-bottom:6px;">📐 平衡分数计算公式</div>
        <div style="color:#7f7f7f; font-size:11px; line-height:1.7; font-family:monospace;">
          分数 = (存活好人 − 存活恶魔×2 − 存活爪牙×1.5) / 存活人数 × 0.90<br>
          &emsp;+ 已死邪恶 × 0.20 − 已死好人 × 0.15<br>
          &emsp;+ 关键角色存活奖励（信息位+0.1,僧侣+0.1,杀手+0.05）<br>
          <span style="color:#8c8c8c;">→ 结果范围 [-1, 1]，负数=邪恶优势，正数=好人优势</span>
        </div>
        <div style="color:#0FA958; font-size:12px; font-weight:bold; margin:8px 0 6px;">📊 偏袒判定（偏袒强度=100%）</div>
        <div style="color:#7f7f7f; font-size:11px; line-height:1.7; font-family:monospace;">
          偏袒概率 = min(|分数| × 1.0 + 1.0, 1.0) = 100%<br>
          <span style="color:#8c8c8c;">→ 好人弱势(分数&lt;-0.20)：必触发偏袒帮好人</span><br>
          <span style="color:#8c8c8c;">→ 邪恶弱势(分数&gt;0.30)：必触发偏袒帮邪恶（误导好人）</span><br>
          <span style="color:#8c8c8c;">→ 局势均衡(-0.20≤分数≤0.30)：50%概率偏向任一方向</span>
        </div>
      </div>
    </div>`;

    container.innerHTML = html;
    return;
  }

  // ===== 高级模式UI =====
  let html = '';

  // 角色技能干扰概率（当前剧本无此类干扰项时整块不显示）
  const interfereItemsAdv = [];
  meta.forEach(cat => {
    if (cat.category === '角色技能干扰概率') interfereItemsAdv.push(...cat.items);
  });
  if (interfereItemsAdv.length > 0) {
    html += `<div style="background:rgba(0,0,0,0.03); border:1px solid rgba(16,174,255,0.2); border-radius:8px; padding:15px; margin-bottom:12px;">
      <h3 style="color:#4FC3F7; margin-bottom:12px; font-size:1.05em; border-bottom:1px solid rgba(16,174,255,0.2); padding-bottom:6px;">🎯 角色技能干扰概率</h3>`;
    interfereItemsAdv.forEach(item => {
      const val = _getCfgVal(config, item.key);
      const v = (val !== undefined) ? val : item.default;
      html += `<div style="display:flex; align-items:center; margin-bottom:8px; gap:10px; flex-wrap:wrap;">
        <label style="color:#333333; min-width:200px; flex:1; font-size:12px;">${item.label}</label>
        <input type="range" data-pkey="${item.key}" min="${item.min}" max="${item.max}" step="${item.step}" value="${v}"
          oninput="onProbSliderInput(this)" onchange="onProbChanged(this)"
          style="flex:2; min-width:150px; accent-color:#10AEFF;" />
        <span class="prob-val-label" data-pkey-label="${item.key}" style="color:#7ECBF0; font-weight:bold; min-width:50px; text-align:right; font-size:12px;">${Math.round(v * 100)}%</span>
      </div>`;
    });
    html += `</div>`;
  }

  // BMR 专属：修补匠/和平主义者概率（平衡系统自动处理）
  if ((currentState && currentState.script === 'bmr')) {
    html += `<div style="background:rgba(245,130,43,0.08); border:1px solid rgba(245,130,43,0.3); border-radius:8px; padding:15px; margin-bottom:12px;">
      <h3 style="color:#F5822B; margin-bottom:10px; font-size:1.05em;">🔧 修补匠 / 和平主义者（平衡系统自动处理）</h3>
      <div style="color:#4f4f4f; font-size:13px; line-height:1.8; padding:8px 4px;">
        <div style="margin-bottom:4px;"><span style="color:#F5822B;">●</span> 修补匠夜晚死亡概率、和平主义者拯救善良被处决者概率<b style="color:#0FA958;">由平衡系统自动决定</b></div>
        <div style="margin-bottom:4px;"><span style="color:#F5822B;">●</span> 概率随平衡分数自动调整：</div>
        <div style="padding-left:20px; color:#7f7f7f; font-size:12px;">
          · 好人弱势时 → 修补匠<b style="color:#07C160;">降低死亡</b>，和平主义者<b style="color:#07C160;">提高拯救</b>（帮好人保人）<br>
          · 邪恶弱势时 → 修补匠<b style="color:#FA5151;">提高死亡</b>，和平主义者<b style="color:#FA5151;">降低拯救</b>（帮邪恶削减好人）<br>
          · 局势均衡时 → 使用基础概率
        </div>
      </div>
    </div>`;
  }

  // 酒鬼/中毒信息（说明，无滑块）
  html += `<div style="background:rgba(245,130,43,0.08); border:1px solid rgba(245,130,43,0.3); border-radius:8px; padding:15px; margin-bottom:12px;">
    <h3 style="color:#F5822B; margin-bottom:10px; font-size:1.05em;">🍺 酒鬼 / 中毒信息（平衡系统自动处理）</h3>
    <div style="color:#4f4f4f; font-size:13px; line-height:1.8; padding:8px 4px;">
      <div style="margin-bottom:4px;"><span style="color:#F5822B;">●</span> 中毒、醉酒、酒鬼玩家获得的信息真伪<b style="color:#0FA958;">由平衡系统自动判断</b></div>
      <div style="margin-bottom:4px;"><span style="color:#F5822B;">●</span> 信息真伪与方向均由<b style="color:#0FA958;">平衡偏袒系统自动决定</b>：</div>
      <div style="padding-left:20px; color:#7f7f7f; font-size:12px;">
        · 好人弱势时 → <b style="color:#07C160;">可能获得真信息</b>（帮好人调查），假信息指向<b style="color:#FA5151;">邪恶/恶魔</b><br>
        · 邪恶弱势时 → <b style="color:#FA5151;">保持假信息</b>（误导好人），假信息指向<b style="color:#07C160;">善良/无恶魔</b><br>
        · 局势均衡时 → 假信息，方向随机
      </div>
    </div>
  </div>`;

  // Bot行为
  html += `<div style="background:rgba(0,0,0,0.03); border:1px solid rgba(16,174,255,0.2); border-radius:8px; padding:15px; margin-bottom:12px;">
    <h3 style="color:#4FC3F7; margin-bottom:12px; font-size:1.05em; border-bottom:1px solid rgba(16,174,255,0.2); padding-bottom:6px;">🤖 Bot 行为</h3>`;
  meta.forEach(cat => {
    if (cat.category === 'Bot 行为') {
      cat.items.forEach(item => {
        const val = _getCfgVal(config, item.key);
        const v = (val !== undefined) ? val : item.default;
        html += `<div style="display:flex; align-items:center; margin-bottom:8px; gap:10px; flex-wrap:wrap;">
          <label style="color:#333333; min-width:200px; flex:1; font-size:12px;">${item.label}</label>
          <input type="range" data-pkey="${item.key}" min="${item.min}" max="${item.max}" step="${item.step}" value="${v}"
            oninput="onProbSliderInput(this)" onchange="onProbChanged(this)"
            style="flex:2; min-width:150px; accent-color:#10AEFF;" />
          <span class="prob-val-label" data-pkey-label="${item.key}" style="color:#7ECBF0; font-weight:bold; min-width:50px; text-align:right; font-size:12px;">${Math.round(v * 100)}%</span>
        </div>`;
      });
    }
  });
  html += `</div>`;

  // 平衡偏袒系统（全部内置启用，仅展示说明）
  html += `<div style="background:rgba(16,174,255,0.1); border:2px solid rgba(16,174,255,0.4); border-radius:8px; padding:15px; margin-bottom:12px;">
    <h3 style="color:#4FC3F7; margin-bottom:12px; font-size:1.1em;">⚖️ 平衡偏袒系统</h3>

    <div style="background:rgba(7,193,96,0.06); border:1px solid rgba(7,193,96,0.2); border-radius:6px; padding:10px; margin-bottom:12px;">
      <div style="color:#07C160; font-size:12px; line-height:1.6;">
        <b>✓ 内置启用（不可调节）：</b><br>
        · 偏袒强度 = 100%（必帮弱方）<br>
        · 中毒/醉酒信息真伪由平衡系统自动判断<br>
        · 干扰项偏向弱势方<br>
        · 平衡权重自动计算
      </div>
    </div>

    <div style="background:rgba(0,0,0,0.03); border-radius:6px; padding:12px; margin-top:12px;">
      <div style="color:#0FA958; font-size:12px; font-weight:bold; margin-bottom:6px;">📐 平衡分数计算公式</div>
      <div style="color:#7f7f7f; font-size:11px; line-height:1.7; font-family:monospace;">
        分数 = (存活好人 − 存活恶魔×2 − 存活爪牙×1.5) / 存活人数 × 0.90<br>
        &emsp;+ 已死邪恶 × 0.20 − 已死好人 × 0.15<br>
        &emsp;+ 关键角色存活奖励（信息位+0.1,僧侣+0.1,杀手+0.05）<br>
        <span style="color:#8c8c8c;">→ 结果范围 [-1, 1]，负数=邪恶优势，正数=好人优势</span>
      </div>
      <div style="color:#0FA958; font-size:12px; font-weight:bold; margin:8px 0 6px;">📊 偏袒判定（偏袒强度=100%）</div>
      <div style="color:#7f7f7f; font-size:11px; line-height:1.7; font-family:monospace;">
        偏袒概率 = min(|分数| × 1.0 + 1.0, 1.0) = 100%<br>
        <span style="color:#8c8c8c;">→ 好人弱势(分数&lt;-0.20)：必触发偏袒帮好人</span><br>
        <span style="color:#8c8c8c;">→ 邪恶弱势(分数&gt;0.30)：必触发偏袒帮邪恶（误导好人）</span><br>
        <span style="color:#8c8c8c;">→ 局势均衡(-0.20≤分数≤0.30)：50%概率偏向任一方向</span>
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
  const originEl = getLoadingClickTarget();
  if (currentState && currentState.gameStarted) {
    showToast('游戏已开始，无法重置设置');
    return;
  }
  const ok = await showConfirm('确定恢复默认概率设置吗？（将切换回标准模式）', { title: '重置设置' });
  if (!ok) return;
  _probMode = 'standard';
  _probBackupAdvanced = null;
  _updateModeButtons();
  emitRequest('room:resetProbConfig', undefined, originEl);
}

// ========== 历史记录功能 ==========
function openHistoryPanel() {
  const panel = $('historyPanel');
  if (!panel) return;
  panel.style.display = 'flex';
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

function formatHistoryTime(date, short = false) {
  if (!date) return '未知时间';
  const d = new Date(date);
  if (short) {
    return d.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
  }
  return d.toLocaleString('zh-CN', { hour12: false });
}

// 对局时长文案（列表与详情共用）
function formatHistoryDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return '';
  const duration = new Date(endedAt) - new Date(startedAt);
  if (!(duration > 0)) return '';
  const mins = Math.floor(duration / 60000);
  if (mins <= 0) return '不到1分钟';
  if (mins >= 60) return `${Math.floor(mins / 60)}小时${mins % 60}分钟`;
  return `${mins}分钟`;
}

// 历史列表里的玩家小标签：座位 + 昵称 + 角色（死亡置灰、AI 标记）
function historyPlayerTag(p) {
  const teamCls = p.team === 'GOOD' ? 'good' : 'evil';
  const deadCls = p.isAlive === false ? ' dead' : '';
  const bot = p.isBot ? '<span class="hist-tag-bot">🤖</span>' : '';
  const title = `${p.seat + 1}号 ${p.name} · ${p.roleName || ''}${p.isAlive === false ? '（已死亡）' : ''}`;
  return `<span class="hist-tag ${teamCls}${deadCls}" title="${escapeHtml(title)}">`
    + `<b>${p.seat + 1}</b>`
    + `<span class="hist-tag-name">${escapeHtml(p.name)}</span>`
    + `<span class="hist-tag-role">${escapeHtml(p.roleName || '')}</span>`
    + bot
    + `</span>`;
}

let _historyListLoading = false;
async function loadHistoryList() {
  const container = $('historyListContent');
  if (!container) return;
  if (_historyListLoading) return; // 未完成时不重复请求
  _historyListLoading = true;
  container.innerHTML = '<div class="hist-empty">加载中…</div>';

  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    if (!data.success) {
      container.innerHTML = `<div class="hist-empty"><span class="hist-empty-icon">⚠️</span>加载失败：${escapeHtml(data.message || '未知错误')}</div>`;
      return;
    }
    const list = data.history || [];
    if (list.length === 0) {
      container.innerHTML = '<div class="hist-empty"><span class="hist-empty-icon">📜</span>暂无历史记录<br>完成一局游戏后会显示在这里</div>';
      return;
    }

    let html = '<div class="hist-list">';
    list.forEach(h => {
      const teamCls = h.winner === 'GOOD' ? 'good' : 'evil';
      const winnerText = h.winner === 'GOOD' ? '善良阵营获胜' : '邪恶阵营获胜';
      const endedTime = formatHistoryTime(h.endedAt, true);
      const durationText = formatHistoryDuration(h.startedAt, h.endedAt);

      const players = h.players || [];
      const goodPlayers = players.filter(p => p.team === 'GOOD').sort((a, b) => a.seat - b.seat);
      const evilPlayers = players.filter(p => p.team === 'EVIL').sort((a, b) => a.seat - b.seat);
      const aliveCount = players.filter(p => p.isAlive).length;
      const botCount = players.filter(p => p.isBot).length;

      const teamRow = (cls, label, group) => `
        <div class="hist-team-row">
          <span class="hist-team-label ${cls}">${label} ${group.length}</span>
          <div class="hist-tags">${group.map(historyPlayerTag).join('') || '<span class="hist-none">—</span>'}</div>
        </div>`;

      html += `<div class="hist-item ${teamCls}" onclick="viewHistoryDetail('${h.id}')">
        <div class="hist-item-head">
          <span class="hist-win ${teamCls}">${winnerText}</span>
          <span class="hist-time">${endedTime}</span>
        </div>
        ${h.winReason ? `<div class="hist-reason">${escapeHtml(h.winReason)}</div>` : ''}
        <div class="hist-meta">
          <span class="hist-meta-item">👥 ${h.playerCount} 人${botCount > 0 ? `（${botCount} AI）` : ''}</span>
          ${durationText ? `<span class="hist-meta-item">⏱ ${durationText}</span>` : ''}
          <span class="hist-meta-item">❤ ${aliveCount} 人存活</span>
        </div>
        <div class="hist-teams">
          ${teamRow('good', '善良', goodPlayers)}
          ${teamRow('evil', '邪恶', evilPlayers)}
        </div>
      </div>`;
    });
    html += '</div>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div class="hist-empty"><span class="hist-empty-icon">⚠️</span>加载失败：${escapeHtml(e.message)}</div>`;
  } finally {
    _historyListLoading = false;
  }
}

let _historyDetailLoading = false;
async function viewHistoryDetail(historyId) {
  const container = $('historyDetailContent');
  if (!container) return;
  if (_historyDetailLoading) return; // 未完成时不重复请求
  _historyDetailLoading = true;
  container.innerHTML = '<div class="hist-empty">加载中…</div>';
  $('historyList').style.display = 'none';
  $('historyDetail').style.display = 'block';
  $('historyBackBtn').style.display = 'inline-block';
  $('historyTitle').textContent = '📜 游戏详情';

  try {
    const res = await fetch(`/api/history/${historyId}`);
    const data = await res.json();
    if (!data.success) {
      container.innerHTML = `<div class="hist-empty"><span class="hist-empty-icon">⚠️</span>加载失败：${escapeHtml(data.message || '未知错误')}</div>`;
      return;
    }
    const h = data.data;

    const teamCls = h.winner === 'GOOD' ? 'good' : 'evil';
    const winnerText = h.winner === 'GOOD' ? '善良阵营获胜' : '邪恶阵营获胜';
    const durationText = formatHistoryDuration(h.startedAt, h.endedAt);
    const players = [...(h.players || [])].sort((a, b) => a.seat - b.seat);
    const logCount = (h.actionLog || []).length;

    let html = `
      <div class="hist-hero ${teamCls}">
        <div class="hist-hero-title">${winnerText}</div>
        ${h.winReason ? `<div class="hist-hero-reason">${escapeHtml(h.winReason)}</div>` : ''}
        <div class="hist-hero-meta">
          <span>🏁 ${formatHistoryTime(h.endedAt)}</span>
          ${durationText ? `<span>⏱ ${durationText}</span>` : ''}
          <span>👥 ${h.playerCount} 人</span>
        </div>
      </div>

      <div class="hist-card">
        <h3 class="hist-card-title">👥 玩家角色<span class="hist-count">共 ${h.playerCount} 人</span></h3>
        <div class="hist-table-wrap">
          <table class="hist-table">
            <thead>
              <tr>
                <th>座位</th><th>昵称</th><th>角色</th><th>阵营</th><th>状态</th>
              </tr>
            </thead>
            <tbody>
              ${players.map(p => {
                const cls = p.team === 'GOOD' ? 'good' : 'evil';
                const teamText = p.team === 'GOOD' ? '善良' : '邪恶';
                const alive = p.isAlive !== false;
                return `<tr>
                  <td class="hist-seat">${p.seat + 1}号</td>
                  <td>${escapeHtml(p.name)}${p.isBot ? ' <span class="hist-bot">🤖</span>' : ''}</td>
                  <td class="hist-role">${escapeHtml(p.roleName || '')}</td>
                  <td class="hist-team ${cls}">${teamText}</td>
                  <td class="hist-status ${alive ? 'alive' : 'dead'}">${alive ? '存活' : '死亡'}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="hist-card">
        <h3 class="hist-card-title">📋 行动日志<span class="hist-count">${logCount} 条记录</span></h3>
        <div id="historyActionLog" class="wx-god-log hist-log"></div>
      </div>
    `;
    container.innerHTML = html;
    // 行动日志与上帝视角共用同一套渲染（分组表头、徽标流程、合并规则、真假信息标记）
    renderGodLogInto($('historyActionLog'), h.actionLog || [], h.players || []);
  } catch (e) {
    container.innerHTML = `<div class="hist-empty"><span class="hist-empty-icon">⚠️</span>加载失败：${escapeHtml(e.message)}</div>`;
  } finally {
    _historyDetailLoading = false;
  }
}

