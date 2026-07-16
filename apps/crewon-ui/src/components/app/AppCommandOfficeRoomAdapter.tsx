import type { ComponentProps } from "react";

import type { LibraryPanel } from "../../lib/domain/crewonDomain";
import type { Locale } from "../../lib/i18n";
import {
  officePanelFromRecord,
  officePanelMatchesRecord,
  officeRecordKey,
  type OfficeConfigRecordReference,
} from "../../lib/office/officePanelFromRecord";
import { OfficeWorkspaceView } from "../office/OfficeWorkspaceView";
import type { CommandOfficeRoomAdapter } from "./CommandWorkspace";

type OfficeWorkspaceRuntimeProps = Omit<
  ComponentProps<typeof OfficeWorkspaceView>,
  "panel" | "onBack"
>;

/**
 * Adapts the canonical Office runtime state to the Command Team room without
 * routing through the legacy Library page hierarchy.
 */
export function createAppCommandOfficeRoomAdapter({
  libraryPanel,
  locale,
  refreshRecord,
  runtimeProps,
  setLibraryPanel,
}: {
  libraryPanel: LibraryPanel | null;
  locale: Locale;
  refreshRecord?: (
    record: OfficeConfigRecordReference,
  ) => Promise<OfficeConfigRecordReference | null>;
  runtimeProps: OfficeWorkspaceRuntimeProps;
  setLibraryPanel: (panel: LibraryPanel) => void;
}): CommandOfficeRoomAdapter {
  return {
    open: (record) => {
      setLibraryPanel(officePanelFromRecord(record, locale));
    },
    render: (record, onBack, onDeleted) =>
      officePanelMatchesRecord(libraryPanel, record) && libraryPanel ? (
        <OfficeWorkspaceView
          {...runtimeProps}
          key={officeRecordKey(record)}
          panel={libraryPanel}
          onBack={onBack}
          onPanelAction={async (action) => {
            const succeeded = await runtimeProps.onPanelAction(action);
            if (action.id === "recruit-agent" && succeeded === true) {
              try {
                const refreshedRecord = await refreshRecord?.(record);
                if (refreshedRecord) {
                  setLibraryPanel(
                    officePanelFromRecord(refreshedRecord, locale),
                  );
                }
              } catch {
                // The member is already persisted; keep the action result and
                // allow the next room refresh to reconcile the canonical record.
              }
            }
            if (action.id === "delete-config-file" && succeeded === true) {
              onDeleted();
            }
          }}
        />
      ) : (
        <div className="team-office-room-loading" role="status">
          正在连接办公室运行态…
        </div>
      ),
  };
}
