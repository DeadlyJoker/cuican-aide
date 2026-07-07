import { useState } from "react";

import type { PendingComposerMention } from "../shared/composerMentions";
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

  return {
    composerFocusSignal,
    composerValue,
    isSending,
    pendingComposerMentions,
    pendingContextFile,
    setSlashCommandRefreshKey,
    setComposerFocusSignal,
    setComposerValue,
    setIsSending,
    setPendingComposerMentions,
    setPendingContextFile,
    slashCommandRefreshKey,
    setWorkMode,
    workMode,
  };
}
