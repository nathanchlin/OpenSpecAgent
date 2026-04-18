// server/routes.js
// API 路由 — 将 Electron IPC handlers 改写为 Express 路由

const express = require('express');
const archiver = require('archiver');

function createRoutes(session) {
  const router = express.Router();

  // ── 对话 ──

  router.post('/chat', async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    session.conversationHistory.push({ role: 'user', content: message });

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

  router.post('/chat/modify', async (req, res) => {
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

      res.json({ type: 'success', reply: result.reply });
    } catch (err) {
      res.json({ type: 'error', reply: `Error: ${err.message}` });
    }
  });

  // ── Spec & History ──

  router.get('/spec', (req, res) => {
    res.json(session.spec);
  });

  router.get('/history', (req, res) => {
    res.json(session.conversationHistory);
  });

  // ── 头脑风暴 ──

  router.post('/brainstorm/start', async (req, res) => {
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
      res.json({ reply: result.reply, infoSufficient: result.infoSufficient });
    } catch (err) {
      res.json({ reply: '头脑风暴启动失败: ' + err.message, infoSufficient: false });
    }
  });

  router.post('/brainstorm/chat', async (req, res) => {
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
      res.json({ reply: result.reply, infoSufficient: result.infoSufficient });
    } catch (err) {
      res.json({ reply: '头脑风暴失败: ' + err.message, infoSufficient: false });
    }
  });

  // ── 生成管道 ──

  router.post('/generate', async (req, res) => {
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

    // 不等待完成——通过 SSE 推送进度
    session.activePipeline.runGeneration(session.spec, brainstormSummary)
      .then((result) => {
        session.activePipeline = null;

        if (Object.keys(result.files).length === 0) {
          session.broadcastDone({ type: 'error', error: '代码生成失败：未能生成文件', steps: result.steps });
          return;
        }

        session.generatedFiles = result.files;
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

    // 立即返回，前端通过 SSE 接收进度
    res.json({ status: 'started' });
  });

  // SSE 进度流
  router.get('/generate/stream', (req, res) => {
    session.addSSEClient(res);
  });

  // 取消生成
  router.post('/generate/cancel', (req, res) => {
    if (session.activePipeline) {
      session.activePipeline.cancel();
      res.json({ ok: true });
    } else {
      res.json({ ok: false });
    }
  });

  // ── 导出 zip ──

  router.get('/export', (req, res) => {
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

  router.post('/reset', (req, res) => {
    session.reset();
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createRoutes };
