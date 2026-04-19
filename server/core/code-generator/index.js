/**
 * Code Generator — 从结构化 Spec 生成原生 HTML/CSS/JS 代码
 *
 * 支持：
 * - 从 Spec 全量生成
 * - 基于用户修改指令的增量更新
 */

const { debug } = require('../logger');

const CODE_GEN_SYSTEM_PROMPT = `你是 OpenSpecAgent 的代码生成专家。你根据应用规格说明（Spec）生成完整的 Web 应用代码。

## 严格规则

1. **纯原生技术**：只使用 HTML5 + CSS3 + 原生 JavaScript（ES6+），不使用任何框架或库
2. **单文件页面**：每个页面是一个完整的 HTML 文件，包含内联 CSS 和 JS
3. **完整 HTML 结构**：每个页面必须包含 <!DOCTYPE html>、<html>、<head>、<body>
4. **语义化 HTML**：使用 header/nav/main/section/article/footer 等语义标签
5. **响应式设计**：使用 CSS Grid/Flexbox + 媒体查询，适配手机(375px)/平板(768px)/桌面
6. **无外部依赖**：不引用 CDN、不使用 import、不依赖任何外部资源
7. **数据存储**：使用 localStorage 或内存 JavaScript 对象
8. **交互完整**：所有按钮、表单、导航必须有真实的交互行为
9. **中文界面**：所有 UI 文本使用中文

## 输出格式（严格遵守，不可省略）

为每个页面生成代码，用以下格式包裹。**这是强制格式，每个文件必须如此包裹，不可省略标记。**

:::FILE:文件名.html
完整的 HTML 代码
:::END

可以生成多个文件。如果需要 CSS 或 JS 独立文件也可以生成。

### 正确示例

:::FILE:index.html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>示例</title>
</head>
<body>
  <h1>Hello</h1>
</body>
</html>
:::END

:::FILE:about.html
<!DOCTYPE html>
<html lang="zh-CN">
...
:::END

**注意**：不要在 :::FILE: 标记外加 markdown 代码围栏，直接输出标记即可。

## 样式指南

- 使用 CSS 变量定义主题色：:root { --primary: #...; --bg: #...; }
- 表单输入框高度至少 40px，按钮至少 36px 高
- 间距使用 8px 的倍数
- 圆角统一使用 8px（大元素）或 4px（小元素）
- 阴影使用 box-shadow: 0 2px 8px rgba(0,0,0,0.1)

## 质量要求

- 代码整洁、有缩进、有注释
- 变量命名有意义
- 函数单一职责
- 事件监听器正确绑定
- 表单验证完整
- 错误提示友好`;

const MODIFY_SYSTEM_PROMPT = `你是 OpenSpecAgent 的代码修改专家。用户要求修改已生成的 Web 应用代码。

## 规则
1. 只修改需要改的部分，保持其他代码不变
2. 必须输出修改后的完整文件（不是 diff）
3. 依然使用纯原生 HTML/CSS/JS
4. 修改不能破坏已有功能

## 输出格式（严格遵守）
先回复修改说明，然后输出文件。每个文件必须用 :::FILE: 标记包裹：

MODIFY:::修改说明文字
:::FILES
:::FILE:文件名.html
修改后的完整 HTML 代码
:::END
:::ENDFILES

**注意**：不要在 :::FILE: 标记外加 markdown 代码围栏，直接输出标记即可。`;

class CodeGenerator {
  constructor(llmClient) {
    this.llm = llmClient;
  }

  /**
   * 从 Spec 全量生成代码（带自动重试）
   */
  async generate(spec, maxRetries = 2) {
    const specText = JSON.stringify(spec, null, 2);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const messages = [
        { role: 'system', content: CODE_GEN_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `请根据以下 Spec 生成完整的 Web 应用代码：\n\n${specText}`,
        },
      ];

      if (attempt > 0) {
        // 重试时额外强调格式
        messages.push({
          role: 'assistant',
          content: '好的，我来生成代码。',
        });
        messages.push({
          role: 'user',
          content: `你上次输出中没有包含 :::FILE: 标记，我无法提取文件。请重新生成，确保每个文件都用 :::FILE:文件名 开头、:::END 结尾包裹。不要加 markdown 代码围栏。`,
        });
      }

      const response = await this.llm.chatStreamingFull(messages, {
        temperature: 0.5,
        maxTokens: 8192,
      });

      const msg = response.choices?.[0]?.message || {};
      const content = (msg.content || '') + '\n' + (msg.reasoning_content || '');
      debug(`[CodeGenerator] attempt ${attempt + 1}, content length: ${content.length}, has FILE marker: ${content.includes(':::FILE:')}`);

      const files = this.parseFiles(content);
      if (Object.keys(files).length > 0) {
        if (attempt > 0) {
          debug(`[CodeGenerator] succeeded on attempt ${attempt + 1}`);
        }
        return files;
      }

      debug(`[CodeGenerator] attempt ${attempt + 1} produced 0 files, ${attempt < maxRetries ? 'retrying...' : 'giving up.'}`);
    }

    return {};
  }

  /**
   * 增量修改已生成的代码
   */
  async modify(userMessage, spec, currentFiles, conversationHistory) {
    // 构造当前代码上下文（截断过长的文件以控制 token 消耗）
    const MAX_FILE_CHARS = 6000;
    let codeContext = '当前已生成的文件：\n\n';
    for (const [fileName, fileContent] of Object.entries(currentFiles)) {
      const truncated = fileContent.length > MAX_FILE_CHARS
        ? fileContent.substring(0, MAX_FILE_CHARS) + '\n...[已截断]'
        : fileContent;
      codeContext += `--- ${fileName} ---\n${truncated}\n\n`;
    }

    const messages = [
      { role: 'system', content: MODIFY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${codeContext}\n\nSpec：${JSON.stringify(spec, null, 2)}\n\n用户修改要求：${userMessage}`,
      },
    ];

    const response = await this.llm.chatStreamingFull(messages, {
      temperature: 0.4,
      maxTokens: 8192,
    });

    const msg = response.choices?.[0]?.message || {};
    const content = (msg.content || '') + '\n' + (msg.reasoning_content || '');

    // 提取修改说明
    const replyMatch = content.match(/MODIFY:::([\s\S]*?):::FILES/);
    const reply = replyMatch ? replyMatch[1].trim() : '已修改。';

    // 解析文件
    const newFiles = this.parseFiles(content);

    // 合并：如果有同名文件则替换，否则追加
    const merged = { ...currentFiles, ...newFiles };

    return { reply, files: merged };
  }

  /**
   * 解析 LLM 输出中的文件
   */
  parseFiles(content) {
    const files = {};

    // 调试：打印 :::FILE: 标记附近的原始内容
    const markerIdx = content.indexOf(':::FILE:');
    if (markerIdx >= 0) {
      const sample = content.substring(markerIdx, markerIdx + 120);
      debug('[CodeGenerator] FILE marker sample:', JSON.stringify(sample));
    }

    // 策略 1：标准 :::FILE:filename\n 内容 :::END 格式
    const regex = /:::FILE:\s*(\S+)\s*\r?\n([\s\S]*?):::END/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const fileName = match[1].trim();
      const fileContent = match[2].trim();
      files[fileName] = fileContent;
    }

    // 策略 2：尝试匹配被 markdown 代码围栏包裹的 :::FILE: 标记
    if (Object.keys(files).length === 0) {
      // GLM 可能在 :::FILE: 外面加了 ```...```
      const fencedRegex = /```(?:\w*)?\s*\r?\n\s*:::FILE:\s*(\S+)\s*\r?\n([\s\S]*?):::END\s*\r?\n\s*```/g;
      while ((match = fencedRegex.exec(content)) !== null) {
        const fileName = match[1].trim();
        const fileContent = match[2].trim();
        files[fileName] = fileContent;
      }
    }

    // 策略 2.5：:::FILE: 存在但无 :::END（LLM 输出被截断）
    if (Object.keys(files).length === 0 && content.includes(':::FILE:')) {
      debug('[CodeGenerator] :::FILE: found but no :::END, trying no-end strategy...');
      // 匹配 :::FILE:name\n 到下一个 :::FILE: 或内容末尾
      const noEndRegex = /:::FILE:\s*(\S+)\s*\r?\n([\s\S]*?)(?=:::FILE:|$)/g;
      while ((match = noEndRegex.exec(content)) !== null) {
        const fileName = match[1].trim();
        const fileContent = match[2].trim();
        if (fileContent.length > 0) {
          files[fileName] = fileContent;
        }
      }
    }

    // 策略 3：Fallback — 检测独立的 HTML 文档块
    if (Object.keys(files).length === 0) {
      debug('[CodeGenerator] no :::FILE: markers found, trying fallback HTML detection...');
      const htmlBlocks = this.extractFallbackHTML(content);
      for (const [name, code] of Object.entries(htmlBlocks)) {
        files[name] = code;
      }
    }

    debug('[CodeGenerator] parsed files:', Object.keys(files));
    return files;
  }

  /**
   * Fallback：从 LLM 输出中提取独立的 HTML 文档
   * 检测 <!DOCTYPE html> 或 <html 开头的代码块
   */
  extractFallbackHTML(content) {
    const files = {};

    // 3a. 先尝试从 markdown 代码围栏中提取
    const fenceRegex = /```(?:html|HTML)?\s*\r?\n([\s\S]*?)```/g;
    let fenceIdx = 0;
    let fenceMatch;
    while ((fenceMatch = fenceRegex.exec(content)) !== null) {
      const block = fenceMatch[1].trim();
      if (block.includes('<!DOCTYPE html') || block.includes('<html')) {
        const name = fenceIdx === 0 ? 'index.html' : `page${fenceIdx + 1}.html`;
        files[name] = block;
        fenceIdx++;
      }
    }

    if (Object.keys(files).length > 0) return files;

    // 3b. 直接搜索 <!DOCTYPE html> 块
    const doctypeRegex = /<!DOCTYPE html[\s\S]*?<\/html>/gi;
    let docIdx = 0;
    let docMatch;
    while ((docMatch = doctypeRegex.exec(content)) !== null) {
      const block = docMatch[0].trim();
      const name = docIdx === 0 ? 'index.html' : `page${docIdx + 1}.html`;
      files[name] = block;
      docIdx++;
    }

    return files;
  }
}

module.exports = CodeGenerator;
