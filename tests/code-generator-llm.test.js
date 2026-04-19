// tests/code-generator-llm.test.js
// CodeGenerator 的 LLM mock 集成测试

const CodeGenerator = require('../server/core/code-generator');

function createMockLlm(responses) {
  const queue = [...responses];
  return {
    chatStreamingFull: jest.fn(() => {
      const resp = queue.shift() || {
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
        usage: {},
      };
      return Promise.resolve(resp);
    }),
  };
}

describe('CodeGenerator.generate', () => {
  test('成功生成返回文件映射', async () => {
    const mockLlm = createMockLlm([{
      choices: [{
        message: {
          content: '以下是生成的代码\n\n:::FILE:index.html\n<!DOCTYPE html><html><body>Hello</body></html>\n:::END\n\n:::FILE:style.css\nbody { margin: 0; }\n:::END',
        },
        finish_reason: 'stop',
      }],
      usage: {},
    }]);

    const gen = new CodeGenerator(mockLlm);
    const files = await gen.generate({ name: 'TestApp', pages: [{ name: 'index', file: 'index.html' }] });

    expect(Object.keys(files)).toHaveLength(2);
    expect(files['index.html']).toContain('<!DOCTYPE html>');
    expect(files['style.css']).toContain('margin: 0');
  });

  test('LLM 无输出返回空对象', async () => {
    const mockLlm = createMockLlm([{
      choices: [{ message: { content: '抱歉，我无法生成代码。' }, finish_reason: 'stop' }],
      usage: {},
    }]);

    const gen = new CodeGenerator(mockLlm);
    const files = await gen.generate({ name: 'App' });
    expect(Object.keys(files)).toHaveLength(0);
  });

  test('首次无 FILE 标记时自动重试', async () => {
    const mockLlm = createMockLlm([
      // 第一次：无标记
      { choices: [{ message: { content: '这是代码但没有标记' }, finish_reason: 'stop' }], usage: {} },
      // 第二次：有标记
      { choices: [{
        message: { content: ':::FILE:index.html\n<!DOCTYPE html><html><body>Retry OK</body></html>\n:::END' },
        finish_reason: 'stop',
      }], usage: {} },
    ]);

    const gen = new CodeGenerator(mockLlm);
    const files = await gen.generate({ name: 'App' });
    expect(mockLlm.chatStreamingFull).toHaveBeenCalledTimes(2);
    expect(files['index.html']).toContain('Retry OK');
  });

  test('重试耗尽返回空对象', async () => {
    const mockLlm = createMockLlm([
      { choices: [{ message: { content: 'no markers 1' }, finish_reason: 'stop' }], usage: {} },
      { choices: [{ message: { content: 'no markers 2' }, finish_reason: 'stop' }], usage: {} },
      { choices: [{ message: { content: 'no markers 3' }, finish_reason: 'stop' }], usage: {} },
    ]);

    const gen = new CodeGenerator(mockLlm);
    const files = await gen.generate({ name: 'App' });
    expect(Object.keys(files)).toHaveLength(0);
    expect(mockLlm.chatStreamingFull).toHaveBeenCalledTimes(3);
  });
});

describe('CodeGenerator.modify', () => {
  test('修改已有文件并合并', async () => {
    const mockLlm = createMockLlm([{
      choices: [{
        message: {
          content: 'MODIFY:::已修改标题\n:::FILES\n:::FILE:index.html\n<!DOCTYPE html><html><body>New Title</body></html>\n:::END\n:::ENDFILES',
        },
        finish_reason: 'stop',
      }],
      usage: {},
    }]);

    const gen = new CodeGenerator(mockLlm);
    const currentFiles = { 'index.html': '<!DOCTYPE html><html><body>Old Title</body></html>' };

    const result = await gen.modify('修改标题', { name: 'App' }, currentFiles, []);

    expect(result.reply).toContain('已修改标题');
    expect(result.files['index.html']).toContain('New Title');
  });

  test('修改时新增文件', async () => {
    const mockLlm = createMockLlm([{
      choices: [{
        message: {
          content: 'MODIFY:::新增页面\n:::FILES\n:::FILE:about.html\n<!DOCTYPE html><html><body>About</body></html>\n:::END\n:::ENDFILES',
        },
        finish_reason: 'stop',
      }],
      usage: {},
    }]);

    const gen = new CodeGenerator(mockLlm);
    const currentFiles = { 'index.html': '<html></html>' };

    const result = await gen.modify('添加关于页面', { name: 'App' }, currentFiles, []);
    expect(result.files['index.html']).toBeDefined();
    expect(result.files['about.html']).toContain('About');
  });

  test('LLM 无修改输出返回原文件', async () => {
    const mockLlm = createMockLlm([{
      choices: [{ message: { content: '没有需要修改的内容' }, finish_reason: 'stop' }],
      usage: {},
    }]);

    const gen = new CodeGenerator(mockLlm);
    const currentFiles = { 'index.html': '<html>original</html>' };
    const result = await gen.modify('改下颜色', { name: 'App' }, currentFiles, []);

    // 没有新文件，merged 保持原样
    expect(result.files['index.html']).toBe('<html>original</html>');
  });

  test('长文件在 modify 请求中被截断', async () => {
    let capturedMessage = '';
    const mockLlm = {
      chatStreamingFull: jest.fn(async (messages) => {
        capturedMessage = messages[1].content;
        return {
          choices: [{ message: { content: 'MODIFY:::ok\n:::FILES\n:::FILE:big.html\n<html>new</html>\n:::END\n:::ENDFILES' }, finish_reason: 'stop' }],
          usage: {},
        };
      }),
    };

    const gen = new CodeGenerator(mockLlm);
    const bigContent = '<html>' + 'x'.repeat(10000) + '</html>';
    await gen.modify('修改', { name: 'App' }, { 'big.html': bigContent }, []);

    // 截断后的文件不应包含全部 10000 个字符
    expect(capturedMessage).toContain('已截断');
    expect(capturedMessage).not.toContain('x'.repeat(10000));
  });
});
