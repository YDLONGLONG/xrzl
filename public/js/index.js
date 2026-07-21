// 首页逻辑
const socket = io();

socket.on('connect', () => {
  console.log('已连接到服务器');
});

socket.on('room:created', ({ roomId, playerId }) => {
  setSession(roomId, playerId);
  showGameView();
});

socket.on('room:joined', ({ roomId, playerId }) => {
  setSession(roomId, playerId);
  showGameView();
});

function showGameView() {
  document.getElementById('homeView').style.display = 'none';
  document.getElementById('gameView').style.display = 'flex';
}

socket.on('room:error', ({ message }) => {
  showToast(message);
});

function createRoom() {
  const name = $('createName').value.trim();
  if (!name) {
    showError('请输入昵称', 'createError');
    return;
  }
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
  socket.emit('room:join', { roomId, playerName: name });
}

// 回车提交
$('createName').addEventListener('keydown', e => { if (e.key === 'Enter') createRoom(); });
$('joinName').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
$('joinRoomId').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
