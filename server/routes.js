// server/routes.js
// API 路由 — 多会话版本，所有路由加 :sessionId

const express = require('express');
const archiver = require('archiver');
const { error: logError } = require('./core/logger');

const MAX_HISTORY_LENGTH = 100;
const MAX_BRAINSTORM_LENGTH = 50;

function createRoutes(store) {
  const router = express.Router();

  // ── 健康检查 ──
  router.get('/health', (req, res) => {
    const sessions = store.list();
    res.json({
      status: 'ok',
      sessions: sessions.length,
      uptime: process.uptime(),
      memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    });
  });

  // ── 辅助：获取会话 ──
  function getSession(req, res) {
    const session = store.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return null;
    }
    return session;
  }

  // ═══════════════════════════════════════
  //  会话 CRUD
  // ═══════════════════════════════════════

  // 列出所有会话
  router.get('/sessions', (req, res) => {
    res.json(store.list());
  });

  // 创建新会话
  router.post('/sessions', (req, res) => {
    const { name } = req.body || {};
    if (name && typeof name !== 'string') {
      return res.status(400).json({ error: 'name must be a string' });
    }
    if (name && name.length > 100) {
      return res.status(400).json({ error: 'name too long (max 100 chars)' });
    }
    const { id, session } = store.create(name);
    res.json({ id, name: session.name, createdAt: session.createdAt });
  });

  // 删除会话
  router.delete('/sessions/:id', (req, res) => {
    const ok = store.delete(req.params.id);
    res.json({ ok });
  });

  // 重命名会话
  router.post('/sessions/:id/rename', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (typeof name !== 'string') return res.status(400).json({ error: 'name must be a string' });
    if (name.length > 100) return res.status(400).json({ error: 'name too long (max 100 chars)' });
    const ok = store.rename(req.params.id, name);
    res.json({ ok });
  });

  // ═══════════════════════════════════════
  //  对话
  // ═══════════════════════════════════════

  router.post('/sessions/:id/chat', async (req, res) => {
    const session = getSession(req, res);
    if (!session) return;

    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });
    if (typeof message !== 'string') return res.status(400).json({ error: 'message must be a string' });
    if (message.length > 10000) return res.status(400).json({ error: 'message too long (max 10000 chars)' });

    session.conversationHistory.push({ role: 'user', content: message.slice(0, 10000) });
    session.touch();

    try {
      const specResult = await session.specEngine.processMessage(
        session.conversationHistory,
        session.spec
      );

      if (specResult.spec) {
        session.spec = specResult.spec;
      }

      session.conversationHistory.push({
        role: 'assistant',
        content: specResult.reply,
      });

      if (session.conversationHistory.length > MAX_HISTORY_LENGTH) {
        session.conversationHistory = session.conversationHistory.slice(-MAX_HISTORY_LENGTH);
      }

      store.save(session.id);
      res.json({
        type: specResult.type,
        reply: specResult.reply,
        spec: specResult.spec || null,
      });
    } catch (err) {
      res.json({ type: 'error', reply: `Error: ${err.message}`, spec: null });
    }
  });

  // ── 增量修改 ──

  router.post('/sessions/:id/chat/modify', async (req, res) => {
    const session = getSession(req, res);
    if (!session) return;

    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });
    if (typeof message !== 'string') return res.status(400).json({ error: 'message must be a string' });
    if (message.length > 10000) return res.status(400).json({ error: 'message too long (max 10000 chars)' });

    if (Object.keys(session.generatedFiles).length === 0) {
      return res.status(400).json({ error: 'No generated files to modify. Please generate code first.' });
    }

    session.conversationHistory.push({ role: 'user', content: message.slice(0, 10000) });

    try {
      const result = await session.codeGenerator.modify(
        message,
        session.spec,
        session.generatedFiles,
        session.conversationHistory
      );

      if (result.files) {
        session.generatedFiles = result.files;
      }

      session.conversationHistory.push({
        role: 'assistant',
        content: result.reply,
      });

      if (session.conversationHistory.length > MAX_HISTORY_LENGTH) {
        session.conversationHistory = session.conversationHistory.slice(-MAX_HISTORY_LENGTH);
      }

      session.touch();
      store.save(session.id);
      res.json({ type: 'success', reply: result.reply });
    } catch (err) {
      res.json({ type: 'error', reply: `Error: ${err.message}` });
    }
  });

  // ── Spec & History & Files ──

  router.get('/sessions/:id/spec', (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    res.json(session.spec);
  });

  router.get('/sessions/:id/history', (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    res.json(session.conversationHistory);
  });

  router.get('/sessions/:id/files', (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    res.json(Object.keys(session.generatedFiles || {}));
  });

  // ═══════════════════════════════════════
  //  头脑风暴
  // ═══════════════════════════════════════

  router.post('/sessions/:id/brainstorm/start', async (req, res) => {
    const session = getSession(req, res);
    if (!session) return;

    const { spec } = req.body;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      return res.status(400).json({ error: 'spec must be a non-empty object' });
    }
    session.spec = spec;
    session.brainstormHistory = [];
    const specJson = JSON.stringify(spec, null, 2);

    const GenPipeline = require('./core/gen-pipeline');
    const pipeline = new GenPipeline(
      session.glmClient,
      session.codeGenerator,
      (progressEvent) => session.broadcastProgress(progressEvent)
    );
    session.activePipeline = pipeline;

    try {
      const result = await pipeline.startBrainstorm(specJson);
      session.brainstormHistory.push({ role: 'assistant', content: result.reply });
      if (session.brainstormHistory.length > MAX_BRAINSTORM_LENGTH) {
        session.brainstormHistory = session.brainstormHistory.slice(-MAX_BRAINSTORM_LENGTH);
      }
      session.touch();
      store.save(session.id);
      res.json({ reply: result.reply, infoSufficient: result.infoSufficient });
    } catch (err) {
      res.json({ reply: '头脑风暴启动失败: ' + err.message, infoSufficient: false });
    }
  });

  router.post('/sessions/:id/brainstorm/chat', async (req, res) => {
    const session = getSession(req, res);
    if (!session) return;

    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });
    if (typeof message !== 'string') return res.status(400).json({ error: 'message must be a string' });
    if (message.length > 10000) return res.status(400).json({ error: 'message too long (max 10000 chars)' });

    if (!session.activePipeline) {
      return res.json({ reply: '管道未启动', infoSufficient: false });
    }

    session.brainstormHistory.push({ role: 'user', content: message.slice(0, 10000) });
    const specJson = JSON.stringify(session.spec, null, 2);

    try {
      const result = await session.activePipeline.continueBrainstorm(specJson, session.brainstormHistory);
      session.brainstormHistory.push({ role: 'assistant', content: result.reply });
      if (session.brainstormHistory.length > MAX_BRAINSTORM_LENGTH) {
        session.brainstormHistory = session.brainstormHistory.slice(-MAX_BRAINSTORM_LENGTH);
      }
      session.touch();
      store.save(session.id);
      res.json({ reply: result.reply, infoSufficient: result.infoSufficient });
    } catch (err) {
      res.json({ reply: '头脑风暴失败: ' + err.message, infoSufficient: false });
    }
  });

  // ═══════════════════════════════════════
  //  生成管道
  // ═══════════════════════════════════════

  router.post('/sessions/:id/generate', async (req, res) => {
    const session = getSession(req, res);
    if (!session) return;

    if (!session.spec) {
      return res.json({ type: 'error', error: 'No spec available' });
    }

    const brainstormSummary = (session.brainstormHistory || [])
      .map(m => `${m.role === 'user' ? '用户' : '分析师'}: ${m.content}`)
      .join('\n\n')
      .substring(0, 8000);

    if (!session.activePipeline) {
      const GenPipeline = require('./core/gen-pipeline');
      session.activePipeline = new GenPipeline(
        session.glmClient,
        session.codeGenerator,
        (progressEvent) => session.broadcastProgress(progressEvent)
      );
    }

    const sessionId = session.id;
    session._lastDoneEvent = null;

    session.activePipeline.runGeneration(session.spec, brainstormSummary)
      .then((result) => {
        session.activePipeline = null;

        if (Object.keys(result.files).length === 0) {
          session.broadcastDone({ type: 'error', error: '代码生成失败：未能生成文件', steps: result.steps });
          return;
        }

        session.generatedFiles = result.files;
        session.touch();
        store.save(sessionId);
        session.broadcastDone({
          type: 'success',
          files: Object.keys(result.files),
          review: result.reviewSummary,
          steps: result.steps,
        });
      })
      .catch((err) => {
        session.activePipeline = null;
        session.broadcastDone({ type: 'error', error: err.message, steps: [] });
      });

    res.json({ status: 'started' });
  });

  // SSE 进度流
  router.get('/sessions/:id/generate/stream', (req, res) => {
    const session = getSession(req, res);
    if (!session) return;
    session.addSSEClient(res);
  });

  // 取消生成
  router.post('/sessions/:id/generate/cancel', (req, res) => {
    const session = getSession(req, res);
    if (!session) return;

    if (session.activePipeline) {
      session.activePipeline.cancel();
      res.json({ ok: true });
    } else {
      res.json({ ok: false });
    }
  });

  // ── 导出 zip ──

  router.get('/sessions/:id/export', (req, res) => {
    const session = getSession(req, res);
    if (!session) return;

    const files = session.getGeneratedFiles();
    if (Object.keys(files).length === 0) {
      return res.status(404).json({ error: 'No files to export' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=openspec-export.zip');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    archive.on('error', (err) => {
      logError('[Export] Archive error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create archive' });
      }
    });

    for (const [fileName, content] of Object.entries(files)) {
      archive.append(content, { name: fileName });
    }

    archive.finalize();
  });

  // ── 重置会话 ──

  router.post('/sessions/:id/reset', (req, res) => {
    const session = getSession(req, res);
    if (!session) return;

    session.reset();
    store.save(session.id);
    res.json({ ok: true });
  });

  return router;
}

/**
 * 创建预览路由（从内存提供生成的文件，按会话隔离）
 */
function createPreviewRoutes(store) {
  const router = express.Router();
  const path = require('path');

  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };

  router.use('/:sessionId', (req, res) => {
    const session = store.get(req.params.sessionId);
    if (!session) return res.status(404).send('Session not found');

    const files = session.getGeneratedFiles();
    let filePath = req.path;

    if (filePath === '/') filePath = '/index.html';
    const fileName = filePath.slice(1);

    // 路径安全检查：拒绝路径遍历
    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      return res.status(400).send('Invalid file name');
    }

    if (files[fileName]) {
      const ext = path.extname(fileName);
      res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.send(files[fileName]);
    } else {
      res.status(404).send('File not found');
    }
  });

  return router;
}

module.exports = { createRoutes, createPreviewRoutes };
