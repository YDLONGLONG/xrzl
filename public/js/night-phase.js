// 夜晚阶段交互
let nightSelectedTargets = [];
let nightCanSelectCount = 0;
let nightExcludeSelf = false;

function showNightWake(data) {
  const overlay = $('nightOverlay');
  const text = $('nightText');
  const subtext = $('nightSubtext');
  const selectArea = $('nightSelectArea');
  const confirmBtn = $('nightConfirmBtn');

  overlay.classList.add('active', 'wake');
  text.textContent = `你的回合：${data.role}`;
  subtext.textContent = data.message;
  
  nightCanSelectCount = data.canSelectCount || 0;
  nightExcludeSelf = data.excludeSelf || false;
  nightSelectedTargets = [];

  if (nightCanSelectCount > 0) {
    // 显示可选玩家
    selectArea.innerHTML = '';
    const players = currentState.players.filter(p => {
      if (nightExcludeSelf && p.id === myId) return false;
      return p.seat !== -1;
    });

    players.forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'night-player-btn';
      btn.textContent = `${p.seat + 1}号 ${p.name}`;
      btn.dataset.pid = p.id;
      btn.onclick = () => toggleNightTarget(p.id, btn);
      selectArea.appendChild(btn);
    });

    confirmBtn.style.display = 'block';
    confirmBtn.disabled = true;
  } else {
    // 纯信息展示，确认后继续
    selectArea.innerHTML = '';
    if (currentState.privateInfo) {
      selectArea.innerHTML = `<div style="color:#d4af37; font-size:1.1em; padding:20px; text-align:center;">${currentState.privateInfo.message || ''}</div>`;
    }
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
    if (nightSelectedTargets.length >= nightCanSelectCount) {
      // 取消第一个
      const first = nightSelectedTargets.shift();
      const firstBtn = document.querySelector(`.night-player-btn[data-pid="${first}"]`);
      if (firstBtn) firstBtn.classList.remove('selected');
    }
    nightSelectedTargets.push(pid);
    btn.classList.add('selected');
  }

  $('nightConfirmBtn').disabled = nightSelectedTargets.length !== nightCanSelectCount;
}

function submitNightAction() {
  if (nightCanSelectCount > 0 && nightSelectedTargets.length !== nightCanSelectCount) {
    showToast(`请选择${nightCanSelectCount}名玩家`);
    return;
  }

  sendSocket('night:action', {
    targets: nightSelectedTargets
  });
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
