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

    return this._streamRequest('/chat/completions', body, (res, resolve) => {
      let buffer = '';
      let fullContent = '';
      let fullReasoning = '';
      let finishReason = null;
      let usage = null;

      const done = () => {
        resolve({
          choices: [{ message: { content: fullContent, reasoning_content: fullReasoning || undefined }, finish_reason: finishReason || 'stop' }],
          usage: usage,
        });
      };

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const parsed = this._parseSSELine(line);
          if (parsed === null) { done(); return; }
          if (!parsed) continue;

          if (parsed.delta) fullContent += parsed.delta;
          if (parsed.reasoning) fullReasoning += parsed.reasoning;
          if (parsed.finishReason) finishReason = parsed.finishReason;
          if (parsed.usage) usage = parsed.usage;
        }
      });

      res.on('end', done);
    });
  }

  /**
   * 发送 HTTP 请求（非流式）
   */
  request(endpoint, body) {
    return new Promise((resolve, reject) => {
      this._sendRequest(endpoint, body, (res) => {
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
      }, reject);
    });
  }

  /**
   * 流式 HTTP 请求（仅返回拼接后的文本）
   */
  requestStream(endpoint, body, onChunk) {
    return this._streamRequest(endpoint, body, (res, resolve) => {
      let buffer = '';
      let fullContent = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const parsed = this._parseSSELine(line);
          if (parsed === null) { resolve(fullContent); return; }
          if (!parsed) continue;

          fullContent += parsed.delta;
          if (onChunk) onChunk(parsed.delta, fullContent);
        }
      });

      res.on('end', () => resolve(fullContent));
    });
  }

  // ═══════════════════════════════════════
  //  内部方法
  // ═══════════════════════════════════════

  /**
   * 构建并发送 HTTP 请求，返回 response 供调用方处理
   */
  _sendRequest(endpoint, body, onResponse, onError) {
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
      onResponse
    );

    req.on('error', onError);
    req.setTimeout(300000, () => {
      req.destroy(new Error('Request timeout after 300s'));
    });
    req.write(payload);
    req.end();
  }

  /**
   * 通用的流式请求骨架
   */
  _streamRequest(endpoint, body, handleResponse) {
    return new Promise((resolve, reject) => {
      this._sendRequest(endpoint, body, (res) => {
        handleResponse(res, resolve);
      }, reject);
    });
  }

  /**
   * 解析单行 SSE 数据
   * @returns {null} 遇到 [DONE]
   * @returns {undefined} 非数据行
   * @returns {{delta, reasoning, finishReason, usage}} 有效数据
   */
  _parseSSELine(line) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) return undefined;

    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return null;

    try {
      const json = JSON.parse(data);
      return {
        delta: json.choices?.[0]?.delta?.content || '',
        reasoning: json.choices?.[0]?.delta?.reasoning_content || '',
        finishReason: json.choices?.[0]?.finish_reason || null,
        usage: json.usage || null,
      };
    } catch (e) {
      return undefined;
    }
  }
}

module.exports = GLMClient;
