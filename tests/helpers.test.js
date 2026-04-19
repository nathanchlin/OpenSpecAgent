// tests/helpers.test.js
const { formatContent, escapeHtml, formatTime, renderSpecPreview, parseBrainstormOptions } = require('../public/helpers');

describe('formatContent', () => {
  test('转义 HTML 特殊字符', () => {
    expect(formatContent('<script>alert(1)</script>')).not.toContain('<script>');
    expect(formatContent('a & b')).toBe('a &amp; b');
  });

  test('换行转 <br>', () => {
    expect(formatContent('line1\nline2')).toBe('line1<br>line2');
  });

  test('行内代码用 <code> 标签', () => {
    const result = formatContent('use `const x = 1` here');
    expect(result).toContain('<code');
    expect(result).toContain('const x = 1');
  });

  test('行内代码内特殊字符只转义一次', () => {
    const result = formatContent('use `a & b` here');
    // 在 <code> 内应该是 a &amp; b（浏览器渲染为 a & b）
    expect(result).toContain('<code');
    expect(result).toMatch(/a &amp; b/);
    // 不应该双重转义为 a &amp;amp; b
    expect(result).not.toContain('&amp;amp;');
  });

  test('行内代码内 HTML 标签被转义', () => {
    const result = formatContent('`<script>alert(1)</script>` is bad');
    expect(result).toContain('&lt;script&gt;');
    expect(result).not.toContain('<script>');
  });

  test('多个行内代码', () => {
    const result = formatContent('`a` and `b`');
    expect(result).toContain('a');
    expect(result).toContain('b');
  });

  test('空字符串', () => {
    expect(formatContent('')).toBe('');
  });

  test('null/undefined 安全', () => {
    expect(formatContent(null)).toBe('');
    expect(formatContent(undefined)).toBe('');
  });

  test('纯文本不变', () => {
    expect(formatContent('hello world')).toBe('hello world');
  });
});

describe('escapeHtml', () => {
  test('转义所有危险字符', () => {
    expect(escapeHtml('<div class="x">&</div>')).toBe('&lt;div class=&quot;x&quot;&gt;&amp;&lt;/div&gt;');
  });

  test('无特殊字符不变', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  test('空字符串', () => {
    expect(escapeHtml('')).toBe('');
  });

  test('null/undefined 安全', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('formatTime', () => {
  test('今天显示 HH:mm', () => {
    const now = new Date();
    const ts = now.getTime();
    const result = formatTime(ts);
    expect(result).toMatch(/^\d{2}:\d{2}$/);
  });

  test('非今天显示 M/D HH:mm', () => {
    const past = new Date('2025-01-15T10:30:00');
    const result = formatTime(past.getTime());
    expect(result).toMatch(/\d+\/\d+ \d{2}:\d{2}/);
  });

  test('空值返回空字符串', () => {
    expect(formatTime(null)).toBe('');
    expect(formatTime(undefined)).toBe('');
    expect(formatTime(0)).toBe('');
  });
});

describe('renderSpecPreview', () => {
  test('空 spec 显示(空)', () => {
    expect(renderSpecPreview(null)).toContain('(空)');
    expect(renderSpecPreview({})).toContain('(空)');
    expect(renderSpecPreview({ pages: [] })).toContain('(空)');
  });

  test('渲染页面标题', () => {
    const spec = {
      pages: [{ title: '首页', name: 'index', file: 'index.html', elements: [] }],
    };
    const html = renderSpecPreview(spec);
    expect(html).toContain('首页');
    expect(html).toContain('index.html');
  });

  test('渲染元素', () => {
    const spec = {
      pages: [{
        title: 'Test', file: 'test.html',
        elements: [
          { type: 'input', label: '用户名', id: 'username' },
          { type: 'button', text: '提交' },
        ],
      }],
    };
    const html = renderSpecPreview(spec);
    expect(html).toContain('input');
    expect(html).toContain('用户名');
    expect(html).toContain('button');
  });

  test('渲染行为', () => {
    const spec = {
      pages: [{
        title: 'T', file: 't.html', elements: [],
        behaviors: [{ trigger: 'btn.click', type: 'submit' }],
      }],
    };
    const html = renderSpecPreview(spec);
    expect(html).toContain('btn.click');
    expect(html).toContain('submit');
  });

  test('多页面', () => {
    const spec = {
      pages: [
        { title: 'A', file: 'a.html', elements: [] },
        { title: 'B', file: 'b.html', elements: [] },
      ],
    };
    const html = renderSpecPreview(spec);
    expect(html).toContain('A');
    expect(html).toContain('B');
  });

  test('XSS — 特殊字符被转义', () => {
    const spec = {
      pages: [{
        title: '<script>alert(1)</script>',
        file: '"><img src=x onerror=alert(1)>',
        elements: [{ type: 'input', label: '<b>bold</b>' }],
        behaviors: [{ trigger: '<a href=evil>', type: 'click&<>' }],
      }],
    };
    const html = renderSpecPreview(spec);
    // HTML 标签被转义
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).not.toContain('<a href=evil>');
    // 转义后的版本存在
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).toContain('&amp;&lt;&gt;');
  });

  test('page.name 回退（无 title 时用 name）', () => {
    const spec = {
      pages: [{ name: 'GamePage', file: 'game.html', elements: [] }],
    };
    const html = renderSpecPreview(spec);
    expect(html).toContain('GamePage');
  });

  test('无 title 和 name 时显示空', () => {
    const spec = {
      pages: [{ file: 'empty.html', elements: [] }],
    };
    const html = renderSpecPreview(spec);
    // 不崩溃，包含文件名
    expect(html).toContain('empty.html');
  });

  test('el.id 回退（无 label 时用 id）', () => {
    const spec = {
      pages: [{
        title: 'T', file: 't.html',
        elements: [{ type: 'div', id: 'main-content' }],
      }],
    };
    const html = renderSpecPreview(spec);
    expect(html).toContain('main-content');
  });

  test('el.text 回退（无 label 和 id 时用 text）', () => {
    const spec = {
      pages: [{
        title: 'T', file: 't.html',
        elements: [{ type: 'span', text: 'Hello' }],
      }],
    };
    const html = renderSpecPreview(spec);
    expect(html).toContain('Hello');
  });

  test('空 trigger 和 type 不崩溃', () => {
    const spec = {
      pages: [{
        title: 'T', file: 't.html', elements: [],
        behaviors: [{ trigger: '', type: '' }],
      }],
    };
    expect(() => renderSpecPreview(spec)).not.toThrow();
  });
});

describe('parseBrainstormOptions', () => {
  test('解析 ##Q/##A 格式', () => {
    const text = '一些说明\n##Q1: 颜色主题？\n##A: 深色\n##A: 浅色\n##Q2: 布局？\n##A: 单栏';
    const { questions, remaining } = parseBrainstormOptions(text);
    expect(questions).toHaveLength(2);
    expect(questions[0].title).toBe('颜色主题？');
    expect(questions[0].options).toEqual(['深色', '浅色']);
    expect(questions[1].title).toBe('布局？');
    expect(questions[1].options).toEqual(['单栏']);
    expect(remaining).toBe('一些说明');
  });

  test('无 Q/A 结构返回原文', () => {
    const text = '这是一段普通文本';
    const { questions, remaining } = parseBrainstormOptions(text);
    expect(questions).toHaveLength(0);
    expect(remaining).toBe('这是一段普通文本');
  });

  test('空输入返回空', () => {
    const { questions, remaining } = parseBrainstormOptions('');
    expect(questions).toHaveLength(0);
    expect(remaining).toBe('');
  });

  test('null/undefined 安全', () => {
    expect(parseBrainstormOptions(null)).toEqual({ questions: [], remaining: '' });
    expect(parseBrainstormOptions(undefined)).toEqual({ questions: [], remaining: '' });
  });

  test('##A 在 ##Q 之前被忽略', () => {
    const text = '##A: 孤立的回答\n##Q: 问题？\n##A: 回答';
    const { questions } = parseBrainstormOptions(text);
    expect(questions).toHaveLength(1);
    expect(questions[0].options).toEqual(['回答']);
  });

  test('中文冒号支持', () => {
    const text = '##Q：问题\n##A：选项';
    const { questions } = parseBrainstormOptions(text);
    expect(questions).toHaveLength(1);
    expect(questions[0].title).toBe('问题');
    expect(questions[0].options).toEqual(['选项']);
  });
});
