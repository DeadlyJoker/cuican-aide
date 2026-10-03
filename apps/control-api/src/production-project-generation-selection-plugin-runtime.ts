import {
  ApplicationError,
  ExtensionReadApplicationService,
  ProjectConceptSelectionApplicationService,
} from "@crewon/application";
import type { PluginUiHostServiceAvailabilityPort } from "@crewon/plugin-host";
import {
  AbortSecurityDeadline,
  ProductionControlApiIdentity,
} from "./production-security-adapters.ts";
import { AuthorityPluginHostProfile } from "./plugin-security-adapters.ts";
import { HttpPluginProfileAuthorityPort } from "./plugin-security-http-ports.ts";
import {
  captureInstalledPluginReadRequestScope,
  InstalledPluginRequestOwner,
} from "./installed-plugin-request-owner.ts";
import type { ProductionPluginUiConfiguration } from "./production-plugin-ui-environment.ts";
import {
  assertCreativeProjectPluginPublications,
  type CreativeProjectPluginUiConfig,
} from "./creative-project-plugin-ui-composition.ts";
import {
  createProjectGenerationSelectionPluginRuntime,
  type ProjectGenerationSelectionPluginRuntime,
} from "./project-history-plugin-runtime.ts";

export type ProductionProjectGenerationSelectionPluginRuntime =
  ProjectGenerationSelectionPluginRuntime;

/** Configuration-only source scope and original Run reader; selecting has no execution peer. */
export function createProductionProjectGenerationSelectionPluginRuntime(
  input: Readonly<{
    configuration: CreativeProjectPluginUiConfig;
    selections: ProjectConceptSelectionApplicationService;
    taskReads: ExtensionReadApplicationService;
    ui: ProductionPluginUiConfiguration;
    identity: ProductionControlApiIdentity;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
    fetch?: typeof globalThis.fetch;
  }>,
): ProductionProjectGenerationSelectionPluginRuntime {
  if (
    !(input.identity instanceof ProductionControlApiIdentity) ||
    !(input.selections instanceof ProjectConceptSelectionApplicationService) ||
    !(input.taskReads instanceof ExtensionReadApplicationService)
  )
    throw new Error(
      "production_project_generation_selection_composition_invalid",
    );
  assertCreativeProjectPluginPublications(
    input.configuration,
    input.ui.publications,
  );
  captureInstalledPluginReadRequestScope(input.taskReads);
  let requests: InstalledPluginRequestOwner | undefined;
  const deadline = new AbortSecurityDeadline();
  const profiles = new AuthorityPluginHostProfile({
    authority: new HttpPluginProfileAuthorityPort({
      ...input.ui.profileAuthority,
      fetch: input.fetch,
    }),
    timeoutMs: input.ui.timeoutMs,
    deadline: {
      run: (timeoutMs, task) =>
        deadline.run(timeoutMs, (signal) => {
          if (requests === undefined) unavailable();
          return task(AbortSignal.any([signal, requests.currentSignal()]));
        }),
    },
  });
  requests = new InstalledPluginRequestOwner({
    identity: input.identity,
    profiles,
  });
  const sourceRequests = requests;
  const runtime = createProjectGenerationSelectionPluginRuntime({
    configuration: input.configuration,
    selections: input.selections,
    taskReads: input.taskReads,
    requests: sourceRequests,
    publications: input.ui.publications,
    ...(input.hostUiServices === undefined
      ? {}
      : { hostUiServices: input.hostUiServices }),
  });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    ...runtime,
    close: () =>
      (closing ??= Promise.allSettled([
        sourceRequests.close(),
        runtime.close(),
      ]).then((results) => {
        const failures = results.flatMap((r) =>
          r.status === "rejected" ? [r.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(
            failures,
            "production_project_generation_selection_cleanup_failed",
          );
      })),
  });
}
function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_generation_selection_unavailable",
  );
}
