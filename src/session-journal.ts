/** 单条会话日志：从 assistant 回复中提取的关键动作。 */
export type SessionJournalEntry = {
  time: string;
  action: string;
};

type JournalMessage = {
  role?: string;
  content?: unknown;
};

const sessionJournals = new Map<string, SessionJournalEntry[]>();

/** 将 message.content 归一化为纯文本（与 context-governance 一致）。 */
function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as { type?: string; text?: string };
          if (p.type === "text" && typeof p.text === "string") return p.text;
          if (p.type === "input_text" && typeof p.text === "string") return p.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : String(content);
}

/** 识别「总结 / 回顾 / 进展」类 prompt，决定是否注入 session journal。 */
export function needsSessionJournal(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return [
    "what did you do",
    "what have you done",
    "what did we do",
    "what have we done",
    "earlier",
    "before",
    "previously",
    "this session",
    "today",
    "so far",
    "remind me",
    "summarize",
    "summary of",
    "recap",
    "your work",
    "your progress",
    "accomplished",
    "completed tasks",
    "刚才",
    "之前",
    "前面",
    "总结",
    "做了什么",
    "进展",
    "继续",
  ].some((trigger) => lower.includes(trigger));
}

/** 会话过期时同步清理 journal。 */
/** 热重载配置时清空全部 session journal。 */
export function clearAllSessionJournals(): void {
  sessionJournals.clear();
}

export function deleteSessionJournal(sessionId: string): void {
  sessionJournals.delete(sessionId);
}

/**
 * 将内存中的 session journal 注入 system/developer 消息。
 * 若无匹配会话或 journal 为空，则原样返回 body。
 */
export function injectSessionJournal<T extends Record<string, unknown> & { messages?: JournalMessage[] }>(
  body: T,
  sessionId: string | null,
  prompt: string,
): { body: T; injected: boolean } {
  if (!sessionId || !needsSessionJournal(prompt)) {
    return { body, injected: false };
  }

  const journal = sessionJournals.get(sessionId);
  if (!journal?.length) {
    return { body, injected: false };
  }

  const journalText = [
    "[Session Memory - Key Actions]",
    ...journal.slice(-8).map((entry) => `- ${entry.time}: ${entry.action}`),
  ].join("\n");

  const nextBody = { ...body, messages: [...(body.messages ?? [])] };
  const systemIdx = nextBody.messages.findIndex((m) => m.role === "system" || m.role === "developer");
  if (systemIdx >= 0 && typeof nextBody.messages[systemIdx].content === "string") {
    nextBody.messages[systemIdx] = {
      ...nextBody.messages[systemIdx],
      content: `${journalText}\n\n${nextBody.messages[systemIdx].content}`,
    };
  } else {
    nextBody.messages.unshift({ role: "system", content: journalText });
  }

  return { body: nextBody, injected: true };
}

/** 从非流式 chat completion JSON 中提取 assistant 文本。 */
export function extractAssistantTextFromJson(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string }; delta?: { content?: string } }>;
    };
    if (Array.isArray(parsed.choices)) {
      return parsed.choices
        .map((choice) => choice.message?.content || choice.delta?.content || "")
        .filter(Boolean)
        .join("\n");
    }
  } catch {
    return "";
  }
  return "";
}

/** 从 SSE 聚合文本中提取 assistant 内容（兜底解析）。 */
export function extractAssistantTextFromSse(text: string): string {
  const parts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
      };
      for (const choice of parsed.choices ?? []) {
        const content = choice.delta?.content || choice.message?.content || "";
        if (content) parts.push(content);
      }
    } catch {
      // 忽略非 JSON SSE 片段。
    }
  }
  return parts.join("");
}

/**
 * 从 assistant 回复中提取关键动作并写入 session journal。
 * 与 example-router 一致：英文动词短语 + 中文动作句，最多 4 条/轮。
 */
export function recordSessionJournal(sessionId: string | null, modelLabel: string, assistantText: string): void {
  if (!sessionId || !assistantText) return;

  const events: string[] = [];
  const patterns = [
    /(?:created|updated|modified|added|removed|fixed|implemented|configured|wrote|changed)\s+[^.\n]{8,180}/gi,
    /(?:创建|更新|修改|新增|删除|修复|实现|配置|调整)[^。\n]{4,120}/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(assistantText)) && events.length < 4) {
      events.push(match[0].trim());
    }
  }
  if (!events.length) return;

  const journal = sessionJournals.get(sessionId) ?? [];
  const now = new Date();
  for (const action of events) {
    journal.push({
      time: now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true }),
      action: `${action} (${modelLabel})`,
    });
  }
  sessionJournals.set(sessionId, journal.slice(-20));
}
