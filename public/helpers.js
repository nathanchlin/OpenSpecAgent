// public/helpers.js
// 前端纯函数辅助工具 — 可在 Node 环境中测试

/**
 * 格式化文本内容为安全 HTML
 */
function formatContent(text) {
  if (!text) return '';
  // 先提取行内代码（避免双重转义）
  const codes = [];
  let processed = text.replace(/`([^`]+)`/g, (_, content) => {
    codes.push(escapeHtml(content));
    return `\x00CODE${codes.length - 1}\x00`;
  });

  // 转义 HTML + 换行
  processed = processed
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  // 还原行内代码
  processed = processed.replace(/\x00CODE(\d+)\x00/g, (_, idx) => {
    return '<code style="background:#11111b;padding:1px 4px;border-radius:3px;font-size:12px;">' + codes[parseInt(idx)] + '</code>';
  });

  return processed;
}

/**
 * HTML 转义
 */
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 格式化时间戳
 */
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

/**
 * 渲染 Spec 预览卡片
 */
function renderSpecPreview(spec) {
  if (!spec || !spec.pages || spec.pages.length === 0) return '<div class="spec-card-item">(空)</div>';
  let html = '';
  for (const page of spec.pages) {
    html += '<div class="spec-card-item">&#128196; ' + escapeHtml(page.title || page.name || '') + ' (' + escapeHtml(page.file || '') + ')</div>';
    if (page.elements) {
      for (const el of page.elements) {
        html += '<div class="spec-card-item">&nbsp;&nbsp;\u251C\u2500 ' + escapeHtml(el.type || '') + ': ' + escapeHtml(el.label || el.id || el.text || '') + '</div>';
      }
    }
    if (page.behaviors) {
      for (const b of page.behaviors) {
        html += '<div class="spec-card-item">&nbsp;&nbsp;\u251C\u2500 \u884C\u4E3A: ' + escapeHtml(b.trigger || '') + ' \u2192 ' + escapeHtml(b.type || '') + '</div>';
      }
    }
  }
  return html;
}

/**
 * 解析 LLM 回复中的 ##Q/##A 结构化问题选项
 * @param {string} text - LLM 原始回复
 * @returns {{ questions: Array<{title: string, options: Array<string>}>, remaining: string }}
 */
function parseBrainstormOptions(text) {
  if (!text) return { questions: [], remaining: '' };

  const questions = [];
  const lines = text.split('\n');
  let currentQ = null;
  const nonQALines = [];

  for (const line of lines) {
    const qMatch = line.match(/^##Q\d*\s*[:：]\s*(.+)/);
    const aMatch = line.match(/^##A\s*[:：]?\s*(.+)/);

    if (qMatch) {
      currentQ = { title: qMatch[1].trim(), options: [] };
      questions.push(currentQ);
    } else if (aMatch && currentQ) {
      currentQ.options.push(aMatch[1].trim());
    } else {
      nonQALines.push(line);
    }
  }

  const remaining = nonQALines.join('\n').trim();
  return { questions, remaining };
}

// 支持 browser 全局 和 Node module
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatContent, escapeHtml, formatTime, renderSpecPreview, parseBrainstormOptions };
}
