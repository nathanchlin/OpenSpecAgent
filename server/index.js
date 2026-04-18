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
