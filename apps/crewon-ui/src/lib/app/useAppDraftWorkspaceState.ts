import { useState } from "react";

export function useAppDraftWorkspaceState() {
  const [draftWorkspaceCwd, setDraftWorkspaceCwd] = useState<string | null>(null);

  return {
    draftWorkspaceCwd,
    setDraftWorkspaceCwd,
  };
}
