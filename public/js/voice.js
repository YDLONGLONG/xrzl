// ========== 房间语音模块（WebRTC Mesh拓扑） ==========
const VoiceManager = {
  localStream: null,
  audioContext: null,
  analyser: null,
  peers: new Map(),        // userId -> { pc, audioEl, gainNode, audioCtx, sourceNode }
  voiceUsers: new Map(),   // userId -> { name, seat }
  peerVolumes: new Map(),  // userId -> volume (0~1.5)
  isJoined: false,
  isMuted: false,
  isSpeakerOff: false,
  speakingState: false,
  vadInterval: null,

  // WebRTC配置
  rtcConfig: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  },

  // 初始化（需要传入socket）
  init(socket) {
    this.socket = socket;
    this.setupSocketListeners();
  },

  setupSocketListeners() {
    // 收到语音频道用户列表
    this.socket.on('voice:users', ({ users }) => {
      this.voiceUsers.clear();
      users.forEach(u => this.voiceUsers.set(u.id, u));
      this.updateVoiceUI();
      // 与已有用户建立连接：只有socket.id较小的一方作为initiator，避免双方同时发offer
      users.forEach(u => {
        if (u.id !== this.socket.id && !this.peers.has(u.id) && this.socket.id < u.id) {
          this.createPeerConnection(u.id, true);
        }
      });
    });

    // 有新用户加入语音
    this.socket.on('voice:userJoined', ({ userId, name }) => {
      this.voiceUsers.set(userId, { id: userId, name });
      this.updateVoiceUI();
      // 新用户加入时，由先加入的用户发起offer
      // 这里不主动创建连接，等待voice:users广播
    });

    // 有用户离开语音
    this.socket.on('voice:userLeft', ({ userId }) => {
      this.voiceUsers.delete(userId);
      this.closePeerConnection(userId);
      this.updateVoiceUI();
    });

    // 收到WebRTC信令
    this.socket.on('voice:signal', ({ fromId, type, data }) => {
      this.handleSignal(fromId, type, data);
    });

    // 静音状态
    this.socket.on('voice:muteState', ({ userId, muted }) => {
      const userEl = document.querySelector(`[data-voice-user="${userId}"]`);
      if (userEl) {
        userEl.classList.toggle('voice-muted', muted);
      }
    });

    // 说话状态
    this.socket.on('voice:speakingState', ({ userId, speaking }) => {
      const userEl = document.querySelector(`[data-voice-user="${userId}"]`);
      if (userEl) {
        userEl.classList.toggle('voice-speaking', speaking);
      }
    });
  },

  // 加入语音频道
  async join() {
    if (this.isJoined) return;
    try {
      // 获取麦克风权限
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      this.isJoined = true;
      this.isMuted = false;
      this.isSpeakerOff = false;

      // 创建本地音频处理链：用GainNode控制发送给别人的音量
      this.localAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.localAudioCtx.state === 'suspended') {
        await this.localAudioCtx.resume();
      }
      const localSource = this.localAudioCtx.createMediaStreamSource(this.localStream);
      this.localGainNode = this.localAudioCtx.createGain();
      this.localGainNode.gain.value = 1.0;
      const localDest = this.localAudioCtx.createMediaStreamDestination();
      localSource.connect(this.localGainNode);
      this.localGainNode.connect(localDest);
      // 处理后的流用于发送给其他用户
      this.processedStream = localDest.stream;

      // 设置语音活动检测（用原始流检测说话状态）
      this.setupVoiceActivityDetection();

      // 通知服务器加入
      this.socket.emit('voice:join');
      this.updateVoiceUI();
      this.showToast('已加入语音频道', 'success');
    } catch (err) {
      console.error('获取麦克风失败:', err);
      if (err.name === 'NotAllowedError') {
        this.showToast('请允许麦克风权限', 'error');
      } else if (err.name === 'NotFoundError') {
        this.showToast('未找到麦克风设备', 'error');
      } else {
        this.showToast('加入语音失败: ' + err.message, 'error');
      }
    }
  },

  // 离开语音频道
  leave() {
    if (!this.isJoined) return;

    // 停止麦克风测试
    if (this.isTesting) {
      this.stopTestMic();
    }

    // 关闭所有P2P连接
    for (const [userId] of this.peers) {
      this.closePeerConnection(userId);
    }

    // 关闭本地音频流
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    // 停止语音活动检测
    if (this.vadInterval) {
      clearInterval(this.vadInterval);
      this.vadInterval = null;
    }

    // 关闭AudioContext
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    if (this.localAudioCtx) {
      this.localAudioCtx.close();
      this.localAudioCtx = null;
    }
    this.localGainNode = null;
    this.processedStream = null;

    this.isJoined = false;
    this.isMuted = false;
    this.speakingState = false;

    // 通知服务器离开
    this.socket.emit('voice:leave');
    this.updateVoiceUI();
    this.showToast('已离开语音频道', 'info');
  },

  // 切换麦克风静音
  toggleMute() {
    if (!this.isJoined || !this.localStream) return;
    this.isMuted = !this.isMuted;
    this.localStream.getAudioTracks().forEach(t => {
      t.enabled = !this.isMuted;
    });
    this.socket.emit('voice:mute', { muted: this.isMuted });
    this.updateVoiceUI();
  },

  // 切换扬声器
  toggleSpeaker() {
    this.isSpeakerOff = !this.isSpeakerOff;
    this.peers.forEach(peer => {
      if (peer.audioEl) {
        peer.audioEl.muted = this.isSpeakerOff;
      }
    });
    this.updateVoiceUI();
  },

  // 设置某个用户的音量 (0 ~ 1.5，实际映射到0~1)
  setPeerVolume(userId, volume) {
    volume = Math.max(0, Math.min(1.5, volume));
    this.peerVolumes.set(userId, volume);
    const peer = this.peers.get(userId);
    if (peer && peer.audioEl) {
      // audioEl.volume 最大为1.0
      peer.audioEl.volume = Math.min(volume, 1.0);
    }
  },

  // 测试麦克风（本地回环：听到自己的声音）
  isTesting: false,
  testStream: null,
  testAudioCtx: null,
  testTimer: null,

  async testMic() {
    // 如果正在测试，则停止
    if (this.isTesting) {
      this.stopTestMic();
      return;
    }

    const btn = document.getElementById('voiceTestBtn');
    try {
      // 获取麦克风音频流
      this.testStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,  // 关闭回声消除，确保能听到原声
          noiseSuppression: false,
          autoGainControl: false
        },
        video: false
      });

      this.isTesting = true;

      // 使用 Web Audio API 播放（绕过浏览器自动播放策略）
      this.testAudioCtx = new (window.AudioContext || window.webkitAudioContext)();

      // 如果 AudioContext 处于 suspended 状态，需要 resume
      if (this.testAudioCtx.state === 'suspended') {
        await this.testAudioCtx.resume();
      }

      const source = this.testAudioCtx.createMediaStreamSource(this.testStream);
      const gain = this.testAudioCtx.createGain();
      gain.gain.value = 0.8;
      source.connect(gain);
      gain.connect(this.testAudioCtx.destination);

      // 更新按钮状态
      if (btn) {
        btn.classList.add('testing');
        btn.title = '停止测试';
      }
      this.showToast('🎤 麦克风测试中...请说话（5秒后自动停止）', 'info');

      // 5秒后自动停止
      this.testTimer = setTimeout(() => {
        this.stopTestMic();
      }, 5000);

    } catch (err) {
      console.error('麦克风测试失败:', err);
      if (err.name === 'NotAllowedError') {
        this.showToast('请允许麦克风权限', 'error');
      } else if (err.name === 'NotFoundError') {
        this.showToast('未找到麦克风设备', 'error');
      } else {
        this.showToast('测试失败: ' + err.message, 'error');
      }
    }
  },

  // 停止麦克风测试
  stopTestMic() {
    if (this.testTimer) {
      clearTimeout(this.testTimer);
      this.testTimer = null;
    }
    if (this.testAudioCtx) {
      this.testAudioCtx.close();
      this.testAudioCtx = null;
    }
    if (this.testStream) {
      this.testStream.getTracks().forEach(t => t.stop());
      this.testStream = null;
    }
    this.isTesting = false;

    const btn = document.getElementById('voiceTestBtn');
    if (btn) {
      btn.classList.remove('testing');
      btn.title = '测试麦克风';
    }
    this.showToast('麦克风测试已停止', 'info');
  },

  // 创建P2P连接
  async createPeerConnection(userId, isInitiator) {
    if (this.peers.has(userId)) return;

    const pc = new RTCPeerConnection(this.rtcConfig);

    // 添加本地音频流（使用经过GainNode处理的流）
    const sendStream = this.processedStream || this.localStream;
    if (sendStream) {
      sendStream.getTracks().forEach(track => {
        pc.addTrack(track, sendStream);
      });
    }

    // 创建音频元素播放远端音频（原生方式，最可靠）
    const audioEl = new Audio();
    audioEl.autoplay = true;
    audioEl.muted = this.isSpeakerOff;
    // 设置初始音量
    const initVol = this.peerVolumes.get(userId);
    audioEl.volume = initVol !== undefined ? Math.min(initVol, 1.0) : 1.0;
    // 附加到DOM（某些浏览器需要才能播放）
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);

    // 接收远端音频流
    pc.ontrack = (event) => {
      audioEl.srcObject = event.streams[0];
      audioEl.play().catch(() => {});
    };

    // ICE候选转发
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('voice:signal', {
          targetId: userId,
          type: 'candidate',
          data: event.candidate
        });
      }
    };

    // 连接状态
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        console.log(`与 ${userId} 的语音连接: ${pc.connectionState}`);
      }
    };

    this.peers.set(userId, { pc, audioEl, _userId: userId });

    // 如果是发起方，创建offer
    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('voice:signal', {
        targetId: userId,
        type: 'offer',
        data: offer
      });
    }
  },

  // 处理收到的信令
  async handleSignal(fromId, type, data) {
    let peer = this.peers.get(fromId);

    if (!peer) {
      // 收到offer时，如果还没有连接，创建一个（非发起方）
      if (type === 'offer') {
        await this.createPeerConnection(fromId, false);
        peer = this.peers.get(fromId);
      } else {
        return;
      }
    }

    const pc = peer.pc;

    try {
      if (type === 'offer') {
        await pc.setRemoteDescription(data);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.socket.emit('voice:signal', {
          targetId: fromId,
          type: 'answer',
          data: answer
        });
      } else if (type === 'answer') {
        await pc.setRemoteDescription(data);
      } else if (type === 'candidate') {
        await pc.addIceCandidate(data);
      }
    } catch (err) {
      console.error('处理信令失败:', err);
    }
  },

  // 关闭P2P连接
  closePeerConnection(userId) {
    const peer = this.peers.get(userId);
    if (peer) {
      if (peer.pc) peer.pc.close();
      if (peer.audioEl) {
        peer.audioEl.srcObject = null;
        peer.audioEl.remove();
      }
      this.peers.delete(userId);
    }
  },

  // 语音活动检测（检测自己是否在说话）
  setupVoiceActivityDetection() {
    if (!this.localStream) return;

    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = this.audioContext.createMediaStreamSource(this.localStream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.5;
    source.connect(this.analyser);

    const buffer = new Uint8Array(this.analyser.frequencyBinCount);
    let lastSpeaking = false;
    let silenceCount = 0;

    this.vadInterval = setInterval(() => {
      if (this.isMuted) {
        if (lastSpeaking) {
          lastSpeaking = false;
          this.socket.emit('voice:speaking', { speaking: false });
        }
        return;
      }

      this.analyser.getByteFrequencyData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) {
        sum += buffer[i];
      }
      const avg = sum / buffer.length;

      // 阈值：超过15认为在说话
      const isSpeaking = avg > 15;

      if (isSpeaking) {
        silenceCount = 0;
        if (!lastSpeaking) {
          lastSpeaking = true;
          this.socket.emit('voice:speaking', { speaking: true });
        }
      } else {
        silenceCount++;
        // 连续5帧静音才认为停止说话
        if (lastSpeaking && silenceCount > 5) {
          lastSpeaking = false;
          this.socket.emit('voice:speaking', { speaking: false });
        }
      }
    }, 100);
  },

  // 更新语音UI
  updateVoiceUI() {
    const userList = document.getElementById('voiceUserList');
    const joinBtn = document.getElementById('voiceJoinBtn');
    const leaveBtn = document.getElementById('voiceLeaveBtn');
    const muteBtn = document.getElementById('voiceMuteBtn');
    const speakerBtn = document.getElementById('voiceSpeakerBtn');
    const testBtn = document.getElementById('voiceTestBtn');
    const title = document.getElementById('voicePanelTitle');

    if (this.isJoined) {
      // 已加入：显示控制按钮，隐藏加入按钮
      if (joinBtn) joinBtn.style.display = 'none';
      if (leaveBtn) leaveBtn.style.display = '';
      if (muteBtn) {
        muteBtn.style.display = 'flex';
        muteBtn.classList.toggle('active', this.isMuted);
        muteBtn.textContent = this.isMuted ? '🔇' : '🎤';
        muteBtn.title = this.isMuted ? '取消静音' : '静音麦克风';
      }
      if (speakerBtn) {
        speakerBtn.style.display = 'flex';
        speakerBtn.classList.toggle('active', this.isSpeakerOff);
        speakerBtn.textContent = this.isSpeakerOff ? '🔈' : '🔊';
        speakerBtn.title = this.isSpeakerOff ? '开启扬声器' : '关闭扬声器';
      }
      if (testBtn) testBtn.style.display = '';

      // 更新用户列表
      if (userList) {
        let html = '';
        // 自己
        html += `<div class="voice-user voice-self ${this.isMuted ? 'voice-muted' : ''}" data-voice-user="${this.socket.id}">
          <div class="voice-user-row">
            <span class="voice-user-icon">🎤</span>
            <span class="voice-user-name">我</span>
            ${this.isMuted ? '<span class="voice-mute-icon">🔇</span>' : ''}
          </div>
          <div class="voice-vol-row">
            <span class="voice-vol-label">🔊</span>
            <input type="range" class="voice-vol-slider" min="0" max="100" value="100"
              oninput="VoiceManager.setLocalVolume(this.value/100); this.nextElementSibling.textContent=this.value+'%'" title="我的麦克风音量">
            <span class="voice-vol-val">100%</span>
          </div>
        </div>`;
        // 其他用户
        for (const [uid, user] of this.voiceUsers) {
          if (uid === this.socket.id) continue;
          const vol = this.peerVolumes.get(uid);
          const volPct = vol !== undefined ? Math.round(vol * 100) : 100;
          html += `<div class="voice-user" data-voice-user="${uid}">
            <div class="voice-user-row">
              <span class="voice-user-icon">🎤</span>
              <span class="voice-user-name">${this.escapeHtml(user.name)}</span>
            </div>
            <div class="voice-vol-row">
              <span class="voice-vol-label">🔊</span>
              <input type="range" class="voice-vol-slider" min="0" max="100" value="${volPct}"
                oninput="VoiceManager.setPeerVolume('${uid}', this.value/100); this.nextElementSibling.textContent=this.value+'%'"
                title="${this.escapeHtml(user.name)} 的音量">
              <span class="voice-vol-val">${volPct}%</span>
            </div>
          </div>`;
        }
        userList.innerHTML = html;
      }
    } else {
      // 未加入：显示加入按钮，隐藏控制按钮
      if (joinBtn) joinBtn.style.display = '';
      if (leaveBtn) leaveBtn.style.display = 'none';
      if (muteBtn) muteBtn.style.display = 'none';
      if (speakerBtn) speakerBtn.style.display = 'none';
      if (testBtn) testBtn.style.display = 'none';
      if (userList) userList.innerHTML = '';
    }

    // 更新标题（显示在线人数）
    if (title) {
      const count = this.voiceUsers.size;
      title.textContent = `🔊 语音频道${count > 0 ? ' (' + count + ')' : ''}`;
    }
  },

  // 设置本地麦克风音量（影响别人听到的音量）
  localGainNode: null,
  setLocalVolume(volume) {
    volume = Math.max(0, Math.min(1.0, volume));
    if (this.localGainNode) {
      this.localGainNode.gain.value = volume;
    }
  },

  // Toast提示
  showToast(msg, type = 'info') {
    if (typeof showToast === 'function') {
      showToast(msg);
    } else {
      console.log('[Voice]', msg);
    }
  },

  // HTML转义
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};
