import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";

const PROJECT_CONVERSATION_SERVICES = new Set([
  "crewon.project-conversations",
  "crewon.project-conversation-association",
  "crewon.project-generation-contexts",
]);

/** Older modules consume the Host's task projection without their own project conversation entrypoint. */
export function needsInstalledPluginLegacyTaskNavigation(
  descriptor: Pick<PluginPackageDescriptor, "requires">,
): boolean {
  return (
    descriptor.requires.some(
      (item) =>
        item.service === "crewon.tasks" &&
        (item.apiVersion === "1" || item.apiVersion === "2"),
    ) &&
    !descriptor.requires.some((item) =>
      PROJECT_CONVERSATION_SERVICES.has(item.service),
    )
  );
}
