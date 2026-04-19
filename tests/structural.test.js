// tests/structural.test.js
// 验证项目结构完整性：prompt 常量、HTML 结构、配置文件

const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════
//  Prompts 常量验证
// ═══════════════════════════════════════

describe('Gen Pipeline Prompts', () => {
  const prompts = require('../server/core/gen-pipeline/prompts');

  test('导出所有 4 个 prompt', () => {
    expect(prompts.BRAINSTORM_PROMPT).toBeDefined();
    expect(prompts.PLAN_PROMPT).toBeDefined();
    expect(prompts.EXECUTE_PROMPT).toBeDefined();
    expect(prompts.REVIEW_PROMPT).toBeDefined();
  });

  test('BRAINSTORM_PROMPT 包含关键指令', () => {
    expect(prompts.BRAINSTORM_PROMPT).toContain('INFO_SUFFICIENT');
    expect(prompts.BRAINSTORM_PROMPT).toContain('不要写任何代码');
  });

  test('PLAN_PROMPT 包含架构规划要求', () => {
    expect(prompts.PLAN_PROMPT).toContain('HTML 结构');
    expect(prompts.PLAN_PROMPT).toContain('CSS');
    expect(prompts.PLAN_PROMPT).toContain('JavaScript');
    expect(prompts.PLAN_PROMPT).toContain('不要写任何代码');
  });

  test('EXECUTE_PROMPT 包含输出格式规范', () => {
    expect(prompts.EXECUTE_PROMPT).toContain(':::FILE:');
    expect(prompts.EXECUTE_PROMPT).toContain(':::END');
    expect(prompts.EXECUTE_PROMPT).toContain('纯原生');
    expect(prompts.EXECUTE_PROMPT).toContain('响应式');
  });

  test('REVIEW_PROMPT 包含审核清单', () => {
    expect(prompts.REVIEW_PROMPT).toContain('REVIEW:::OK');
    expect(prompts.REVIEW_PROMPT).toContain('REVIEW:::CORRECTED');
    expect(prompts.REVIEW_PROMPT).toContain('完整性检查');
    expect(prompts.REVIEW_PROMPT).toContain('正确性检查');
  });

  test('每个 prompt 长度合理（非空且非过长）', () => {
    for (const [name, content] of Object.entries(prompts)) {
      expect(content.length).toBeGreaterThan(100);
      expect(content.length).toBeLessThan(5000);
    }
  });
});

// ═══════════════════════════════════════
//  Spec Engine Prompt 验证
// ═══════════════════════════════════════

describe('Spec Engine Prompt', () => {
  // 读取 spec-engine/index.js 源码提取 prompt
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'core', 'spec-engine', 'index.js'),
    'utf-8'
  );

  test('包含 JSON_SPEC::: 输出格式', () => {
    expect(source).toContain('JSON_SPEC:::');
    expect(source).toContain(':::SPEC');
    expect(source).toContain(':::END');
  });

  test('包含 Spec JSON 格式模板', () => {
    expect(source).toContain('"pages"');
    expect(source).toContain('"elements"');
    expect(source).toContain('"behaviors"');
  });
});

// ═══════════════════════════════════════
//  Code Generator Prompt 验证
// ═══════════════════════════════════════

describe('Code Generator Prompts', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'core', 'code-generator', 'index.js'),
    'utf-8'
  );

  test('包含生成和修改两套 prompt', () => {
    expect(source).toContain('CODE_GEN_SYSTEM_PROMPT');
    expect(source).toContain('MODIFY_SYSTEM_PROMPT');
  });

  test('MODIFY prompt 包含输出格式', () => {
    expect(source).toContain('MODIFY:::');
    expect(source).toContain(':::FILES');
  });
});

// ═══════════════════════════════════════
//  前端文件结构验证
// ═══════════════════════════════════════

describe('Frontend File Structure', () => {
  test('public/index.html 包含必要元素', () => {
    const html = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'index.html'),
      'utf-8'
    );
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<meta charset="UTF-8">');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('helpers.js');
    expect(html).toContain('app.js');
    expect(html).toContain('style.css');
  });

  test('helpers.js 在 app.js 之前加载', () => {
    const html = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'index.html'),
      'utf-8'
    );
    const helpersPos = html.indexOf('helpers.js');
    const appPos = html.indexOf('app.js');
    expect(helpersPos).toBeLessThan(appPos);
  });

  test('public/style.css 存在且非空', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'style.css'),
      'utf-8'
    );
    expect(css.length).toBeGreaterThan(100);
  });

  test('public/helpers.js 导出所有函数', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'helpers.js'),
      'utf-8'
    );
    expect(source).toContain('formatContent');
    expect(source).toContain('escapeHtml');
    expect(source).toContain('formatTime');
    expect(source).toContain('renderSpecPreview');
    expect(source).toContain('parseBrainstormOptions');
    expect(source).toContain('module.exports');
  });
});

// ═══════════════════════════════════════
//  项目配置验证
// ═══════════════════════════════════════

describe('Project Configuration', () => {
  test('package.json 包含 test script', () => {
    const pkg = require('../package.json');
    expect(pkg.scripts.test).toContain('jest');
  });

  test('package.json 包含必要依赖', () => {
    const pkg = require('../package.json');
    expect(pkg.dependencies.express).toBeDefined();
    expect(pkg.dependencies.archiver).toBeDefined();
    expect(pkg.devDependencies.jest).toBeDefined();
  });

  test('.env.example 存在', () => {
    const envPath = path.join(__dirname, '..', '.env.example');
    expect(fs.existsSync(envPath)).toBe(true);
  });

  test('.env.example 包含 GLM_API_KEY', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', '.env.example'),
      'utf-8'
    );
    expect(content).toContain('GLM_API_KEY');
    expect(content).toContain('PORT');
  });

  test('package.json 不包含未使用的依赖', () => {
    const pkg = require('../package.json');
    expect(pkg.dependencies.ws).toBeUndefined();
  });
});

// ═══════════════════════════════════════
//  Logger 工具验证
// ═══════════════════════════════════════

describe('Logger 工具', () => {
  const origDebug = process.env.DEBUG;

  afterEach(() => {
    process.env.DEBUG = origDebug;
    jest.resetModules();
  });

  test('DEBUG=1 时 debug 输出到 console', () => {
    process.env.DEBUG = '1';
    jest.resetModules();
    const { debug } = require('../server/core/logger');
    const spy = jest.spyOn(console, 'log').mockImplementation();
    debug('test message');
    expect(spy).toHaveBeenCalledWith('test message');
    spy.mockRestore();
  });

  test('DEBUG 未设置时 debug 不输出', () => {
    delete process.env.DEBUG;
    jest.resetModules();
    const { debug } = require('../server/core/logger');
    const spy = jest.spyOn(console, 'log').mockImplementation();
    debug('should not appear');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('error 总是输出', () => {
    delete process.env.DEBUG;
    jest.resetModules();
    const { error } = require('../server/core/logger');
    const spy = jest.spyOn(console, 'error').mockImplementation();
    error('always shown');
    expect(spy).toHaveBeenCalledWith('always shown');
    spy.mockRestore();
  });

  test('info 总是输出到 console.log', () => {
    delete process.env.DEBUG;
    jest.resetModules();
    const { info } = require('../server/core/logger');
    const spy = jest.spyOn(console, 'log').mockImplementation();
    info('info message');
    expect(spy).toHaveBeenCalledWith('info message');
    spy.mockRestore();
  });
});
