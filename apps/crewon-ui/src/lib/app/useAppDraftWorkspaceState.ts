import { useState } from "react";

export function useAppDraftWorkspaceState() {
  const [draftWorkspaceCwd, setDraftWorkspaceCwd] = useState<
    string | null | undefined
  >(undefined);

  return {
    draftWorkspaceCwd,
    setDraftWorkspaceCwd,
  };
}
