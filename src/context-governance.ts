import { createHash } from "node:crypto";

/** OpenAI-compatible message shape (fields needed for governance only). */
export type GovernableMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  [key: string]: unknown;
};

export type ContextGovernanceMeta = {
  wasTruncated: boolean;
  wasCompressed: boolean;
  originalCount?: number;
  truncatedCount?: number;
  charsSaved: number;
};

export type ContextGovernanceResult = {
  messages: GovernableMessage[];
  meta: ContextGovernanceMeta;
};

const MAX_MESSAGES = Number(process.env.GATEWAY_MAX_MESSAGES ?? "60");
const COMPRESSION_THRESHOLD_KB = Number(process.env.GATEWAY_COMPRESSION_THRESHOLD_KB ?? "180");
/** Also compress when total message chars exceed this threshold (matches example-router). */
const COMPRESS_CHARS_THRESHOLD = 5000;

function hashText(text: string, length = 12): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

/** Normalize message.content to plain text for length estimates and dedup fingerprints. */
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

/** Minify JSON object/array text when content looks like JSON, to save tokens. */
function compactJsonLikeText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed));
  } catch {
    return text;
  }
}

function calculateMessagesChars(messages: GovernableMessage[]): number {
  return messages.reduce((total, msg) => total + normalizeMessageContent(msg.content).length, 0);
}

/**
 * Truncate long message lists: keep all system/developer messages, retain only the last N conversation turns.
 * N is controlled by GATEWAY_MAX_MESSAGES; system/developer messages do not count toward the cap.
 */
export function truncateMessages(messages: GovernableMessage[]): {
  messages: GovernableMessage[];
  wasTruncated: boolean;
  originalCount?: number;
  truncatedCount?: number;
} {
  if (!Array.isArray(messages) || messages.length <= MAX_MESSAGES) {
    return { messages, wasTruncated: false };
  }

  const systemMessages = messages.filter((m) => m.role === "system" || m.role === "developer");
  const conversationMessages = messages.filter((m) => m.role !== "system" && m.role !== "developer");
  const maxConversation = Math.max(1, MAX_MESSAGES - systemMessages.length);
  const truncatedConversation = conversationMessages.slice(-maxConversation);

  return {
    messages: [...systemMessages, ...truncatedConversation],
    wasTruncated: true,
    originalCount: messages.length,
    truncatedCount: systemMessages.length + truncatedConversation.length,
  };
}

/**
 * Compress large requests:
 * - Drop duplicate long messages (same role + content hash, length > 200 chars);
 * - Minify string content that looks like JSON.
 */
export function compressMessages(messages: GovernableMessage[]): {
  messages: GovernableMessage[];
  charsSaved: number;
} {
  let charsSaved = 0;
  const seen = new Set<string>();
  const compressed: GovernableMessage[] = [];

  for (const msg of messages) {
    const contentText = normalizeMessageContent(msg.content);
    const key = `${msg.role}:${hashText(contentText, 16)}`;
    if (contentText.length > 200 && seen.has(key)) {
      charsSaved += contentText.length;
      continue;
    }
    seen.add(key);

    if (typeof msg.content === "string") {
      const compacted = compactJsonLikeText(msg.content);
      if (compacted !== msg.content) {
        charsSaved += msg.content.length - compacted.length;
        compressed.push({ ...msg, content: compacted });
        continue;
      }
    }
    compressed.push(msg);
  }

  return { messages: compressed, charsSaved };
}

/**
 * Apply long-context governance before upstream forwarding: truncate first, then compress if needed.
 * Compression runs when request size or total message chars exceed thresholds.
 */
export function governMessages(messages: GovernableMessage[]): ContextGovernanceResult {
  if (!Array.isArray(messages)) {
    return {
      messages,
      meta: { wasTruncated: false, wasCompressed: false, charsSaved: 0 },
    };
  }

  const truncation = truncateMessages(messages);
  let nextMessages = truncation.messages;

  const probeBody = { messages: nextMessages };
  const requestSizeKB = Math.ceil(Buffer.byteLength(JSON.stringify(probeBody)) / 1024);
  let compression = { messages: nextMessages, charsSaved: 0 };
  let wasCompressed = false;

  if (requestSizeKB > COMPRESSION_THRESHOLD_KB || calculateMessagesChars(nextMessages) > COMPRESS_CHARS_THRESHOLD) {
    compression = compressMessages(nextMessages);
    nextMessages = compression.messages;
    wasCompressed = compression.charsSaved > 0;
  }

  return {
    messages: nextMessages,
    meta: {
      wasTruncated: truncation.wasTruncated,
      originalCount: truncation.originalCount,
      truncatedCount: truncation.truncatedCount,
      wasCompressed,
      charsSaved: compression.charsSaved,
    },
  };
}
