import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  readThreadModelSelection,
  subscribeThreadModelSelection,
  writeThreadModelSelection,
} from "../../lib/thread/threadModelSelection";
import {
  fallbackCommandModelOptions,
  type CommandModelOption,
} from "../../lib/thread/threadRuntimeSettings";

export function useCommandThreadModelSelection({
  threadId,
  draft,
  modelOptions,
}: Readonly<{
  threadId: string | null;
  draft: boolean;
  modelOptions: readonly CommandModelOption[];
}>) {
  const scope = draft
    ? "draft"
    : threadId === null
      ? "unselected"
      : `thread:${threadId}`;
  const scopedThreadId = draft ? null : threadId;
  const subscribe = useCallback(
    (changed: () => void) =>
      subscribeThreadModelSelection(scopedThreadId, changed),
    [scopedThreadId],
  );
  const snapshot = useCallback(
    () =>
      scopedThreadId === null
        ? null
        : (readThreadModelSelection(scopedThreadId)?.modelId ?? null),
    [scopedThreadId],
  );
  const savedModel = useSyncExternalStore(subscribe, snapshot, () => null);
  const [selection, setSelection] = useState<{
    scope: string;
    model: string | null;
  }>({ scope, model: null });
  // Derive from the new scope immediately; the previous conversation's choice
  // must never be published or submitted during the first render after switching.
  const manualModel = selection.scope === scope ? selection.model : null;
  const available =
    modelOptions.length > 0 ? modelOptions : fallbackCommandModelOptions;
  const defaultModel =
    available.find((option) => option.isDefault)?.value ?? available[0]!.value;
  const model =
    [manualModel, savedModel].find(
      (candidate) =>
        candidate !== null &&
        available.some((option) => option.value === candidate),
    ) ?? defaultModel;
  useEffect(() => {
    setSelection((current) =>
      current.scope === scope ? current : { scope, model: null },
    );
  }, [scope]);
  const selectModel = (nextModel: string) => {
    if (!available.some((option) => option.value === nextModel)) return;
    if (scopedThreadId !== null)
      writeThreadModelSelection(scopedThreadId, nextModel);
    setSelection({ scope, model: nextModel });
  };
  return { model, selectModel };
}
