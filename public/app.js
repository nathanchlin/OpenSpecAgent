// public/app.js
// OpenSpecAgent Web 版前端逻辑 — 多会话版本

// ── API Helper ──
async function apiFetch(endpoint, options = {}) {
  const res = await fetch(endpoint, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

async function apiPost(endpoint, body = {}) {
  return apiFetch(endpoint, { method: 'POST', body });
}

// ── DOM References ──
const sessionListEl = document.getElementById('session-list');
const chatHeaderEl = document.getElementById('chat-header');
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const previewFrame = document.getElementById('preview-frame');
const previewUrl = document.getElementById('preview-url');

// ── State ──
let activeSessionId = null;
let currentSpec = null;
let activeSpecCard = null;

// ═══════════════════════════════════════
//  会话管理
// ═══════════════════════════════════════

function previewPath() {
  return `/preview/${activeSessionId}/index.html`;
}

async function loadSessions() {
  try {
    const sessions = await apiFetch('/api/sessions');
    renderSessionList(sessions);

    // 仅在初始化时（无活跃会话）自动切换
    if (!activeSessionId) {
      // 优先恢复上次选中的会话
      const lastId = localStorage.getItem('activeSessionId');
      const lastExists = lastId && sessions.some(s => s.id === lastId);

      if (lastExists) {
        switchSession(lastId);
      } else if (sessions.length > 0) {
        switchSession(sessions[0].id);
      } else {
        await createSession();
      }
    }
  } catch (e) {
    sessionListEl.innerHTML = '<div style="padding:12px;color:#f38ba8;font-size:12px;">连接失败，请检查服务器</div>';
  }
}

function renderSessionList(sessions) {
  sessionListEl.innerHTML = '';
  for (const s of sessions) {
    const div = document.createElement('div');
    div.className = 'session-item' + (s.id === activeSessionId ? ' active' : '');
    div.dataset.id = s.id;
    div.dataset.hasFiles = s.hasFiles ? '1' : '0';

    const timeStr = formatTime(s.updatedAt);
    const statusIcon = s.hasFiles ? ' \uD83D\uDCC4' : (s.hasSpec ? ' \uD83D\uDCCB' : '');
    div.innerHTML = `
      <div class="session-item-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}<span class="session-status-icon">${statusIcon}</span></div>
      <div class="session-item-time">${timeStr}</div>
      <div class="session-item-actions">
        <button class="session-action-btn session-rename-btn" title="重命名">&#9998;</button>
        <button class="session-action-btn session-delete-btn" title="删除">&#10005;</button>
      </div>
    `;

    div.addEventListener('click', (e) => {
      // 如果点击了操作按钮，不切换
      if (e.target.closest('.session-action-btn')) return;
      switchSession(s.id);
    });

    div.querySelector('.session-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSession(s.id);
    });

    div.querySelector('.session-rename-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      renameSession(s.id, s.name);
    });

    sessionListEl.appendChild(div);
  }
}

async function createSession(name) {
  const result = await apiPost('/api/sessions', { name: name || '新会话' });
  await loadSessions();
  switchSession(result.id);
  return result;
}

async function deleteSession(id) {
  const item = document.querySelector(`.session-item[data-id="${id}"]`);
  const name = item ? (item.querySelector('.session-item-name').firstChild?.textContent || '此会话') : '此会话';
  if (!confirm(`确认删除「${name}」？所有对话和文件将被清除。`)) return;

  try {
    await apiFetch(`/api/sessions/${id}`, { method: 'DELETE' });

    if (id === activeSessionId) {
      activeSessionId = null;
      localStorage.removeItem('activeSessionId');
      currentSpec = null;
      activeSpecCard = null;
      messagesEl.innerHTML = '';
      previewFrame.src = 'about:blank';
      chatHeaderEl.textContent = 'OpenSpecAgent';
    }

    await loadSessions();

    // 如果删完了，创建新的
    if (!activeSessionId) {
      await createSession();
    }
  } catch (err) {
    alert('删除失败: ' + err.message);
  }
}

async function renameSession(id, currentName) {
  const newName = prompt('重命名会话:', currentName);
  if (!newName || newName === currentName) return;

  try {
    await apiPost(`/api/sessions/${id}/rename`, { name: newName });
    await loadSessions();

    // 如果重命名的是当前会话，更新 chatHeader
    if (id === activeSessionId) {
      chatHeaderEl.textContent = newName;
    }
  } catch (err) {
    alert('重命名失败: ' + err.message);
  }
}

async function switchSession(id) {
  if (id === activeSessionId) return;
  activeSessionId = id;
  localStorage.setItem('activeSessionId', id);

  // 确保输入状态恢复
  sendBtn.disabled = false;
  inputEl.disabled = false;

  // 更新列表高亮
  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  // 加载对话历史
  try {
    const history = await apiFetch(`/api/sessions/${id}/history`);
    if (activeSessionId === id) renderHistory(history);
  } catch (e) {
    if (activeSessionId === id) messagesEl.innerHTML = '';
  }

  // 加载 spec
  try {
    const spec = await apiFetch(`/api/sessions/${id}/spec`);
    if (activeSessionId === id) currentSpec = spec;
  } catch (e) {
    if (activeSessionId === id) currentSpec = null;
  }

  // 更新 header 和预览
  if (activeSessionId !== id) return;
  const item = document.querySelector(`.session-item[data-id="${id}"]`);
  const nameEl = item ? item.querySelector('.session-item-name') : null;
  // 读取纯名称（排除状态图标的 text）
  chatHeaderEl.textContent = nameEl?.firstChild?.textContent || 'OpenSpecAgent';

  if (item && item.dataset.hasFiles === '1') {
    loadPreview();
  } else {
    previewFrame.src = 'about:blank';
    previewUrl.value = '';
  }

  inputEl.focus();
}

function renderHistory(history) {
  messagesEl.innerHTML = '';
  if (!history || history.length === 0) {
    messagesEl.innerHTML = `
      <div class="msg msg-assistant">
        你好！告诉我你想创建什么样的 Web 应用。
      </div>`;
    return;
  }

  for (const msg of history) {
    if (msg.role === 'user') {
      addMessage('user', msg.content);
    } else {
      // 尝试检测 spec 卡片（简化：不重新解析 spec 卡片，直接显示文本）
      addMessage('assistant', msg.content);
    }
  }
}

// ── 会话按钮 ──
document.getElementById('btn-add-session').addEventListener('click', async () => {
  const name = prompt('会话名称:');
  if (name) await createSession(name);
  else await createSession();
});

// ═══════════════════════════════════════
//  Preview
// ═══════════════════════════════════════

function loadPreview() {
  if (!activeSessionId) {
    previewFrame.src = 'about:blank';
    previewUrl.value = '';
    return;
  }
  const p = previewPath();
  previewFrame.src = p;
  previewUrl.value = p;
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

// ── Export ──
document.getElementById('btn-export').addEventListener('click', () => {
  if (!activeSessionId) return;
  const item = document.querySelector(`.session-item[data-id="${activeSessionId}"]`);
  if (!item || item.dataset.hasFiles !== '1') {
    alert('当前会话没有可导出的文件。请先生成代码。');
    return;
  }
  window.open(`/api/sessions/${activeSessionId}/export`, '_blank');
});

// ── Resize Handles ──
function setupResize(handleId, panelId, direction) {
  const handle = document.getElementById(handleId);
  const panel = document.getElementById(panelId);
  if (!handle || !panel) return;
  let startX, startWidth;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    previewFrame.style.pointerEvents = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  function onMove(e) {
    const diff = e.clientX - startX;
    const w = direction === 'left'
      ? Math.max(280, Math.min(600, startWidth + diff))
      : Math.max(180, Math.min(300, startWidth + diff));
    panel.style.width = w + 'px';
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    previewFrame.style.pointerEvents = '';
  }
}
setupResize('resize-session', 'panel-sessions', 'right');
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
  if (!text || !activeSessionId) return;

  const sessionId = activeSessionId;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  sendBtn.disabled = true;

  addMessage('user', text);
  const loadingEl = addLoading();

  try {
    const result = await apiPost(`/api/sessions/${sessionId}/chat`, { message: text });

    loadingEl.remove();

    // 如果用户已切换到其他会话，不渲染响应
    if (activeSessionId !== sessionId) {
      sendBtn.disabled = false;
      return;
    }

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
    if (activeSessionId === sessionId) {
      addMessage('error', '连接失败: ' + err.message);
    }
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
  modifyBtn.addEventListener('click', () => {
    inputEl.placeholder = '输入你想修改的内容，如"增加一个排行榜页面"...';
    inputEl.focus();
  });
}

// ═══════════════════════════════════════
//  确认 Spec → 头脑风暴
// ═══════════════════════════════════════

async function confirmSpec() {
  if (!currentSpec || !activeSessionId) return;

  const specCard = this.closest('.spec-card');
  if (!specCard) return;
  activeSpecCard = specCard;

  const sessionId = activeSessionId;
  const spec = currentSpec;

  const actions = specCard.querySelector('.spec-card-actions');
  if (actions) actions.style.display = 'none';

  injectStepper(specCard);

  const brainstormStep = specCard.querySelector('.gen-step[data-step="brainstorm"]');
  if (!brainstormStep) return;
  brainstormStep.className = 'gen-step running';
  brainstormStep.querySelector('.gen-step-status').textContent = '分析中...';

  try {
    const result = await apiPost(`/api/sessions/${sessionId}/brainstorm/start`, { spec });
    brainstormStep.className = 'gen-step completed';
    brainstormStep.querySelector('.gen-step-status').textContent = '问答中';

    injectBrainstormChat(specCard, result.reply, result.infoSufficient);
  } catch (err) {
    brainstormStep.className = 'gen-step failed';
    brainstormStep.querySelector('.gen-step-status').textContent = '失败: ' + err.message;
  }
}

function injectBrainstormChat(specCard, firstReply, infoSufficient) {
  const oldChat = specCard.querySelector('.brainstorm-chat');
  if (oldChat) oldChat.remove();

  const chatHTML = `
    <div class="brainstorm-chat">
      <div class="brainstorm-messages"></div>
      <div class="brainstorm-input-row">
        <textarea class="brainstorm-input" placeholder="补充说明（可选）..." rows="2"></textarea>
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

  // 渲染第一轮回复（带选项）
  renderBrainstormReply(chatArea, firstReply);

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

function renderBrainstormReply(chatArea, reply) {
  const msgArea = chatArea.querySelector('.brainstorm-messages');
  if (!msgArea) return;

  const { questions, remaining } = parseBrainstormOptions(reply);

  // 如果有非 Q/A 的说明文字，先显示
  if (remaining) {
    msgArea.insertAdjacentHTML('beforeend',
      `<div class="brainstorm-msg brainstorm-msg-assistant">${formatContent(remaining)}</div>`);
  }

  if (questions.length === 0) {
    // 没有 ##Q/##A 结构，直接显示原文
    if (!remaining) {
      msgArea.insertAdjacentHTML('beforeend',
        `<div class="brainstorm-msg brainstorm-msg-assistant">${formatContent(reply)}</div>`);
    }
    return;
  }

  // 渲染选项按钮组
  let optionsHTML = '<div class="brainstorm-options">';
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    optionsHTML += `<div class="brainstorm-option-group" data-q="${i}">`;
    optionsHTML += `<div class="brainstorm-option-group-title">${formatContent(q.title)}</div>`;
    for (const opt of q.options) {
      optionsHTML += `<button class="brainstorm-option-btn" data-q="${i}">${formatContent(opt)}</button>`;
    }
    optionsHTML += '</div>';
  }
  optionsHTML += '</div>';
  msgArea.insertAdjacentHTML('beforeend', optionsHTML);

  // 绑定选项点击事件（同一问题组内单选）
  const optionBtns = msgArea.querySelectorAll('.brainstorm-option-btn');
  for (const btn of optionBtns) {
    btn.addEventListener('click', () => {
      const qIdx = btn.getAttribute('data-q');
      // 同组内取消其他选中
      const siblings = msgArea.querySelectorAll(`.brainstorm-option-btn[data-q="${qIdx}"]`);
      for (const s of siblings) s.classList.remove('selected');
      btn.classList.add('selected');
    });
  }
}

/**
 * 收集当前选中的选项文本
 */
function collectSelectedOptions(chatArea) {
  const msgArea = chatArea.querySelector('.brainstorm-messages');
  if (!msgArea) return [];

  const groups = msgArea.querySelectorAll('.brainstorm-option-group');
  const answers = [];
  for (const group of groups) {
    const qTitle = group.querySelector('.brainstorm-option-group-title');
    const selected = group.querySelector('.brainstorm-option-btn.selected');
    if (selected) {
      const qText = qTitle ? qTitle.textContent : '';
      answers.push(`${qText} → ${selected.textContent}`);
    }
  }
  return answers;
}

async function brainstormSend(chatArea, textarea) {
  // 收集选项 + 自定义文本
  const optionAnswers = collectSelectedOptions(chatArea);
  const customText = textarea.value.trim();
  const text = [...optionAnswers, customText].filter(Boolean).join('\n');
  if (!text || !activeSessionId) return;

  const sessionId = activeSessionId;

  textarea.value = '';
  // 清除已选中的选项按钮
  const msgArea = chatArea.querySelector('.brainstorm-messages');
  const selectedBtns = msgArea.querySelectorAll('.brainstorm-option-btn.selected');
  for (const btn of selectedBtns) btn.classList.remove('selected');

  msgArea.insertAdjacentHTML('beforeend', `<div class="brainstorm-msg brainstorm-msg-user">${formatContent(text)}</div>`);
  msgArea.insertAdjacentHTML('beforeend', '<div class="brainstorm-msg brainstorm-msg-loading"><span></span><span></span><span></span></div>');
  messagesEl.scrollTop = messagesEl.scrollHeight;

  textarea.disabled = true;
  chatArea.querySelector('.brainstorm-send-btn').disabled = true;

  try {
    const result = await apiPost(`/api/sessions/${sessionId}/brainstorm/chat`, { message: text });

    const loading = msgArea.querySelector('.brainstorm-msg-loading');
    if (loading) loading.remove();

    renderBrainstormReply(chatArea, result.reply);

    if (result.infoSufficient && !chatArea.querySelector('.brainstorm-done-btn')) {
      chatArea.insertAdjacentHTML('beforeend', '<button class="spec-btn spec-btn-confirm brainstorm-done-btn" style="margin-top:8px;width:100%;">信息已足够，开始生成</button>');
      const doneBtn = chatArea.querySelector('.brainstorm-done-btn');
      const parentSpecCard = chatArea.closest('.spec-card');
      doneBtn.addEventListener('click', () => startGeneration(parentSpecCard));
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
  if (!specCard || !currentSpec || !activeSessionId) return;

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

  // 记录当前会话 ID，用于 SSE 回调中的身份检查
  const generationSessionId = activeSessionId;

  // 先建立 SSE 连接，再触发生成 POST（避免竞态：pipeline 完成/done 在 SSE 注册之前）
  const sseUrl = `/api/sessions/${generationSessionId}/generate/stream`;
  const eventSource = new EventSource(sseUrl);

  // 安全超时：10 分钟内未收到 done 事件则恢复 UI（防止永久锁定）
  // 多文件生成（计划+每文件执行+审核）可能需要较长时间
  const safetyTimeout = setTimeout(() => {
    eventSource.close();
    showError(specCard, '生成超时，请重试。');
    sendBtn.disabled = false;
    inputEl.disabled = false;
  }, 10 * 60 * 1000);

  eventSource.addEventListener('progress', (e) => {
    if (activeSessionId !== generationSessionId) return;
    try {
      const event = JSON.parse(e.data);
      updateStepper(specCard, event);
    } catch (err) {
      console.error('[SSE] Failed to parse progress event:', err);
    }
  });

  eventSource.addEventListener('done', (e) => {
    clearTimeout(safetyTimeout);
    if (activeSessionId !== generationSessionId) {
      eventSource.close();
      return;
    }
    let result;
    try {
      result = JSON.parse(e.data);
    } catch (err) {
      console.error('[SSE] Failed to parse done event:', err);
      showError(specCard, '收到无效的完成信号');
      sendBtn.disabled = false;
      inputEl.disabled = false;
      return;
    }
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

  // SSE 错误处理：不立即放弃，允许浏览器自动重连
  // EventSource 内置重连机制，只在安全超时时才真正放弃
  eventSource.onerror = () => {
    // EventSource 会自动重连，不要关闭
    // 如果 pipeline 已完成，重连后服务端会通过 _lastDoneEvent 重放 done 事件
    // 安全超时是最终的兜底
  };

  // SSE 连接建立后触发 POST（给 SSE 一小段时间完成握手）
  setTimeout(async () => {
    try {
      await apiPost(`/api/sessions/${generationSessionId}/generate`, {});
    } catch (err) {
      clearTimeout(safetyTimeout);
      eventSource.close();
      showError(specCard, err.message);
      sendBtn.disabled = false;
      inputEl.disabled = false;
    }
  }, 100);
}

async function cancelGen() {
  if (!activeSessionId) return;
  const sessionId = activeSessionId;
  try {
    await apiPost(`/api/sessions/${sessionId}/generate/cancel`);
  } catch (e) {
    console.warn('取消生成失败:', e.message);
  }
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

  if (event.output && typeof event.output === 'string' && event.status === 'completed') {
    const detailEl = stepEl.querySelector('.gen-step-detail');
    if (detailEl) {
      detailEl.textContent = event.output.substring(0, 500) + (event.output.length > 500 ? '...' : '');
      const titleEl = stepEl.querySelector('.gen-step-title');
      if (titleEl && !titleEl.dataset.toggleBound) {
        titleEl.dataset.toggleBound = '1';
        titleEl.addEventListener('click', () => {
          detailEl.classList.toggle('visible');
        });
      }
    }
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
    const truncatedReview = review.length > 300 ? review.substring(0, 300) + '...' : review;
    summaryHTML += '<br>' + formatContent(truncatedReview);
  }
  summaryHTML += '</div>';
  specCard.insertAdjacentHTML('beforeend', summaryHTML);

  // 刷新会话列表以更新状态图标和 data-hasFiles（影响导出按钮）
  loadSessions();
}

function showError(specCard, message) {
  const cancelBtn = specCard.querySelector('.gen-cancel-btn');
  if (cancelBtn) cancelBtn.remove();

  specCard.insertAdjacentHTML('beforeend',
    `<div class="gen-error">生成失败: ${formatContent(message || '未知错误')}</div>`
  );
}

// ═══════════════════════════════════════
//  Global Error Handling
// ═══════════════════════════════════════

window.addEventListener('unhandledrejection', (e) => {
  console.error('[Unhandled Promise]', e.reason);
  e.preventDefault();
});

// ═══════════════════════════════════════
//  Init
// ═══════════════════════════════════════

loadSessions();
