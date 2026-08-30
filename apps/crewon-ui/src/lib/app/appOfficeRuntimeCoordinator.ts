import type { LibraryPanel } from "../domain/crewonDomain";
import {
  officeDelegationDispatchFailureNotice,
  officeRunActiveTurnByThread,
  officeRunSyncedPanel,
  officeRunTurnRecord,
  type OfficeRunTurnRecord,
} from "../office/officeRunPanel";
import { officeConfigForThread } from "../domain/crewonDomain";
import {
  autoDispatchNextOfficeDelegationFromClientAction,
  syncOfficeRunFromClientAction,
} from "./appTurnCompletionActions";
import { upsertTurnInThread } from "../thread/threadModel";
import {
  createAppOfficeRuntimeHandlers,
  type AppOfficeRuntimeHandlersParams,
} from "./handlers/appOfficeRuntimeHandlers";

type Ref<T> = {
  current: T;
};

type OfficeRunByTurn = Record<string, OfficeRunTurnRecord>;
const OFFICE_RUN_SYNC_FALLBACK_DELAYS_MS = [100, 300, 700, 1500, 3000];

export type AppOfficeRuntimeCoordinatorParams = Omit<
  AppOfficeRuntimeHandlersParams,
  "getLibraryPanel" | "recordOfficeRunTurn"
> & {
  libraryPanelRef: Ref<LibraryPanel | null>;
  officeRunByTurnRef: Ref<OfficeRunByTurn>;
};

export function createAppOfficeRuntimeCoordinator(
  params: AppOfficeRuntimeCoordinatorParams,
) {
  return createAppOfficeRuntimeHandlers({
    ...params,
    getLibraryPanel: () => params.libraryPanelRef.current,
    recordOfficeRunTurn: (turnId, record) => {
      if (params.officeRunByTurnRef.current[turnId]) {
        return;
      }
      params.officeRunByTurnRef.current[turnId] = record;
      scheduleOfficeRunCompletionSync(params, turnId, record);
    },
  });
}

function scheduleOfficeRunCompletionSync(
  params: AppOfficeRuntimeCoordinatorParams,
  turnId: string,
  record: OfficeRunTurnRecord,
): void {
  if (!params.client) {
    return;
  }

  void (async () => {
    for (const delayMs of OFFICE_RUN_SYNC_FALLBACK_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (!params.officeRunByTurnRef.current[turnId]) {
        return;
      }

      const thread = await params.client
        ?.readThread(record.turnThreadId ?? record.threadId)
        .catch(() => null);
      const turn = thread?.turns.find((candidate) => candidate.id === turnId);
      if (!turn || !officeRunTurnIsTerminal(turn.status)) {
        continue;
      }

      const currentPanel = params.libraryPanelRef.current;
      const config =
        currentPanel?.kind === "office" &&
        currentPanel.workspace?.threadId === record.threadId
          ? officeConfigForThread(
              currentPanel.title,
              currentPanel.subtitle,
              currentPanel.workspace,
              record.threadId,
            )
          : record.config;
      const syncedConfig = await syncOfficeRunFromClientAction({
        client: params.client,
        config,
        locale: params.locale,
        record,
        turn,
      }).catch(() => null);
      if (!syncedConfig) {
        return;
      }

      delete params.officeRunByTurnRef.current[turnId];
      params.setLibraryPanel((currentPanel) =>
        officeRunSyncedPanel(currentPanel, {
          config: syncedConfig,
          threadId: record.threadId,
        }),
      );
      const dispatchResponse =
        await autoDispatchNextOfficeDelegationFromClientAction({
          client: params.client,
          config: syncedConfig,
          locale: params.locale,
          record,
        }).catch((error) => {
          params.setNotice(
            officeDelegationDispatchFailureNotice(error, params.locale),
          );
          return null;
        });
      if (dispatchResponse) {
        params.officeRunByTurnRef.current[dispatchResponse.turn.id] =
          officeRunTurnRecord(record.cwd, dispatchResponse);
        params.setThreads((current) =>
          upsertTurnInThread(
            current,
            dispatchResponse.threadId,
            dispatchResponse.turn,
          ),
        );
        params.setActiveTurnByThread((current) =>
          officeRunActiveTurnByThread(current, dispatchResponse),
        );
        params.setLibraryPanel((currentPanel) =>
          officeRunSyncedPanel(currentPanel, {
            config: dispatchResponse.config,
            threadId: record.threadId,
          }),
        );
      }
      return;
    }
  })();
}

function officeRunTurnIsTerminal(status: string): boolean {
  return (
    status === "completed" || status === "failed" || status === "interrupted"
  );
}
