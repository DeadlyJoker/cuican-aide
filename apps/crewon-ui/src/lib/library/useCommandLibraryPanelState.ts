import { useCallback, useRef, useState } from "react";

import type { ControlApiClient } from "@crewon/control-client";
import type { LibraryPanel } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { openControlLibraryAction } from "./controlLibraryActions";

type CommandLibraryPanelStateOptions = Readonly<{
  client: ControlApiClient;
  locale: Locale;
  selectedThreadId: string | null;
}>;

export function useCommandLibraryPanelState({
  client,
  locale,
  selectedThreadId,
}: CommandLibraryPanelStateOptions) {
  const [panel, setPanel] = useState<LibraryPanel | null>(null);
  const loadRequestRef = useRef(0);
  const openPanel = useCallback(
    async (kind: LibraryPanel["kind"]) => {
      const requestId = loadRequestRef.current + 1;
      loadRequestRef.current = requestId;
      await openControlLibraryAction({
        client,
        kind,
        locale,
        selectedThreadId,
        setLibraryPanel: setPanel,
        isCurrent: () => loadRequestRef.current === requestId,
      });
    },
    [client, locale, selectedThreadId],
  );

  return { loadRequestRef, openPanel, panel, setPanel };
}
