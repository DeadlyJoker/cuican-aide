const keyPrefix = "crewon.thread-model-selection.v1.";
const maxSelections = 128;
const listeners = new Set<(threadId: string) => void>();

type ThreadModelSelection = Readonly<{
  modelId: string;
  selectionId: string;
  updatedAt: number;
}>;

function boundedIdentifier(value: string, maxBytes: number): boolean {
  return (
    value.length > 0 &&
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= maxBytes &&
    !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)
  );
}

function selectionKey(threadId: string): string | null {
  return boundedIdentifier(threadId, 512)
    ? `${keyPrefix}${encodeURIComponent(threadId)}`
    : null;
}

function parseSelection(raw: string | null): ThreadModelSelection | null {
  if (raw === null || raw.length > 1_024) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    return typeof record.modelId === "string" &&
      boundedIdentifier(record.modelId, 256) &&
      typeof record.selectionId === "string" &&
      boundedIdentifier(record.selectionId, 128) &&
      typeof record.updatedAt === "number" &&
      Number.isSafeInteger(record.updatedAt) &&
      record.updatedAt >= 0
      ? {
          modelId: record.modelId,
          selectionId: record.selectionId,
          updatedAt: record.updatedAt,
        }
      : null;
  } catch {
    return null;
  }
}

export function readThreadModelSelection(
  threadId: string,
): ThreadModelSelection | null {
  const key = selectionKey(threadId);
  if (key === null || typeof window === "undefined") return null;
  try {
    return parseSelection(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}

/** UI preference only. The current catalog and the Control API still authorize a model. */
export function writeThreadModelSelection(
  threadId: string,
  modelId: string,
  options: Readonly<{ expectedSelectionId?: string | null }> = {},
): boolean {
  const key = selectionKey(threadId);
  if (
    key === null ||
    !boundedIdentifier(modelId, 256) ||
    typeof window === "undefined"
  )
    return false;
  try {
    const storage = window.localStorage;
    const current = parseSelection(storage.getItem(key));
    // A completed request must not overwrite a choice made while it was starting.
    if (
      options.expectedSelectionId !== undefined &&
      (current?.selectionId ?? null) !== options.expectedSelectionId
    )
      return false;
    storage.setItem(
      key,
      JSON.stringify({
        modelId,
        selectionId: crypto.randomUUID(),
        updatedAt: Date.now(),
      }),
    );
    const selections: { key: string; updatedAt: number }[] = [];
    for (let index = 0; index < storage.length; index++) {
      const storedKey = storage.key(index);
      if (storedKey?.startsWith(keyPrefix)) {
        selections.push({
          key: storedKey,
          updatedAt: parseSelection(storage.getItem(storedKey))?.updatedAt ?? 0,
        });
      }
    }
    const older = selections
      .filter((selection) => selection.key !== key)
      .sort((left, right) => left.updatedAt - right.updatedAt);
    for (const selection of older.slice(
      0,
      Math.max(0, selections.length - maxSelections),
    )) {
      storage.removeItem(selection.key);
    }
    for (const listener of listeners) listener(threadId);
    return true;
  } catch {
    return false;
  }
}

export function subscribeThreadModelSelection(
  threadId: string | null,
  changed: () => void,
): () => void {
  if (threadId === null || typeof window === "undefined")
    return () => undefined;
  const key = selectionKey(threadId);
  const onLocalWrite = (changedThreadId: string) => {
    if (changedThreadId === threadId) changed();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) changed();
  };
  listeners.add(onLocalWrite);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onLocalWrite);
    window.removeEventListener("storage", onStorage);
  };
}
