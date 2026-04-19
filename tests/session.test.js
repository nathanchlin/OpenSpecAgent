// tests/session.test.js
const { SessionManager, SessionStore } = require('../server/session');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 使用临时目录避免污染项目数据
const TEST_DATA_DIR = path.join(os.tmpdir(), 'openspec-test-sessions-' + Date.now());

afterAll(() => {
  // 清理临时目录
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
});

describe('SessionManager', () => {
  test('创建新会话', () => {
    const session = new SessionManager('test-id', '测试会话');
    expect(session.id).toBe('test-id');
    expect(session.name).toBe('测试会话');
    expect(session.spec).toBeNull();
    expect(session.generatedFiles).toEqual({});
    expect(session.conversationHistory).toEqual([]);
    expect(session.brainstormHistory).toEqual([]);
  });

  test('默认名称为"新会话"', () => {
    const session = new SessionManager('id1');
    expect(session.name).toBe('新会话');
  });

  test('toJSON 序列化运行时状态', () => {
    const session = new SessionManager('id1', 'Test');
    session.spec = { name: 'App', pages: [] };
    session.conversationHistory = [{ role: 'user', content: 'Hello' }];
    session.generatedFiles = { 'index.html': '<html></html>' };

    const json = session.toJSON();
    expect(json.id).toBe('id1');
    expect(json.name).toBe('Test');
    expect(json.spec).toEqual({ name: 'App', pages: [] });
    expect(json.conversationHistory).toHaveLength(1);
    expect(json.generatedFiles).toEqual({ 'index.html': '<html></html>' });
    // 不应包含运行时状态
    expect(json.glmClient).toBeUndefined();
    expect(json.sseClients).toBeUndefined();
    expect(json.activePipeline).toBeUndefined();
  });

  test('fromJSON 恢复会话', () => {
    const original = new SessionManager('id1', 'Original');
    original.spec = { name: 'App' };
    original.conversationHistory = [{ role: 'user', content: 'Hi' }];
    original.brainstormHistory = [{ role: 'assistant', content: '问题' }];

    const json = original.toJSON();
    const restored = SessionManager.fromJSON(json);

    expect(restored.id).toBe('id1');
    expect(restored.name).toBe('Original');
    expect(restored.spec).toEqual({ name: 'App' });
    expect(restored.conversationHistory).toHaveLength(1);
    expect(restored.brainstormHistory).toHaveLength(1);
    // 恢复后应该有新的服务实例
    expect(restored.glmClient).toBeDefined();
    expect(restored.specEngine).toBeDefined();
    expect(restored.codeGenerator).toBeDefined();
  });

  test('touch 更新 updatedAt', () => {
    const session = new SessionManager('id1');
    const before = session.updatedAt;
    // 等一小段时间
    const start = Date.now();
    while (Date.now() === start) {} // 忙等 1ms
    session.touch();
    expect(session.updatedAt).toBeGreaterThanOrEqual(before);
  });

  test('reset 清除所有状态', () => {
    const session = new SessionManager('id1');
    session.spec = { name: 'App' };
    session.conversationHistory = [{ role: 'user', content: 'Hi' }];
    session.generatedFiles = { 'index.html': '<html></html>' };
    session.brainstormHistory = [{ role: 'assistant', content: 'Q' }];

    session.reset();
    expect(session.spec).toBeNull();
    expect(session.conversationHistory).toEqual([]);
    expect(session.generatedFiles).toEqual({});
    expect(session.brainstormHistory).toEqual([]);
  });

  test('getGeneratedFiles 返回生成文件', () => {
    const session = new SessionManager('id1');
    session.generatedFiles = { 'index.html': '<html></html>', 'style.css': 'body{}' };
    const files = session.getGeneratedFiles();
    expect(Object.keys(files)).toHaveLength(2);
    expect(files['index.html']).toBe('<html></html>');
  });

  test('SSE 客户端管理', () => {
    const session = new SessionManager('id1');
    // mock response 对象
    const mockRes = {
      writeHead: jest.fn(),
      write: jest.fn(),
      on: jest.fn((event, cb) => {
        if (event === 'close') {
          // 模拟关闭事件
        }
      }),
    };

    session.addSSEClient(mockRes);
    expect(session.sseClients).toHaveLength(1);
    expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream',
    }));
  });

  test('broadcastProgress 发送 SSE 事件', () => {
    const session = new SessionManager('id1');
    const mockRes = { write: jest.fn() };
    session.sseClients = [mockRes];

    session.broadcastProgress({ step: 'plan', status: 'running' });
    expect(mockRes.write).toHaveBeenCalledWith(
      expect.stringContaining('"step":"plan"')
    );
  });

  test('broadcastDone 关闭所有 SSE 客户端', () => {
    const session = new SessionManager('id1');
    const mockRes1 = { write: jest.fn(), end: jest.fn() };
    const mockRes2 = { write: jest.fn(), end: jest.fn() };
    session.sseClients = [mockRes1, mockRes2];

    session.broadcastDone({ type: 'success' });
    expect(mockRes1.end).toHaveBeenCalled();
    expect(mockRes2.end).toHaveBeenCalled();
    expect(session.sseClients).toHaveLength(0);
  });

  test('broadcastDone 存储 _lastDoneEvent', () => {
    const session = new SessionManager('id1');
    session.sseClients = [];
    session.broadcastDone({ type: 'success', files: ['index.html'] });
    expect(session._lastDoneEvent).toEqual({ type: 'success', files: ['index.html'] });
  });

  test('addSSEClient 重放已完成的 done 事件', () => {
    const session = new SessionManager('id1');
    session._lastDoneEvent = { type: 'success', files: ['index.html'] };

    const mockRes = {
      writeHead: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      on: jest.fn(),
    };

    session.addSSEClient(mockRes);

    // 应该重放 done 事件并立即关闭
    expect(mockRes.write).toHaveBeenCalledWith(expect.stringContaining('event: done'));
    expect(mockRes.end).toHaveBeenCalled();
    // 不应该加入 sseClients 列表
    expect(session.sseClients).toHaveLength(0);
  });

  test('SSE client close 回调从列表移除', () => {
    const session = new SessionManager('id1');
    let closeCallback = null;
    const mockRes = {
      writeHead: jest.fn(),
      write: jest.fn(),
      on: jest.fn((event, cb) => {
        if (event === 'close') closeCallback = cb;
      }),
    };

    session.addSSEClient(mockRes);
    expect(session.sseClients).toHaveLength(1);

    // 模拟客户端断开
    closeCallback();
    expect(session.sseClients).toHaveLength(0);
  });

  test('reset 取消活跃 pipeline', () => {
    const session = new SessionManager('id1');
    session.spec = { name: 'App' };
    session.generatedFiles = { 'index.html': '<html></html>' };
    session.conversationHistory = [{ role: 'user', content: 'hi' }];

    const mockPipeline = { cancel: jest.fn() };
    session.activePipeline = mockPipeline;

    session.reset();

    expect(session.spec).toBeNull();
    expect(session.generatedFiles).toEqual({});
    expect(session.conversationHistory).toEqual([]);
    expect(mockPipeline.cancel).toHaveBeenCalled();
    expect(session.activePipeline).toBeNull();
  });
});

describe('SessionStore', () => {
  let store;

  beforeEach(() => {
    store = new SessionStore(TEST_DATA_DIR);
  });

  test('创建新会话', () => {
    const { id, session } = store.create('测试');
    expect(id).toBeTruthy();
    expect(session.name).toBe('测试');
    expect(store.get(id)).toBe(session);
  });

  test('自动生成唯一 ID', () => {
    const { id: id1 } = store.create('会话1');
    const { id: id2 } = store.create('会话2');
    expect(id1).not.toBe(id2);
  });

  test('列出会话按 updatedAt 降序', () => {
    const { id: id1 } = store.create('First');
    // 确保 updatedAt 不同
    const session1 = store.get(id1);
    session1.updatedAt = Date.now() - 1000;
    const { id: id2 } = store.create('Second');
    const list = store.list();
    // 最新的在前
    expect(list[0].id).toBe(id2);
    expect(list[1].id).toBe(id1);
  });

  test('列出会话包含正确的状态信息', () => {
    const { id } = store.create('Test');
    const session = store.get(id);
    session.spec = { name: 'App' };

    const list = store.list();
    const item = list.find(s => s.id === id);
    expect(item.hasSpec).toBe(true);
    expect(item.hasFiles).toBe(false);
  });

  test('删除会话', () => {
    const { id } = store.create('ToDelete');
    expect(store.get(id)).toBeTruthy();
    store.delete(id);
    expect(store.get(id)).toBeNull();
  });

  test('删除不存在的会话不报错', () => {
    expect(() => store.delete('nonexistent')).not.toThrow();
  });

  test('删除时 unlinkSync 失败不抛异常', () => {
    const { id } = store.create('DelErr');
    // 先同步保存确保文件存在
    store.saveSync(id);

    const origExistsSync = fs.existsSync;
    const origUnlink = fs.unlinkSync;
    fs.existsSync = () => true;
    fs.unlinkSync = () => { throw new Error('EPERM: operation not permitted'); };
    const logSpy = jest.spyOn(console, 'error').mockImplementation();

    expect(() => store.delete(id)).not.toThrow();
    expect(logSpy).toHaveBeenCalled();

    logSpy.mockRestore();
    fs.existsSync = origExistsSync;
    fs.unlinkSync = origUnlink;
  });

  test('重命名会话', () => {
    const { id } = store.create('旧名');
    const ok = store.rename(id, '新名');
    expect(ok).toBe(true);
    expect(store.get(id).name).toBe('新名');
  });

  test('重命名不存在的会话返回 false', () => {
    const ok = store.rename('nonexistent', 'name');
    expect(ok).toBe(false);
  });

  test('保存和加载会话', () => {
    const { id } = store.create('持久化测试');
    const session = store.get(id);
    session.spec = { name: 'TestApp', pages: [{ name: 'index' }] };
    session.conversationHistory = [{ role: 'user', content: 'Hi' }];
    store.saveSync(id);

    // 创建新 store 从同一目录加载
    const store2 = new SessionStore(TEST_DATA_DIR);
    store2.loadAll();

    const loaded = store2.get(id);
    expect(loaded).toBeTruthy();
    expect(loaded.name).toBe('持久化测试');
    expect(loaded.spec).toEqual({ name: 'TestApp', pages: [{ name: 'index' }] });
    expect(loaded.conversationHistory).toHaveLength(1);
  });

  test('saveAll 保存所有会话', () => {
    // 使用独立的临时目录
    const saveAllDir = path.join(os.tmpdir(), 'openspec-test-saveall-' + Date.now());
    const saveAllStore = new SessionStore(saveAllDir);
    saveAllStore.create('S1');
    saveAllStore.create('S2');
    saveAllStore.saveAll();

    const files = fs.readdirSync(saveAllDir).filter(f => f.endsWith('.json'));
    expect(files).toHaveLength(2);

    // 清理
    fs.rmSync(saveAllDir, { recursive: true, force: true });
  });

  test('loadAll 处理损坏的 JSON 文件', () => {
    // 写入一个损坏的 JSON
    const corruptPath = path.join(TEST_DATA_DIR, 'corrupt.json');
    fs.writeFileSync(corruptPath, 'not valid json{', 'utf-8');

    // loadAll 不应抛出异常
    const store2 = new SessionStore(TEST_DATA_DIR);
    expect(() => store2.loadAll()).not.toThrow();
  });

  test('saveAll 处理保存错误', () => {
    // 创建 store 但指向不存在的父目录使 saveSync 失败
    const badDir = path.join(os.tmpdir(), 'openspec-test-saveall-error-' + Date.now());
    const badStore = new SessionStore(badDir);
    badStore.create('Test');

    // 手动设置 dataDir 为不存在的路径（不调用 mkdir）
    // 使用 saveAll，内部 try-catch 不应抛出
    badStore.dataDir = path.join(os.tmpdir(), 'openspec-nonexistent-parent-' + Date.now(), 'sub');
    expect(() => badStore.saveAll()).not.toThrow();
  });

  test('save() handles rename failure gracefully', async () => {
    const store = new SessionStore(TEST_DATA_DIR);
    const id = store.create('RenameTest');

    // Write .tmp file, then remove the dataDir before rename can happen
    const origRename = fs.rename;
    fs.rename = (src, dest, cb) => {
      // Simulate rename failure (e.g., temp dir cleaned up)
      cb(new Error('ENOENT: no such file or directory'));
    };

    const logSpy = jest.spyOn(console, 'error').mockImplementation();
    store.save(id);

    // Wait for async write + rename to complete
    await new Promise(r => setTimeout(r, 100));

    // Should have logged the rename error but not thrown
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
    fs.rename = origRename;
  });

  test('saveSync() handles write error gracefully', () => {
    const badDir = path.join(os.tmpdir(), 'openspec-test-sync-error-' + Date.now());
    const badStore = new SessionStore(badDir);
    const id = badStore.create('SyncErr');

    // Point to nonexistent directory
    badStore.dataDir = path.join(os.tmpdir(), 'openspec-nonexistent-sync-' + Date.now(), 'sub');
    const logSpy = jest.spyOn(console, 'error').mockImplementation();
    expect(() => badStore.saveSync(id)).not.toThrow();
    logSpy.mockRestore();
  });

});

describe('SessionStore save error paths', () => {
  test('save() handles writeFile error gracefully', async () => {
    const writeDir = path.join(os.tmpdir(), 'openspec-write-err-' + Date.now());
    const store = new SessionStore(writeDir);
    const { id } = store.create('WriteErr');

    expect(store.get(id)).toBeTruthy();

    const writeSpy = jest.spyOn(fs, 'writeFile').mockImplementation((p, d, enc, cb) => {
      if (typeof enc === 'function') cb = enc;
      cb(new Error('ENOSPC: no space left on device'));
    });

    const logSpy = jest.spyOn(console, 'error').mockImplementation();

    store.save(id);

    await new Promise(r => setTimeout(r, 100));

    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
    writeSpy.mockRestore();

    fs.rmSync(writeDir, { recursive: true, force: true });
  });
});

describe('SessionStore uncovered branches', () => {
  test('save() with non-existent id does nothing', () => {
    const dir = path.join(os.tmpdir(), 'openspec-save-noexist-' + Date.now());
    const store = new SessionStore(dir);
    // 不应抛异常
    expect(() => store.save('nonexistent-id')).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('saveSync() with non-existent id does nothing', () => {
    const dir = path.join(os.tmpdir(), 'openspec-sync-noexist-' + Date.now());
    const store = new SessionStore(dir);
    expect(() => store.saveSync('nonexistent-id')).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('delete() cancels active pipeline and closes SSE clients', () => {
    const dir = path.join(os.tmpdir(), 'openspec-del-active-' + Date.now());
    const store = new SessionStore(dir);
    const { id } = store.create('ActiveDel');
    const session = store.get(id);

    // 添加 mock activePipeline
    const mockPipeline = { cancel: jest.fn() };
    session.activePipeline = mockPipeline;

    // 添加 mock SSE client
    const mockSseClient = { end: jest.fn() };
    session.sseClients = [mockSseClient];

    store.delete(id);

    expect(mockPipeline.cancel).toHaveBeenCalled();
    expect(mockSseClient.end).toHaveBeenCalled();
    expect(store.get(id)).toBeNull();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
