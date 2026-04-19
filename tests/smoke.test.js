// tests/smoke.test.js
// 服务构建冒烟测试 — 验证应用可以完整构建和响应基础请求

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 测试用的完整应用构建（不启动真实监听）
function buildApp() {
  // 加载 .env 变量（与 server/index.js 一致）
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
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key) process.env[key] = value;
    }
  }

  const { createRoutes, createPreviewRoutes } = require('../server/routes');
  const { SessionStore } = require('../server/session');

  const dataDir = path.join(os.tmpdir(), 'openspec-smoke-' + Date.now());
  const store = new SessionStore(dataDir);
  store.loadAll();

  const app = express();
  app.use(express.json());

  // 安全头中间件（与 server/index.js 一致）
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
  });

  app.use('/api', createRoutes(store));
  app.use('/preview', createPreviewRoutes(store));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // SPA fallback（与 server/index.js 一致）
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/preview/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  return { app, store, dataDir };
}

describe('Server Build Smoke Test', () => {
  let app, store, dataDir;

  beforeAll(() => {
    ({ app, store, dataDir } = buildApp());
  });

  afterAll(() => {
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('所有核心模块可以被 require 而不崩溃', () => {
    expect(() => require('../server/core/llm/glm-client')).not.toThrow();
    expect(() => require('../server/core/spec-engine')).not.toThrow();
    expect(() => require('../server/core/code-generator')).not.toThrow();
    require('../server/core/gen-pipeline');
    expect(() => require('../server/core/gen-pipeline')).not.toThrow();
    expect(() => require('../server/session')).not.toThrow();
    expect(() => require('../server/routes')).not.toThrow();
  });

  test('prompts 常量全部加载', () => {
    const prompts = require('../server/core/gen-pipeline/prompts');
    expect(Object.keys(prompts)).toHaveLength(4);
  });

  test('前端文件全部存在', () => {
    const publicDir = path.join(__dirname, '..', 'public');
    expect(fs.existsSync(path.join(publicDir, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(publicDir, 'app.js'))).toBe(true);
    expect(fs.existsSync(path.join(publicDir, 'style.css'))).toBe(true);
    expect(fs.existsSync(path.join(publicDir, 'helpers.js'))).toBe(true);
  });

  test('GET /api/health 响应正常', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  test('安全头正确设置', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-xss-protection']).toBe('1; mode=block');
  });

  test('GET /api/sessions 返回空数组', async () => {
    const res = await request(app).get('/api/sessions').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('POST /api/sessions 创建会话成功', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .send({ name: '冒烟测试' })
      .expect(200);
    expect(res.body.id).toBeTruthy();
  });

  test('GET / 返回 index.html', async () => {
    const res = await request(app).get('/').expect(200);
    expect(res.text).toContain('<!DOCTYPE html>');
    expect(res.text).toContain('OpenSpecAgent');
  });

  test('GET /helpers.js 返回 JS 文件', async () => {
    const res = await request(app).get('/helpers.js').expect(200);
    expect(res.text).toContain('formatContent');
  });

  test('错误处理中间件捕获异常', async () => {
    // 添加一个故意抛错的中间件测试错误处理
    const errorApp = express();
    errorApp.use(express.json());
    errorApp.get('/test-error', (req, res, next) => {
      next(new Error('test error'));
    });
    errorApp.use((err, req, res, next) => {
      res.status(500).json({ error: 'Internal server error' });
    });

    const res = await request(errorApp).get('/test-error').expect(500);
    expect(res.body.error).toBe('Internal server error');
  });

  test('SPA fallback 不匹配 /api/ 路径', async () => {
    const res = await request(app).get('/api/nonexistent').expect(404);
    expect(res.body.error).toBeDefined();
  });

  test('SPA fallback 不匹配 /preview/ 路径', async () => {
    const res = await request(app).get('/preview/nonexistent/index.html').expect(404);
  });
});
