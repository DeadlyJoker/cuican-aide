import { useState } from "react";

/** Directory visibility is controlled only by the user's collapse action. */
export function useCommandSidebarCollapse() {
  return useState(false);
}
