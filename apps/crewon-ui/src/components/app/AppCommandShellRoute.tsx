import type { ComponentProps } from "react";

import { AppConfirmDialog } from "./AppConfirmDialog";
import { CommandWorkspace } from "./CommandWorkspace";

type AppCommandShellRouteProps = ComponentProps<typeof CommandWorkspace> & {
  confirmDialog: ComponentProps<typeof AppConfirmDialog>;
};

export function AppCommandShellRoute({
  confirmDialog,
  ...commandWorkspaceProps
}: AppCommandShellRouteProps) {
  return (
    <>
      <CommandWorkspace {...commandWorkspaceProps} />
      <AppConfirmDialog {...confirmDialog} />
    </>
  );
}
