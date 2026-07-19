// 聊天模块
let chatMessages = [];

function switchChatChannel(channel) {
  currentChatChannel = channel;
  document.querySelectorAll('.chat-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.channel === channel);
  });
  $('whisperTarget').style.display = channel === 'whisper' ? 'block' : 'none';
  renderChatMessages();
}

function sendChat() {
  const input = $('chatInput');
  const content = input.value.trim();
  if (!content) return;

  let targetId = null;
  if (currentChatChannel === 'whisper') {
    targetId = $('whisperTarget').value;
    if (!targetId) {
      showToast('请选择私聊对象');
      return;
    }
  }

  sendSocket('chat:send', {
    content,
    channel: currentChatChannel,
    targetId
  });

  input.value = '';
}

function addChatMessage(msg) {
  chatMessages.push(msg);
  renderChatMessages();
}

function renderChatMessages() {
  const container = $('chatMessages');
  const visible = chatMessages.filter(m => {
    if (currentChatChannel === 'public') return m.channel === 'public';
    if (currentChatChannel === 'dead') return m.channel === 'dead';
    if (currentChatChannel === 'whisper') return m.channel === 'whisper';
    return false;
  });

  container.innerHTML = visible.map(msg => {
    const senderClass = msg.fromId === myId ? 'you' : '';
    const deadClass = msg.isDead ? 'dead' : '';
    const privateClass = msg.channel === 'whisper' ? 'private' : '';
    const seatText = msg.fromSeat >= 0 ? `${msg.fromSeat + 1}号 ` : '';
    const prefix = msg.channel === 'whisper' ? '[私聊] ' : '';
    const deadPrefix = msg.isDead && msg.channel === 'public' ? '[死者] ' : '';
    return `<div class="chat-msg ${privateClass}">
      <span class="msg-sender ${senderClass} ${deadClass}">${prefix}${deadPrefix}${seatText}${msg.fromName}:</span>
      <span>${escapeHtml(msg.content)}</span>
    </div>`;
  }).join('');

}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function updateWhisperTargets(players) {
  const select = $('whisperTarget');
  const me = players.find(p => p.id === myId);
  select.innerHTML = '<option value="">选择玩家</option>' + 
    players.filter(p => p.id !== myId).map(p => 
      `<option value="${p.id}">${p.seat >= 0 ? p.seat + 1 + '号 ' : ''}${p.name}${p.isDead ? ' (死者)' : ''}</option>`
    ).join('');
}
