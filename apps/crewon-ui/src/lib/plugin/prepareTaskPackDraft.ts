export type TaskPackDraftHandler = (prompt: string) => string | null;

/** Guard before clearing the composer. Preparing a template never starts a run. */
export function prepareTaskPackDraft(params: {
  prompt: string;
  isSending: boolean;
  currentDraft: string;
  hasAttachments: boolean;
  locale: "zh" | "en";
  startDraft: () => void;
  setComposerValue: (value: string) => void;
}): string | null {
  if (params.isSending || params.currentDraft.trim() || params.hasAttachments)
    return params.locale === "zh"
      ? "任务输入框已有草稿、附件或正在发送。请先处理原输入，再准备模板任务，避免覆盖。"
      : "The composer has a draft, attachments, or is sending. Resolve it before preparing a template task; nothing has been replaced.";
  params.startDraft();
  params.setComposerValue(params.prompt);
  return null;
}
