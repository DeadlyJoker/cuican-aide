import { useRef, useState } from "react";

import type { PendingComposerMention } from "../shared/composerMentions";
import type { CommandExecutionIntent } from "../thread/threadRuntimeSettings";
import type { WorkMode } from "../workMode";

export function useAppComposerState() {
  const [workMode, setWorkMode] = useState<WorkMode>("code");
  const [composerValue, setComposerValue] = useState("");
  const [pendingComposerMentions, setPendingComposerMentions] = useState<
    PendingComposerMention[]
  >([]);
  const [pendingContextFile, setPendingContextFile] = useState<{
    path: string;
    text: string;
  } | null>(null);
  const [composerFocusSignal, setComposerFocusSignal] = useState(0);
  const [isSending, setIsSending] = useState(false);
  const [slashCommandRefreshKey, setSlashCommandRefreshKey] = useState(0);
  const [committedExecutionIntent, setCommittedExecutionIntent] = useState<{
    intent: Exclude<CommandExecutionIntent, "none">;
    sequence: number;
  } | null>(null);
  const officeAttachmentConsumerRef = useRef<((path: string) => void) | null>(
    null,
  );

  return {
    committedExecutionIntent,
    composerFocusSignal,
    composerValue,
    isSending,
    officeAttachmentConsumerRef,
    pendingComposerMentions,
    pendingContextFile,
    setSlashCommandRefreshKey,
    setComposerFocusSignal,
    setComposerValue,
    setCommittedExecutionIntent,
    setIsSending,
    setPendingComposerMentions,
    setPendingContextFile,
    slashCommandRefreshKey,
    setWorkMode,
    workMode,
  };
}
