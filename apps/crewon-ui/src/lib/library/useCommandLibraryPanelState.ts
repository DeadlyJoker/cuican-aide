import { useRef, useState } from "react";

import type { LibraryPanel } from "../domain/crewonDomain";

export function useCommandLibraryPanelState() {
  const [panel, setPanel] = useState<LibraryPanel | null>(null);
  const loadRequestRef = useRef(0);

  return { loadRequestRef, panel, setPanel };
}
