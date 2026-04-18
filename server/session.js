// server/session.js
// 会话状态管理 + SSE 广播

const GLMClient = require('./core/llm/glm-client');
const SpecEngine = require('./core/spec-engine');
const CodeGenerator = require('./core/code-generator');
const GenPipeline = require('./core/gen-pipeline');

class SessionManager {
  constructor() {
    this.spec = null;
    this.generatedFiles = {};
    this.conversationHistory = [];
    this.brainstormHistory = [];
    this.activePipeline = null;
    this.sseClients = [];

    // 初始化服务
    this.glmClient = new GLMClient();
    this.specEngine = new SpecEngine(this.glmClient);
    this.codeGenerator = new CodeGenerator(this.glmClient);
  }

  /**
   * 添加 SSE 客户端连接
   */
  addSSEClient(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');
    this.sseClients.push(res);

    // 客户端断开时清理
    res.on('close', () => {
      this.sseClients = this.sseClients.filter(c => c !== res);
    });
  }

  /**
   * 广播 SSE 进度事件
   */
  broadcastProgress(event) {
    const data = JSON.stringify(event);
    for (const client of this.sseClients) {
      client.write(`event: progress\ndata: ${data}\n\n`);
    }
  }

  /**
   * 广播 SSE 完成事件
   */
  broadcastDone(result) {
    const data = JSON.stringify(result);
    for (const client of this.sseClients) {
      client.write(`event: done\ndata: ${data}\n\n`);
      client.end();
    }
    this.sseClients = [];
  }

  /**
   * 重置会话
   */
  reset() {
    this.spec = null;
    this.generatedFiles = {};
    this.conversationHistory = [];
    this.brainstormHistory = [];
    if (this.activePipeline) {
      this.activePipeline.cancel();
      this.activePipeline = null;
    }
  }

  getGeneratedFiles() {
    return this.generatedFiles;
  }
}

module.exports = { SessionManager };
