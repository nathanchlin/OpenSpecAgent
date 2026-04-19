// tests/glm-client.test.js
const GLMClient = require('../server/core/llm/glm-client');
const http = require('http');

/**
 * 创建一个 mock HTTP 服务器，模拟 GLM API 响应
 */
function createMockServer(responseHandler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      responseHandler(req, res, body);
    });
  });
  return server;
}

describe('GLMClient._parseSSELine', () => {
  const client = new GLMClient({ apiKey: 'test-key' });

  test('解析有效 SSE 数据行', () => {
    const line = 'data: {"choices":[{"delta":{"content":"Hello"}}],"usage":{"prompt_tokens":10}}';
    const result = client._parseSSELine(line);
    expect(result.delta).toBe('Hello');
    expect(result.usage).toEqual({ prompt_tokens: 10 });
  });

  test('解析含 reasoning_content 的行', () => {
    const line = 'data: {"choices":[{"delta":{"content":"text","reasoning_content":"thought"}}]}';
    const result = client._parseSSELine(line);
    expect(result.delta).toBe('text');
    expect(result.reasoning).toBe('thought');
  });

  test('解析含 finish_reason 的行', () => {
    const line = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}';
    const result = client._parseSSELine(line);
    expect(result.finishReason).toBe('stop');
  });

  test('遇到 [DONE] 返回 null', () => {
    const line = 'data: [DONE]';
    expect(client._parseSSELine(line)).toBeNull();
  });

  test('空行返回 undefined', () => {
    expect(client._parseSSELine('')).toBeUndefined();
    expect(client._parseSSELine('   ')).toBeUndefined();
  });

  test('非 data: 开头的行返回 undefined', () => {
    expect(client._parseSSELine('event: progress')).toBeUndefined();
    expect(client._parseSSELine(': keepalive')).toBeUndefined();
  });

  test('无效 JSON 返回 undefined（不崩溃）', () => {
    expect(client._parseSSELine('data: {invalid json}')).toBeUndefined();
  });

  test('无 delta 字段不崩溃', () => {
    const line = 'data: {"choices":[{}]}';
    const result = client._parseSSELine(line);
    expect(result.delta).toBe('');
    expect(result.reasoning).toBe('');
  });

  test('无 choices 数组不崩溃', () => {
    const line = 'data: {"usage":{"prompt_tokens":5}}';
    const result = client._parseSSELine(line);
    expect(result.delta).toBe('');
    expect(result.usage).toEqual({ prompt_tokens: 5 });
  });
});

describe('GLMClient constructor', () => {
  test('使用默认配置', () => {
    const client = new GLMClient({ apiKey: 'test' });
    expect(client.model).toBe('glm-5.1');
    expect(client.maxTokens).toBe(4096);
    expect(client.temperature).toBe(0.7);
  });

  test('覆盖默认配置', () => {
    const client = new GLMClient({
      apiKey: 'k',
      baseUrl: 'http://localhost:8080',
      model: 'glm-4',
      maxTokens: 8192,
      temperature: 0.3,
    });
    expect(client.baseUrl).toBe('http://localhost:8080');
    expect(client.model).toBe('glm-4');
    expect(client.maxTokens).toBe(8192);
    expect(client.temperature).toBe(0.3);
  });
});

describe('GLMClient._sendRequest', () => {
  test('构建正确的请求头', () => {
    const client = new GLMClient({ apiKey: 'my-secret-key', baseUrl: 'https://api.test.com/v1' });
    const https = require('https');
    const originalRequest = https.request;
    let capturedOptions = null;
    let capturedPayload = null;

    https.request = (options, cb) => {
      capturedOptions = options;
      const mockReq = {
        on: () => {},
        setTimeout: () => {},
        write: (data) => { capturedPayload = data; },
        end: () => {},
      };
      return mockReq;
    };

    client._sendRequest('/test', { foo: 'bar' }, () => {}, () => {});

    https.request = originalRequest;

    expect(capturedOptions.hostname).toBe('api.test.com');
    expect(capturedOptions.path).toBe('/v1/test');
    expect(capturedOptions.method).toBe('POST');
    expect(capturedOptions.headers['Authorization']).toBe('Bearer my-secret-key');
    expect(capturedOptions.headers['Content-Type']).toBe('application/json; charset=utf-8');

    const parsed = JSON.parse(capturedPayload.toString());
    expect(parsed.foo).toBe('bar');
  });

  test('网络错误时调用 onError', async () => {
    const client = new GLMClient({ apiKey: 'test', baseUrl: 'http://localhost:1' });
    await expect(client.request('/test', {})).rejects.toThrow();
  });
});

describe('GLMClient.request (非流式)', () => {
  let server;
  let port;

  beforeAll(async () => {
    server = createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: 'Hello from API' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    });
    await new Promise(resolve => server.listen(0, resolve));
    port = server.address().port;
  });

  afterAll(() => server.close());

  test('chat() 返回完整 JSON 响应', async () => {
    const client = new GLMClient({ apiKey: 'test', baseUrl: `http://localhost:${port}` });
    const result = await client.chat([{ role: 'user', content: 'Hi' }]);
    expect(result.choices[0].message.content).toBe('Hello from API');
    expect(result.usage.prompt_tokens).toBe(10);
  });

  test('request() 解析 JSON 错误响应', async () => {
    const errorServer = createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'API rate limit exceeded' } }));
    });
    await new Promise(resolve => errorServer.listen(0, resolve));
    const errorPort = errorServer.address().port;

    const client = new GLMClient({ apiKey: 'test', baseUrl: `http://localhost:${errorPort}` });
    await expect(client.request('/test', {})).rejects.toThrow('API rate limit exceeded');
    errorServer.close();
  });

  test('request() 处理无效 JSON 响应', async () => {
    const badServer = createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not json');
    });
    await new Promise(resolve => badServer.listen(0, resolve));
    const badPort = badServer.address().port;

    const client = new GLMClient({ apiKey: 'test', baseUrl: `http://localhost:${badPort}` });
    await expect(client.request('/test', {})).rejects.toThrow('Parse error');
    badServer.close();
  });

  test('chat() 传递 response_format 选项', async () => {
    let capturedBody = null;
    const fmtServer = createMockServer((req, res, body) => {
      capturedBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }));
    });
    await new Promise(resolve => fmtServer.listen(0, resolve));
    const fmtPort = fmtServer.address().port;

    const client = new GLMClient({ apiKey: 'test', baseUrl: `http://localhost:${fmtPort}` });
    await client.chat([{ role: 'user', content: 'test' }], { response_format: { type: 'json_object' } });
    expect(capturedBody.response_format).toEqual({ type: 'json_object' });
    fmtServer.close();
  });
});

describe('GLMClient streaming methods', () => {
  let server;
  let port;

  beforeAll(async () => {
    server = createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":" World"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    await new Promise(resolve => server.listen(0, resolve));
    port = server.address().port;
  });

  afterAll(() => server.close());

  test('requestStream() 返回拼接文本并调用 onChunk', async () => {
    const client = new GLMClient({ apiKey: 'test', baseUrl: `http://localhost:${port}` });
    const chunks = [];
    const result = await client.requestStream('/chat/completions', {
      model: 'test', messages: [], stream: true,
    }, (delta, full) => {
      chunks.push(delta);
    });
    expect(result).toBe('Hello World');
    // finish_reason 行也触发 onChunk（delta 为空字符串）
    expect(chunks.filter(c => c.length > 0)).toEqual(['Hello', ' World']);
  });

  test('chatStream() 返回完整文本', async () => {
    const client = new GLMClient({ apiKey: 'test', baseUrl: `http://localhost:${port}` });
    const result = await client.chatStream([{ role: 'user', content: 'Hi' }], () => {});
    expect(result).toBe('Hello World');
  });

  test('chatStreamingFull() 返回完整响应对象', async () => {
    const client = new GLMClient({ apiKey: 'test', baseUrl: `http://localhost:${port}` });
    const result = await client.chatStreamingFull([{ role: 'user', content: 'Hi' }]);
    expect(result.choices[0].message.content).toBe('Hello World');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.usage).toEqual({ prompt_tokens: 5 });
  });
});

describe('GLMClient streaming with reasoning', () => {
  let server;
  let port;

  beforeAll(async () => {
    server = createMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"reasoning_content":"Let me think..."}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    await new Promise(resolve => server.listen(0, resolve));
    port = server.address().port;
  });

  afterAll(() => server.close());

  test('chatStreamingFull() 捕获 reasoning_content', async () => {
    const client = new GLMClient({ apiKey: 'test', baseUrl: `http://localhost:${port}` });
    const result = await client.chatStreamingFull([{ role: 'user', content: 'Hi' }]);
    expect(result.choices[0].message.content).toBe('Answer');
    expect(result.choices[0].message.reasoning_content).toBe('Let me think...');
  });
});

describe('GLMClient _sendRequest timeout', () => {
  test('请求超时触发错误', async () => {
    const client = new GLMClient({ apiKey: 'test', baseUrl: 'http://localhost:1' });
    // 连接到不存在的端口会快速失败
    await expect(client.request('/test', {})).rejects.toThrow();
  });
});
