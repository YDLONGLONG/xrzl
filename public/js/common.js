// 公共工具函数
function $(id) { return document.getElementById(id); }

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

function showToast(msg) {
  if (!window._toastQueue) {
    window._toastQueue = [];
    window._toastActive = false;
  }

  // 消息去重：相同的消息不再重复添加
  const last = window._toastQueue[window._toastQueue.length - 1];
  if (last && last === msg) return;

  window._toastQueue.push(msg);
  processToastQueue();
}

function processToastQueue() {
  if (!window._toastQueue || window._toastQueue.length === 0 || window._toastActive) return;
  window._toastActive = true;
  const msg = window._toastQueue.shift();
  createToast(msg);

  // 依次显示后续队列
  const interval = setInterval(() => {
    if (!window._toastQueue || window._toastQueue.length === 0) {
      clearInterval(interval);
      window._toastActive = false;
      return;
    }
    const next = window._toastQueue.shift();
    createToast(next);
  }, 600);
}

function createToast(msg) {
  const toast = document.createElement('div');
  toast.className = 'toast-error';
  toast.textContent = msg;

  // 计算垂直偏移：根据已有的toast数量
  const existing = document.querySelectorAll('.toast-error');
  const index = existing.length;
  const vOffset = 10 + index * 60;

  toast.style.top = vOffset + 'px';
  toast.style.position = 'fixed';
  toast.style.zIndex = 300;

  document.body.appendChild(toast);

  // 消失后移除并重排
  setTimeout(() => {
    toast.remove();
    // 重排剩余toast的位置
    const remaining = document.querySelectorAll('.toast-error');
    remaining.forEach((t, i) => {
      t.style.top = (10 + i * 60) + 'px';
    });
  }, 3000);
}

function getQueryParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

function getPlayerId() {
  return sessionStorage.getItem('playerId');
}

function getRoomId() {
  return sessionStorage.getItem('roomId');
}

function setSession(roomId, playerId) {
  sessionStorage.setItem('roomId', roomId);
  sessionStorage.setItem('playerId', playerId);
}
