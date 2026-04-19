// tests/routes-llm.test.js
// 路由集成测试 — 需要 mock LLM 的端点（brainstorm, modify, chat spec 生成）

const express = require('express');
const request = require('supertest');
const { SessionStore } = require('../server/session');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_DATA_DIR = path.join(os.tmpdir(), 'openspec-llm-test-' + Date.now());

afterAll(() => {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
});

/**
 * 创建测试 app，可选择性地 mock LLM 响应
 */
function createApp(mockLlmResponses = {}) {
  const app = express();
  app.use(express.json());

  // Mock GLMClient 的 chatStreamingFull
  jest.resetModules();

  // 保存原始模块
  const originalGlmClient = require('../server/core/llm/glm-client');
  jest.doMock('../server/core/llm/glm-client', () => {
    return class MockGLMClient {
      constructor() {
        this.responses = mockLlmResponses;
      }
      async chatStreamingFull(messages, options) {
        const key = messages[messages.length - 1]?.content?.substring(0, 50) || 'default';
        const resp = this.responses[key] || this.responses['default'] || {
          choices: [{ message: { content: 'mock reply' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        };
        return resp;
      }
    };
  });

  // 重新加载依赖链
  const { createRoutes } = require('../server/routes');
  const store = new SessionStore(TEST_DATA_DIR);
  app.use('/api', createRoutes(store));

  return { app, store };
}

describe('Chat API with LLM mock', () => {
  let app, sessionId;

  beforeEach(async () => {
    ({ app } = createApp({
      'default': {
        choices: [{ message: { content: '请问你需要什么功能？' }, finish_reason: 'stop' }],
        usage: {},
      },
    }));
    const res = await request(app).post('/api/sessions').send({ name: 'LLM Test' });
    sessionId = res.body.id;
  }, 10000);

  afterEach(() => {
    jest.resetModules();
  });

  test('POST /chat — 正常对话返回 LLM 回复', async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/chat`)
      .send({ message: '我想做个待办应用' })
      .expect(200);

    expect(res.body.reply).toBeDefined();
    expect(res.body.type).toBeDefined();
  }, 10000);

  test('POST /chat — 超长消息返回 400', async () => {
    const longMsg = 'x'.repeat(10001);
    await request(app)
      .post(`/api/sessions/${sessionId}/chat`)
      .send({ message: longMsg })
      .expect(400);
  });

  test('POST /chat — 恰好 10000 字符不报错', async () => {
    const maxMsg = 'a'.repeat(10000);
    await request(app)
      .post(`/api/sessions/${sessionId}/chat`)
      .send({ message: maxMsg })
      .expect(200);
  }, 10000);

  test('POST /chat — 历史记录增长', async () => {
    await request(app)
      .post(`/api/sessions/${sessionId}/chat`)
      .send({ message: 'Hello' })
      .expect(200);

    const historyRes = await request(app)
      .get(`/api/sessions/${sessionId}/history`)
      .expect(200);

    expect(historyRes.body.length).toBeGreaterThanOrEqual(2);
  }, 10000);
});

describe('Chat/modify API input validation', () => {
  let app, sessionId;

  beforeEach(async () => {
    ({ app } = createApp());
    const res = await request(app).post('/api/sessions').send({ name: 'Modify Test' });
    sessionId = res.body.id;
  });

  afterEach(() => {
    jest.resetModules();
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

  test('POST /chat/modify — 无生成文件返回 400', async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/chat/modify`)
      .send({ message: '修改按钮颜色' })
      .expect(400);

    expect(res.body.error).toContain('No generated files');
  });
});

describe('Brainstorm API', () => {
  let app, sessionId;

  beforeEach(async () => {
    ({ app } = createApp({
      'default': {
        choices: [{ message: { content: 'INFO_SUFFICIENT\n以下是我的分析...' }, finish_reason: 'stop' }],
        usage: {},
      },
    }));
    const res = await request(app).post('/api/sessions').send({ name: 'BS Test' });
    sessionId = res.body.id;
  });

  afterEach(() => {
    jest.resetModules();
  });

  test('POST /brainstorm/start — 启动头脑风暴', async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/brainstorm/start`)
      .send({ spec: { name: 'App', pages: [] } })
      .expect(200);

    expect(res.body.reply).toBeDefined();
    // infoSufficient 取决于 LLM 回复是否包含 INFO_SUFFICIENT
    expect(typeof res.body.infoSufficient).toBe('boolean');
  });

  test('POST /brainstorm/chat — 无 message 返回 400', async () => {
    // 先启动 brainstorm
    await request(app)
      .post(`/api/sessions/${sessionId}/brainstorm/start`)
      .send({ spec: { name: 'App', pages: [] } });

    await request(app)
      .post(`/api/sessions/${sessionId}/brainstorm/chat`)
      .send({})
      .expect(400);
  });

  test('POST /brainstorm/chat — 超长消息返回 400', async () => {
    await request(app)
      .post(`/api/sessions/${sessionId}/brainstorm/start`)
      .send({ spec: { name: 'App', pages: [] } });

    await request(app)
      .post(`/api/sessions/${sessionId}/brainstorm/chat`)
      .send({ message: 'y'.repeat(10001) })
      .expect(400);
  });

  test('POST /brainstorm/chat — 非字符串 message 返回 400', async () => {
    await request(app)
      .post(`/api/sessions/${sessionId}/brainstorm/chat`)
      .send({ message: 123 })
      .expect(400);
  });

  test('POST /brainstorm/chat — 未启动管道返回提示', async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/brainstorm/chat`)
      .send({ message: 'test' })
      .expect(200);

    expect(res.body.reply).toContain('管道未启动');
  });
});

describe('Generate cancel API', () => {
  let app, sessionId;

  beforeEach(async () => {
    ({ app } = createApp());
    const res = await request(app).post('/api/sessions').send({ name: 'Cancel Test' });
    sessionId = res.body.id;
  });

  afterEach(() => {
    jest.resetModules();
  });

  test('POST /generate/cancel — 无活跃管道返回 ok: false', async () => {
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/generate/cancel`)
      .expect(200);

    expect(res.body.ok).toBe(false);
  });

  test('POST /generate/cancel — 有活跃管道返回 ok: true', async () => {
    // 模拟一个活跃 pipeline（先启动 generate 让 pipeline 被创建）
    const res = await request(app)
      .post(`/api/sessions/${sessionId}/generate`)
      .send({ spec: { name: 'Cancel', pages: [{ name: 'index', file: 'index.html', title: 'T' }] } });

    // generate 需要 spec 先存在，所以先设置 spec
    // 直接通过 session store 设置
    const store = require('../server/session').SessionStore
      ? undefined : undefined; // just reference for clarity

    // 使用 brainstorm/start 来创建 activePipeline
    // 先设置 spec
    const specRes = await request(app)
      .post(`/api/sessions/${sessionId}/brainstorm/start`)
      .send({ spec: { name: 'Cancel', pages: [{ name: 'index', file: 'index.html', title: 'T' }] } });

    // brainstorm/start 已经创建了 activePipeline
    const cancelRes = await request(app)
      .post(`/api/sessions/${sessionId}/generate/cancel`)
      .expect(200);

    expect(cancelRes.body.ok).toBe(true);
  });
});
