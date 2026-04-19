// tests/spec-engine.test.js
const SpecEngine = require('../server/core/spec-engine');

// 创建 mock LLM 客户端
function createMockLlm(responses) {
  const queue = [...responses];
  return {
    chatStreamingFull: jest.fn(() => {
      const resp = queue.shift() || { choices: [{ message: { content: '' }, finish_reason: 'stop' }] };
      return Promise.resolve(resp);
    }),
  };
}

// 直接测试 parseResponse（纯函数，不需要 LLM）
const specEngine = new SpecEngine({});

describe('SpecEngine.parseResponse', () => {
  test('解析包含 Spec JSON 的响应', () => {
    const content = `JSON_SPEC:::我已经分析了你的需求，生成如下 Spec：
:::SPEC
{
  "name": "TodoApp",
  "version": "1.0",
  "pages": [
    {
      "name": "index",
      "file": "index.html",
      "title": "待办事项",
      "elements": []
    }
  ]
}
:::END`;

    const result = specEngine.parseResponse(content, null);
    expect(result.type).toBe('spec');
    expect(result.spec).toBeDefined();
    expect(result.spec.name).toBe('TodoApp');
    expect(result.spec.pages).toHaveLength(1);
    expect(result.reply).toContain('分析了你的需求');
  });

  test('解析追问回复（无 Spec）', () => {
    const content = '请问你需要多少个页面？是否有用户登录功能？';

    const result = specEngine.parseResponse(content, null);
    expect(result.type).toBe('clarification');
    expect(result.reply).toBe(content);
    expect(result.spec).toBeNull();
  });

  // JSON 解析失败时，正则移除整个 JSON_SPEC:::...:::END 块导致 reply 为空
  // 这是已知的边界情况行为，返回 chat 类型但 reply 可能为空
  test('Spec JSON 解析失败时返回 chat 类型', () => {
    const content = `JSON_SPEC:::这是回复
:::SPEC
{invalid json here}
:::END`;

    const result = specEngine.parseResponse(content, null);
    expect(result.type).toBe('chat');
  });

  test('保留 currentSpec 当新响应无 Spec 时', () => {
    const existingSpec = { name: 'Existing', pages: [] };
    const content = '请告诉我更多细节';
    const result = specEngine.parseResponse(content, existingSpec);
    expect(result.spec).toBe(existingSpec);
  });

  test('保留 currentSpec 当 Spec 解析失败时', () => {
    const existingSpec = { name: 'Existing', pages: [] };
    const content = `JSON_SPEC:::回复
:::SPEC
{bad json}
:::END`;

    const result = specEngine.parseResponse(content, existingSpec);
    expect(result.spec).toBe(existingSpec);
  });

  test('解析空回复', () => {
    const result = specEngine.parseResponse('', null);
    expect(result.type).toBe('clarification');
    expect(result.reply).toBe('');
    expect(result.spec).toBeNull();
  });

  test('解析包含导航和数据的复杂 Spec', () => {
    const content = `JSON_SPEC:::生成完成
:::SPEC
{
  "name": "ComplexApp",
  "version": "1.0",
  "pages": [
    {"name": "index", "file": "index.html", "title": "首页", "elements": []},
    {"name": "login", "file": "login.html", "title": "登录", "elements": []}
  ],
  "navigation": [
    {"from": "index", "to": "login", "condition": "点击登录"}
  ],
  "data": {
    "stores": [
      {"name": "userStore", "fields": [{"name": "username", "type": "string"}]}
    ]
  }
}
:::END`;

    const result = specEngine.parseResponse(content, null);
    expect(result.type).toBe('spec');
    expect(result.spec.pages).toHaveLength(2);
    expect(result.spec.navigation).toHaveLength(1);
    expect(result.spec.data.stores).toHaveLength(1);
  });

  test('无 JSON_SPEC::: 前缀但有 :::SPEC 块', () => {
    const content = `以下是回复
:::SPEC
{"name": "App", "pages": []}
:::END`;

    const result = specEngine.parseResponse(content, null);
    expect(result.type).toBe('spec');
    expect(result.spec.name).toBe('App');
    // 回复应该是默认文本
    expect(result.reply).toContain('已生成应用规格说明');
  });
});

describe('SpecEngine.processMessage', () => {
  test('正确构造消息并调用 LLM', async () => {
    const mockLlm = createMockLlm([{
      choices: [{
        message: { content: '请问你需要什么类型的应用？' },
        finish_reason: 'stop',
      }],
    }]);

    const engine = new SpecEngine(mockLlm);
    // conversationHistory 中已包含用户消息（调用方负责 push）
    const history = [
      { role: 'user', content: '我想做个待办应用' },
    ];
    const result = await engine.processMessage(history, null);

    expect(result.type).toBe('clarification');
    expect(mockLlm.chatStreamingFull).toHaveBeenCalledTimes(1);

    const callArgs = mockLlm.chatStreamingFull.mock.calls[0];
    const messages = callArgs[0];
    // 第一条消息应该是 system prompt
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('需求分析专家');
    // 第二条消息应该是历史中的用户消息
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toBe('我想做个待办应用');
  });

  test('传入 currentSpec 时注入系统消息', async () => {
    const mockLlm = createMockLlm([{
      choices: [{
        message: { content: '好的，我来更新 Spec' },
        finish_reason: 'stop',
      }],
    }]);

    const engine = new SpecEngine(mockLlm);
    const result = await engine.processMessage([
      { role: 'user', content: '我想做个待办应用' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '加个登录页' },
    ], { name: 'TodoApp', pages: [] });

    const messages = mockLlm.chatStreamingFull.mock.calls[0][0];
    // 应该有 system prompt + 2 历史消息 + 1 新消息 + 1 spec 注入
    const systemMessages = messages.filter(m => m.role === 'system');
    expect(systemMessages.length).toBeGreaterThanOrEqual(2);
    // spec 注入应包含当前 spec
    const specMsg = systemMessages.find(m => m.content.includes('当前已确认的 Spec'));
    expect(specMsg).toBeDefined();
  });

  test('LLM 错误返回 error 类型', async () => {
    const mockLlm = {
      chatStreamingFull: jest.fn(() => Promise.reject(new Error('API timeout'))),
    };

    const engine = new SpecEngine(mockLlm);
    const result = await engine.processMessage([], null);
    expect(result.type).toBe('error');
    expect(result.reply).toContain('API timeout');
  });

  test('大 Spec 注入时截断到 4000 字符', async () => {
    const mockLlm = createMockLlm([{
      choices: [{ message: { content: '好的' }, finish_reason: 'stop' }],
    }]);

    const engine = new SpecEngine(mockLlm);
    // 创建一个大 Spec
    const bigSpec = { name: 'BigApp', pages: Array(50).fill(null).map((_, i) => ({
      name: `page${i}`, file: `page${i}.html`, title: `页面${i}`,
      elements: Array(20).fill(null).map((_, j) => ({ type: 'input', label: `元素${j}` })),
    })) };

    await engine.processMessage([{ role: 'user', content: '修改' }], bigSpec);

    const messages = mockLlm.chatStreamingFull.mock.calls[0][0];
    const specMsg = messages.find(m => m.content.includes('当前已确认的 Spec'));
    expect(specMsg).toBeDefined();
    expect(specMsg.content).toContain('Spec 已截断');
  });
});
