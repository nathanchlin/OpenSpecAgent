// server/index.js
// Express 入口 — 多会话版本

const express = require('express');
const path = require('path');
const fs = require('fs');
const { createRoutes, createPreviewRoutes } = require('./routes');
const { SessionStore } = require('./session');
const { debug, error: logError, info } = require('./core/logger');

// ── 加载 .env ──
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // 去除引号包裹
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) {
      process.env[key] = value;
    }
  }
}

const app = express();
app.use(express.json());

// ── 请求日志 ──
app.use((req, res, next) => {
  // 安全头
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (req.path.startsWith('/api/')) {
      debug(`[${res.statusCode}] ${req.method} ${req.path} ${ms}ms`);
    }
  });
  next();
});

// ── 初始化会话仓库 ──
const store = new SessionStore();
store.loadAll();

// 退出时保存
process.on('SIGINT', () => {
  info('\nShutting down...');
  store.saveAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  store.saveAll();
  process.exit(0);
});

// ── API 路由 ──
app.use('/api', createRoutes(store));

// ── 预览路由 ──
app.use('/preview', createPreviewRoutes(store));

// ── 静态文件（前端）──
app.use(express.static(path.join(__dirname, '..', 'public')));

// SPA fallback（仅对非 API/preview 路径）
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/preview/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Express 错误处理中间件 ──
app.use((err, req, res, next) => {
  logError(`[Express Error] ${req.method} ${req.path}:`, err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── 全局错误处理 ──
process.on('uncaughtException', (err) => {
  logError('[Uncaught Exception]', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  logError('[Unhandled Rejection]', reason);
});

// ── 启动服务 ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  info(`OpenSpecAgent running at http://localhost:${PORT}`);
});
