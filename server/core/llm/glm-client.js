const https = require('https');
const http = require('http');

/**
 * GLM-5.1 API 客户端
 * 支持流式和非流式响应
 */
class GLMClient {
  constructor(config = {}) {
    this.apiKey = config.apiKey || process.env.GLM_API_KEY || '';
    this.baseUrl = config.baseUrl || process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
    this.model = config.model || 'glm-5.1';
    this.maxTokens = config.maxTokens || 4096;
    this.temperature = config.temperature || 0.7;
  }

  /**
   * 非流式对话
   */
  async chat(messages, options = {}) {
    const body = {
      model: options.model || this.model,
      messages,
      max_tokens: options.maxTokens || this.maxTokens,
      temperature: options.temperature ?? this.temperature,
    };

    if (options.response_format) {
      body.response_format = options.response_format;
    }

    return this.request('/chat/completions', body);
  }

  /**
   * 流式对话
   * @param {function} onChunk - 每个 chunk 的回调
   * @returns {Promise<string>} 完整响应
   */
  async chatStream(messages, onChunk, options = {}) {
    const body = {
      model: options.model || this.model,
      messages,
      max_tokens: options.maxTokens || this.maxTokens,
      temperature: options.temperature ?? this.temperature,
      stream: true,
    };

    return this.requestStream('/chat/completions', body, onChunk);
  }

  /**
   * 流式对话，但返回完整响应对象（兼容 chat() 的返回格式）
   * 解决 GLM API 服务端 30s 非流式超时问题
   */
  async chatStreamingFull(messages, options = {}) {
    const body = {
      model: options.model || this.model,
      messages,
      max_tokens: options.maxTokens || this.maxTokens,
      temperature: options.temperature ?? this.temperature,
      stream: true,
    };

    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + '/chat/completions');
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const payload = JSON.stringify(body);
      let fullContent = '';
      let finishReason = null;
      let usage = null;

      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let buffer = '';
          let fullReasoning = '';

          res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data:')) continue;

              const data = trimmed.slice(5).trim();
              if (data === '[DONE]') {
                resolve({
                  choices: [{ message: { content: fullContent, reasoning_content: fullReasoning || undefined }, finish_reason: finishReason || 'stop' }],
                  usage: usage,
                });
                return;
              }

              try {
                const json = JSON.parse(data);
                const delta = json.choices?.[0]?.delta?.content || '';
                if (delta) fullContent += delta;
                const reasoning = json.choices?.[0]?.delta?.reasoning_content || '';
                if (reasoning) fullReasoning += reasoning;
                if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
                if (json.usage) usage = json.usage;
              } catch (e) {
                // 忽略解析错误
              }
            }
          });

          res.on('end', () => {
            resolve({
              choices: [{ message: { content: fullContent, reasoning_content: fullReasoning || undefined }, finish_reason: finishReason || 'stop' }],
              usage: usage,
            });
          });
        }
      );

      req.on('error', reject);
      req.setTimeout(300000, () => {
        req.destroy(new Error('Request timeout after 300s'));
      });
      req.write(payload);
      req.end();
    });
  }

  /**
   * 发送 HTTP 请求
   */
  request(endpoint, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + endpoint);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const payload = Buffer.from(JSON.stringify(body), 'utf-8');

      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Length': payload.length,
          },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf-8');
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.error) {
                reject(new Error(json.error.message || JSON.stringify(json.error)));
                return;
              }
              resolve(json);
            } catch (e) {
              reject(new Error(`Parse error: ${e.message}\nRaw: ${data.substring(0, 200)}`));
            }
          });
        }
      );

      req.on('error', reject);
      req.setTimeout(300000, () => {
        req.destroy(new Error('Request timeout after 300s'));
      });
      req.write(payload);
      req.end();
    });
  }

  /**
   * 流式 HTTP 请求
   */
  requestStream(endpoint, body, onChunk) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + endpoint);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const payload = JSON.stringify(body);
      let fullContent = '';

      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let buffer = '';

          res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data:')) continue;

              const data = trimmed.slice(5).trim();
              if (data === '[DONE]') {
                resolve(fullContent);
                return;
              }

              try {
                const json = JSON.parse(data);
                const delta = json.choices?.[0]?.delta?.content || '';
                if (delta) {
                  fullContent += delta;
                  if (onChunk) onChunk(delta, fullContent);
                }
              } catch (e) {
                // 忽略解析错误，继续处理
              }
            }
          });

          res.on('end', () => resolve(fullContent));
        }
      );

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

module.exports = GLMClient;
