/** One session journal entry: a key action extracted from an assistant reply. */
export type SessionJournalEntry = {
  time: string;
  action: string;
};

type JournalMessage = {
  role?: string;
  content?: unknown;
};

const sessionJournals = new Map<string, SessionJournalEntry[]>();

/** Normalize message.content to plain text (same approach as context-governance). */
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

/** Detect recap/summary/progress prompts to decide whether to inject session journal. */
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
    "continue",
  ].some((trigger) => lower.includes(trigger));
}

/** Clear all session journals on config hot reload. */
export function clearAllSessionJournals(): void {
  sessionJournals.clear();
}

export function deleteSessionJournal(sessionId: string): void {
  sessionJournals.delete(sessionId);
}

/**
 * Inject in-memory session journal into system/developer messages.
 * Returns the original body when there is no session or journal is empty.
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

/** Extract assistant text from a non-streaming chat completion JSON body. */
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

/** Extract assistant content from aggregated SSE text (fallback parser). */
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
      // Ignore non-JSON SSE chunks.
    }
  }
  return parts.join("");
}

/**
 * Extract key actions from assistant replies and append to session journal.
 * Matches example-router: English verb phrases, up to 4 entries per turn.
 */
export function recordSessionJournal(sessionId: string | null, modelLabel: string, assistantText: string): void {
  if (!sessionId || !assistantText) return;

  const events: string[] = [];
  const patterns = [
    /(?:created|updated|modified|added|removed|fixed|implemented|configured|wrote|changed)\s+[^.\n]{8,180}/gi,
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
