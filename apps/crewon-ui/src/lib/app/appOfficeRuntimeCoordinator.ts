import type { LibraryPanel } from "../domain/crewonDomain";
import type { OfficeRunTurnRecord } from "../office/officeRunPanel";
import {
  createAppOfficeRuntimeHandlers,
  type AppOfficeRuntimeHandlersParams,
} from "./handlers/appOfficeRuntimeHandlers";

type Ref<T> = {
  current: T;
};

type OfficeRunByTurn = Record<string, OfficeRunTurnRecord>;

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
      params.officeRunByTurnRef.current[turnId] = record;
    },
  });
}
