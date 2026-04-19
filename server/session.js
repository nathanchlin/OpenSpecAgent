// server/session.js
// 多会话管理 + 文件持久化

const fs = require('fs');
const path = require('path');
const GLMClient = require('./core/llm/glm-client');
const SpecEngine = require('./core/spec-engine');
const CodeGenerator = require('./core/code-generator');

/**
 * 单个会话的状态管理
 */
class SessionManager {
  constructor(id, name) {
    this.id = id;
    this.name = name || '新会话';
    this.createdAt = Date.now();
    this.updatedAt = Date.now();

    this.spec = null;
    this.generatedFiles = {};
    this.conversationHistory = [];
    this.brainstormHistory = [];
    this.activePipeline = null;
    this.sseClients = [];

    // 初始化服务（不序列化）
    this._initServices();
  }

  _initServices() {
    this.glmClient = new GLMClient();
    this.specEngine = new SpecEngine(this.glmClient);
    this.codeGenerator = new CodeGenerator(this.glmClient);
  }

  /**
   * 序列化到 JSON（不含运行时状态）
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      spec: this.spec,
      generatedFiles: this.generatedFiles,
      conversationHistory: this.conversationHistory,
      brainstormHistory: this.brainstormHistory,
    };
  }

  /**
   * 从 JSON 恢复
   */
  static fromJSON(data) {
    const session = new SessionManager(data.id, data.name);
    session.createdAt = data.createdAt || Date.now();
    session.updatedAt = data.updatedAt || Date.now();
    session.spec = data.spec || null;
    session.generatedFiles = data.generatedFiles || {};
    session.conversationHistory = data.conversationHistory || [];
    session.brainstormHistory = data.brainstormHistory || [];
    return session;
  }

  touch() {
    this.updatedAt = Date.now();
  }

  // ── SSE ──

  addSSEClient(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');
    this.sseClients.push(res);

    res.on('close', () => {
      this.sseClients = this.sseClients.filter(c => c !== res);
    });
  }

  broadcastProgress(event) {
    const data = JSON.stringify(event);
    for (const client of this.sseClients) {
      client.write(`event: progress\ndata: ${data}\n\n`);
    }
  }

  broadcastDone(result) {
    const data = JSON.stringify(result);
    for (const client of this.sseClients) {
      client.write(`event: done\ndata: ${data}\n\n`);
      client.end();
    }
    this.sseClients = [];
  }

  // ── 操作 ──

  reset() {
    this.spec = null;
    this.generatedFiles = {};
    this.conversationHistory = [];
    this.brainstormHistory = [];
    if (this.activePipeline) {
      this.activePipeline.cancel();
      this.activePipeline = null;
    }
    this.touch();
  }

  getGeneratedFiles() {
    return this.generatedFiles;
  }
}

/**
 * 会话仓库 — 管理多个 SessionManager + 文件持久化
 */
class SessionStore {
  constructor(dataDir) {
    this.dataDir = dataDir || path.join(__dirname, '..', 'data', 'sessions');
    this.sessions = new Map();

    // 确保目录存在
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /**
   * 创建新会话
   */
  create(name) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const session = new SessionManager(id, name || '新会话');
    this.sessions.set(id, session);
    this.save(id);
    return { id, session };
  }

  /**
   * 获取会话
   */
  get(id) {
    return this.sessions.get(id) || null;
  }

  /**
   * 列出所有会话（按 updatedAt 降序）
   */
  list() {
    const items = [];
    for (const [id, session] of this.sessions) {
      items.push({
        id,
        name: session.name,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        hasSpec: !!session.spec,
        hasFiles: Object.keys(session.generatedFiles).length > 0,
      });
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return items;
  }

  /**
   * 删除会话
   */
  delete(id) {
    const session = this.sessions.get(id);
    if (session) {
      if (session.activePipeline) session.activePipeline.cancel();
      session.sseClients.forEach(c => { try { c.end(); } catch (e) {} });
    }
    this.sessions.delete(id);

    const filePath = path.join(this.dataDir, `${id}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return true;
  }

  /**
   * 重命名会话
   */
  rename(id, newName) {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.name = newName;
    session.touch();
    this.save(id);
    return true;
  }

  /**
   * 保存单个会话到文件
   */
  save(id) {
    const session = this.sessions.get(id);
    if (!session) return;

    const filePath = path.join(this.dataDir, `${id}.json`);
    const data = JSON.stringify(session.toJSON(), null, 2);
    fs.writeFileSync(filePath, data, 'utf-8');
  }

  /**
   * 从文件加载所有会话
   */
  loadAll() {
    if (!fs.existsSync(this.dataDir)) return;

    const files = fs.readdirSync(this.dataDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.dataDir, file), 'utf-8'));
        const session = SessionManager.fromJSON(data);
        this.sessions.set(session.id, session);
      } catch (e) {
        console.error(`[SessionStore] Failed to load ${file}: ${e.message}`);
      }
    }
    console.log(`[SessionStore] Loaded ${this.sessions.size} sessions`);
  }

  /**
   * 保存所有会话
   */
  saveAll() {
    for (const id of this.sessions.keys()) {
      try {
        this.save(id);
      } catch (e) {
        console.error(`[SessionStore] Failed to save ${id}: ${e.message}`);
      }
    }
    console.log(`[SessionStore] Saved ${this.sessions.size} sessions`);
  }
}

module.exports = { SessionManager, SessionStore };
