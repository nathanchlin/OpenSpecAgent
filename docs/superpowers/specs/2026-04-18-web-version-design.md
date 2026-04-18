# OpenSpecAgent Web 版设计文档

## 概述

将 OpenSpecAgent 从 Electron 桌面应用改写为 B/S 架构的 Web 应用。Express 单体服务同时托管前端静态文件和后端 API，通过 SSE 推送生成进度。前端保持纯原生 HTML/CSS/JS，核心模块（GLMClient、SpecEngine、CodeGenerator、GenPipeline）原封不动复用。

## 架构决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 整体架构 | B/S（Express 单体） | 改动最小，核心逻辑直接复用 |
| 前端技术 | 纯原生 HTML/CSS/JS | 与项目"纯原生"理念一致 |
| 代码组织 | 单体仓库 | 前端 public/，后端 server/，同一 Express 服务 |
| 进度推送 | SSE (EventSource) | 单向推送足够，比 WebSocket 简单 |
| API Key 管理 | 服务端 .env | 用户无感知，适合个人部署 |
| 预览文件存储 | 内存 | 无需写磁盘，Express 路由直接服务 |
| 去掉的功能 | 测试面板（空壳） | 当前未实现，Web 版不再保留空壳 |

## 目录结构

```
OpenSpecAgent/
├── server/
│   ├── index.js          # Express 入口：启动服务、加载中间件
│   ├── routes.js         # API 路由定义
│   ├── session.js        # 会话状态管理（替代 Electron sessionState）
│   └── core/             # 核心模块（从 src/core/ 迁移，代码不变）
│       ├── llm/
│       │   └── glm-client.js
│       ├── spec-engine/
│       │   └── index.js
│       ├── code-generator/
│       │   └── index.js
│       └── gen-pipeline/
│           ├── index.js
│           └── prompts.js
├── public/
│   ├── index.html        # 主页面（从 src/renderer/main.html 改写）
│   ├── app.js            # 前端逻辑（从 main.html <script> 提取）
│   └── style.css         # 样式（从 main.html <style> 提取）
├── .env                  # GLM_API_KEY + 端口配置
├── .env.example
├── package.json          # 去掉 electron，保留 express + ws
└── knowledge/            # 知识库（保留）
```

## API 设计

### 对话 & Spec

| 端点 | 方法 | 说明 | 请求体 | 响应 |
|------|------|------|--------|------|
| `/api/chat` | POST | 发送消息 | `{ message }` | `{ type, reply, spec }` |
| `/api/chat/modify` | POST | 增量修改 | `{ message }` | `{ type, reply }` |
| `/api/spec` | GET | 获取当前 Spec | - | spec JSON |
| `/api/history` | GET | 获取对话历史 | - | `[{role, content}]` |

### 头脑风暴

| 端点 | 方法 | 说明 | 请求体 | 响应 |
|------|------|------|--------|------|
| `/api/brainstorm/start` | POST | 启动头脑风暴 | `{ spec }` | `{ reply, infoSufficient }` |
| `/api/brainstorm/chat` | POST | 继续问答 | `{ message }` | `{ reply, infoSufficient }` |

### 生成管道

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/generate` | POST | 启动自动生成（计划→执行→审核） |
| `/api/generate/stream` | GET (SSE) | 生成进度事件流 |
| `/api/generate/cancel` | POST | 取消生成 |

`POST /api/generate` 触发生成但不等待完成。前端通过 `EventSource('/api/generate/stream')` 接收进度事件。

SSE 事件格式：
```
event: progress
data: {"step":"plan","stepIndex":1,"status":"running","timestamp":...}

event: progress
data: {"step":"execute","stepIndex":2,"status":"completed","output":"3 个文件生成完成"}

event: done
data: {"type":"success","files":["index.html"],"review":"..."}

event: done
data: {"type":"error","error":"代码生成失败"}
```

### 预览 & 导出

| 端点 | 方法 | 说明 |
|------|------|------|
| `/preview/*` | GET | 预览生成的应用（iframe src） |
| `/api/export` | GET | 导出生成文件为 zip |
| `/api/reset` | POST | 重置会话（清空状态） |

## 前端改动

### 从 Electron IPC 到 Web API

| Electron IPC | Web API |
|-------------|---------|
| `window.openspec.chat.send(msg)` | `fetch('/api/chat', { method: 'POST', body: JSON.stringify({message: msg}) })` |
| `window.openspec.brainstorm.start(spec)` | `fetch('/api/brainstorm/start', ...)` |
| `window.openspec.brainstorm.chat(msg)` | `fetch('/api/brainstorm/chat', ...)` |
| `window.openspec.gen.startGeneration(spec)` | `fetch('/api/generate', ...)` |
| `window.openspec.gen.cancel()` | `fetch('/api/generate/cancel', ...)` |
| `window.openspec.on('gen:progress', cb)` | `new EventSource('/api/generate/stream')` |
| `window.openspec.preview.getUrl()` | 固定路径 `/preview/index.html` |

### UI 改动

- **去掉** Electron 窗口标题栏（`-webkit-app-region: drag`）
- **去掉** 测试面板（空壳，暂不迁移）
- **去掉** `preload.js` 依赖，改为 `fetch` 调用
- **新增** 导出按钮功能：`GET /api/export` 下载 zip
- **保持** 三栏布局（对话 + 预览 + 可折叠区域）
- **保持** 步进器 UI 样式和交互
- **保持** 头脑风暴问答区域

## 服务端实现

### server/index.js

```js
// Express 入口
const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const { createRoutes } = require('./routes');
const { SessionManager } = require('./session');

// 加载 .env
dotenv.config();

const app = express();
app.use(express.json());

// API 路由
const session = new SessionManager();
app.use('/api', createRoutes(session));

// 预览路由（从内存提供生成的文件）
app.use('/preview', (req, res) => {
  const files = session.getGeneratedFiles();
  const filePath = req.path === '/' ? '/index.html' : req.path;
  const content = files[filePath.slice(1)]; // 去掉前导 /
  if (content) {
    res.type('html').send(content);
  } else {
    res.status(404).send('Not found');
  }
});

// 静态文件（前端）
app.use(express.static(path.join(__dirname, '../public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OpenSpecAgent running at http://localhost:${PORT}`));
```

### server/session.js

管理单个会话的状态（当前版本为单用户，无需认证）：

```js
class SessionManager {
  constructor() {
    this.spec = null;
    this.generatedFiles = {};
    this.conversationHistory = [];
    this.brainstormHistory = [];
    this.activePipeline = null;
    this.sseClients = [];  // SSE 连接池
  }

  // 广播 SSE 事件
  broadcastProgress(event) {
    for (const client of this.sseClients) {
      client.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
    }
  }

  broadcastDone(result) {
    for (const client of this.sseClients) {
      client.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
      client.end();
    }
    this.sseClients = [];
  }

  addSSEClient(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    this.sseClients.push(res);
  }

  getGeneratedFiles() { return this.generatedFiles; }

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
}
```

### server/routes.js

每个 API 路由从 Electron IPC handler 中迁移，逻辑不变，只是把 `ipcMain.handle` 改为 Express 路由，`sessionState` 改为 `session` 对象。

## 依赖变化

### package.json

**去掉：**
- `electron`

**保留：**
- `express`
- `ws`

**新增：**
- `dotenv`（或手动读取 .env，与现有 main.js 方式一致）
- `archiver`（zip 导出功能）

## 启动方式

```bash
# 安装依赖
npm install

# 配置 API Key
cp .env.example .env
# 编辑 .env 填入 GLM_API_KEY

# 启动
npm start
# 或
node server/index.js
```

浏览器打开 `http://localhost:3000`。
