// 公共工具函数
function $(id) { return document.getElementById(id); }

function showError(msg, elementId) {
  const el = $(elementId);
  if (el) {
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 3000);
  } else {
    showToast(msg, 'error');
  }
}

function showToast(msg, type = 'info') {
  if (!window._toastQueue) {
    window._toastQueue = [];
    window._toastActive = false;
  }

  // 消息去重：相同的消息不再重复添加
  const last = window._toastQueue[window._toastQueue.length - 1];
  if (last && last.msg === msg) return;

  window._toastQueue.push({ msg, type });
  processToastQueue();
}

function processToastQueue() {
  if (!window._toastQueue || window._toastQueue.length === 0 || window._toastActive) return;
  window._toastActive = true;
  const item = window._toastQueue.shift();
  createToast(item.msg, item.type);

  // 依次显示后续队列
  const interval = setInterval(() => {
    if (!window._toastQueue || window._toastQueue.length === 0) {
      clearInterval(interval);
      window._toastActive = false;
      return;
    }
    const next = window._toastQueue.shift();
    createToast(next.msg, next.type);
  }, 600);
}

function createToast(msg, type = 'info') {
  const container = getToastContainer();

  const toast = document.createElement('div');
  toast.className = `app-toast app-toast-${type}`;

  const icon = document.createElement('span');
  icon.className = 'app-toast-icon';
  icon.textContent = type === 'success' ? '✓'
    : (type === 'error' || type === 'warning') ? '!'
    : 'i';

  const text = document.createElement('span');
  text.className = 'app-toast-text';
  text.textContent = msg;

  // 关闭按钮：支持手动关闭提示
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'app-toast-close';
  close.title = '关闭';
  close.setAttribute('aria-label', '关闭');
  close.textContent = '✕';

  toast.appendChild(icon);
  toast.appendChild(text);
  toast.appendChild(close);
  container.appendChild(toast);

  // 淡出后移除（flex容器自动重排）；手动关闭与自动关闭共用同一流程
  let removeTimer = null;
  let autoTimer = null;
  const dismiss = () => {
    if (removeTimer) return;
    clearTimeout(autoTimer);
    toast.classList.add('app-toast-out');
    removeTimer = setTimeout(() => toast.remove(), 250);
  };
  close.addEventListener('click', dismiss);
  autoTimer = setTimeout(dismiss, 2600);
}

function getToastContainer() {
  let container = document.getElementById('app-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'app-toast-container';
    document.body.appendChild(container);
  }
  return container;
}

function showConfirm(message, options = {}) {
  return new Promise((resolve) => {
    const title = options.title || '确认';
    const confirmText = options.confirmText || '确定';
    const cancelText = options.cancelText || '取消';
    const type = options.type || 'default';

    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog confirm-type-${type}">
        <div class="confirm-title">${title}</div>
        <div class="confirm-message">${message}</div>
        <div class="confirm-buttons">
          <button class="confirm-btn confirm-cancel">${cancelText}</button>
          <button class="confirm-btn confirm-ok">${confirmText}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const okBtn = overlay.querySelector('.confirm-ok');
    const cancelBtn = overlay.querySelector('.confirm-cancel');

    const close = (result) => {
      overlay.classList.add('confirm-closing');
      setTimeout(() => {
        overlay.remove();
        resolve(result);
      }, 200);
    };

    okBtn.addEventListener('click', () => close(true));
    cancelBtn.addEventListener('click', () => close(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
    });

    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
      else if (e.key === 'Escape') { e.preventDefault(); close(false); }
    };
    document.addEventListener('keydown', onKey);
    const origRemove = overlay.remove.bind(overlay);
    overlay.remove = function() {
      document.removeEventListener('keydown', onKey);
      origRemove();
    };

    requestAnimationFrame(() => {
      overlay.classList.add('confirm-show');
    });
  });
}

function showTextInput(title, options = {}) {
  return new Promise((resolve) => {
    const placeholder = options.placeholder || '';
    const defaultValue = options.defaultValue || '';
    const confirmText = options.confirmText || '确定';
    const cancelText = options.cancelText || '取消';
    const maxLength = options.maxLength || 200;
    const multiline = options.multiline !== false;
    const type = options.type || 'default';

    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog confirm-type-${type}" style="min-width:340px;max-width:500px;">
        <div class="confirm-title">${title}</div>
        ${options.description ? `<div class="confirm-message" style="margin-bottom:10px;font-size:13px;color:#7f7f7f;">${options.description}</div>` : ''}
        <div class="confirm-input-area">
          ${multiline
            ? `<textarea class="confirm-textarea" placeholder="${placeholder}" maxlength="${maxLength}" rows="3"></textarea>`
            : `<input type="text" class="confirm-input" placeholder="${placeholder}" maxlength="${maxLength}">`
          }
          <div class="confirm-input-counter" style="text-align:right;font-size:11px;color:#999999;margin-top:4px;">
            <span class="confirm-counter-num">0</span>/${maxLength}
          </div>
        </div>
        <div class="confirm-buttons">
          <button class="confirm-btn confirm-cancel">${cancelText}</button>
          <button class="confirm-btn confirm-ok">${confirmText}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const okBtn = overlay.querySelector('.confirm-ok');
    const cancelBtn = overlay.querySelector('.confirm-cancel');
    const inputEl = overlay.querySelector(multiline ? '.confirm-textarea' : '.confirm-input');
    const counterNum = overlay.querySelector('.confirm-counter-num');

    // 默认值用赋值方式写入，避免用户输入（如造谣者声明的重试回填）破坏弹窗结构
    if (defaultValue) inputEl.value = defaultValue;

    const updateCounter = () => {
      if (counterNum) counterNum.textContent = inputEl.value.length;
    };
    updateCounter();
    inputEl.addEventListener('input', updateCounter);

    setTimeout(() => {
      inputEl.focus();
      // 有回填内容时光标置于末尾，便于直接补充或修改
      if (defaultValue && inputEl.setSelectionRange) {
        const len = inputEl.value.length;
        inputEl.setSelectionRange(len, len);
      }
    }, 100);

    const close = (result) => {
      overlay.classList.add('confirm-closing');
      setTimeout(() => {
        overlay.remove();
        resolve(result);
      }, 200);
    };

    okBtn.addEventListener('click', () => {
      const val = inputEl.value.trim();
      if (options.minLength && val.length < options.minLength) {
        inputEl.style.borderColor = '#FA5151';
        return;
      }
      close(val || null);
    });
    cancelBtn.addEventListener('click', () => close(null));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter' && !multiline) { e.preventDefault(); okBtn.click(); }
      else if (e.key === 'Enter' && e.ctrlKey && multiline) { e.preventDefault(); okBtn.click(); }
    };
    document.addEventListener('keydown', onKey);
    const origRemove = overlay.remove.bind(overlay);
    overlay.remove = function() {
      document.removeEventListener('keydown', onKey);
      origRemove();
    };

    requestAnimationFrame(() => {
      overlay.classList.add('confirm-show');
    });
  });
}

// 双问题输入弹窗（学者）：在同一个弹窗里填写两个问题，一次性提交
function showDoubleTextInput(title, options = {}) {
  return new Promise((resolve) => {
    const maxLength = options.maxLength || 120;
    const minLength = options.minLength || 1;
    const labels = options.labels || ['第一个问题', '第二个问题'];
    const placeholders = options.placeholders || ['', ''];
    const defaultValues = options.defaultValues || ['', ''];
    const confirmText = options.confirmText || '提交';
    const cancelText = options.cancelText || '取消';
    const type = options.type || 'default';

    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog confirm-type-${type}" style="min-width:360px;max-width:520px;">
        <div class="confirm-title">${title}</div>
        ${options.description ? `<div class="confirm-message" style="margin-bottom:10px;font-size:13px;color:#7f7f7f;line-height:1.5;">${options.description}</div>` : ''}
        <div class="confirm-input-area">
          <div style="font-size:12px;color:#666;margin-bottom:4px;">① ${labels[0]}</div>
          <input type="text" class="confirm-input dbl-input" data-idx="0" placeholder="${placeholders[0]}" maxlength="${maxLength}">
          <div style="text-align:right;font-size:11px;color:#999;margin:4px 0 10px;">
            <span class="dbl-count" data-idx="0">0</span>/${maxLength}
          </div>
          <div style="font-size:12px;color:#666;margin-bottom:4px;">② ${labels[1]}</div>
          <input type="text" class="confirm-input dbl-input" data-idx="1" placeholder="${placeholders[1]}" maxlength="${maxLength}">
          <div style="text-align:right;font-size:11px;color:#999;margin-top:4px;">
            <span class="dbl-count" data-idx="1">0</span>/${maxLength}
          </div>
          <div class="dbl-error" style="display:none;color:#FA5151;font-size:12px;margin-top:8px;"></div>
        </div>
        <div class="confirm-buttons">
          <button class="confirm-btn confirm-cancel">${cancelText}</button>
          <button class="confirm-btn confirm-ok">${confirmText}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const okBtn = overlay.querySelector('.confirm-ok');
    const cancelBtn = overlay.querySelector('.confirm-cancel');
    const inputs = Array.from(overlay.querySelectorAll('.dbl-input'));
    const counts = Array.from(overlay.querySelectorAll('.dbl-count'));
    const errorEl = overlay.querySelector('.dbl-error');

    const updateCount = (idx) => {
      if (counts[idx]) counts[idx].textContent = inputs[idx].value.length;
    };
    // 用赋值方式回填默认值（如学者 AI 失败后重试时带入上次的问题）
    inputs.forEach((el, idx) => {
      if (defaultValues[idx]) el.value = String(defaultValues[idx]);
      updateCount(idx);
    });
    inputs.forEach((el, idx) => {
      el.addEventListener('input', () => {
        updateCount(idx);
        el.style.borderColor = '';
        errorEl.style.display = 'none';
      });
    });

    setTimeout(() => {
      const focusEl = inputs.find(el => !el.value) || inputs[0];
      if (focusEl) focusEl.focus();
    }, 100);

    const close = (result) => {
      overlay.classList.add('confirm-closing');
      setTimeout(() => {
        overlay.remove();
        resolve(result);
      }, 200);
    };

    const submit = () => {
      const values = inputs.map(el => el.value.trim());
      const badIdx = values.findIndex(v => v.length < minLength);
      if (badIdx !== -1) {
        errorEl.textContent = `请填写${badIdx === 0 ? '第一个' : '第二个'}问题（至少 ${minLength} 字）`;
        errorEl.style.display = 'block';
        inputs[badIdx].style.borderColor = '#FA5151';
        inputs[badIdx].focus();
        return;
      }
      close(values);
    };

    okBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', () => close(null));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter') { e.preventDefault(); submit(); }
    };
    document.addEventListener('keydown', onKey);
    const origRemove = overlay.remove.bind(overlay);
    overlay.remove = function() {
      document.removeEventListener('keydown', onKey);
      origRemove();
    };

    requestAnimationFrame(() => {
      overlay.classList.add('confirm-show');
    });
  });
}
