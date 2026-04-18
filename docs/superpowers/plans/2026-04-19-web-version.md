# OpenSpecAgent Web 版实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 OpenSpecAgent 从 Electron 桌面应用改写为 B/S 架构 Web 应用，Express 单体 + SSE 进度推送。

**Architecture:** Express 同时托管前端静态文件（public/）和后端 API（/api/*）。核心模块（GLMClient、SpecEngine、CodeGenerator、GenPipeline）从 src/core/ 原封不动复制到 server/core/。前端用 fetch 调 API，EventSource 接收 SSE 进度。生成的文件存内存，通过 /preview/* 路由提供给 iframe。

**Tech Stack:** Node.js, Express, 原生 HTML/CSS/JS, SSE (EventSource), archiver (zip 导出)

---

## File Structure

```
server/
  index.js          ← Express 入口：启动服务、挂载路由和静态文件
  routes.js         ← 所有 /api/* 路由定义
  session.js        ← 会话状态管理（替代 Electron sessionState + SSE 广播）
  core/
    llm/glm-client.js          ← 从 src/core/llm/ 复制，不变
    spec-engine/index.js       ← 从 src/core/spec-engine/ 复制，不变
    code-generator/index.js    ← 从 src/core/code-generator/ 复制，不变
    gen-pipeline/index.js      ← 从 src/core/gen-pipeline/ 复制，不变
    gen-pipeline/prompts.js    ← 从 src/core/gen-pipeline/ 复制，不变

public/
  index.html        ← 主页面 HTML 结构（从 src/renderer/main.html 改写）
  style.css         ← 所有样式（从 main.html <style> 提取）
  app.js            ← 前端逻辑（从 main.html <script> 改写：IPC→fetch/SSE）
```

---

### Task 1: 创建目录结构 + 复制核心模块

**Files:**
- Create: `server/core/llm/glm-client.js`
- Create: `server/core/spec-engine/index.js`
- Create: `server/core/code-generator/index.js`
- Create: `server/core/gen-pipeline/index.js`
- Create: `server/core/gen-pipeline/prompts.js`

- [ ] **Step 1: 创建 server 目录结构**

```bash
mkdir -p server/core/llm server/core/spec-engine server/core/code-generator server/core/gen-pipeline public
```

- [ ] **Step 2: 复制核心模块**

```bash
cp src/core/llm/glm-client.js server/core/llm/glm-client.js
cp src/core/spec-engine/index.js server/core/spec-engine/index.js
cp src/core/code-generator/index.js server/core/code-generator/index.js
cp src/core/gen-pipeline/index.js server/core/gen-pipeline/index.js
cp src/core/gen-pipeline/prompts.js server/core/gen-pipeline/prompts.js
```

这些文件使用 `module.exports`，不需要任何改动——它们是纯 Node.js 模块，不依赖 Electron。

- [ ] **Step 3: 验证复制结果**

```bash
ls -la server/core/llm/ server/core/spec-engine/ server/core/code-generator/ server/core/gen-pipeline/
```

Expected: 每个目录下有对应的 .js 文件

- [ ] **Step 4: Commit**

```bash
git add server/core/
git commit -m "feat: copy core modules to server/ for web version"
```

---

### Task 2: 创建 server/session.js

**Files:**
- Create: `server/session.js`

这个模块管理单个会话的状态（当前为单用户，无需认证），并处理 SSE 客户端连接。它替代 Electron main.js 中的 `sessionState` 对象和 `mainWindow.webContents.send` 广播。

- [ ] **Step 1: 创建 server/session.js**

```js
// server/session.js
// 会话状态管理 + SSE 广播

const GLMClient = require('./core/llm/glm-client');
const SpecEngine = require('./core/spec-engine');
const CodeGenerator = require('./core/code-generator');
const GenPipeline = require('./core/gen-pipeline');

class SessionManager {
  constructor() {
    this.spec = null;
    this.generatedFiles = {};
    this.conversationHistory = [];
    this.brainstormHistory = [];
    this.activePipeline = null;
    this.sseClients = [];

    // 初始化服务
    this.glmClient = new GLMClient();
    this.specEngine = new SpecEngine(this.glmClient);
    this.codeGenerator = new CodeGenerator(this.glmClient);
  }

  /**
   * 添加 SSE 客户端连接
   */
  addSSEClient(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');
    this.sseClients.push(res);

    // 客户端断开时清理
    res.on('close', () => {
      this.sseClients = this.sseClients.filter(c => c !== res);
    });
  }

  /**
   * 广播 SSE 进度事件
   */
  broadcastProgress(event) {
    const data = JSON.stringify(event);
    for (const client of this.sseClients) {
      client.write(`event: progress\ndata: ${data}\n\n`);
    }
  }

  /**
   * 广播 SSE 完成事件
   */
  broadcastDone(result) {
    const data = JSON.stringify(result);
    for (const client of this.sseClients) {
      client.write(`event: done\ndata: ${data}\n\n`);
      client.end();
    }
    this.sseClients = [];
  }

  /**
   * 重置会话
   */
  reset() {
    this.spec = null;
    this.generatedFiles = {};
    this.conversationHistory = [];
    this.brainstormHistory = [];
    if (this.activePipeline) {
      this.activePipeline.cancel();
      this.activePipeline = null;
    }
  }

  getGeneratedFiles() {
    return this.generatedFiles;
  }
}

module.exports = { SessionManager };
```

- [ ] **Step 2: 验证模块可加载**

```bash
cd "D:/AIProject/OpenSpecAgent" && node -e "const { SessionManager } = require('./server/session'); const s = new SessionManager(); console.log('OK, spec:', s.spec, 'files:', Object.keys(s.generatedFiles).length);"
```

Expected: `OK, spec: null files: 0`

- [ ] **Step 3: Commit**

```bash
git add server/session.js
git commit -m "feat: add session manager with SSE broadcast support"
```

---

### Task 3: 创建 server/routes.js

**Files:**
- Create: `server/routes.js`

将 Electron `ipcMain.handle` 中的每个 handler 改写为 Express 路由。逻辑完全相同，只是从 `ipcMain.handle` 改为 `router.post/get`，从 `mainWindow.webContents.send` 改为 `session.broadcastProgress`。

- [ ] **Step 1: 创建 server/routes.js**

```js
// server/routes.js
// API 路由 — 将 Electron IPC handlers 改写为 Express 路由

const express = require('express');
const archiver = require('archiver');

function createRoutes(session) {
  const router = express.Router();

  // ── 对话 ──

  router.post('/chat', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    session.conversationHistory.push({ role: 'user', content: message });

    try {
      const specResult = await session.specEngine.processMessage(
        message,
        session.conversationHistory,
        session.spec
      );

      if (specResult.spec) {
        session.spec = specResult.spec;
      }

      session.conversationHistory.push({
        role: 'assistant',
        content: specResult.reply,
      });

      res.json({
        type: specResult.type,
        reply: specResult.reply,
        spec: specResult.spec || null,
      });
    } catch (err) {
      res.json({ type: 'error', reply: `Error: ${err.message}`, spec: null });
    }
  });

  // ── 增量修改 ──

  router.post('/chat/modify', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    session.conversationHistory.push({ role: 'user', content: message });

    try {
      const result = await session.codeGenerator.modify(
        message,
        session.spec,
        session.generatedFiles,
        session.conversationHistory
      );

      if (result.files) {
        session.generatedFiles = result.files;
      }

      session.conversationHistory.push({
        role: 'assistant',
        content: result.reply,
      });

      res.json({ type: 'success', reply: result.reply });
    } catch (err) {
      res.json({ type: 'error', reply: `Error: ${err.message}` });
    }
  });

  // ── Spec & History ──

  router.get('/spec', (req, res) => {
    res.json(session.spec);
  });

  router.get('/history', (req, res) => {
    res.json(session.conversationHistory);
  });

  // ── 头脑风暴 ──

  router.post('/brainstorm/start', async (req, res) => {
    const { spec } = req.body;
    session.spec = spec;
    session.brainstormHistory = [];
    const specJson = JSON.stringify(spec, null, 2);

    const pipeline = new (require('./core/gen-pipeline'))(
      session.glmClient,
      session.codeGenerator,
      (progressEvent) => session.broadcastProgress(progressEvent)
    );
    session.activePipeline = pipeline;

    try {
      const result = await pipeline.startBrainstorm(specJson);
      session.brainstormHistory.push({ role: 'assistant', content: result.reply });
      res.json({ reply: result.reply, infoSufficient: result.infoSufficient });
    } catch (err) {
      res.json({ reply: '头脑风暴启动失败: ' + err.message, infoSufficient: false });
    }
  });

  router.post('/brainstorm/chat', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    if (!session.activePipeline) {
      return res.json({ reply: '管道未启动', infoSufficient: false });
    }

    session.brainstormHistory.push({ role: 'user', content: message });
    const specJson = JSON.stringify(session.spec, null, 2);

    try {
      const result = await session.activePipeline.continueBrainstorm(specJson, session.brainstormHistory);
      session.brainstormHistory.push({ role: 'assistant', content: result.reply });
      res.json({ reply: result.reply, infoSufficient: result.infoSufficient });
    } catch (err) {
      res.json({ reply: '头脑风暴失败: ' + err.message, infoSufficient: false });
    }
  });

  // ── 生成管道 ──

  router.post('/generate', async (req, res) => {
    // 先注册 SSE 客户端（如果还没注册），然后启动生成
    // 注意：SSE 客户端通过 GET /generate/stream 注册
    // 这里只是触发生成

    if (!session.spec) {
      return res.json({ type: 'error', error: 'No spec available' });
    }

    const brainstormSummary = (session.brainstormHistory || [])
      .map(m => `${m.role === 'user' ? '用户' : '分析师'}: ${m.content}`)
      .join('\n\n');

    if (!session.activePipeline) {
      const GenPipeline = require('./core/gen-pipeline');
      session.activePipeline = new GenPipeline(
        session.glmClient,
        session.codeGenerator,
        (progressEvent) => session.broadcastProgress(progressEvent)
      );
    }

    // 不等待完成——通过 SSE 推送进度
    session.activePipeline.runGeneration(session.spec, brainstormSummary)
      .then((result) => {
        session.activePipeline = null;

        if (Object.keys(result.files).length === 0) {
          session.broadcastDone({ type: 'error', error: '代码生成失败：未能生成文件', steps: result.steps });
          return;
        }

        session.generatedFiles = result.files;
        session.broadcastDone({
          type: 'success',
          files: Object.keys(result.files),
          review: result.reviewSummary,
          steps: result.steps,
        });
      })
      .catch((err) => {
        session.activePipeline = null;
        session.broadcastDone({ type: 'error', error: err.message, steps: [] });
      });

    // 立即返回，前端通过 SSE 接收进度
    res.json({ status: 'started' });
  });

  // SSE 进度流
  router.get('/generate/stream', (req, res) => {
    session.addSSEClient(res);
  });

  // 取消生成
  router.post('/generate/cancel', (req, res) => {
    if (session.activePipeline) {
      session.activePipeline.cancel();
      res.json({ ok: true });
    } else {
      res.json({ ok: false });
    }
  });

  // ── 预览（从内存提供生成的文件）──

  router.get('/preview-url', (req, res) => {
    res.json({ url: '/preview/index.html' });
  });

  // ── 导出 zip ──

  router.get('/export', (req, res) => {
    const files = session.getGeneratedFiles();
    if (Object.keys(files).length === 0) {
      return res.status(404).json({ error: 'No files to export' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=openspec-export.zip');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    for (const [fileName, content] of Object.entries(files)) {
      archive.append(content, { name: fileName });
    }

    archive.finalize();
  });

  // ── 重置会话 ──

  router.post('/reset', (req, res) => {
    session.reset();
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createRoutes };
```

- [ ] **Step 2: 验证路由模块可加载**

```bash
cd "D:/AIProject/OpenSpecAgent" && node -e "const { createRoutes } = require('./server/routes'); console.log('OK, typeof:', typeof createRoutes);"
```

注意：此时 archiver 还没安装，这个验证会失败。先跳过，等 Task 5 安装依赖后再验证。

- [ ] **Step 3: Commit**

```bash
git add server/routes.js
git commit -m "feat: add Express API routes for all Electron IPC handlers"
```

---

### Task 4: 创建 server/index.js

**Files:**
- Create: `server/index.js`

Express 入口：加载 .env、初始化 SessionManager、挂载 API 路由、设置预览路由（从内存提供生成文件）、托管前端静态文件。

- [ ] **Step 1: 创建 server/index.js**

```js
// server/index.js
// Express 入口

const express = require('express');
const path = require('path');
const fs = require('fs');
const { createRoutes } = require('./routes');
const { SessionManager } = require('./session');

// ── 加载 .env ──
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...valueParts] = trimmed.split('=');
    if (key && valueParts.length > 0) {
      process.env[key.trim()] = valueParts.join('=').trim();
    }
  }
}

const app = express();
app.use(express.json());

// ── 初始化会话 ──
const session = new SessionManager();

// ── API 路由 ──
app.use('/api', createRoutes(session));

// ── 预览路由（从内存提供生成的文件）──
app.use('/preview', (req, res, next) => {
  const files = session.getGeneratedFiles();
  let filePath = req.path;

  // 规范化路径
  if (filePath === '/') filePath = '/index.html';
  // 去掉前导 /
  const fileName = filePath.slice(1);

  if (files[fileName]) {
    const ext = path.extname(fileName);
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
    };
    res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(files[fileName]);
  } else {
    next();
  }
});

// ── 静态文件（前端）──
app.use(express.static(path.join(__dirname, '..', 'public')));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── 全局错误处理 ──
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});

// ── 启动服务 ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OpenSpecAgent running at http://localhost:${PORT}`);
});
```

- [ ] **Step 2: 验证 server/index.js 语法**

```bash
cd "D:/AIProject/OpenSpecAgent" && node -c server/index.js && echo "Syntax OK"
```

Expected: `Syntax OK`

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat: add Express entry point with preview and static serving"
```

---

### Task 5: 更新 package.json + 安装依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 更新 package.json**

将现有的 `package.json` 更新为 Web 版配置。去掉 electron，保留 express + ws，新增 archiver：

```json
{
  "name": "openspec-agent",
  "version": "0.2.0",
  "description": "对话即规范 — 通过自然语言对话生成 Web 应用的 Web 工具",
  "main": "server/index.js",
  "scripts": {
    "start": "node server/index.js",
    "dev": "node server/index.js"
  },
  "dependencies": {
    "express": "^4.21.0",
    "ws": "^8.18.0",
    "archiver": "^7.0.0"
  },
  "keywords": ["openspec", "web-generator", "ai"],
  "license": "MIT"
}
```

- [ ] **Step 2: 安装新依赖**

```bash
cd "D:/AIProject/OpenSpecAgent" && npm install archiver
```

Expected: `added 1 package`（express 和 ws 已在 node_modules 中）

- [ ] **Step 3: 验证所有依赖可加载**

```bash
cd "D:/AIProject/OpenSpecAgent" && node -e "require('express'); require('archiver'); require('ws'); console.log('All deps OK');"
```

Expected: `All deps OK`

- [ ] **Step 4: 验证路由模块现在可以加载**

```bash
cd "D:/AIProject/OpenSpecAgent" && node -e "const { createRoutes } = require('./server/routes'); console.log('Routes OK, typeof:', typeof createRoutes);"
```

Expected: `Routes OK, typeof: function`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: update package.json for web version, add archiver"
```

---

### Task 6: 创建 public/style.css

**Files:**
- Create: `public/style.css`

从 `src/renderer/main.html` 的 `<style>` 标签（第 9-577 行）中提取所有 CSS。去掉 Electron 特有样式（`-webkit-app-region`），去掉测试面板样式。

- [ ] **Step 1: 创建 public/style.css**

将 main.html 的 `<style>` 内容原样提取，做以下修改：
- 删除 `-webkit-app-region: drag;` 和 `-webkit-app-region: no-drag;`
- 删除测试面板相关样式（`.panel-test`, `.test-header`, `.test-content`, `.test-footer`, `.test-btn`）
- 保留所有其他样式不变

```css
/* public/style.css */
/* 从 src/renderer/main.html 提取，去掉 Electron 和测试面板样式 */

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  height: 100vh;
  overflow: hidden;
  background: #1e1e2e;
  color: #cdd6f4;
}

/* ── Toolbar ── */
.toolbar {
  height: 42px;
  background: #181825;
  display: flex;
  align-items: center;
  padding: 0 16px;
  border-bottom: 1px solid #313244;
}
.toolbar-title {
  font-size: 13px;
  font-weight: 600;
  color: #cba6f7;
  letter-spacing: 0.5px;
}
.toolbar-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
.toolbar-btn {
  background: none;
  border: 1px solid #45475a;
  color: #a6adc8;
  padding: 4px 12px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.toolbar-btn:hover {
  background: #313244;
  color: #cdd6f4;
}

/* ── 双栏布局 ── */
.panels {
  display: flex;
  height: calc(100vh - 42px);
}

/* 对话面板 */
.panel-chat {
  width: 360px;
  min-width: 280px;
  border-right: 1px solid #313244;
  display: flex;
  flex-direction: column;
  background: #1e1e2e;
}

/* 预览面板 */
.panel-preview {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #11111b;
}

/* Resize Handle */
.resize-handle {
  width: 4px;
  cursor: col-resize;
  background: transparent;
  transition: background 0.15s;
}
.resize-handle:hover {
  background: #cba6f7;
}

/* ── 对话面板内部样式 ── */
.chat-header {
  padding: 12px 16px;
  border-bottom: 1px solid #313244;
  font-size: 13px;
  font-weight: 600;
  color: #cba6f7;
}
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.messages::-webkit-scrollbar { width: 6px; }
.messages::-webkit-scrollbar-thumb { background: #45475a; border-radius: 3px; }
.msg {
  max-width: 90%;
  padding: 10px 14px;
  border-radius: 12px;
  line-height: 1.5;
  word-break: break-word;
  font-size: 14px;
}
.msg-user {
  align-self: flex-end;
  background: #313244;
  border-bottom-right-radius: 4px;
}
.msg-assistant {
  align-self: flex-start;
  background: #252540;
  border-bottom-left-radius: 4px;
}
.msg-error {
  align-self: flex-start;
  background: #45273a;
  color: #f38ba8;
  border-bottom-left-radius: 4px;
}
.msg pre {
  background: #11111b;
  padding: 8px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 6px 0;
  font-size: 12px;
}
.spec-card {
  background: #1e1e2e;
  border: 1px solid #45475a;
  border-radius: 8px;
  padding: 12px;
  margin-top: 8px;
}
.spec-card-title {
  font-size: 12px;
  font-weight: 600;
  color: #a6e3a1;
  margin-bottom: 8px;
}
.spec-card-item {
  font-size: 12px;
  color: #a6adc8;
  padding: 2px 0;
}
.spec-card-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}
.spec-btn {
  padding: 6px 16px;
  border-radius: 6px;
  border: none;
  font-size: 12px;
  cursor: pointer;
  font-weight: 500;
}
.spec-btn-confirm {
  background: #a6e3a1;
  color: #1e1e2e;
}
.spec-btn-modify {
  background: #45475a;
  color: #cdd6f4;
}
.input-area {
  padding: 12px 16px;
  border-top: 1px solid #313244;
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.input-area textarea {
  flex: 1;
  background: #11111b;
  border: 1px solid #313244;
  border-radius: 8px;
  padding: 10px 12px;
  color: #cdd6f4;
  font-size: 14px;
  font-family: inherit;
  resize: none;
  outline: none;
  min-height: 42px;
  max-height: 120px;
}
.input-area textarea:focus {
  border-color: #cba6f7;
}
.input-area textarea::placeholder {
  color: #585b70;
}
.send-btn {
  background: #cba6f7;
  color: #1e1e2e;
  border: none;
  border-radius: 8px;
  padding: 10px 16px;
  font-size: 14px;
  cursor: pointer;
  font-weight: 600;
  transition: opacity 0.15s;
}
.send-btn:hover { opacity: 0.85; }
.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.typing-indicator {
  display: inline-flex;
  gap: 4px;
  padding: 4px 0;
}
.typing-indicator span {
  width: 6px;
  height: 6px;
  background: #585b70;
  border-radius: 50%;
  animation: bounce 1.2s infinite;
}
.typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
.typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
@keyframes bounce {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-6px); }
}

/* ── 预览面板 ── */
.preview-toolbar {
  height: 36px;
  background: #181825;
  display: flex;
  align-items: center;
  padding: 0 12px;
  gap: 8px;
  border-bottom: 1px solid #313244;
}
.preview-url {
  flex: 1;
  background: #11111b;
  border: 1px solid #313244;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  color: #a6adc8;
  font-family: monospace;
}
.device-btn {
  background: none;
  border: 1px solid #45475a;
  color: #a6adc8;
  padding: 2px 8px;
  border-radius: 3px;
  font-size: 11px;
  cursor: pointer;
}
.device-btn:hover, .device-btn.active {
  background: #313244;
  color: #cba6f7;
  border-color: #cba6f7;
}
.preview-frame {
  flex: 1;
  border: none;
  background: #fff;
}

/* ── 生成步进器 ── */
.gen-stepper {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid #313244;
}
.gen-step {
  display: flex;
  gap: 10px;
  min-height: 36px;
}
.gen-step:last-child .gen-step-line {
  display: none;
}
.gen-step-indicator {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 20px;
}
.gen-step-dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid #45475a;
  background: transparent;
  flex-shrink: 0;
  transition: all 0.3s;
}
.gen-step-line {
  width: 2px;
  flex: 1;
  min-height: 12px;
  background: #45475a;
  transition: background 0.3s;
}
.gen-step-content {
  flex: 1;
  padding-bottom: 8px;
}
.gen-step-title {
  font-size: 12px;
  font-weight: 600;
  color: #a6adc8;
  margin-bottom: 2px;
}
.gen-step-status {
  font-size: 11px;
  color: #585b70;
}
/* 状态变体 */
.gen-step.running .gen-step-dot {
  border-color: #cba6f7;
  background: #cba6f7;
  animation: pulse 1.2s ease-in-out infinite;
}
.gen-step.running .gen-step-title { color: #cba6f7; }
.gen-step.running .gen-step-status { color: #cba6f7; }
.gen-step.running .gen-step-line { background: #cba6f7; }

.gen-step.completed .gen-step-dot {
  border-color: #a6e3a1;
  background: #a6e3a1;
}
.gen-step.completed .gen-step-dot::after {
  content: '\2713';
  color: #1e1e2e;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}
.gen-step.completed .gen-step-title { color: #a6e3a1; }
.gen-step.completed .gen-step-status { color: #a6e3a1; }
.gen-step.completed .gen-step-line { background: #a6e3a1; }

.gen-step.skipped .gen-step-dot {
  border-color: #f9e2af;
  background: transparent;
}
.gen-step.skipped .gen-step-title { color: #f9e2af; }
.gen-step.skipped .gen-step-status { color: #f9e2af; }

.gen-step.failed .gen-step-dot {
  border-color: #f38ba8;
  background: #f38ba8;
}
.gen-step.failed .gen-step-title { color: #f38ba8; }
.gen-step.failed .gen-step-status { color: #f38ba8; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* 步骤详情（可折叠） */
.gen-step-detail {
  margin-top: 6px;
  padding: 8px;
  background: #11111b;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.5;
  color: #a6adc8;
  max-height: 150px;
  overflow-y: auto;
  display: none;
  word-break: break-word;
}
.gen-step-detail.visible { display: block; }
.gen-step.completed .gen-step-title { cursor: pointer; }

/* 取消按钮 */
.gen-cancel-btn {
  margin-top: 10px;
  padding: 4px 12px;
  background: #45273a;
  color: #f38ba8;
  border: 1px solid #f38ba8;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
}
.gen-cancel-btn:hover { background: #f38ba8; color: #1e1e2e; }

/* 生成完成摘要 */
.gen-summary {
  margin-top: 8px;
  padding: 8px;
  background: #1e3a2e;
  border: 1px solid #a6e3a1;
  border-radius: 6px;
  font-size: 12px;
  color: #a6e3a1;
  line-height: 1.5;
}
.gen-error {
  margin-top: 8px;
  padding: 8px;
  background: #45273a;
  border: 1px solid #f38ba8;
  border-radius: 6px;
  font-size: 12px;
  color: #f38ba8;
}

/* ── 头脑风暴问答区 ── */
.brainstorm-chat {
  margin-top: 12px;
  padding: 10px;
  background: #181825;
  border: 1px solid #313244;
  border-radius: 8px;
}
.brainstorm-messages {
  max-height: 250px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 8px;
}
.brainstorm-msg {
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
  word-break: break-word;
}
.brainstorm-msg-user {
  background: #313244;
  align-self: flex-end;
  max-width: 85%;
  border-bottom-right-radius: 4px;
}
.brainstorm-msg-assistant {
  background: #252540;
  align-self: flex-start;
  max-width: 90%;
  border-bottom-left-radius: 4px;
}
.brainstorm-msg-error {
  background: #45273a;
  color: #f38ba8;
}
.brainstorm-msg-loading {
  display: inline-flex;
  gap: 4px;
  padding: 4px 0;
}
.brainstorm-msg-loading span {
  width: 6px; height: 6px;
  background: #585b70;
  border-radius: 50%;
  animation: bounce 1.2s infinite;
}
.brainstorm-msg-loading span:nth-child(2) { animation-delay: 0.2s; }
.brainstorm-msg-loading span:nth-child(3) { animation-delay: 0.4s; }
.brainstorm-input-row {
  display: flex;
  gap: 6px;
  align-items: flex-end;
}
.brainstorm-input {
  flex: 1;
  background: #11111b;
  border: 1px solid #313244;
  border-radius: 6px;
  padding: 8px 10px;
  color: #cdd6f4;
  font-size: 12px;
  font-family: inherit;
  resize: none;
  outline: none;
  min-height: 36px;
  max-height: 80px;
}
.brainstorm-input:focus { border-color: #cba6f7; }
.brainstorm-send-btn {
  padding: 6px 12px !important;
  font-size: 12px !important;
  white-space: nowrap;
}
```

- [ ] **Step 2: Commit**

```bash
git add public/style.css
git commit -m "feat: add web version stylesheet (extracted from Electron main.html)"
```

---

### Task 7: 创建 public/index.html

**Files:**
- Create: `public/index.html`

从 `src/renderer/main.html` 的 HTML 结构改写。去掉测试面板、去掉 Electron preload 依赖，引入外部 CSS/JS。

- [ ] **Step 1: 创建 public/index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenSpecAgent</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <!-- Toolbar -->
  <div class="toolbar">
    <span class="toolbar-title">OpenSpecAgent</span>
    <div class="toolbar-actions">
      <button class="toolbar-btn" id="btn-new">新建</button>
      <button class="toolbar-btn" id="btn-export">导出</button>
    </div>
  </div>

  <!-- 双栏布局 -->
  <div class="panels">
    <!-- 左：对话面板 -->
    <div class="panel-chat" id="panel-chat">
      <div class="chat-header">OpenSpecAgent</div>
      <div class="messages" id="messages">
        <div class="msg msg-assistant">
          你好！我是 OpenSpecAgent。<br><br>
          告诉我你想创建什么样的 Web 应用，我会帮你从设计到实现。<br><br>
          例如：<br>&#8226; "做一个待办事项应用"<br>&#8226; "帮我做一个登录注册页面"<br>&#8226; "创建一个个人博客首页"
        </div>
      </div>
      <div class="input-area">
        <textarea id="input" placeholder="描述你想创建的 Web 应用..." rows="1"></textarea>
        <button class="send-btn" id="send-btn">发送</button>
      </div>
    </div>

    <div class="resize-handle" id="resize-chat"></div>

    <!-- 右：预览面板 -->
    <div class="panel-preview" id="panel-preview">
      <div class="preview-toolbar">
        <button class="device-btn active" data-viewport="desktop" title="桌面">&#128187;</button>
        <button class="device-btn" data-viewport="tablet" title="平板">&#128421;</button>
        <button class="device-btn" data-viewport="mobile" title="手机">&#128241;</button>
        <input class="preview-url" id="preview-url" value="/preview/index.html" readonly>
        <button class="device-btn" id="btn-refresh" title="刷新">&#8635;</button>
      </div>
      <iframe class="preview-frame" id="preview-frame" src="about:blank" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
    </div>
  </div>

  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat: add web version HTML page (two-column layout, no test panel)"
```

---

### Task 8: 创建 public/app.js

**Files:**
- Create: `public/app.js`

这是最大的改写任务。将 `src/renderer/main.html` 的 `<script>` 部分（第 646-1107 行）改写，将所有 `window.openspec` (Electron IPC) 调用替换为 `fetch` + `EventSource`。

核心映射：
- `API.chat.send(msg)` → `fetch('/api/chat', { method: 'POST', body: JSON.stringify({message: msg}) })`
- `API.brainstorm.start(spec)` → `fetch('/api/brainstorm/start', ...)`
- `API.brainstorm.chat(msg)` → `fetch('/api/brainstorm/chat', ...)`
- `API.gen.startGeneration(spec)` → 先建立 `EventSource('/api/generate/stream')`，再 `fetch('/api/generate', ...)`
- `API.gen.cancel()` → `fetch('/api/generate/cancel', ...)`
- `API.on('gen:progress', cb)` → `eventSource.addEventListener('progress', cb)`
- `API.preview.getUrl()` → 固定值 `/preview/index.html`

- [ ] **Step 1: 创建 public/app.js**

```js
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

async function apiGet(endpoint) {
  const res = await fetch(endpoint);
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
```

- [ ] **Step 2: Commit**

```bash
git add public/app.js
git commit -m "feat: add web version frontend logic with fetch API and SSE"
```

---

### Task 9: 集成验证

**Files:** 无新文件

验证整个 Web 版可以启动，前端页面可访问。

- [ ] **Step 1: 启动服务**

```bash
cd "D:/AIProject/OpenSpecAgent" && node server/index.js
```

Expected: `OpenSpecAgent running at http://localhost:3000`

- [ ] **Step 2: 验证前端页面可访问**

在浏览器打开 http://localhost:3000，确认：
1. 页面正常显示（双栏布局：左对话、右预览）
2. 无 JS 控制台错误
3. 预览面板 URL 显示 `/preview/index.html`
4. 导出按钮存在，新建按钮存在

- [ ] **Step 3: 验证 API 端点**

在另一个终端运行：

```bash
curl -X POST http://localhost:3000/api/chat -H "Content-Type: application/json" -d '{"message":"你好"}'
```

Expected: JSON 响应 `{ type: "...", reply: "...", spec: null }`（需要 .env 中有有效的 GLM_API_KEY）

- [ ] **Step 4: 验证重置端点**

```bash
curl -X POST http://localhost:3000/api/reset
```

Expected: `{"ok":true}`

- [ ] **Step 5: Commit（如有修复）**

如果集成测试中发现问题，修复后提交。

---

### Task 10: 清理旧 Electron 文件

**Files:**
- 可选删除: `main.js`
- 可选删除: `preload.js`
- 可选删除: `src/core/preview-server/`
- 可选删除: `src/renderer/`

这些文件在 Web 版中不再使用。可以选择保留作为参考，或删除以保持项目整洁。

- [ ] **Step 1: 确认是否清理**

根据用户偏好决定是否删除旧的 Electron 文件。如果删除：

```bash
rm main.js preload.js
rm -rf src/core/preview-server
rm -rf src/renderer
rm -rf test
```

- [ ] **Step 2: 更新 .gitignore**

在 `.gitignore` 中添加：

```
.superpowers/
```

- [ ] **Step 3: Final Commit**

```bash
git add -A
git commit -m "chore: clean up Electron files, add web version entry point"
```
