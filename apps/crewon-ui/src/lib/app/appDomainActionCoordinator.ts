import type { CapabilityPanelItem } from "../capability/capabilityPanelTypes";
import {
  createAppDomainActionHandlers,
  type AppDomainActionHandlersParams,
} from "./handlers/appDomainActionHandlers";

export type AppDomainActionCoordinatorParams = Omit<
  AppDomainActionHandlersParams,
  "handleCapabilityPanelItem"
> & {
  getCapabilityPanelItemHandler: () => (
    item: CapabilityPanelItem,
  ) => Promise<void>;
};

export function createAppDomainActionCoordinator(
  params: AppDomainActionCoordinatorParams,
) {
  return createAppDomainActionHandlers({
    ...params,
    handleCapabilityPanelItem: (item) =>
      params.getCapabilityPanelItemHandler()(item),
  });
}
