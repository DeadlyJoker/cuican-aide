export type LinkedThreadCandidate = {
  id: string;
  preview?: string | null;
  title: string;
};

export type ConversationThreadBindings = Record<string, string>;

const STORAGE_KEY = "crewon.commandWorkspace.conversationThreadBindings";

function normalizeThreadLabel(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[「」"'`]/g, "")
    .replace(/\s+/g, " ");
}

export function conversationBindingKey(
  spaceId: string,
  conversation: string,
): string {
  return `${spaceId}:${normalizeThreadLabel(conversation)}`;
}

export function readConversationThreadBindings(): ConversationThreadBindings {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const rawValue = window.localStorage.getItem(STORAGE_KEY);
    if (!rawValue) {
      return {};
    }
    const parsedValue = JSON.parse(rawValue) as unknown;
    if (!parsedValue || typeof parsedValue !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsedValue).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function writeConversationThreadBindings(
  bindings: ConversationThreadBindings,
) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    // Local storage is best-effort; title/preview matching still works.
  }
}

export function findLinkedThreadForConversation<
  T extends LinkedThreadCandidate,
>(
  threads: T[],
  conversation: string,
  aliases: string[] = [],
  explicitThreadId?: string | null,
): T | null {
  if (explicitThreadId) {
    const explicitThread = threads.find((thread) => thread.id === explicitThreadId);
    if (explicitThread) {
      return explicitThread;
    }
  }

  const targets = [conversation, ...aliases]
    .map(normalizeThreadLabel)
    .filter(Boolean);
  if (targets.length === 0) {
    return null;
  }

  return (
    threads.find((thread) => {
      const title = normalizeThreadLabel(thread.title);
      const preview = normalizeThreadLabel(thread.preview ?? "");
      return targets.some(
        (target) =>
          title === target ||
          title.includes(target) ||
          target.includes(title) ||
          preview.includes(target),
      );
    }) ?? null
  );
}
