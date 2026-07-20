// 白天阶段交互
let votingMode = false;
let currentNomineeId = null;

function showVotingPanel(data) {
  votingMode = true;
  currentNomineeId = data.nomineeId;
  const nominee = currentState.players.find(p => p.id === data.nomineeId);
  
  $('actionPanel').style.display = 'block';
  $('actionTitle').textContent = '投票环节';
  $('selectedTargets').innerHTML = `<div style="font-size:1.2em; color:#e74c3c;">${nominee.seat+1}号 ${nominee.name} 被提名处决</div>`;
  $('actionButtons').innerHTML = `
    <button class="btn btn-success vote-btn yes" onclick="castVote(true)">赞成处决</button>
    <button class="btn btn-danger vote-btn no" onclick="castVote(false)">反对</button>
    <div style="width:100%; margin-top:10px;">
      <button class="btn btn-primary btn-sm" onclick="endVoting()" style="width:auto; margin-top:10px;">结束投票</button>
    </div>
  `;
}

function castVote(vote) {
  const me = currentState.players.find(p => p.id === myId);
  if (!me.isAlive && me.voteToken <= 0) {
    showToast('你已使用死后投票标记');
    return;
  }
  sendSocket('day:vote', { vote });
  const voteLabel = vote
    ? '<span style="color:#2ecc71; font-weight:bold;">✅ 已投赞成</span>'
    : '<span style="color:#e74c3c; font-weight:bold;">❌ 已投反对</span>';
  $('actionButtons').innerHTML = `
    <div style="text-align:center; margin-bottom:8px;">${voteLabel}</div>
    <button class="btn btn-sm btn-warning" onclick="revokeVote()" style="width:100%;">↩️ 撤回投票</button>
  `;
}

function revokeVote() {
  sendSocket('day:revokeVote');
  $('actionButtons').innerHTML = `
    <button class="btn btn-success vote-btn yes" onclick="castVote(true)">赞成处决</button>
    <button class="btn btn-danger vote-btn no" onclick="castVote(false)">反对</button>
  `;
}

function endVoting() {
  sendSocket('day:endVoting');
}

function updateVoteDisplay(data) {
  // 实时更新投票计数
}

function showVoteResult(data) {
  votingMode = false;
  $('actionTitle').textContent = '投票结果';
  const resultText = data.passed ? 
    `<span style="color:#e74c3c;">达到处决线！${data.yesVotes}票赞成，需要${data.threshold}票</span>` :
    `<span style="color:#27ae60;">未达处决线，${data.yesVotes}票赞成，需要${data.threshold}票</span>`;
  $('selectedTargets').innerHTML = resultText;
  $('actionButtons').innerHTML = '';
}

function showNominationStarted(data) {
  const nominator = currentState.players.find(p => p.id === data.nominator.id);
  const nominee = currentState.players.find(p => p.id === data.nominee.id);
  
  if (data.nominee.id === myId) {
    // 你是被提名者，进入辩护
    $('actionPanel').style.display = 'block';
    $('actionTitle').textContent = '你被提名了！请辩护';
    $('selectedTargets').innerHTML = `${nominator.seat+1}号 ${nominator.name} 提名了你`;
    $('actionButtons').innerHTML = `<button class="btn btn-primary" onclick="endDefense()">辩护完毕</button>`;
  } else {
    $('centerMessage').innerHTML = `<div style="color:#f39c12;">${nominator.seat+1}号 ${nominator.name} 提名了 ${nominee.seat+1}号 ${nominee.name}</div><div style="margin-top:10px; color:#aaa;">等待辩护...</div>`;
  }
}

function endDefense() {
  sendSocket('day:endDefense');
}

function showExecutionResult(data) {
  $('actionPanel').style.display = 'block';
  $('actionTitle').textContent = '处决结果';
  if (data.executedId) {
    $('selectedTargets').innerHTML = `<div style="color:#e74c3c; font-size:1.1em;">${data.seat+1}号 ${data.name} 被处决</div>`;
  } else {
    $('selectedTargets').innerHTML = `<div style="color:#27ae60;">${data.message}</div>`;
  }
  $('actionButtons').innerHTML = '';
}

function showAbilityUsed(data) {
  const from = currentState.players.find(p => p.id === data.fromId);
  let msg = '';
  if (data.abilityName === 'slayer') {
    if (data.result.killed) {
      msg = `${from.seat+1}号 ${data.fromName} 使用杀手技能击杀了恶魔！`;
    } else {
      msg = `${from.seat+1}号 ${data.fromName} 使用杀手技能，但无事发生。`;
    }
  }
  $('centerMessage').innerHTML = `<div style="color:#9b59b6;">${msg}</div>`;
}

async function nominatePlayer(targetId) {
  const phase = currentState.phase;
  if (phase !== 'DAY_DISCUSSION' && phase !== 'NOMINATION_PHASE') {
    showToast('现在不是提名时间');
    return;
  }
  const me = currentState.players.find(p => p.id === myId);
  if (!me.isAlive) {
    if (me.voteToken <= 0) {
      showToast('你已使用死后投票标记，无法提名');
      return;
    }
  }
  const target = currentState.players.find(p => p.id === targetId);
  const ok = await showConfirm(`确定提名 ${target.seat+1}号 玩家吗？`, { title: '提名确认' });
  if (ok) {
    sendSocket('day:nominates', { targetId });
  }
}

async function useSlayerAbility() {
  const targetId = await selectTargetPlayer('选择要击杀的玩家（杀手技能）');
  if (targetId) {
    const target = currentState.players.find(p => p.id === targetId);
    const ok = await showConfirm(`确定对 ${target ? target.seat+1 + '号 ' + target.name : '该玩家'} 使用杀手技能吗？每局只能使用一次。`, { type: 'warning', title: '杀手技能', confirmText: '确认击杀' });
    if (ok) {
      sendSocket('day:useAbility', { abilityName: 'slayer', targetId });
    }
  }
}

let selectCallback = null;
function selectTargetPlayer(prompt) {
  // 简单实现：点击座位选择
  showToast(prompt + '，点击玩家座位选择');
  return new Promise(resolve => {
    window._onSeatClick = (pid) => {
      window._onSeatClick = null;
      resolve(pid);
    };
    // 简化：直接弹出选择框
    const players = currentState.players.filter(p => p.isAlive && p.seat !== -1);
    const name = prompt(prompt + '\n' + players.map((p,i) => `${i+1}: ${p.seat+1}号 ${p.name}`).join('\n'));
    if (name) {
      const idx = parseInt(name) - 1;
      if (idx >= 0 && idx < players.length) {
        resolve(players[idx].id);
        return;
      }
    }
    resolve(null);
  });
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
