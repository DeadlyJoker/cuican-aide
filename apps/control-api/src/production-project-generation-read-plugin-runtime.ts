import {
  ApplicationError,
  ExtensionReadApplicationService,
  ProjectGenerationReadApplicationService,
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
  assertProjectGenerationReadPluginPublications,
  captureProjectGenerationReadPluginUiConfig,
  type ProjectGenerationReadPluginUiConfig,
} from "./project-generation-read-plugin-ui-composition.ts";
import {
  createProjectGenerationReadPluginRuntime,
  type ProjectGenerationReadPluginRuntime,
} from "./project-history-plugin-runtime.ts";

export type ProductionProjectGenerationReadPluginRuntime =
  ProjectGenerationReadPluginRuntime;

/** Configuration-only current identity/profile scopes for both the source module and original task reader. */
export function createProductionProjectGenerationReadPluginRuntime(
  input: Readonly<{
    configuration: ProjectGenerationReadPluginUiConfig;
    reads: ProjectGenerationReadApplicationService;
    taskReads: ExtensionReadApplicationService;
    ui: ProductionPluginUiConfiguration;
    identity: ProductionControlApiIdentity;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
    fetch?: typeof globalThis.fetch;
  }>,
): ProductionProjectGenerationReadPluginRuntime {
  if (
    !(input.identity instanceof ProductionControlApiIdentity) ||
    !(input.reads instanceof ProjectGenerationReadApplicationService) ||
    !(input.taskReads instanceof ExtensionReadApplicationService)
  )
    throw new Error("production_project_generation_read_composition_invalid");
  const configuration = captureProjectGenerationReadPluginUiConfig(
    input.configuration,
  )!;
  assertProjectGenerationReadPluginPublications(
    configuration,
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
  const runtime = createProjectGenerationReadPluginRuntime({
    configuration,
    reads: input.reads,
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
    close: () => {
      return (closing ??= Promise.allSettled([
        sourceRequests.close(),
        runtime.close(),
      ]).then((results) => {
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(
            failures,
            "production_project_generation_read_plugin_cleanup_failed",
          );
      }));
    },
  });
}

function unavailable(): never {
  throw new ApplicationError(
    "authorization",
    "plugin_project_generation_read_unavailable",
  );
}
