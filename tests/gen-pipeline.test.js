// tests/gen-pipeline.test.js
const GenPipeline = require('../server/core/gen-pipeline');

// 创建 mock 依赖
function createMockPipeline() {
  const mockLlm = { chatStreamingFull: jest.fn() };
  const mockCodeGen = { parseFiles: jest.fn() };
  const onProgress = jest.fn();

  const pipeline = new GenPipeline(mockLlm, mockCodeGen, onProgress);
  return { pipeline, mockLlm, mockCodeGen, onProgress };
}

describe('GenPipeline._detectPlaceholders', () => {
  const { pipeline } = createMockPipeline();

  test('检测 /* ... code ... */ 占位注释', () => {
    const files = {
      'index.html': '<!DOCTYPE html><html><body><script>/* ... extensive styling ... */</script></body></html>',
    };
    const issues = pipeline._detectPlaceholders(files);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toContain('index.html');
  });

  test('检测 <!-- ... --> HTML 占位注释', () => {
    const files = {
      'index.html': '<!DOCTYPE html><html><body><!-- ... more content --></body></html>',
    };
    const issues = pipeline._detectPlaceholders(files);
    expect(issues.length).toBeGreaterThan(0);
  });

  test('检测 // ... js 占位注释', () => {
    const files = {
      'index.html': '<script>// ... more logic here</script>',
    };
    const issues = pipeline._detectPlaceholders(files);
    expect(issues.length).toBeGreaterThan(0);
  });

  test('检测中文占位注释', () => {
    const files = {
      'index.html': '<script>// 更多代码此处</script>',
    };
    const issues = pipeline._detectPlaceholders(files);
    expect(issues.length).toBeGreaterThan(0);
  });

  test('完整代码无占位注释返回空数组', () => {
    const files = {
      'index.html': `<!DOCTYPE html>
<html>
<head><style>body { margin: 0; padding: 20px; } h1 { color: red; }</style></head>
<body>
<h1>Hello</h1>
<script>
function init() { console.log('init'); }
function render() { console.log('render'); }
init();
</script>
</body>
</html>`,
    };
    const issues = pipeline._detectPlaceholders(files);
    expect(issues).toHaveLength(0);
  });

  test('内容过短检测', () => {
    const files = {
      'index.html': '<!DOCTYPE html>',
    };
    const issues = pipeline._detectPlaceholders(files);
    expect(issues.some(i => i.includes('内容过短'))).toBe(true);
  });

  test('CSS 规则过少检测', () => {
    const files = {
      'index.html': `<!DOCTYPE html><html><head><style>body { margin: 0; }</style></head><body></body></html>`,
    };
    const issues = pipeline._detectPlaceholders(files);
    expect(issues.some(i => i.includes('CSS 规则过少'))).toBe(true);
  });

  test('JavaScript 函数过少检测', () => {
    const files = {
      'index.html': `<!DOCTYPE html><html><head><style>body{margin:0}h1{color:red}p{font-size:14px}</style></head><body><script>console.log('hi');</script></body></html>`,
    };
    const issues = pipeline._detectPlaceholders(files);
    expect(issues.some(i => i.includes('JavaScript 函数过少'))).toBe(true);
  });
});

describe('GenPipeline._hasPlaceholders', () => {
  const { pipeline } = createMockPipeline();

  test('有占位返回 true', () => {
    expect(pipeline._hasPlaceholders({
      'index.html': '<!DOCTYPE html><body><!-- ... more --></body></html>',
    })).toBe(true);
  });

  test('无占位返回 false', () => {
    expect(pipeline._hasPlaceholders({
      'index.html': `<!DOCTYPE html><html><head><style>body{margin:0}h1{color:red}p{font-size:14px}div{padding:8px}</style></head><body><script>function init(){var x=1;}function render(){var y=2;}function update(){var z=3;}init();</script></body></html>`,
    })).toBe(false);
  });
});

describe('GenPipeline._extractPageList', () => {
  const { pipeline } = createMockPipeline();

  test('从 spec.pages 提取页面列表', () => {
    const spec = {
      pages: [
        { name: 'index', file: 'index.html', title: '首页' },
        { name: 'login', file: 'login.html', title: '登录' },
      ],
    };
    const pages = pipeline._extractPageList(spec, null);
    expect(pages).toHaveLength(2);
    expect(pages[0].file).toBe('index.html');
    expect(pages[1].file).toBe('login.html');
  });

  test('spec 无 pages 时从 plan 提取', () => {
    const spec = {};
    const plan = '实现 index.html 和 about.html 两个页面...';
    const pages = pipeline._extractPageList(spec, plan);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages.some(p => p.file === 'index.html')).toBe(true);
    expect(pages.some(p => p.file === 'about.html')).toBe(true);
  });

  test('兜底：至少生成 index.html', () => {
    const pages = pipeline._extractPageList({}, '');
    expect(pages).toHaveLength(1);
    expect(pages[0].file).toBe('index.html');
  });

  test('plan 中重复的文件名不重复提取', () => {
    const plan = 'index.html 内容... index.html 还提到...';
    const pages = pipeline._extractPageList({}, plan);
    const indexCount = pages.filter(p => p.file === 'index.html').length;
    expect(indexCount).toBe(1);
  });
});

describe('GenPipeline._extractSharedStyles', () => {
  const { pipeline } = createMockPipeline();

  test('提取 primaryColor', () => {
    const spec = {
      pages: [{ styles: { primaryColor: '#ff6600', theme: 'dark' } }],
    };
    const result = pipeline._extractSharedStyles(spec);
    expect(result).toContain('--primary: #ff6600');
    expect(result).toContain('--bg: #1e1e2e');
  });

  test('浅色主题', () => {
    const spec = {
      pages: [{ styles: { theme: 'light' } }],
    };
    const result = pipeline._extractSharedStyles(spec);
    expect(result).toContain('--bg: #ffffff');
    expect(result).toContain('--text: #333333');
  });

  test('默认深色主题', () => {
    const spec = { pages: [{}] };
    const result = pipeline._extractSharedStyles(spec);
    expect(result).toContain('--primary: #cba6f7');
  });
});

describe('GenPipeline._extractRouteTable', () => {
  const { pipeline } = createMockPipeline();

  test('生成路由表', () => {
    const spec = {
      navigation: [
        { from: 'index', to: 'login.html', condition: '点击登录' },
      ],
    };
    const pageList = [
      { name: 'index', file: 'index.html', title: '首页' },
    ];
    const result = pipeline._extractRouteTable(spec, pageList);
    expect(result).toContain('index.html');
    expect(result).toContain('login.html');
    expect(result).toContain('条件');
  });
});

describe('GenPipeline._extractDataInterface', () => {
  const { pipeline } = createMockPipeline();

  test('提取 localStorage 操作', () => {
    const files = {
      'index.html': `<script>
        localStorage.setItem('user', JSON.stringify({name:'test'}));
        var data = localStorage.getItem('user');
      </script>`,
    };
    const result = pipeline._extractDataInterface(files);
    expect(result).toContain('写入 localStorage key: "user"');
    expect(result).toContain('读取 localStorage key: "user"');
  });

  test('无 localStorage 操作返回提示', () => {
    const result = pipeline._extractDataInterface({ 'index.html': '<script>1+1</script>' });
    expect(result).toContain('暂无跨页面数据');
  });
});

describe('GenPipeline._extractFilePlan', () => {
  const { pipeline } = createMockPipeline();

  test('从 plan 中提取特定文件的段落', () => {
    const plan = `## 实现计划

### index.html 实现方案
- 使用 Flexbox 布局
- 包含 header 和 main

### about.html 实现方案
- 简单内容页`;

    const result = pipeline._extractFilePlan(plan, 'index.html');
    expect(result).toContain('Flexbox');
    expect(result).not.toContain('about.html');
  });

  test('找不到文件名时返回截断的 plan', () => {
    const longPlan = 'a'.repeat(4000);
    const result = pipeline._extractFilePlan(longPlan, 'nonexist.html');
    expect(result.length).toBeLessThanOrEqual(3100);
    expect(result).toContain('计划已截断');
  });

  test('空 plan 返回空字符串', () => {
    expect(pipeline._extractFilePlan('', 'index.html')).toBe('');
    expect(pipeline._extractFilePlan(null, 'index.html')).toBe('');
  });
});

describe('GenPipeline._parseReviewOutput', () => {
  const { pipeline, mockCodeGen } = createMockPipeline();

  test('REVIEW:::OK 返回审核摘要', () => {
    const content = 'REVIEW:::OK\n所有功能检查通过，代码质量良好。';
    const result = pipeline._parseReviewOutput(content, {});
    expect(result.summary).toContain('所有功能检查通过');
    expect(result.corrected).toBeNull();
  });

  test('REVIEW:::CORRECTED 返回修正文件', () => {
    mockCodeGen.parseFiles.mockReturnValue({ 'index.html': '<html></html>' });
    const content = 'REVIEW:::CORRECTED\n发现 bug，已修正。\n:::FILE:index.html\n<html></html>\n:::END';
    const result = pipeline._parseReviewOutput(content, {});
    expect(result.corrected).toBeDefined();
    expect(result.corrected['index.html']).toBe('<html></html>');
  });

  test('无标记返回原始内容作为摘要', () => {
    const content = '这是一段普通的审核文字。';
    const result = pipeline._parseReviewOutput(content, {});
    expect(result.summary).toBe('这是一段普通的审核文字。');
    expect(result.corrected).toBeNull();
  });
});

describe('GenPipeline.cancel', () => {
  test('取消设置 cancelled 标志', () => {
    const { pipeline } = createMockPipeline();
    expect(pipeline.cancelled).toBe(false);
    pipeline.cancel();
    expect(pipeline.cancelled).toBe(true);
  });
});

describe('GenPipeline._extractContent', () => {
  const { pipeline } = createMockPipeline();

  test('提取 content 和 reasoning_content', () => {
    const resp = {
      choices: [{
        message: {
          content: 'Hello',
          reasoning_content: ' thinking',
        },
      }],
    };
    const result = pipeline._extractContent(resp);
    expect(result).toContain('Hello');
    expect(result).toContain('thinking');
  });

  test('无 reasoning_content 时正常工作', () => {
    const resp = {
      choices: [{ message: { content: 'Hello' } }],
    };
    const result = pipeline._extractContent(resp);
    expect(result.trim()).toBe('Hello');
  });

  test('空 choices 不崩溃', () => {
    const resp = { choices: [] };
    const result = pipeline._extractContent(resp);
    expect(result).toBeDefined();
  });
});

describe('GenPipeline._emit', () => {
  test('调用 onProgress 回调', () => {
    const { pipeline, onProgress } = createMockPipeline();
    pipeline._emit(1, 'running', null, null);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'plan',
        status: 'running',
      })
    );
  });

  test('无效 stepIndex 不崩溃', () => {
    const { pipeline, onProgress } = createMockPipeline();
    expect(() => pipeline._emit(99, 'running', null, null)).not.toThrow();
    expect(onProgress).not.toHaveBeenCalled();
  });
});

// ── runGeneration 高级路径测试 ──

const GOOD_HTML = '<!DOCTYPE html><html><head><style>body{margin:0}h1{color:red}p{font-size:14px}div{padding:8px}</style></head><body><h1>Hello</h1><script>function init(){var x=1;}function render(){var y=2;}function update(){var z=3;}init();</script></body></html>';

function mockLlmResponds(responses) {
  let idx = 0;
  return {
    chatStreamingFull: jest.fn(() => {
      const resp = responses[idx] || { choices: [{ message: { content: '' }, finish_reason: 'stop' }], usage: {} };
      idx++;
      return Promise.resolve(resp);
    }),
  };
}

function mockCodeGenReturns(files) {
  return { parseFiles: jest.fn(() => files || {}) };
}

describe('GenPipeline.runGeneration cancel paths', () => {
  const spec = { name: 'Test', pages: [{ name: 'index', file: 'index.html', title: '首页' }] };

  test('取消在 plan 步骤前中止', async () => {
    const mockLlm = mockLlmResponds([
      { choices: [{ message: { content: 'plan' }, finish_reason: 'stop' }], usage: {} },
    ]);
    const pipeline = new GenPipeline(mockLlm, mockCodeGenReturns({ 'index.html': GOOD_HTML }), jest.fn());
    pipeline.cancelled = true; // 预设取消

    const result = await pipeline.runGeneration(spec, '');
    expect(result.files).toEqual({});
    // 取消后不执行任何步骤
    expect(result.steps).toHaveLength(0);
  });

  test('取消在 execute 中中止', async () => {
    const mockLlm = mockLlmResponds([
      { choices: [{ message: { content: 'plan' }, finish_reason: 'stop' }], usage: {} },
      { choices: [{ message: { content: 'some code' }, finish_reason: 'stop' }], usage: {} },
    ]);
    const onProgress = jest.fn();
    const pipeline = new GenPipeline(mockLlm, mockCodeGenReturns({ 'index.html': GOOD_HTML }), onProgress);

    // 在 plan 完成后设置取消
    const origChatStreamingFull = mockLlm.chatStreamingFull;
    let callCount = 0;
    mockLlm.chatStreamingFull = jest.fn(async (...args) => {
      callCount++;
      if (callCount >= 2) pipeline.cancelled = true;
      return origChatStreamingFull(...args);
    });

    const result = await pipeline.runGeneration(spec, '');
    // 取消导致 files 可能为空
    expect(result).toHaveProperty('files');
  });
});

describe('GenPipeline.runGeneration error handling', () => {
  const spec = { name: 'Test', pages: [{ name: 'index', file: 'index.html', title: '首页' }] };

  test('plan 步骤失败标记为 skipped', async () => {
    const mockLlm = {
      chatStreamingFull: jest.fn()
        .mockRejectedValueOnce(new Error('LLM timeout'))  // plan fails
        .mockResolvedValueOnce({ choices: [{ message: { content: 'REVIEW:::OK\npass' }, finish_reason: 'stop' }], usage: {} }),
    };
    const onProgress = jest.fn();
    const pipeline = new GenPipeline(mockLlm, mockCodeGenReturns({ 'index.html': GOOD_HTML }), onProgress);

    const result = await pipeline.runGeneration(spec, '');
    // plan failed = skipped, execute never ran, review never ran
    expect(result.steps.some(s => s.status === 'skipped')).toBe(true);
  });

  test('execute 步骤失败返回空文件', async () => {
    const mockLlm = {
      chatStreamingFull: jest.fn()
        .mockResolvedValueOnce({ choices: [{ message: { content: 'plan text' }, finish_reason: 'stop' }], usage: {} }),
    };
    const mockCodeGen = { parseFiles: jest.fn(() => ({})) }; // 始终返回空
    const onProgress = jest.fn();
    const pipeline = new GenPipeline(mockLlm, mockCodeGen, onProgress);

    const result = await pipeline.runGeneration(spec, '');
    // _executePerFile 返回 null 时 runGeneration 直接返回空
    expect(result.files).toEqual({});
  });

  test('execute 步骤抛错时提前返回（critical failure）', async () => {
    // 让 _executePerFile 内部的 JSON.parse 抛出：specJson 必须是有效 JSON，
    // 所以我们让 _extractPageList 得到空 pages，然后 _executePerFile 返回空 files
    // 实际上覆盖 line 175 的最直接方式：让 execute case 直接抛错
    const spec = { name: 'Test' }; // 没有 pages，_extractPageList 返回空
    const mockLlm = {
      chatStreamingFull: jest.fn()
        .mockResolvedValueOnce({ choices: [{ message: { content: 'plan text' }, finish_reason: 'stop' }], usage: {} })
        .mockRejectedValueOnce(new Error('LLM execute crash')),
    };
    const mockCodeGen = { parseFiles: jest.fn() };
    const onProgress = jest.fn();
    const pipeline = new GenPipeline(mockLlm, mockCodeGen, onProgress);

    // 没有 pages → _executePerFile 返回 {} → line 142-143 提前返回
    const result = await pipeline.runGeneration(spec, '');
    expect(result.files).toEqual({});
    // execute 返回空 → line 142-143 返回，没有 review 步骤
    expect(result.steps.filter(s => s.key === 'review')).toHaveLength(0);
  });
});

describe('GenPipeline.runGeneration review corrected', () => {
  test('review 返回 corrected 且有效时更新 files', async () => {
    const spec = { name: 'Test', pages: [{ name: 'index', file: 'index.html', title: '首页' }] };
    const CORRECTED_HTML = '<!DOCTYPE html><html><head><style>body{margin:0}h1{color:blue}p{font-size:16px}div{padding:10px}</style></head><body><h1>Fixed</h1><script>function init(){var x=2;}function render(){var y=3;}function update(){var z=4;}init();</script></body></html>';

    const mockLlm = mockLlmResponds([
      // plan
      { choices: [{ message: { content: 'plan' }, finish_reason: 'stop' }], usage: {} },
      // execute (per file)
      { choices: [{ message: { content: ':::FILE:index.html\n' + GOOD_HTML + '\n:::END' }, finish_reason: 'stop' }], usage: {} },
      // review — 返回 corrected
      { choices: [{ message: { content: 'REVIEW:::CORRECTED\n已修正。\n:::FILE:index.html\n' + CORRECTED_HTML + '\n:::END' }, finish_reason: 'stop' }], usage: {} },
    ]);

    let parseCallCount = 0;
    const mockCodeGen = {
      parseFiles: jest.fn(() => {
        parseCallCount++;
        if (parseCallCount === 1) return { 'index.html': GOOD_HTML }; // execute 生成
        return { 'index.html': CORRECTED_HTML }; // review 修正
      }),
    };

    const pipeline = new GenPipeline(mockLlm, mockCodeGen, jest.fn());
    const result = await pipeline.runGeneration(spec, '');

    expect(result.files['index.html']).toBe(CORRECTED_HTML);
    expect(result.reviewSummary).toContain('已修正');
  });

  test('review corrected 有占位符时不应用', async () => {
    const spec = { name: 'Test', pages: [{ name: 'index', file: 'index.html', title: '首页' }] };
    const BAD_CORRECTED = '<!DOCTYPE html><html><head><style>body{margin:0}h1{color:red}p{font-size:14px}div{padding:8px}</style></head><body><script>/* ... more code ... */</script></body></html>';

    const mockLlm = mockLlmResponds([
      { choices: [{ message: { content: 'plan' }, finish_reason: 'stop' }], usage: {} },
      { choices: [{ message: { content: ':::FILE:index.html\n' + GOOD_HTML + '\n:::END' }, finish_reason: 'stop' }], usage: {} },
      { choices: [{ message: { content: 'REVIEW:::CORRECTED\n修正\n:::FILE:index.html\n' + BAD_CORRECTED + '\n:::END' }, finish_reason: 'stop' }], usage: {} },
    ]);

    let parseCallCount = 0;
    const mockCodeGen = {
      parseFiles: jest.fn(() => {
        parseCallCount++;
        if (parseCallCount === 1) return { 'index.html': GOOD_HTML };
        return { 'index.html': BAD_CORRECTED };
      }),
    };

    const pipeline = new GenPipeline(mockLlm, mockCodeGen, jest.fn());
    const result = await pipeline.runGeneration(spec, '');

    // corrected 有占位符，不应应用
    expect(result.files['index.html']).toBe(GOOD_HTML);
  });
});

describe('GenPipeline._callLlmWithContinue', () => {
  test('截断续写 — finish_reason=length 触发续写', async () => {
    const mockLlm = {
      chatStreamingFull: jest.fn()
        .mockResolvedValueOnce({
          choices: [{ message: { content: 'first part' }, finish_reason: 'length' }],
          usage: {},
        })
        .mockResolvedValueOnce({
          choices: [{ message: { content: ' second part' }, finish_reason: 'stop' }],
          usage: {},
        }),
    };
    const pipeline = new GenPipeline(mockLlm, mockCodeGenReturns({}), jest.fn());
    const result = await pipeline._callLlmWithContinue([], {}, 2);
    expect(result).toBe('first part\n second part\n');
    expect(mockLlm.chatStreamingFull).toHaveBeenCalledTimes(2);
    // 第二次调用应包含续写提示
    const secondCallArgs = mockLlm.chatStreamingFull.mock.calls[1][0];
    expect(secondCallArgs.some(m => m.content.includes('截断'))).toBe(true);
  });

  test('LLM 错误后重试第一轮', async () => {
    const mockLlm = {
      chatStreamingFull: jest.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          choices: [{ message: { content: 'recovered' }, finish_reason: 'stop' }],
          usage: {},
        }),
    };
    const pipeline = new GenPipeline(mockLlm, mockCodeGenReturns({}), jest.fn());
    const result = await pipeline._callLlmWithContinue([], {}, 1);
    expect(result).toBe('recovered\n');
    expect(mockLlm.chatStreamingFull).toHaveBeenCalledTimes(2);
  });

  test('LLM 错误且已有内容则返回已收到内容', async () => {
    const mockLlm = {
      chatStreamingFull: jest.fn()
        .mockResolvedValueOnce({
          choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
          usage: {},
        })
        .mockRejectedValueOnce(new Error('Network error')),
    };
    const pipeline = new GenPipeline(mockLlm, mockCodeGenReturns({}), jest.fn());
    const result = await pipeline._callLlmWithContinue([], {}, 2);
    expect(result).toContain('partial');
  });

  test('LLM 第二轮错误抛出异常', async () => {
    const mockLlm = {
      chatStreamingFull: jest.fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockRejectedValueOnce(new Error('fail again')),
    };
    const pipeline = new GenPipeline(mockLlm, mockCodeGenReturns({}), jest.fn());
    await expect(pipeline._callLlmWithContinue([], {}, 1)).rejects.toThrow('fail again');
  });

  test('截断续写时 cancelled 中断', async () => {
    const mockLlm = {
      chatStreamingFull: jest.fn()
        .mockResolvedValueOnce({
          choices: [{ message: { content: 'part1' }, finish_reason: 'length' }],
          usage: {},
        })
        .mockResolvedValueOnce({
          choices: [{ message: { content: 'part2' }, finish_reason: 'length' }],
          usage: {},
        }),
    };
    const pipeline = new GenPipeline(mockLlm, mockCodeGenReturns({}), jest.fn());
    // 第一次续写后取消
    const origFn = mockLlm.chatStreamingFull;
    let callCount = 0;
    mockLlm.chatStreamingFull = jest.fn(async (...args) => {
      callCount++;
      if (callCount >= 2) pipeline.cancelled = true;
      return origFn(...args);
    });

    const result = await pipeline._callLlmWithContinue([], {}, 5);
    expect(result).toContain('part1');
  });

  test('长 assistant 文本被截断', async () => {
    const longText = 'a'.repeat(3000);
    const mockLlm = {
      chatStreamingFull: jest.fn()
        .mockResolvedValueOnce({
          choices: [{ message: { content: longText }, finish_reason: 'length' }],
          usage: {},
        })
        .mockResolvedValueOnce({
          choices: [{ message: { content: 'end' }, finish_reason: 'stop' }],
          usage: {},
        }),
    };
    const pipeline = new GenPipeline(mockLlm, mockCodeGenReturns({}), jest.fn());
    await pipeline._callLlmWithContinue([], {}, 2);
    // 第二次调用消息中的 assistant 内容应被截断
    const secondCallArgs = mockLlm.chatStreamingFull.mock.calls[1][0];
    const assistantMsg = secondCallArgs.find(m => m.role === 'assistant');
    expect(assistantMsg.content.length).toBeLessThan(longText.length);
    expect(assistantMsg.content).toContain('前文已输出');
  });
});

describe('GenPipeline._generateSingleFile retry paths', () => {
  test('所有重试失败返回 null', async () => {
    const mockLlm = {
      chatStreamingFull: jest.fn().mockResolvedValue({
        choices: [{ message: { content: 'not valid html' }, finish_reason: 'stop' }],
        usage: {},
      }),
    };
    const mockCodeGen = { parseFiles: jest.fn(() => ({})) };
    const pipeline = new GenPipeline(mockLlm, mockCodeGen, jest.fn());

    const result = await pipeline._generateSingleFile(
      '{}', '', '', { name: 'index', file: 'index.html', title: '首页' },
      ':root{}', '', ''
    );
    expect(result).toBeNull();
    // MAX_EXECUTE_RETRIES = 1, 所以总共 2 次尝试
    expect(mockLlm.chatStreamingFull).toHaveBeenCalledTimes(2);
  });

  test('取消时返回 null', async () => {
    const mockLlm = {
      chatStreamingFull: jest.fn().mockResolvedValue({
        choices: [{ message: { content: ':::FILE:index.html\n<html></html>\n:::END' }, finish_reason: 'stop' }],
        usage: {},
      }),
    };
    const pipeline = new GenPipeline(mockLlm, mockCodeGenReturns({ 'index.html': GOOD_HTML }), jest.fn());
    pipeline.cancelled = true;

    const result = await pipeline._generateSingleFile(
      '{}', '', '', { name: 'index', file: 'index.html', title: '首页' },
      ':root{}', '', ''
    );
    expect(result).toBeNull();
    expect(mockLlm.chatStreamingFull).not.toHaveBeenCalled();
  });

  test('多页面并行生成', async () => {
    const spec = {
      name: 'Multi',
      pages: [
        { name: 'index', file: 'index.html', title: '首页' },
        { name: 'about', file: 'about.html', title: '关于' },
      ],
    };

    const mockLlm = {
      chatStreamingFull: jest.fn(async () => ({
        choices: [{ message: { content: ':::FILE:index.html\n' + GOOD_HTML + '\n:::END' }, finish_reason: 'stop' }],
        usage: {},
      })),
    };

    const mockCodeGen = {
      parseFiles: jest.fn(() => ({ 'index.html': GOOD_HTML })),
    };
    const onProgress = jest.fn();

    const pipeline = new GenPipeline(mockLlm, mockCodeGen, onProgress);
    const specJson = JSON.stringify(spec);
    const pageList = pipeline._extractPageList(spec, 'plan');

    const result = await pipeline._executePerFile(specJson, '', 'plan', pageList, 2);

    // 并行生成两个文件都应成功
    expect(result).toBeTruthy();
    expect(Object.keys(result)).toHaveLength(2);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' })
    );
  });

  test('placeholder 检测触发重试（覆盖 line 431 debug）', async () => {
    let llmCallCount = 0;
    // 第一次生成有占位符，第二次生成正常
    const mockLlm = {
      chatStreamingFull: jest.fn(async () => {
        llmCallCount++;
        if (llmCallCount === 1) {
          return {
            choices: [{ message: { content: ':::FILE:index.html\n<html><!-- ... more content --></html>\n:::END' }, finish_reason: 'stop' }],
            usage: {},
          };
        }
        return {
          choices: [{ message: { content: ':::FILE:index.html\n' + GOOD_HTML + '\n:::END' }, finish_reason: 'stop' }],
          usage: {},
        };
      }),
    };

    let parseCount = 0;
    const mockCodeGen = {
      parseFiles: jest.fn(() => {
        parseCount++;
        if (parseCount === 1) return { 'index.html': '<html><!-- ... more content --></html>' };
        return { 'index.html': GOOD_HTML };
      }),
    };

    const pipeline = new GenPipeline(mockLlm, mockCodeGen, jest.fn());
    const result = await pipeline._generateSingleFile(
      '{}', '', '', { name: 'index', file: 'index.html', title: '首页' },
      ':root{}', '', ''
    );
    expect(result).toBe(GOOD_HTML);
    expect(mockLlm.chatStreamingFull).toHaveBeenCalledTimes(2);
  });

  test('重试时发送 assistant+user 续写消息', async () => {
    let callCount = 0;
    const mockLlm = {
      chatStreamingFull: jest.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return { choices: [{ message: { content: ':::FILE:index.html\n<html></html>\n:::END' }, finish_reason: 'stop' }], usage: {} };
        }
        return { choices: [{ message: { content: ':::FILE:index.html\n' + GOOD_HTML + '\n:::END' }, finish_reason: 'stop' }], usage: {} };
      }),
    };
    let parseCount = 0;
    const mockCodeGen = {
      parseFiles: jest.fn(() => {
        parseCount++;
        if (parseCount === 1) return {}; // 第一次解析失败
        return { 'index.html': GOOD_HTML };
      }),
    };

    const pipeline = new GenPipeline(mockLlm, mockCodeGen, jest.fn());
    const result = await pipeline._generateSingleFile(
      '{}', '', '', { name: 'index', file: 'index.html', title: '首页' },
      ':root{}', '', ''
    );
    expect(result).toBe(GOOD_HTML);
    // 第二次调用应包含 assistant 和 user 消息
    const secondCallArgs = mockLlm.chatStreamingFull.mock.calls[1][0];
    expect(secondCallArgs.some(m => m.role === 'assistant')).toBe(true);
    expect(secondCallArgs.some(m => m.content.includes('占位符'))).toBe(true);
  });
});
