import { useEffect, useState } from "react";

import type { AppServerClient } from "../app-server/appServer";
import {
  loadComposerSlashCommands,
  type ComposerSlashCommand,
} from "../composer/composerSlashCommands";

export function useAppSlashCommands({
  client,
  cwd,
  isConnected,
  isDemoPreview,
  refreshKey = 0,
  selectedThreadId,
}: {
  client: AppServerClient | null | undefined;
  cwd: string;
  isConnected: boolean;
  isDemoPreview: boolean;
  refreshKey?: number;
  selectedThreadId: string | null;
}): ComposerSlashCommand[] {
  const [commands, setCommands] = useState<ComposerSlashCommand[]>([]);

  useEffect(() => {
    let canceled = false;

    void loadComposerSlashCommands({
      client,
      cwd,
      isConnected,
      isDemoPreview,
      threadId: selectedThreadId,
    }).then((nextCommands) => {
      if (!canceled) {
        setCommands(nextCommands);
      }
    });

    return () => {
      canceled = true;
    };
  }, [client, cwd, isConnected, isDemoPreview, refreshKey, selectedThreadId]);

  return commands;
}
