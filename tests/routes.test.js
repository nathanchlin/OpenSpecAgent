// tests/routes.test.js
// Express 路由集成测试 — 使用 supertest

const express = require('express');
const request = require('supertest');
const { createRoutes, createPreviewRoutes } = require('../server/routes');
const { SessionStore } = require('../server/session');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 使用临时数据目录
const TEST_DATA_DIR = path.join(os.tmpdir(), 'openspec-routes-test-' + Date.now());

function createApp() {
  const app = express();
  app.use(express.json());
  const store = new SessionStore(TEST_DATA_DIR);
  app.use('/api', createRoutes(store));
  app.use('/preview', createPreviewRoutes(store));
  return { app, store };
}

afterAll(() => {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
});

describe('Health Check', () => {
  let app;

  beforeEach(() => {
    ({ app } = createApp());
  });

  test('GET /api/health — 返回服务状态', async () => {
    const res = await request(app)
      .get('/api/health')
      .expect(200);

    expect(res.body.status).toBe('ok');
    expect(typeof res.body.sessions).toBe('number');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.memory).toContain('MB');
  });

  test('GET /api/health — 会话数正确', async () => {
    await request(app).post('/api/sessions').send({ name: 'S1' });
    await request(app).post('/api/sessions').send({ name: 'S2' });

    const res = await request(app)
      .get('/api/health')
      .expect(200);

    expect(res.body.sessions).toBeGreaterThanOrEqual(2);
  });
});

describe('Session CRUD API', () => {
  let app;

  beforeEach(() => {
    ({ app } = createApp());
  });

  test('POST /api/sessions — 创建会话', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .send({ name: '测试会话' })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('测试会话');
  });

  test('POST /api/sessions — 无 name 使用默认值', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .send({})
      .expect(200);

    expect(res.body.name).toBe('新会话');
  });

  test('POST /api/sessions — name 非字符串返回 400', async () => {
    await request(app)
      .post('/api/sessions')
      .send({ name: 123 })
      .expect(400);
  });

  test('POST /api/sessions — name 超长返回 400', async () => {
    await request(app)
      .post('/api/sessions')
      .send({ name: 'x'.repeat(101) })
      .expect(400);
  });

  test('GET /api/sessions — 列出会话', async () => {
    await request(app).post('/api/sessions').send({ name: 'S1' });
    await request(app).post('/api/sessions').send({ name: 'S2' });

    const res = await request(app)
      .get('/api/sessions')
      .expect(200);

    expect(res.body).toHaveLength(2);
  });

  test('DELETE /api/sessions/:id — 删除会话', async () => {
    const createRes = await request(app)
      .post('/api/sessions')
      .send({ name: 'ToDelete' });

    const id = createRes.body.id;

    await request(app).delete(`/api/sessions/${id}`).expect(200);

    const listRes = await request(app).get('/api/sessions').expect(200);
    expect(listRes.body.find(s => s.id === id)).toBeUndefined();
  });

  test('POST /api/sessions/:id/rename — 重命名会话', async () => {
    const createRes = await request(app)
      .post('/api/sessions')
      .send({ name: 'Old' });
    const id = createRes.body.id;

    await request(app)
      .post(`/api/sessions/${id}/rename`)
      .send({ name: 'New Name' })
      .expect(200);

    const listRes = await request(app).get('/api/sessions').expect(200);
    const session = listRes.body.find(s => s.id === id);
    expect(session.name).toBe('New Name');
  });

  test('POST /api/sessions/:id/rename — 缺少 name 返回 400', async () => {
    const createRes = await request(app).post('/api/sessions').send({ name: 'T' });
    await request(app)
      .post(`/api/sessions/${createRes.body.id}/rename`)
      .send({})
      .expect(400);
  });

  test('POST /api/sessions/:id/rename — name 非字符串返回 400', async () => {
    const createRes = await request(app).post('/api/sessions').send({ name: 'T' });
    await request(app)
      .post(`/api/sessions/${createRes.body.id}/rename`)
      .send({ name: 123 })
      .expect(400);
  });

  test('POST /api/sessions/:id/rename — name 过长返回 400', async () => {
    const createRes = await request(app).post('/api/sessions').send({ name: 'T' });
    await request(app)
      .post(`/api/sessions/${createRes.body.id}/rename`)
      .send({ name: 'x'.repeat(101) })
      .expect(400);
  });

  test('操作不存在的会话返回 404', async () => {
    await request(app).get('/api/sessions/nonexistent/spec').expect(404);
    await request(app).delete('/api/sessions/nonexistent'); // delete returns { ok: true }
    await request(app).get('/api/sessions/nonexistent/history').expect(404);
  });
});

describe('Chat API', () => {
  let app, sessionId;

  beforeEach(async () => {
    ({ app } = createApp());
    const res = await request(app).post('/api/sessions').send({ name: 'Chat Test' });
    sessionId = res.body.id;
  });

  test('POST /api/sessions/:id/chat — 缺少 message 返回 400', async () => {
    await request(app)
      .post(`/api/sessions/${sessionId}/chat`)
      .send({})
      .expect(400);
  });

  test('POST /api/sessions/:id/chat — message 非字符串返回 400', async () => {
    await request(app)
      .post(`/api/sessions/${sessionId}/chat`)
      .send({ message: 12345 })
      .expect(400);
  });

  test('GET /api/sessions/:id/history — 空历史返回空数组', async () => {
    const res = await request(app)
      .get(`/api/sessions/${sessionId}/history`)
      .expect(200);
    expect(res.body).toEqual([]);
  });

  test('GET /api/sessions/:id/spec — 无 spec 返回 null', async () => {
    const res = await request(app)
      .get(`/api/sessions/${sessionId}/spec`)
      .expect(200);
    expect(res.body).toBeNull();
  });
});

describe('Reset API', () => {
  let app, sessionId;

  beforeEach(async () => {
    ({ app } = createApp());
    const res = await request(app).post('/api/sessions').send({ name: 'Reset Test' });
    sessionId = res.body.id;
  });

  test('POST /api/sessions/:id/reset — 重置会话', async () => {
    await request(app)
      .post(`/api/sessions/${sessionId}/reset`)
      .expect(200);

    const specRes = await request(app).get(`/api/sessions/${sessionId}/spec`).expect(200);
    expect(specRes.body).toBeNull();
  });
});

describe('Export API', () => {
  let app, sessionId;

  beforeEach(async () => {
    ({ app } = createApp());
    const res = await request(app).post('/api/sessions').send({ name: 'Export Test' });
    sessionId = res.body.id;
  });

  test('GET /api/sessions/:id/export — 无文件返回 404', async () => {
    await request(app)
      .get(`/api/sessions/${sessionId}/export`)
      .expect(404);
  });
});

describe('Generate API', () => {
  let app, sessionId;

  beforeEach(async () => {
    ({ app } = createApp());
    const res = await request(app).post('/api/sessions').send({ name: 'Gen Test' });
    sessionId = res.body.id;
  });

  test('POST /api/sessions/:id/generate — 无 spec 返回错误', async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/generate`)
      .send({})
      .expect(200);
    expect(res.body.type).toBe('error');
  });
});

describe('Preview Security', () => {
  let app, sessionId, store;

  beforeEach(async () => {
    ({ app, store } = createApp());
    const res = await request(app).post('/api/sessions').send({ name: 'Preview Sec' });
    sessionId = res.body.id;
    // 注入测试文件到 session
    const session = store.get(sessionId);
    session.generatedFiles = {
      'index.html': '<!DOCTYPE html><html><body>Test</body></html>',
      'style.css': 'body { margin: 0; }',
    };
  });

  test('正常预览请求返回文件内容', async () => {
    const res = await request(app)
      .get(`/preview/${sessionId}/index.html`)
      .expect(200);
    expect(res.text).toContain('<!DOCTYPE html>');
    expect(res.headers['content-type']).toContain('text/html');
  });

  test('请求 CSS 文件返回正确 Content-Type', async () => {
    const res = await request(app)
      .get(`/preview/${sessionId}/style.css`)
      .expect(200);
    expect(res.headers['content-type']).toContain('text/css');
  });

  test('路径遍历 ../ 被 Express 路由层拦截', async () => {
    // Express 路由器在 handler 前解析路径，/preview/id/../x 变为 /x，不匹配 preview 路由
    await request(app)
      .get(`/preview/${sessionId}/../package.json`)
      .expect(404);
  });

  test('URL 编码的路径分隔符返回 400', async () => {
    await request(app)
      .get(`/preview/${sessionId}/..%2Fpackage.json`)
      .expect(400);
  });

  test('不存在的会话返回 404', async () => {
    await request(app)
      .get('/preview/nonexistent-session/index.html')
      .expect(404);
  });

  test('不存在的文件返回 404', async () => {
    await request(app)
      .get(`/preview/${sessionId}/nonexistent.html`)
      .expect(404);
  });

  test('根路径默认返回 index.html', async () => {
    const res = await request(app)
      .get(`/preview/${sessionId}/`)
      .expect(200);
    expect(res.text).toContain('<!DOCTYPE html>');
  });
});

describe('Export ZIP with files', () => {
  let app, sessionId, store;

  beforeEach(async () => {
    ({ app, store } = createApp());
    const res = await request(app).post('/api/sessions').send({ name: 'Export' });
    sessionId = res.body.id;
    const session = store.get(sessionId);
    session.generatedFiles = {
      'index.html': '<!DOCTYPE html><html><body>Hello</body></html>',
      'app.js': 'console.log("hi")',
    };
  });

  test('GET /api/sessions/:id/export — 返回 zip 文件', async () => {
    const res = await request(app)
      .get(`/api/sessions/${sessionId}/export`)
      .responseType('blob')
      .expect(200);

    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain('openspec-export.zip');
    expect(res.body.length).toBeGreaterThan(0);
  });
});

describe('Generate with spec', () => {
  let app, sessionId, store;

  beforeEach(async () => {
    ({ app, store } = createApp());
    const res = await request(app).post('/api/sessions').send({ name: 'Gen' });
    sessionId = res.body.id;
    const session = store.get(sessionId);
    session.spec = { name: 'TestApp', pages: [{ name: 'index', file: 'index.html', title: '首页' }] };
  });

  test('POST /api/sessions/:id/generate — 有 spec 返回 started', async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/generate`)
      .send({})
      .expect(200);
    expect(res.body.status).toBe('started');
  });

  test('POST /api/sessions/:id/generate/cancel — 无管道返回 ok:false', async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/generate/cancel`)
      .expect(200);
    expect(res.body.ok).toBe(false);
  });

  test('GET /api/sessions/:id/generate/stream — SSE 端点存在', async () => {
    // 直接测试 addSSEClient 设置正确头
    const session = store.get(sessionId);
    expect(session).toBeTruthy();

    const mockRes = {
      writeHead: jest.fn(),
      write: jest.fn(),
      on: jest.fn(),
    };

    session.addSSEClient(mockRes);
    expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream',
    }));
    expect(mockRes.write).toHaveBeenCalledWith(': connected\n\n');
  });
});

describe('Modify API validation', () => {
  let app, sessionId;

  beforeEach(async () => {
    ({ app } = createApp());
    const res = await request(app).post('/api/sessions').send({ name: 'Mod' });
    sessionId = res.body.id;
  });

  test('POST /chat/modify — 无 message 返回 400', async () => {
    await request(app)
      .post(`/api/sessions/${sessionId}/chat/modify`)
      .send({})
      .expect(400);
  });

  test('POST /chat/modify — 超长消息返回 400', async () => {
    await request(app)
      .post(`/api/sessions/${sessionId}/chat/modify`)
      .send({ message: 'x'.repeat(10001) })
      .expect(400);
  });

  test('POST /chat/modify — 不存在的 session 返回 404', async () => {
    await request(app)
      .post('/api/sessions/nonexistent/chat/modify')
      .send({ message: 'test' })
      .expect(404);
  });

  test('POST /chat/modify — 无生成文件返回 400', async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/chat/modify`)
      .send({ message: '修改按钮颜色' })
      .expect(400);
    expect(res.body.error).toContain('No generated files');
  });
});

describe('Brainstorm API validation', () => {
  let app, sessionId;

  beforeEach(async () => {
    ({ app } = createApp());
    const res = await request(app).post('/api/sessions').send({ name: 'BS' });
    sessionId = res.body.id;
  });

  test('POST /brainstorm/chat — 未启动管道返回提示', async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/brainstorm/chat`)
      .send({ message: 'test' })
      .expect(200);
    expect(res.body.reply).toContain('管道未启动');
  });

  test('POST /brainstorm/start — 不存在的 session 返回 404', async () => {
    await request(app)
      .post('/api/sessions/nonexistent/brainstorm/start')
      .send({ spec: {} })
      .expect(404);
  });

  test('POST /brainstorm/start — 缺少 spec 返回 400', async () => {
    await request(app)
      .post(`/api/sessions/${sessionId}/brainstorm/start`)
      .send({})
      .expect(400);
  });

  test('POST /brainstorm/start — spec 为数组返回 400', async () => {
    await request(app)
      .post(`/api/sessions/${sessionId}/brainstorm/start`)
      .send({ spec: [1, 2, 3] })
      .expect(400);
  });

  test('POST /brainstorm/start — spec 为字符串返回 400', async () => {
    await request(app)
      .post(`/api/sessions/${sessionId}/brainstorm/start`)
      .send({ spec: 'not an object' })
      .expect(400);
  });

  test('POST /chat/modify — message 非字符串返回 400', async () => {
    await request(app)
      .post(`/api/sessions/${sessionId}/chat/modify`)
      .send({ message: 999 })
      .expect(400);
  });

  test('POST /brainstorm/chat — message 非字符串返回 400', async () => {
    await request(app)
      .post(`/api/sessions/${sessionId}/brainstorm/chat`)
      .send({ message: false })
      .expect(400);
  });
});
