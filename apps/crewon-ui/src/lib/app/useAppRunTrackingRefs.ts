import { useRef } from "react";

import type {
  AutomationRunTurnRecord,
  OfficeRunTurnRecord,
} from "./appTurnCompletionNotificationHandler";

export function useAppRunTrackingRefs() {
  const automationRunByTurnRef = useRef<
    Record<string, AutomationRunTurnRecord>
  >({});
  const officeRunByTurnRef = useRef<Record<string, OfficeRunTurnRecord>>({});

  return {
    automationRunByTurnRef,
    officeRunByTurnRef,
  };
}
