// tests/gen-pipeline-integration.test.js
// GenPipeline 完整管道 mock LLM 集成测试

const GenPipeline = require('../server/core/gen-pipeline');

function createMockLlm(responses) {
  let callIndex = 0;
  return {
    chatStreamingFull: jest.fn(() => {
      const resp = responses[callIndex] || {
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
        usage: {},
      };
      callIndex++;
      return Promise.resolve(resp);
    }),
  };
}

function createMockCodeGen(files) {
  return {
    parseFiles: jest.fn(() => files || {}),
  };
}

const GOOD_HTML = '<!DOCTYPE html><html><head><style>body{margin:0}h1{color:red}p{font-size:14px}div{padding:8px}</style></head><body><h1>Hello</h1><script>function init(){var x=1;}function render(){var y=2;}function update(){var z=3;}init();</script></body></html>';

describe('GenPipeline.startBrainstorm', () => {
  test('返回 LLM 回复和 infoSufficient 标志', async () => {
    const mockLlm = createMockLlm([{
      choices: [{ message: { content: '以下是分析...\n\nINFO_SUFFICIENT' }, finish_reason: 'stop' }],
      usage: {},
    }]);

    const pipeline = new GenPipeline(mockLlm, createMockCodeGen(), jest.fn());
    const result = await pipeline.startBrainstorm('{"name":"App","pages":[]}');

    expect(result.reply).toContain('分析');
    expect(result.infoSufficient).toBe(true);
  });

  test('信息不足时 infoSufficient 为 false', async () => {
    const mockLlm = createMockLlm([{
      choices: [{ message: { content: '请问你需要什么主题？' }, finish_reason: 'stop' }],
      usage: {},
    }]);

    const pipeline = new GenPipeline(mockLlm, createMockCodeGen(), jest.fn());
    const result = await pipeline.startBrainstorm('{"name":"App"}');
    expect(result.infoSufficient).toBe(false);
  });
});

describe('GenPipeline.continueBrainstorm', () => {
  test('传递历史并返回结果', async () => {
    const mockLlm = createMockLlm([{
      choices: [{ message: { content: '明白了，信息已足够。\nINFO_SUFFICIENT' }, finish_reason: 'stop' }],
      usage: {},
    }]);

    const pipeline = new GenPipeline(mockLlm, createMockCodeGen(), jest.fn());
    const result = await pipeline.continueBrainstorm('{"name":"App"}', [
      { role: 'user', content: '我想用深色主题' },
    ]);

    expect(result.infoSufficient).toBe(true);
    // 验证 LLM 被调用且消息包含系统提示+历史
    const callArgs = mockLlm.chatStreamingFull.mock.calls[0][0];
    expect(callArgs.length).toBeGreaterThanOrEqual(2);
  });
});

describe('GenPipeline.runGeneration', () => {
  const spec = {
    name: 'TestApp',
    version: '1.0',
    pages: [
      { name: 'index', file: 'index.html', title: '首页', elements: [], styles: { primaryColor: '#ff6600' } },
    ],
  };

  test('完整管道产生文件和步骤', async () => {
    const mockLlm = createMockLlm([
      // plan
      { choices: [{ message: { content: '## index.html 实现方案\n- Flexbox 布局' }, finish_reason: 'stop' }], usage: {} },
      // review
      { choices: [{ message: { content: 'REVIEW:::OK\n代码审核通过。' }, finish_reason: 'stop' }], usage: {} },
    ]);

    const mockCodeGen = createMockCodeGen({ 'index.html': GOOD_HTML });
    const onProgress = jest.fn();
    const pipeline = new GenPipeline(mockLlm, mockCodeGen, onProgress);

    const result = await pipeline.runGeneration(spec, '讨论摘要');

    expect(Object.keys(result.files)).toHaveLength(1);
    expect(result.files['index.html']).toBeDefined();
    expect(result.steps).toHaveLength(3);
    expect(result.steps.every(s => s.status === 'completed')).toBe(true);
    expect(onProgress).toHaveBeenCalled();
  });

  test('管道进度事件格式正确', async () => {
    const mockLlm = createMockLlm([
      { choices: [{ message: { content: 'plan text' }, finish_reason: 'stop' }], usage: {} },
      { choices: [{ message: { content: 'REVIEW:::OK\npass' }, finish_reason: 'stop' }], usage: {} },
    ]);

    const mockCodeGen = createMockCodeGen({ 'index.html': GOOD_HTML });
    const onProgress = jest.fn();

    const pipeline = new GenPipeline(mockLlm, mockCodeGen, onProgress);
    await pipeline.runGeneration(spec, '');

    for (const call of onProgress.mock.calls) {
      const event = call[0];
      expect(event).toHaveProperty('step');
      expect(event).toHaveProperty('stepIndex');
      expect(event).toHaveProperty('status');
      expect(event).toHaveProperty('timestamp');
      expect(typeof event.timestamp).toBe('number');
    }
  });

  test('无页面时兜底生成 index.html', async () => {
    const emptySpec = { name: 'Empty', pages: [] };
    const mockLlm = createMockLlm([
      { choices: [{ message: { content: 'plan' }, finish_reason: 'stop' }], usage: {} },
      { choices: [{ message: { content: 'REVIEW:::OK' }, finish_reason: 'stop' }], usage: {} },
    ]);

    const mockCodeGen = createMockCodeGen({ 'index.html': GOOD_HTML });
    const pipeline = new GenPipeline(mockLlm, mockCodeGen, jest.fn());

    const result = await pipeline.runGeneration(emptySpec, '');
    expect(Object.keys(result.files)).toHaveLength(1);
  });
});
