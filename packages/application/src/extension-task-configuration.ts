import {
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  type ExtensionActivation,
  type ExtensionRunBinding,
  type ExtensionScope,
} from "@crewon/domain";
import type { ContentDigester } from "./application-runtime-ports.ts";
import type { ExtensionStore } from "./extension-store-port.ts";
import { ApplicationError } from "./application-error.ts";
export async function loadExtensionTaskConfiguration(input: {
  extensions: ExtensionStore;
  digester: ContentDigester;
  scope: ExtensionScope;
  activation: ExtensionActivation;
  source: ExtensionRunBinding | null;
}) {
  const { scope, activation, source } = input;
  const target = parseExtensionExecutionTarget(
    source?.target ?? activation.target,
  );
  const configuration = await input.extensions.loadExtensionConfiguration({
    ...scope,
    revision: source?.configurationRevision ?? activation.configurationRevision,
  });
  if (configuration === null)
    throw new ApplicationError("notFound", "extension_configuration_not_found");
  const frozen = parseExtensionConfiguration(configuration, input.digester);
  if (
    frozen.tenantId !== scope.tenantId ||
    frozen.spaceId !== scope.spaceId ||
    frozen.pluginId !== scope.pluginId ||
    frozen.revision !==
      (source?.configurationRevision ?? activation.configurationRevision) ||
    frozen.contentDigest !==
      (source?.configurationDigest ?? activation.configurationDigest)
  )
    throw new ApplicationError("conflict", "extension_configuration_mismatch");
  return { target, frozen };
}
