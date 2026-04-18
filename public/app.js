// public/app.js
// OpenSpecAgent Web 版前端逻辑

// ── API Helper ──
async function apiPost(endpoint, body = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── DOM References ──
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const previewFrame = document.getElementById('preview-frame');
const previewUrl = document.getElementById('preview-url');

let currentSpec = null;
let activeSpecCard = null;

// ── Preview ──
const PREVIEW_PATH = '/preview/index.html';

function loadPreview() {
  previewFrame.src = PREVIEW_PATH;
  previewUrl.value = PREVIEW_PATH;
}

document.getElementById('btn-refresh').addEventListener('click', () => {
  previewFrame.src = previewFrame.src;
});

// ── Viewport Switch ──
const viewports = {
  desktop: { maxWidth: '100%' },
  tablet: { maxWidth: '768px' },
  mobile: { maxWidth: '375px' },
};
document.querySelectorAll('.device-btn[data-viewport]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.device-btn[data-viewport]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const vp = viewports[btn.dataset.viewport];
    previewFrame.style.maxWidth = vp.maxWidth;
    previewFrame.style.margin = vp.maxWidth === '100%' ? '0' : '0 auto';
  });
});

// ── New ──
document.getElementById('btn-new').addEventListener('click', async () => {
  if (confirm('确认新建项目？当前内容将被清除。')) {
    await apiPost('/api/reset');
    previewFrame.src = 'about:blank';
    messagesEl.innerHTML = `
      <div class="msg msg-assistant">
        已重置。告诉我你想创建什么应用。
      </div>`;
    currentSpec = null;
  }
});

// ── Export ──
document.getElementById('btn-export').addEventListener('click', () => {
  window.open('/api/export', '_blank');
});

// ── Resize Handles ──
function setupResize(handleId, panelId, direction) {
  const handle = document.getElementById(handleId);
  const panel = document.getElementById(panelId);
  if (!handle || !panel) return;
  let startX, startWidth;
  handle.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
  function onMove(e) {
    const diff = e.clientX - startX;
    const w = direction === 'left'
      ? Math.max(280, Math.min(600, startWidth + diff))
      : Math.max(240, Math.min(500, startWidth - diff));
    panel.style.width = w + 'px';
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
}
setupResize('resize-chat', 'panel-chat', 'left');

// ═══════════════════════════════════════
//  Chat Logic
// ═══════════════════════════════════════

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener('click', sendMessage);

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text) return;

  inputEl.value = '';
  inputEl.style.height = 'auto';
  sendBtn.disabled = true;

  addMessage('user', text);
  const loadingEl = addLoading();

  try {
    const result = await apiPost('/api/chat', { message: text });
    loadingEl.remove();

    if (result.type === 'error') {
      addMessage('error', result.reply);
    } else if (result.spec) {
      currentSpec = result.spec;
      addSpecCard(result.reply, result.spec);
    } else {
      addMessage('assistant', result.reply);
    }
  } catch (err) {
    loadingEl.remove();
    addMessage('error', '连接失败: ' + err.message);
  }

  sendBtn.disabled = false;
  inputEl.focus();
}

function addMessage(type, content) {
  const div = document.createElement('div');
  div.className = 'msg msg-' + type;
  div.innerHTML = formatContent(content);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addLoading() {
  const div = document.createElement('div');
  div.className = 'msg msg-assistant';
  div.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addSpecCard(reply, spec) {
  const div = document.createElement('div');
  div.className = 'msg msg-assistant';
  div.innerHTML = `
    ${formatContent(reply)}
    <div class="spec-card">
      <div class="spec-card-title">Spec 预览</div>
      ${renderSpecPreview(spec)}
      <div class="spec-card-actions">
        <button class="spec-btn spec-btn-confirm">确认生成</button>
        <button class="spec-btn spec-btn-modify">我要修改</button>
      </div>
    </div>
  `;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const confirmBtn = div.querySelector('.spec-btn-confirm');
  const modifyBtn = div.querySelector('.spec-btn-modify');
  confirmBtn.addEventListener('click', confirmSpec);
  modifyBtn.addEventListener('click', () => inputEl.focus());
}

function renderSpecPreview(spec) {
  if (!spec || !spec.pages) return '<div class="spec-card-item">(空)</div>';
  let html = '';
  for (const page of spec.pages) {
    html += '<div class="spec-card-item">&#128196; ' + (page.title || page.name) + ' (' + page.file + ')</div>';
    if (page.elements) {
      for (const el of page.elements) {
        html += '<div class="spec-card-item">&nbsp;&nbsp;\u251C\u2500 ' + el.type + ': ' + (el.label || el.id || el.text || '') + '</div>';
      }
    }
    if (page.behaviors) {
      for (const b of page.behaviors) {
        html += '<div class="spec-card-item">&nbsp;&nbsp;\u251C\u2500 \u884C\u4E3A: ' + b.trigger + ' \u2192 ' + b.type + '</div>';
      }
    }
  }
  return html;
}

// ═══════════════════════════════════════
//  确认 Spec → 头脑风暴
// ═══════════════════════════════════════

async function confirmSpec() {
  if (!currentSpec) return;

  const specCard = this.closest('.spec-card');
  if (!specCard) return;
  activeSpecCard = specCard;

  // 隐藏操作按钮
  const actions = specCard.querySelector('.spec-card-actions');
  if (actions) actions.style.display = 'none';

  // 注入步进器
  injectStepper(specCard);

  // 启动头脑风暴
  const brainstormStep = specCard.querySelector('.gen-step[data-step="brainstorm"]');
  brainstormStep.className = 'gen-step running';
  brainstormStep.querySelector('.gen-step-status').textContent = '分析中...';

  try {
    const result = await apiPost('/api/brainstorm/start', { spec: currentSpec });
    brainstormStep.className = 'gen-step completed';
    brainstormStep.querySelector('.gen-step-status').textContent = '问答中';

    const detailEl = brainstormStep.querySelector('.gen-step-detail');
    detailEl.innerHTML = formatContent(result.reply);
    detailEl.classList.add('visible');

    injectBrainstormChat(specCard, result.infoSufficient);
  } catch (err) {
    brainstormStep.className = 'gen-step failed';
    brainstormStep.querySelector('.gen-step-status').textContent = '失败: ' + err.message;
  }
}

function injectBrainstormChat(specCard, infoSufficient) {
  const oldChat = specCard.querySelector('.brainstorm-chat');
  if (oldChat) oldChat.remove();

  const chatHTML = `
    <div class="brainstorm-chat">
      <div class="brainstorm-messages"></div>
      <div class="brainstorm-input-row">
        <textarea class="brainstorm-input" placeholder="回答问题或补充想法..." rows="2"></textarea>
        <button class="spec-btn spec-btn-confirm brainstorm-send-btn">发送</button>
      </div>
      ${infoSufficient ? '' : '<button class="spec-btn spec-btn-confirm brainstorm-done-btn" style="margin-top:8px;width:100%;">信息已足够，开始生成</button>'}
    </div>
  `;
  specCard.insertAdjacentHTML('beforeend', chatHTML);

  const chatArea = specCard.querySelector('.brainstorm-chat');
  const textarea = chatArea.querySelector('.brainstorm-input');
  const brainstormSendBtn = chatArea.querySelector('.brainstorm-send-btn');
  const doneBtn = chatArea.querySelector('.brainstorm-done-btn');

  brainstormSendBtn.addEventListener('click', () => brainstormSend(chatArea, textarea));
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      brainstormSend(chatArea, textarea);
    }
  });

  if (doneBtn) {
    doneBtn.addEventListener('click', () => startGeneration(specCard));
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function brainstormSend(chatArea, textarea) {
  const text = textarea.value.trim();
  if (!text) return;

  textarea.value = '';

  const msgArea = chatArea.querySelector('.brainstorm-messages');
  msgArea.insertAdjacentHTML('beforeend', `<div class="brainstorm-msg brainstorm-msg-user">${formatContent(text)}</div>`);
  msgArea.insertAdjacentHTML('beforeend', '<div class="brainstorm-msg brainstorm-msg-loading"><span></span><span></span><span></span></div>');
  messagesEl.scrollTop = messagesEl.scrollHeight;

  textarea.disabled = true;
  chatArea.querySelector('.brainstorm-send-btn').disabled = true;

  try {
    const result = await apiPost('/api/brainstorm/chat', { message: text });

    const loading = msgArea.querySelector('.brainstorm-msg-loading');
    if (loading) loading.remove();

    msgArea.insertAdjacentHTML('beforeend', `<div class="brainstorm-msg brainstorm-msg-assistant">${formatContent(result.reply)}</div>`);

    if (result.infoSufficient && !chatArea.querySelector('.brainstorm-done-btn')) {
      chatArea.insertAdjacentHTML('beforeend', '<button class="spec-btn spec-btn-confirm brainstorm-done-btn" style="margin-top:8px;width:100%;">信息已足够，开始生成</button>');
      chatArea.querySelector('.brainstorm-done-btn').addEventListener('click', () => startGeneration(activeSpecCard));
    }
  } catch (err) {
    const loading = msgArea.querySelector('.brainstorm-msg-loading');
    if (loading) loading.remove();
    msgArea.insertAdjacentHTML('beforeend', `<div class="brainstorm-msg brainstorm-msg-error">错误: ${err.message}</div>`);
  } finally {
    textarea.disabled = false;
    chatArea.querySelector('.brainstorm-send-btn').disabled = false;
    textarea.focus();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// ═══════════════════════════════════════
//  生成管道（SSE 进度推送）
// ═══════════════════════════════════════

async function startGeneration(specCard) {
  if (!specCard || !currentSpec) return;

  // 隐藏问答区，禁用输入
  const chatArea = specCard.querySelector('.brainstorm-chat');
  if (chatArea) chatArea.style.display = 'none';
  sendBtn.disabled = true;
  inputEl.disabled = true;

  // 更新头脑风暴步骤状态
  const brainstormStep = specCard.querySelector('.gen-step[data-step="brainstorm"]');
  if (brainstormStep) {
    brainstormStep.className = 'gen-step completed';
    brainstormStep.querySelector('.gen-step-status').textContent = '已完成';
  }

  // 添加取消按钮
  specCard.insertAdjacentHTML('beforeend', '<button class="gen-cancel-btn">取消生成</button>');
  const cancelBtn = specCard.querySelector('.gen-cancel-btn');
  cancelBtn.addEventListener('click', cancelGen);

  // 建立 SSE 连接
  const eventSource = new EventSource('/api/generate/stream');

  eventSource.addEventListener('progress', (e) => {
    const event = JSON.parse(e.data);
    updateStepper(specCard, event);
  });

  eventSource.addEventListener('done', (e) => {
    const result = JSON.parse(e.data);
    eventSource.close();

    if (result.type === 'success') {
      showCompletion(specCard, result.files, result.review);
      setTimeout(loadPreview, 500);
    } else {
      showError(specCard, result.error);
    }

    sendBtn.disabled = false;
    inputEl.disabled = false;
    inputEl.focus();
  });

  eventSource.onerror = () => {
    eventSource.close();
    sendBtn.disabled = false;
    inputEl.disabled = false;
  };

  // 触发生成（不等待，通过 SSE 接收结果）
  try {
    await apiPost('/api/generate', {});
  } catch (err) {
    eventSource.close();
    showError(specCard, err.message);
    sendBtn.disabled = false;
    inputEl.disabled = false;
  }
}

async function cancelGen() {
  try {
    await apiPost('/api/generate/cancel');
  } catch (e) {}
}

// ── 步进器 ──

const GEN_STEPS = [
  { key: 'brainstorm', label: '头脑风暴' },
  { key: 'plan', label: '编写计划' },
  { key: 'execute', label: '执行计划' },
  { key: 'review', label: '代码审核' },
];

const STEP_STATUS_TEXT = {
  running: '进行中...',
  completed: '已完成',
  skipped: '已跳过',
  failed: '失败',
};

function injectStepper(specCard) {
  let stepperHTML = '<div class="gen-stepper">';
  for (const step of GEN_STEPS) {
    stepperHTML += `
      <div class="gen-step" data-step="${step.key}">
        <div class="gen-step-indicator">
          <div class="gen-step-dot"></div>
          <div class="gen-step-line"></div>
        </div>
        <div class="gen-step-content">
          <div class="gen-step-title">${step.label}</div>
          <div class="gen-step-status">等待中</div>
          <div class="gen-step-detail"></div>
        </div>
      </div>`;
  }
  stepperHTML += '</div>';
  specCard.insertAdjacentHTML('beforeend', stepperHTML);
}

function updateStepper(specCard, event) {
  const stepEl = specCard.querySelector(`.gen-step[data-step="${event.step}"]`);
  if (!stepEl) return;

  stepEl.className = 'gen-step ' + event.status;

  const statusEl = stepEl.querySelector('.gen-step-status');
  statusEl.textContent = STEP_STATUS_TEXT[event.status] || event.status;

  if (event.output && event.status === 'completed') {
    const detailEl = stepEl.querySelector('.gen-step-detail');
    detailEl.textContent = event.output.substring(0, 500) + (event.output.length > 500 ? '...' : '');
    stepEl.querySelector('.gen-step-title').addEventListener('click', () => {
      detailEl.classList.toggle('visible');
    });
  }

  if (event.error && event.status === 'failed') {
    statusEl.textContent = '失败: ' + event.error;
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showCompletion(specCard, files, review) {
  const cancelBtn = specCard.querySelector('.gen-cancel-btn');
  if (cancelBtn) cancelBtn.remove();

  let summaryHTML = `<div class="gen-summary">生成完成！共 ${files.length} 个文件。`;
  if (review) {
    summaryHTML += '<br>' + formatContent(review).substring(0, 300);
  }
  summaryHTML += '</div>';
  specCard.insertAdjacentHTML('beforeend', summaryHTML);
}

function showError(specCard, message) {
  const cancelBtn = specCard.querySelector('.gen-cancel-btn');
  if (cancelBtn) cancelBtn.remove();

  specCard.insertAdjacentHTML('beforeend',
    `<div class="gen-error">生成失败: ${formatContent(message || '未知错误')}</div>`
  );
}

// ── Helpers ──

function formatContent(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
    .replace(/`([^`]+)`/g, '<code style="background:#11111b;padding:1px 4px;border-radius:3px;font-size:12px;">$1</code>');
}
