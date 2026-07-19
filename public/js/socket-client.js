// Socket客户端
let gameSocket;
let currentState = null;
let myId = null;
let myRoomId = null;
let selectedTargets = [];
let currentChatChannel = 'public';

function initGameSocket() {
  myId = sessionStorage.getItem('playerId');
  myRoomId = new URLSearchParams(window.location.search).get('roomId') || sessionStorage.getItem('roomId');
  
  if (!myRoomId) {
    window.location.href = '/';
    return;
  }

  gameSocket = io();
  
  gameSocket.on('connect', () => {
    console.log('游戏服务器已连接');
    // 重新加入房间
    if (myId) {
      gameSocket.emit('room:rejoin', { roomId: myRoomId, playerId: myId });
    }
  });

  gameSocket.on('room:stateUpdate', (state) => {
    currentState = state;
    renderGameState(state);
  });

  gameSocket.on('game:stateUpdate', (state) => {
    currentState = state;
    renderGameState(state);
  });

  gameSocket.on('room:error', ({ message }) => {
    showToast(message);
  });

  gameSocket.on('game:over', (data) => {
    showGameOver(data);
  });

  gameSocket.on('night:wake', (data) => {
    showNightWake(data);
  });

  gameSocket.on('night:actionAck', (data) => {
    if (data.success) {
      hideNightOverlay();
    }
  });

  gameSocket.on('game:dawnReport', (data) => {
    // 天亮报告在中心消息区显示
  });

  gameSocket.on('game:votingStarted', (data) => {
    showVotingPanel(data);
  });

  gameSocket.on('game:voteUpdate', (data) => {
    updateVoteDisplay(data);
  });

  gameSocket.on('game:voteResult', (data) => {
    showVoteResult(data);
  });

  gameSocket.on('game:nominationStarted', (data) => {
    showNominationStarted(data);
  });

  gameSocket.on('game:executionResult', (data) => {
    showExecutionResult(data);
  });

  gameSocket.on('game:abilityUsed', (data) => {
    showAbilityUsed(data);
  });

  gameSocket.on('chat:message', (msg) => {
    addChatMessage(msg);
  });

  gameSocket.on('player:died', (data) => {
    showPlayerDied(data);
  });

  $('headerRoomId').textContent = `房间: ${myRoomId}`;
}

function sendSocket(event, data) {
  if (gameSocket) {
    gameSocket.emit(event, data);
  }
}

function leaveRoom() {
  if (confirm('确定要离开房间吗？')) {
    sendSocket('room:leave');
    sessionStorage.clear();
    window.location.href = '/';
  }
}

function confirmPhase() {
  sendSocket('game:confirm');
}
