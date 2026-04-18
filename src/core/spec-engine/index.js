/**
 * Spec Engine — 将用户对话转化为结构化的应用 Spec
 *
 * 核心流程：
 * 1. 接收用户消息
 * 2. 判断意图：新需求 / 修改 / 追问
 * 3. 调用 LLM 生成/更新 Spec
 * 4. 返回 Spec + 回复
 */

const SPEC_SYSTEM_PROMPT = `你是 OpenSpecAgent 的需求分析专家。你的任务是将用户的自然语言需求转化为结构化的应用规格说明（Spec）。

## 你的工作方式

1. 如果用户描述的是一个新应用需求，分析需求并生成完整的 Spec JSON
2. 如果用户在补充细节或修改需求，更新已有的 Spec
3. 如果需求不够清晰，提出精确的追问

## Spec JSON 格式

{
  "name": "应用名称",
  "version": "1.0",
  "pages": [
    {
      "name": "页面标识(英文)",
      "file": "页面文件名.html",
      "title": "页面标题",
      "layout": "布局类型(centered-form/single-column/two-column/dashboard/landing)",
      "elements": [
        {
          "id": "元素ID(英文)",
          "type": "元素类型(input/button/text/image/link/list/card/form/nav/modal/table/select/checkbox/radio/textarea)",
          "label": "显示文本",
          "inputType": "输入类型(仅input: text/password/email/number/tel/url/search)",
          "placeholder": "占位文本",
          "text": "按钮/链接文本",
          "href": "链接地址",
          "items": ["列表项"],
          "validation": { "required": true, "minLength": 6, "pattern": "正则", "min": 0, "max": 100 },
          "action": "行为标识",
          "children": []
        }
      ],
      "behaviors": [
        {
          "trigger": "元素ID.事件(click/change/submit/input)",
          "type": "行为类型(validate-then-navigate/show-message/toggle/add-item/remove-item/filter/api-call)",
          "validate": ["需要验证的元素ID"],
          "success": { "navigate": "目标页面.html", "showMessage": "成功消息" },
          "failure": { "showMessage": "错误消息", "type": "error" },
          "params": {}
        }
      ],
      "styles": {
        "theme": "light/dark",
        "primaryColor": "#十六进制色值",
        "layout": "centered/sidebar/fixed-header"
      }
    }
  ],
  "navigation": [
    { "from": "源页面", "to": "目标页面", "condition": "触发条件描述" }
  ],
  "data": {
    "stores": [
      {
        "name": "存储名称",
        "fields": [
          { "name": "字段名", "type": "string/number/boolean/array/object", "initial": "初始值" }
        ]
      }
    ]
  }
}

## 输出规则

当你能确定用户需求时，回复格式为：
JSON_SPEC:::你的回复文字
:::SPEC
{完整的Spec JSON}
:::END

当你需要追问时，直接回复追问内容，不需要 Spec。

## 重要原则

- 所有页面必须是独立的 HTML 文件，使用原生 HTML/CSS/JS，不使用任何框架
- 样式使用内联 CSS 或 <style> 标签
- 数据使用 localStorage 或内存中的 JavaScript 对象
- 优先使用语义化 HTML 标签
- 应用必须是响应式的，适配手机/平板/桌面
- 每个页面必须包含完整的 <!DOCTYPE html> 结构`;

class SpecEngine {
  constructor(llmClient) {
    this.llm = llmClient;
  }

  /**
   * 处理用户消息
   * @returns {{ type: string, reply: string, spec?: object }}
   */
  async processMessage(userMessage, conversationHistory, currentSpec) {
    const messages = [
      { role: 'system', content: SPEC_SYSTEM_PROMPT },
    ];

    // 加入历史对话（保留最近 10 轮）
    const recentHistory = conversationHistory.slice(-20);
    for (const msg of recentHistory) {
      messages.push({ role: msg.role, content: msg.content });
    }

    // 如果有当前 Spec，注入上下文
    if (currentSpec) {
      messages.push({
        role: 'system',
        content: `当前已确认的 Spec：\n${JSON.stringify(currentSpec, null, 2)}\n\n用户可能要在此基础上修改。`,
      });
    }

    try {
      const response = await this.llm.chat(messages, {
        temperature: 0.6,
        maxTokens: 4096,
      });

      const content = response.choices?.[0]?.message?.content || '';
      const reasoning = response.choices?.[0]?.message?.reasoning_content || '';
      // GLM-5.1 可能将实际内容放在 content 或 reasoning_content
      const fullContent = content || reasoning;
      return this.parseResponse(fullContent, currentSpec);
    } catch (err) {
      return {
        type: 'error',
        reply: `LLM 调用失败: ${err.message}`,
        spec: currentSpec,
      };
    }
  }

  /**
   * 解析 LLM 响应，提取 Spec
   */
  parseResponse(content, currentSpec) {
    // 检查是否包含 Spec JSON
    const specMatch = content.match(/:::SPEC\s*\n?([\s\S]*?):::END/);

    if (specMatch) {
      try {
        const specJson = JSON.parse(specMatch[1].trim());
        // 提取回复文字
        const replyMatch = content.match(/JSON_SPEC:::([\s\S]*?):::SPEC/);
        const reply = replyMatch ? replyMatch[1].trim() : '已生成应用规格说明，请查看并确认。';

        return {
          type: 'spec',
          reply,
          spec: specJson,
        };
      } catch (e) {
        return {
          type: 'chat',
          reply: content.replace(/JSON_SPEC:::[\s\S]*?:::END/g, '').trim(),
          spec: currentSpec,
        };
      }
    }

    // 没有 Spec，是追问或普通回复
    return {
      type: 'clarification',
      reply: content,
      spec: currentSpec,
    };
  }
}

module.exports = SpecEngine;
