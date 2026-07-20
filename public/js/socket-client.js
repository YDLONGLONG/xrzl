// Socket客户端
let gameSocket;
let currentState = null;
let myId = null;
let myRoomId = null;
let selectedTargets = [];
let currentChatChannel = 'public';
let hasLeftRoom = false;

function initGameSocket() {
  myId = sessionStorage.getItem('playerId');
  myRoomId = new URLSearchParams(window.location.search).get('roomId') || sessionStorage.getItem('roomId');
  
  if (!myRoomId) {
    window.location.href = '/';
    return;
  }

  gameSocket = io();
  
  gameSocket.on('connect', () => {
    if (hasLeftRoom) return;
    console.log('游戏服务器已连接');
    // 重新加入房间
    if (myId) {
      gameSocket.emit('room:rejoin', { roomId: myRoomId, playerId: myId });
    }
  });

  gameSocket.on('room:stateUpdate', (state) => {
    if (hasLeftRoom) return;
    currentState = state;
    renderGameState(state);
  });

  gameSocket.on('game:stateUpdate', (state) => {
    if (hasLeftRoom) return;
    currentState = state;
    renderGameState(state);
  });

  gameSocket.on('room:error', ({ message }) => {
    if (hasLeftRoom) return;
    showToast(message);
  });

  gameSocket.on('game:over', (data) => {
    if (hasLeftRoom) return;
    showGameOver(data);
  });

  gameSocket.on('night:wake', (data) => {
    if (hasLeftRoom) return;
    showNightWake(data);
  });

  gameSocket.on('night:actionAck', (data) => {
    if (hasLeftRoom) return;
    if (data.success) {
      hideNightOverlay();
    }
  });

  gameSocket.on('game:dawnReport', (data) => {
    if (hasLeftRoom) return;
    // 天亮报告在中心消息区显示
  });

  gameSocket.on('game:votingStarted', (data) => {
    if (hasLeftRoom) return;
    showVotingPanel(data);
  });

  gameSocket.on('game:voteUpdate', (data) => {
    if (hasLeftRoom) return;
    updateVoteDisplay(data);
  });

  gameSocket.on('game:voteResult', (data) => {
    if (hasLeftRoom) return;
    showVoteResult(data);
  });

  gameSocket.on('game:nominationStarted', (data) => {
    if (hasLeftRoom) return;
    showNominationStarted(data);
  });

  gameSocket.on('game:executionResult', (data) => {
    if (hasLeftRoom) return;
    showExecutionResult(data);
  });

  gameSocket.on('game:abilityUsed', (data) => {
    if (hasLeftRoom) return;
    showAbilityUsed(data);
  });

  gameSocket.on('chat:message', (msg) => {
    if (hasLeftRoom) return;
    addChatMessage(msg);
  });

  gameSocket.on('player:died', (data) => {
    if (hasLeftRoom) return;
    showPlayerDied(data);
  });

  $('headerRoomId').textContent = `房间: ${myRoomId}`;
  $('headerRoomId').title = '点击复制房间号';
  $('headerRoomId').style.cursor = 'pointer';
  $('headerRoomId').onclick = () => {
    if (myRoomId) {
      copyToClipboard(myRoomId);
      showToast('房间号已复制');
    }
  };
}

function sendSocket(event, data) {
  if (gameSocket) {
    gameSocket.emit(event, data);
  }
}

async function leaveRoom() {
  if (hasLeftRoom) return;
  const ok = await showConfirm('确定要离开房间吗？', { type: 'warning', title: '离开房间', confirmText: '离开', cancelText: '取消' });
  if (!ok) return;
  hasLeftRoom = true;
  if (gameSocket && gameSocket.connected) {
    gameSocket.emit('room:leave');
  }
  if (gameSocket) {
    gameSocket.disconnect();
  }
  sessionStorage.clear();
  setTimeout(() => {
    window.location.href = '/';
  }, 10);
}

function confirmPhase() {
  sendSocket('game:confirm');
}
