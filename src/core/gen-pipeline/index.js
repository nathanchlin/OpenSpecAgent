/**
 * Gen Pipeline — 交互式头脑风暴 + 自动生成管道
 *
 * 阶段 1: 头脑风暴（问答循环，用户交互）
 * 阶段 2: 编写计划 → 执行计划（含空壳检测+自动续写+重试）→ 代码审核
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

const MAX_EXECUTE_RETRIES = 3;

/** 空壳代码检测模式 */
const PLACEHOLDER_PATTERNS = [
  /\/\*\s*\.{3}\s*\w+\s*\.{3}\s*\*\//g,
  /<!--\s*\.{3}/g,
  /\/\/\s*\.{3}\s*\w+\s*\.{3}/g,
  /更多\s*(样式|代码|逻辑|功能).*此处/g,
  /此处省略/g,
  /\.\.\.\s*(extensive|more|additional|remaining)/gi,
];

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

  /**
   * 开始头脑风暴 — 发起第一轮分析
   * @returns {{ reply: string, infoSufficient: boolean }}
   */
  async startBrainstorm(specJson) {
    const messages = [
      { role: 'system', content: BRAINSTORM_PROMPT },
      { role: 'user', content: `请分析以下应用 Spec，向我提出关键问题来明确技术方案：\n\n${specJson}` },
    ];
    const resp = await this.llm.chat(messages, { temperature: 0.7, maxTokens: 2048 });
    const reply = this._extractContent(resp);
    return { reply, infoSufficient: reply.includes('INFO_SUFFICIENT') };
  }

  /**
   * 继续头脑风暴 — 用户回答后继续问答
   * @param {string} specJson
   * @param {Array} history - [{role, content}] 问答历史
   * @returns {{ reply: string, infoSufficient: boolean }}
   */
  async continueBrainstorm(specJson, history) {
    const messages = [
      { role: 'system', content: BRAINSTORM_PROMPT + '\n\n## 应用 Spec\n' + specJson },
      ...history,
    ];
    const resp = await this.llm.chat(messages, { temperature: 0.7, maxTokens: 2048 });
    const reply = this._extractContent(resp);
    return { reply, infoSufficient: reply.includes('INFO_SUFFICIENT') };
  }

  // ═══════════════════════════════════════
  // 阶段 2: 自动生成（计划→执行→审核）
  // ═══════════════════════════════════════

  /**
   * 自动生成 — 从头脑风暴结果开始，执行计划→执行→审核
   * @param {object} spec - Spec JSON
   * @param {string} brainstormSummary - 头脑风暴完整记录
   * @returns {{ files: object, reviewSummary: string, steps: array }}
   */
  async runGeneration(spec, brainstormSummary) {
    const specJson = JSON.stringify(spec, null, 2);
    const context = { files: {}, reviewSummary: '' };
    const stepResults = [];
    // 从步骤 1 (plan) 开始，步骤 0 (brainstorm) 已在交互阶段完成
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
            const result = await this._executeWithRetry(specJson, brainstormSummary, context.plan, i);
            if (!result) {
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

  // ── 执行 + 空壳检测 + 自动重试循环 ──

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

    const content = await this._callLlmWithContinue(messages, { temperature: 0.3, maxTokens: 8192 }, 3);
    console.log(`[GenPipeline] Execute: final content length=${content.length}`);
    return this.codeGen.parseFiles(content);
  }

  /**
   * 调用 LLM 并在输出被截断时自动续写
   */
  async _callLlmWithContinue(messages, options, maxContinues = 3) {
    let fullContent = '';
    const workMessages = [...messages];

    for (let round = 0; round <= maxContinues; round++) {
      const resp = await this.llm.chat(workMessages, options);
      const choice = resp.choices?.[0] || {};
      const chunk = this._extractContent(resp);
      fullContent += chunk;

      const finishReason = choice.finish_reason;
      console.log(`[GenPipeline] LLM round ${round + 1}: chunk=${chunk.length} chars, finish_reason=${finishReason}, total=${fullContent.length}`);

      if (finishReason !== 'length') break;

      console.log(`[GenPipeline] Output truncated (finish_reason=length), continuing...`);
      const assistantText = choice.message?.content || '';
      workMessages.push({ role: 'assistant', content: assistantText });
      workMessages.push({
        role: 'user',
        content: '你的输出被截断了。请从截断处继续输出，不要重复已输出的内容。直接接着写即可。',
      });

      if (this.cancelled) break;
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
    const resp = await this.llm.chat(messages, { temperature: 0.4, maxTokens: 4096 });
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
    const resp = await this.llm.chat(messages, { temperature: 0.3, maxTokens: 4096 });
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
