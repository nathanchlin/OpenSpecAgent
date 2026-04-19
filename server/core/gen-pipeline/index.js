/**
 * Gen Pipeline — 交互式头脑风暴 + 自动生成管道
 *
 * 阶段 1: 头脑风暴（问答循环，用户交互）
 * 阶段 2: 编写计划 → 分文件执行（每个 HTML 独立生成）→ 代码审核
 */

const {
  BRAINSTORM_PROMPT,
  PLAN_PROMPT,
  EXECUTE_PROMPT,
  REVIEW_PROMPT,
} = require('./prompts');

const STEPS = [
  { key: 'brainstorm', label: '头脑风暴' },
  { key: 'plan',       label: '编写计划' },
  { key: 'execute',    label: '执行计划' },
  { key: 'review',     label: '代码审核' },
];

const MAX_EXECUTE_RETRIES = 2;

/** 空壳代码检测模式 */
const PLACEHOLDER_PATTERNS = [
  /\/\*\s*\.{3}\s*\w+\s*\.{3}\s*\*\//g,
  /<!--\s*\.{3}/g,
  /\/\/\s*\.{3}\s*\w+\s*\.{3}/g,
  /更多\s*(样式|代码|逻辑|功能).*此处/g,
  /此处省略/g,
  /\.\.\.\s*(extensive|more|additional|remaining)/gi,
];

/**
 * 分文件执行的额外提示词 — 注入共享样式、路由表、数据接口
 */
const PER_FILE_CONTEXT_PROMPT = `
## 重要约束（必须遵守）

### 共享样式（所有页面必须包含以下 CSS 变量）
你必须使用以下 CSS 变量，保持所有页面风格一致：

### 路由表（页面间导航必须使用以下文件名）
你必须使用以下文件名进行页面跳转（href 链接）：

### 数据接口（跨页面共享的数据必须使用以下 localStorage key 和数据格式）
`;

class GenPipeline {
  constructor(llmClient, codeGenerator, onProgress) {
    this.llm = llmClient;
    this.codeGen = codeGenerator;
    this.onProgress = onProgress;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
  }

  // ═══════════════════════════════════════
  // 阶段 1: 交互式头脑风暴
  // ═══════════════════════════════════════

  async startBrainstorm(specJson) {
    const messages = [
      { role: 'system', content: BRAINSTORM_PROMPT },
      { role: 'user', content: `请分析以下应用 Spec，向我提出关键问题来明确技术方案：\n\n${specJson}` },
    ];
    const resp = await this.llm.chatStreamingFull(messages, { temperature: 0.7, maxTokens: 2048 });
    const reply = this._extractContent(resp);
    return { reply, infoSufficient: reply.includes('INFO_SUFFICIENT') };
  }

  async continueBrainstorm(specJson, history) {
    const messages = [
      { role: 'system', content: BRAINSTORM_PROMPT + '\n\n## 应用 Spec\n' + specJson },
      ...history,
    ];
    const resp = await this.llm.chatStreamingFull(messages, { temperature: 0.7, maxTokens: 2048 });
    const reply = this._extractContent(resp);
    return { reply, infoSufficient: reply.includes('INFO_SUFFICIENT') };
  }

  // ═══════════════════════════════════════
  // 阶段 2: 自动生成（计划→分文件执行→审核）
  // ═══════════════════════════════════════

  async runGeneration(spec, brainstormSummary) {
    const specJson = JSON.stringify(spec, null, 2);
    const context = { files: {}, reviewSummary: '' };
    const stepResults = [];
    const startIndex = 1;

    for (let i = startIndex; i < STEPS.length; i++) {
      if (this.cancelled) {
        this._emit(i, 'failed', null, '用户取消');
        break;
      }

      const step = STEPS[i];
      console.log(`[GenPipeline] Step ${i + 1}/${STEPS.length}: ${step.label} starting...`);
      this._emit(i, 'running', null, null);

      try {
        let output;
        switch (step.key) {
          case 'plan':
            output = await this._runPlan(specJson, brainstormSummary);
            context.plan = output;
            break;

          case 'execute': {
            // 从 spec 提取页面列表
            const pageList = this._extractPageList(spec, context.plan);
            const result = await this._executePerFile(specJson, brainstormSummary, context.plan, pageList, i);
            if (!result || Object.keys(result).length === 0) {
              return { files: {}, reviewSummary: '', steps: stepResults };
            }
            context.files = result;
            break;
          }

          case 'review':
            output = await this._runReview(specJson, context.files);
            if (output.corrected) {
              const valid = Object.values(output.corrected).every(
                (c) => c.trim().length > 0 && c.includes('<!DOCTYPE')
              );
              if (valid && !this._hasPlaceholders(output.corrected)) {
                context.files = { ...context.files, ...output.corrected };
              }
            }
            context.reviewSummary = output.summary;
            break;
        }

        if (step.key !== 'execute') {
          this._emit(i, 'completed', output, null);
        }
        console.log(`[GenPipeline] Step ${step.label}: completed`);
        stepResults.push({ key: step.key, label: step.label, status: 'completed' });
      } catch (err) {
        console.error(`[GenPipeline] Step ${step.key} failed:`, err.message);
        const isCritical = step.key === 'execute';
        this._emit(i, isCritical ? 'failed' : 'skipped', null, err.message);
        stepResults.push({ key: step.key, label: step.label, status: isCritical ? 'failed' : 'skipped' });

        if (isCritical) {
          return { files: {}, reviewSummary: '', steps: stepResults };
        }
      }
    }

    return {
      files: context.files,
      reviewSummary: context.reviewSummary || '',
      steps: stepResults,
    };
  }

  // ═══════════════════════════════════════
  // 分文件执行
  // ═══════════════════════════════════════

  /**
   * 从 spec 和 plan 中提取页面文件列表
   * @returns {Array<{name: string, file: string, title: string}>}
   */
  _extractPageList(spec, planText) {
    const pages = [];

    // 优先从 spec.pages 提取
    if (spec.pages && spec.pages.length > 0) {
      for (const page of spec.pages) {
        pages.push({
          name: page.name || page.title,
          file: page.file || `${page.name || 'index'}.html`,
          title: page.title || page.name,
        });
      }
    }

    // 如果 spec 没有页面信息，从 plan 中用正则提取
    if (pages.length === 0 && planText) {
      const fileMatches = planText.matchAll(/(\w+\.html)/g);
      const seen = new Set();
      for (const m of fileMatches) {
        const f = m[1];
        if (!seen.has(f)) {
          seen.add(f);
          pages.push({ name: f.replace('.html', ''), file: f, title: f });
        }
      }
    }

    // 兜底：至少生成 index.html
    if (pages.length === 0) {
      pages.push({ name: 'index', file: 'index.html', title: '首页' });
    }

    console.log(`[GenPipeline] Extracted ${pages.length} pages: ${pages.map(p => p.file).join(', ')}`);
    return pages;
  }

  /**
   * 从 spec 中提取共享样式信息（CSS 变量）
   */
  _extractSharedStyles(spec) {
    const styles = [];
    for (const page of (spec.pages || [])) {
      if (page.styles) {
        if (page.styles.primaryColor) {
          styles.push(`--primary: ${page.styles.primaryColor};`);
        }
        if (page.styles.theme) {
          const isDark = page.styles.theme === 'dark';
          styles.push(`--bg: ${isDark ? '#1e1e2e' : '#ffffff'};`);
          styles.push(`--text: ${isDark ? '#cdd6f4' : '#333333'};`);
        }
      }
    }
    if (styles.length === 0) {
      // 默认深色主题
      styles.push('--primary: #cba6f7;', '--bg: #1e1e2e;', '--text: #cdd6f4;');
    }
    return ':root { ' + styles.join(' ') + ' }';
  }

  /**
   * 从 spec 中提取路由表
   */
  _extractRouteTable(spec, pageList) {
    const routes = [];
    for (const page of pageList) {
      routes.push(`- ${page.title} → ${page.file}`);
    }
    if (spec.navigation) {
      for (const nav of spec.navigation) {
        routes.push(`- ${nav.from} → ${nav.to}${nav.condition ? ' (条件: ' + nav.condition + ')' : ''}`);
      }
    }
    return routes.join('\n');
  }

  /**
   * 从已生成的文件中提取数据接口摘要（localStorage key + 数据格式）
   */
  _extractDataInterface(generatedFiles) {
    const interfaces = [];
    for (const [fileName, content] of Object.entries(generatedFiles)) {
      // 提取 localStorage.setItem 调用
      const setItemMatches = content.matchAll(/localStorage\.setItem\s*\(\s*['"`](\w+)['"`]/g);
      for (const m of setItemMatches) {
        interfaces.push(`- ${fileName} 写入 localStorage key: "${m[1]}"`);
      }
      // 提取 localStorage.getItem 调用
      const getItemMatches = content.matchAll(/localStorage\.getItem\s*\(\s*['"`](\w+)['"`]/g);
      for (const m of getItemMatches) {
        interfaces.push(`- ${fileName} 读取 localStorage key: "${m[1]}"`);
      }
    }
    if (interfaces.length === 0) return '（暂无跨页面数据）';
    return interfaces.join('\n');
  }

  /**
   * 从 plan 中提取特定文件的计划段落
   */
  _extractFilePlan(planText, fileName) {
    if (!planText) return '';
    // 尝试匹配 "文件名.html" 相关的段落
    const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 匹配 ### 标题中包含文件名，到下一个 ### 或文件结尾
    const regex = new RegExp(`#{2,3}[^\\n]*${escaped}[^\\n]*\\n([\\s\\S]*?)(?=#{2,3}|$)`, 'i');
    const match = planText.match(regex);
    if (match) return match[0].trim();

    // 如果没有按文件分段，返回截断的 plan（最多 3000 字符）
    if (planText.length > 3000) {
      return planText.substring(0, 3000) + '\n...[计划已截断]';
    }
    return planText;
  }

  /**
   * 分文件生成主逻辑
   */
  async _executePerFile(specJson, brainstormText, planText, pageList, stepIndex) {
    const allFiles = {};
    const spec = JSON.parse(specJson);
    const sharedStyles = this._extractSharedStyles(spec);
    const routeTable = this._extractRouteTable(spec, pageList);
    const totalPages = pageList.length;

    for (let idx = 0; idx < totalPages; idx++) {
      if (this.cancelled) {
        this._emit(stepIndex, 'failed', null, '用户取消');
        return allFiles;
      }

      const page = pageList[idx];
      const progressMsg = `正在生成第 ${idx + 1}/${totalPages} 个文件: ${page.file}`;
      console.log(`[GenPipeline] ${progressMsg}`);
      this._emit(stepIndex, 'running', null, progressMsg);

      // 从已生成文件提取数据接口（对策：数据传递一致性）
      const dataInterface = this._extractDataInterface(allFiles);

      // 提取当前文件的计划段落（对策：减少 token 消耗）
      const filePlan = this._extractFilePlan(planText, page.file);

      // 生成单个文件（带重试）
      const fileResult = await this._generateSingleFile(
        specJson, brainstormText, filePlan, page,
        sharedStyles, routeTable, dataInterface
      );

      if (fileResult) {
        allFiles[page.file] = fileResult;
        console.log(`[GenPipeline] Generated ${page.file}: ${fileResult.length} chars`);
      } else {
        console.log(`[GenPipeline] Failed to generate ${page.file}, skipping`);
      }
    }

    if (Object.keys(allFiles).length === 0) {
      this._emit(stepIndex, 'failed', null, '所有文件生成失败');
      return null;
    }

    this._emit(stepIndex, 'completed', `${Object.keys(allFiles).length} 个文件生成完成`, null);
    return allFiles;
  }

  /**
   * 生成单个 HTML 文件（带空壳检测和重试）
   */
  async _generateSingleFile(specJson, brainstormText, filePlan, page, sharedStyles, routeTable, dataInterface) {
    for (let attempt = 0; attempt <= MAX_EXECUTE_RETRIES; attempt++) {
      if (this.cancelled) return null;

      const messages = [
        {
          role: 'system',
          content: EXECUTE_PROMPT + '\n\n' + PER_FILE_CONTEXT_PROMPT
            + '\n### 共享 CSS 变量（必须在 :root 中定义）\n' + sharedStyles
            + '\n\n### 路由表\n' + routeTable
            + '\n\n### 数据接口（其他页面已使用的 localStorage key）\n' + dataInterface
        },
        {
          role: 'user',
          content: [
            '## 任务：生成单个页面文件',
            '',
            `当前需要生成的文件：${page.file}（${page.title}）`,
            '',
            '## 应用 Spec（完整）',
            specJson,
            '',
            '## 头脑风暴讨论',
            brainstormText || '（跳过）',
            '',
            `## 当前文件的实现计划（${page.file}）`,
            filePlan || '（按 Spec 直接实现）',
            '',
            '请生成这一个文件的完整代码。使用 :::FILE:' + page.file + ' 格式输出。',
            '',
            '重要要求：',
            '- 必须包含共享 CSS 变量（上面给出的 :root 定义）',
            '- 页面跳转链接必须使用路由表中的文件名',
            '- 如果需要跨页面共享数据，必须使用上面列出的 localStorage key',
            '- 不要使用占位注释，每一行代码都必须完整写出',
            '- 这是一个独立的单文件页面，包含完整的 HTML + CSS + JS',
          ].join('\n'),
        },
      ];

      if (attempt > 0) {
        messages.push({ role: 'assistant', content: '好的，我来生成代码。' });
        messages.push({
          role: 'user',
          content: '上一次生成的代码存在占位符或质量问题。请重新生成，确保：每一行都完整写出，不使用 "..." 省略。',
        });
      }

      try {
        const content = await this._callLlmWithContinue(messages, { temperature: 0.3, maxTokens: 32768 }, 1);
        const files = this.codeGen.parseFiles(content);

        if (Object.keys(files).length === 0) {
          console.log(`[GenPipeline] ${page.file} attempt ${attempt + 1}: 0 files parsed`);
          continue;
        }

        // 获取生成的文件内容（可能是 page.file 或其他名称）
        const generatedContent = files[page.file] || Object.values(files)[0];
        if (!generatedContent) continue;

        // 空壳检测
        const issues = this._detectPlaceholders({ [page.file]: generatedContent });
        if (issues.length === 0) {
          return generatedContent;
        }

        console.log(`[GenPipeline] ${page.file} attempt ${attempt + 1}: placeholder detected: ${issues.join('; ')}`);
      } catch (err) {
        console.error(`[GenPipeline] ${page.file} attempt ${attempt + 1} error: ${err.message}`);
      }
    }

    // 所有重试失败，返回 null
    return null;
  }

  // ── 执行（旧的一次性方法，保留作为 fallback，不再使用）──

  async _executeWithRetry(specJson, brainstormText, planText, stepIndex) {
    let lastFiles = null;
    let lastIssues = [];

    for (let attempt = 0; attempt <= MAX_EXECUTE_RETRIES; attempt++) {
      if (this.cancelled) return null;

      if (attempt === 0) {
        this._emit(stepIndex, 'running', null, null);
      } else {
        this._emit(stepIndex, 'running', null, `第 ${attempt + 1} 次尝试（修复空壳代码）`);
      }

      const files = await this._runExecuteOnce(specJson, brainstormText, planText, lastIssues);

      if (Object.keys(files).length === 0) {
        console.log(`[GenPipeline] Execute attempt ${attempt + 1}: 0 files parsed`);
        lastIssues = ['未能解析出任何文件。请确保使用 :::FILE:文件名 格式输出。'];
        continue;
      }

      const issues = this._detectPlaceholders(files);
      if (issues.length === 0) {
        console.log(`[GenPipeline] Execute attempt ${attempt + 1}: quality OK, ${Object.keys(files).length} files`);
        this._emit(stepIndex, 'completed', `${Object.keys(files).length} 个文件生成完成`, null);
        return files;
      }

      console.log(`[GenPipeline] Execute attempt ${attempt + 1}: placeholder detected: ${issues.join('; ')}`);
      lastFiles = files;
      lastIssues = issues;
    }

    if (lastFiles && Object.keys(lastFiles).length > 0) {
      console.log('[GenPipeline] All retries exhausted, returning last attempt');
      this._emit(stepIndex, 'completed', `重试 ${MAX_EXECUTE_RETRIES} 次后返回`, null);
      return lastFiles;
    }

    this._emit(stepIndex, 'failed', null, '多次重试后仍无法生成有效代码');
    return null;
  }

  async _runExecuteOnce(specJson, brainstormText, planText, previousIssues = []) {
    const messages = [
      { role: 'system', content: EXECUTE_PROMPT },
      {
        role: 'user',
        content: [
          '## 应用 Spec',
          specJson,
          '',
          '## 头脑风暴讨论',
          brainstormText || '（跳过）',
          '',
          '## 实现计划',
          planText || '（跳过）',
        ].join('\n'),
      },
    ];

    if (previousIssues.length > 0) {
      messages.push({ role: 'assistant', content: '好的，我来生成完整的 Web 应用代码。' });
      messages.push({
        role: 'user',
        content: [
          '你上一次生成的代码存在以下问题：',
          ...previousIssues.map((iss, idx) => `${idx + 1}. ${iss}`),
          '',
          '重要要求：',
          '- 不要使用 "..." 或 "/* ... extensive ... */" 等占位注释',
          '- 每一行 CSS、HTML、JavaScript 都必须完整写出',
          '- 宁可减少功能，也不要用占位符省略代码',
          '',
          '请重新生成完整的代码。',
        ].join('\n'),
      });
    } else {
      messages[messages.length - 1].content += '\n\n请严格按实现计划生成完整的 Web 应用代码。不要使用占位注释，每一行代码都必须完整写出。';
    }

    const content = await this._callLlmWithContinue(messages, { temperature: 0.3, maxTokens: 131072 }, 2);
    console.log(`[GenPipeline] Execute: final content length=${content.length}`);
    return this.codeGen.parseFiles(content);
  }

  /**
   * 调用 LLM 并在输出被截断时自动续写
   */
  async _callLlmWithContinue(messages, options, maxContinues = 2) {
    let fullContent = '';
    const workMessages = [...messages];
    const TRUNCATE_LEN = 2000;

    for (let round = 0; round <= maxContinues; round++) {
      try {
        const resp = await this.llm.chatStreamingFull(workMessages, options);
        const choice = resp.choices?.[0] || {};
        const chunk = this._extractContent(resp);
        fullContent += chunk;

        const finishReason = choice.finish_reason;
        console.log(`[GenPipeline] LLM round ${round + 1}: chunk=${chunk.length} chars, finish_reason=${finishReason}, total=${fullContent.length}`);

        if (finishReason !== 'length') break;

        console.log(`[GenPipeline] Output truncated (finish_reason=length), continuing...`);
        const assistantText = choice.message?.content || '';
        const truncatedAssistant = assistantText.length > TRUNCATE_LEN
          ? '...[前文已输出 ' + assistantText.length + ' 字符]...\n' + assistantText.slice(-TRUNCATE_LEN)
          : assistantText;
        workMessages.push({ role: 'assistant', content: truncatedAssistant });
        workMessages.push({
          role: 'user',
          content: '你的输出被截断了。请从截断处继续输出，不要重复已输出的内容。直接接着写即可。',
        });

        if (this.cancelled) break;
      } catch (err) {
        console.error(`[GenPipeline] LLM round ${round + 1} error: ${err.message}`);
        if (fullContent.length > 0) {
          console.log(`[GenPipeline] Returning ${fullContent.length} chars already received`);
          break;
        }
        if (round === 0) {
          console.log(`[GenPipeline] Retrying first round...`);
          continue;
        }
        throw err;
      }
    }

    return fullContent;
  }

  // ── Step Runners ──

  async _runPlan(specJson, brainstormText) {
    const messages = [
      { role: 'system', content: PLAN_PROMPT },
      {
        role: 'user',
        content: `## 应用 Spec\n${specJson}\n\n## 头脑风暴讨论记录\n${brainstormText}\n\n请根据以上讨论制定详细的实现计划。`,
      },
    ];
    const resp = await this.llm.chatStreamingFull(messages, { temperature: 0.4, maxTokens: 4096 });
    return this._extractContent(resp);
  }

  async _runReview(specJson, files) {
    let codeContext = '';
    for (const [name, content] of Object.entries(files)) {
      codeContext += `\n\n--- ${name} ---\n${content}`;
    }
    const messages = [
      { role: 'system', content: REVIEW_PROMPT },
      { role: 'user', content: `## 应用 Spec\n${specJson}\n\n## 生成的代码${codeContext}\n\n请对照 Spec 审核以上代码。` },
    ];
    const resp = await this.llm.chatStreamingFull(messages, { temperature: 0.3, maxTokens: 4096 });
    const content = this._extractContent(resp);
    return this._parseReviewOutput(content, files);
  }

  // ── 空壳检测 ──

  _detectPlaceholders(files) {
    const issues = [];
    for (const [fileName, content] of Object.entries(files)) {
      for (const pattern of PLACEHOLDER_PATTERNS) {
        const matches = content.match(pattern);
        if (matches && matches.length > 0) {
          issues.push(`${fileName} 包含占位注释: "${matches[0].substring(0, 60)}"`);
        }
      }
      if (content.includes('<!DOCTYPE html>') && content.trim().length < 200) {
        issues.push(`${fileName} 内容过短 (${content.length} 字符)`);
      }
      const styleMatch = content.match(/<style[\s\S]*?<\/style>/);
      if (styleMatch) {
        const rules = styleMatch[0].match(/\{[^}]+\}/g);
        if (rules && rules.length < 2) {
          issues.push(`${fileName} CSS 规则过少 (${rules.length} 条)`);
        }
      }
      const scriptMatch = content.match(/<script[\s\S]*?<\/script>/);
      if (scriptMatch) {
        const functions = scriptMatch[0].match(/function\s+\w+|const\s+\w+\s*=\s*(?:function|\()/g);
        if (!functions || functions.length < 2) {
          issues.push(`${fileName} JavaScript 函数过少`);
        }
      }
    }
    return issues;
  }

  _hasPlaceholders(files) {
    return this._detectPlaceholders(files).length > 0;
  }

  // ── Helpers ──

  _emit(stepIndex, status, output, error) {
    const step = STEPS[stepIndex];
    if (!step) return;
    this.onProgress({
      step: step.key,
      stepIndex,
      stepLabel: step.label,
      status,
      output: typeof output === 'string' ? output : (output ? JSON.stringify(output) : null),
      error,
      timestamp: Date.now(),
    });
  }

  _extractContent(resp) {
    const msg = resp.choices?.[0]?.message || {};
    return (msg.content || '') + '\n' + (msg.reasoning_content || '');
  }

  _parseReviewOutput(content, originalFiles) {
    const result = { corrected: null, summary: '' };
    if (content.includes('REVIEW:::CORRECTED')) {
      const corrected = this.codeGen.parseFiles(content);
      if (Object.keys(corrected).length > 0) result.corrected = corrected;
      const summaryMatch = content.match(/REVIEW:::CORRECTED([\s\S]*?)(?=:::FILE:|$)/);
      result.summary = summaryMatch ? summaryMatch[1].trim() : '发现严重 bug，已修正。';
    } else if (content.includes('REVIEW:::OK')) {
      const summaryMatch = content.match(/REVIEW:::OK([\s\S]*?)$/);
      result.summary = summaryMatch ? summaryMatch[1].trim() : '审核通过。';
    } else {
      result.summary = content.trim() || '审核完成。';
    }
    return result;
  }
}

module.exports = GenPipeline;
