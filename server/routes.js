// server/routes.js
// API 路由 — 多会话版本，所有路由加 :sessionId

const express = require('express');
const archiver = require('archiver');

function createRoutes(store) {
  const router = express.Router();

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

    session.conversationHistory.push({ role: 'user', content: message });
    session.touch();

    try {
      const specResult = await session.specEngine.processMessage(
        message,
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

    session.conversationHistory.push({ role: 'user', content: message });

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

      session.touch();
      store.save(session.id);
      res.json({ type: 'success', reply: result.reply });
    } catch (err) {
      res.json({ type: 'error', reply: `Error: ${err.message}` });
    }
  });

  // ── Spec & History ──

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

  // ═══════════════════════════════════════
  //  头脑风暴
  // ═══════════════════════════════════════

  router.post('/sessions/:id/brainstorm/start', async (req, res) => {
    const session = getSession(req, res);
    if (!session) return;

    const { spec } = req.body;
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

    if (!session.activePipeline) {
      return res.json({ reply: '管道未启动', infoSufficient: false });
    }

    session.brainstormHistory.push({ role: 'user', content: message });
    const specJson = JSON.stringify(session.spec, null, 2);

    try {
      const result = await session.activePipeline.continueBrainstorm(specJson, session.brainstormHistory);
      session.brainstormHistory.push({ role: 'assistant', content: result.reply });
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
      .join('\n\n');

    if (!session.activePipeline) {
      const GenPipeline = require('./core/gen-pipeline');
      session.activePipeline = new GenPipeline(
        session.glmClient,
        session.codeGenerator,
        (progressEvent) => session.broadcastProgress(progressEvent)
      );
    }

    const sessionId = session.id;

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

module.exports = { createRoutes };
