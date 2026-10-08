import {
  hasProjectHistoricalQueryHostAvailability,
  preserveProjectHistoricalQueryHostAvailability,
} from "./plugin-project-historical-query-host-availability.ts";
import {
  CREWON_PROJECT_HISTORICAL_QUERIES_SERVICE,
  CREWON_PROJECT_HISTORICAL_QUERIES_API_VERSION,
} from "@crewon/contracts/plugins";
import { ApplicationError } from "@crewon/application";
import {
  parsePluginProfileScope,
  pluginInstallationDigest,
  type PluginProfileScope,
} from "@crewon/domain";
import {
  CREWON_CREATIVE_PROJECTS_SERVICE,
  CREWON_CREATIVE_PROJECTS_API_VERSION,
  CREWON_PROJECT_GENERATIONS_SERVICE,
  CREWON_PROJECT_GENERATIONS_API_VERSION,
  CREWON_PROJECT_GENERATION_READS_SERVICE,
  CREWON_PROJECT_GENERATION_READS_API_VERSION,
  CREWON_PROJECT_GENERATION_QUERIES_SERVICE,
  CREWON_PROJECT_GENERATION_QUERIES_API_VERSION,
  CREWON_PROJECT_GENERATION_CONTEXTS_SERVICE,
  CREWON_PROJECT_GENERATION_CONTEXTS_API_VERSION,
  CREWON_PROJECT_GENERATION_SELECTIONS_SERVICE,
  CREWON_PROJECT_GENERATION_SELECTIONS_API_VERSION,
  CREWON_PLUGIN_UI_RECOVERY_SERVICE,
  CREWON_PLUGIN_UI_RECOVERY_API_VERSION,
  type PluginPackageDescriptor,
  type PluginServiceRequirement,
} from "@crewon/contracts/plugins";
import type { PluginActivationCandidate } from "./plugin-node-host.ts";
import {
  CREWON_PROJECT_TEXTS_SERVICE,
  CREWON_PROJECT_TEXTS_API_VERSION,
} from "@crewon/contracts/project-texts-ui";
import { preserveDeferredPluginUiHostServiceAvailability } from "./plugin-ui-deferred-host-service-availability.ts";
import {
  CREWON_PROJECT_OUTLINES_SERVICE,
  CREWON_PROJECT_OUTLINES_API_VERSION,
} from "@crewon/contracts/project-outlines";
import {
  hasProjectGenerationHostAvailability,
  preserveProjectGenerationHostAvailability,
} from "./plugin-project-generation-host-availability.ts";
import {
  hasProjectGenerationContextHostAvailability,
  preserveProjectGenerationContextHostAvailability,
} from "./plugin-project-generation-context-host-availability.ts";

import {
  hasProjectGenerationQueryHostAvailability,
  preserveProjectGenerationQueryHostAvailability,
} from "./plugin-project-generation-query-host-availability.ts";

/** Host protocol availability never supplies a Node service or grants an invocation permission. */
export type PluginUiHostServiceAvailabilityPort = Readonly<{
  isAvailable(
    input: Readonly<{
      scope: PluginProfileScope;
      candidate: PluginActivationCandidate;
      requirement: PluginServiceRequirement;
    }>,
  ): boolean;
}>;

/** Capture the trusted callback once; getters, later method replacement and async answers fail closed. */
export function capturePluginUiHostServiceAvailability(
  port: PluginUiHostServiceAvailabilityPort | undefined,
): PluginUiHostServiceAvailabilityPort | undefined {
  if (port === undefined) return undefined;
  if (port === null || typeof port !== "object") invalidPort();
  let owner: object | null = port;
  let callback: unknown;
  for (
    let depth = 0;
    owner !== null && depth < 16;
    depth++, owner = Object.getPrototypeOf(owner)
  ) {
    const own = Object.getOwnPropertyDescriptor(owner, "isAvailable");
    if (own === undefined) continue;
    if (!("value" in own) || typeof own.value !== "function") invalidPort();
    callback = own.value;
    break;
  }
  if (typeof callback !== "function") invalidPort();
  const captured = Function.prototype.bind.call(
    callback,
    port,
  ) as PluginUiHostServiceAvailabilityPort["isAvailable"];
  const result = preserveProjectGenerationHostAvailability(
    port,
    Object.freeze({
      isAvailable: (input: Parameters<typeof captured>[0]) => {
        try {
          return synchronousAvailable(captured(input));
        } catch {
          return false;
        }
      },
    }),
  );
  return preserveDeferredPluginUiHostServiceAvailability(
    port,
    preserveProjectGenerationQueryHostAvailability(
      port,
      preserveProjectHistoricalQueryHostAvailability(
        port,
        preserveProjectGenerationContextHostAvailability(port, result),
      ),
    ),
  );
}

/** Extend only this metadata service; every older capability retains its captured original dispatcher. */
export function appendProjectGenerationSelectionUiServiceAvailability(
  input: Readonly<{
    selection: PluginUiHostServiceAvailabilityPort;
    fallback?: PluginUiHostServiceAvailabilityPort;
  }>,
): PluginUiHostServiceAvailabilityPort {
  const selection = capturePluginUiHostServiceAvailability(input.selection)!;
  const fallback = capturePluginUiHostServiceAvailability(input.fallback);
  let port: PluginUiHostServiceAvailabilityPort = Object.freeze({
    isAvailable: (request) =>
      request.requirement.service ===
      CREWON_PROJECT_GENERATION_SELECTIONS_SERVICE
        ? selection.isAvailable(request)
        : fallback?.isAvailable(request) === true,
  });
  if (fallback !== undefined) {
    port = preserveProjectGenerationHostAvailability(fallback, port);
    port = preserveProjectGenerationContextHostAvailability(fallback, port);
    port = preserveProjectGenerationQueryHostAvailability(fallback, port);
    port = preserveProjectHistoricalQueryHostAvailability(fallback, port);
  }
  return port;
}

/** Recovery is independently assembled; preserve every older owner's private availability binding. */
export function appendPluginUiRecoveryServiceAvailability(
  input: Readonly<{
    recovery: PluginUiHostServiceAvailabilityPort;
    fallback?: PluginUiHostServiceAvailabilityPort;
  }>,
): PluginUiHostServiceAvailabilityPort {
  const recovery = capturePluginUiHostServiceAvailability(input.recovery)!;
  const fallback = capturePluginUiHostServiceAvailability(input.fallback);
  let port: PluginUiHostServiceAvailabilityPort = Object.freeze({
    isAvailable: (request) =>
      request.requirement.service === CREWON_PLUGIN_UI_RECOVERY_SERVICE
        ? request.requirement.apiVersion ===
            CREWON_PLUGIN_UI_RECOVERY_API_VERSION &&
          recovery.isAvailable(request)
        : fallback?.isAvailable(request) === true,
  });
  if (fallback !== undefined) {
    port = preserveProjectGenerationHostAvailability(fallback, port);
    port = preserveProjectGenerationContextHostAvailability(fallback, port);
    port = preserveProjectGenerationQueryHostAvailability(fallback, port);
    port = preserveProjectHistoricalQueryHostAvailability(fallback, port);
  }
  return port;
}

/** Text metadata is independent; retain older owners without supplying their private brands. */
export function appendProjectTextUiServiceAvailability(
  input: Readonly<{
    texts: PluginUiHostServiceAvailabilityPort;
    outlines?: PluginUiHostServiceAvailabilityPort;
    fallback?: PluginUiHostServiceAvailabilityPort;
  }>,
): PluginUiHostServiceAvailabilityPort {
  const texts = capturePluginUiHostServiceAvailability(input.texts)!;
  const outlines = capturePluginUiHostServiceAvailability(input.outlines);
  const fallback = capturePluginUiHostServiceAvailability(input.fallback);
  let port: PluginUiHostServiceAvailabilityPort = Object.freeze({
    isAvailable: (request) =>
      request.requirement.service === CREWON_PROJECT_OUTLINES_SERVICE
        ? request.requirement.apiVersion ===
            CREWON_PROJECT_OUTLINES_API_VERSION &&
          outlines?.isAvailable(request) === true
        : request.requirement.service === CREWON_PROJECT_TEXTS_SERVICE
          ? request.requirement.apiVersion ===
              CREWON_PROJECT_TEXTS_API_VERSION && texts.isAvailable(request)
          : fallback?.isAvailable(request) === true,
  });
  if (fallback !== undefined) {
    port = preserveProjectGenerationHostAvailability(fallback, port);
    port = preserveProjectGenerationContextHostAvailability(fallback, port);
    port = preserveProjectGenerationQueryHostAvailability(fallback, port);
    port = preserveProjectHistoricalQueryHostAvailability(fallback, port);
  }
  return port;
}

/** An independent metadata recovery owner never grants Node execution or older protocol availability. */
export function appendProjectTextRecoveryUiServiceAvailability(
  input: Readonly<{
    recovery: PluginUiHostServiceAvailabilityPort;
    fallback?: PluginUiHostServiceAvailabilityPort;
  }>,
): PluginUiHostServiceAvailabilityPort {
  const recovery = capturePluginUiHostServiceAvailability(input.recovery)!;
  const fallback = capturePluginUiHostServiceAvailability(input.fallback);
  let port: PluginUiHostServiceAvailabilityPort = Object.freeze({
    isAvailable: (request) =>
      request.requirement.service === "crewon.project-text-recovery"
        ? request.requirement.apiVersion === "1" &&
          recovery.isAvailable(request)
        : fallback?.isAvailable(request) === true,
  });
  if (fallback !== undefined) {
    port = preserveProjectGenerationHostAvailability(fallback, port);
    port = preserveProjectGenerationContextHostAvailability(fallback, port);
    port = preserveProjectGenerationQueryHostAvailability(fallback, port);
    port = preserveProjectHistoricalQueryHostAvailability(fallback, port);
  }
  return port;
}

/** Conversation metadata publishes only its own protocol, never an executable Run grant. */
export function appendProjectConversationUiServiceAvailability(
  input: Readonly<{
    conversations: PluginUiHostServiceAvailabilityPort;
    fallback?: PluginUiHostServiceAvailabilityPort;
  }>,
): PluginUiHostServiceAvailabilityPort {
  const conversations = capturePluginUiHostServiceAvailability(
    input.conversations,
  )!;
  const fallback = capturePluginUiHostServiceAvailability(input.fallback);
  let port: PluginUiHostServiceAvailabilityPort = Object.freeze({
    isAvailable: (request) =>
      request.requirement.service === "crewon.project-conversations" ||
      request.requirement.service === "crewon.project-conversation-association"
        ? request.requirement.apiVersion === "1" &&
          conversations.isAvailable(request)
        : fallback?.isAvailable(request) === true,
  });
  if (fallback !== undefined) {
    port = preserveProjectGenerationHostAvailability(fallback, port);
    port = preserveProjectGenerationContextHostAvailability(fallback, port);
    port = preserveProjectGenerationQueryHostAvailability(fallback, port);
    port = preserveProjectHistoricalQueryHostAvailability(fallback, port);
  }
  return port;
}

/** Known optional protocols can be declared without an owner; required generation protocols need actual assembly. */
export function assertUiOnlyServiceDeclarations(
  descriptor: PluginPackageDescriptor,
  hostUiServices?: PluginUiHostServiceAvailabilityPort,
): void {
  if (descriptor.entrypoints.node !== null) return;
  if (descriptor.requires.length !== 0 && hostUiServices !== undefined)
    capturePluginUiHostServiceAvailability(hostUiServices);
  if (
    descriptor.provides.length !== 0 ||
    descriptor.requires.some(
      (requirement) =>
        !(
          (requirement.service === CREWON_PROJECT_GENERATION_READS_SERVICE &&
            requirement.apiVersion ===
              CREWON_PROJECT_GENERATION_READS_API_VERSION) ||
          (requirement.service ===
            CREWON_PROJECT_GENERATION_SELECTIONS_SERVICE &&
            requirement.apiVersion ===
              CREWON_PROJECT_GENERATION_SELECTIONS_API_VERSION) ||
          (requirement.service === CREWON_PLUGIN_UI_RECOVERY_SERVICE &&
            requirement.apiVersion === CREWON_PLUGIN_UI_RECOVERY_API_VERSION) ||
          (requirement.service === CREWON_PROJECT_TEXTS_SERVICE &&
            requirement.apiVersion === CREWON_PROJECT_TEXTS_API_VERSION &&
            (requirement.optional || hostUiServices !== undefined)) ||
          (requirement.service === "crewon.project-outlines" &&
            requirement.apiVersion === "2" &&
            (requirement.optional || hostUiServices !== undefined)) ||
          ((requirement.service === "crewon.project-foundation" ||
            requirement.service === "crewon.project-source-uploads") &&
            requirement.apiVersion === "1" &&
            (requirement.optional || hostUiServices !== undefined)) ||
          ((requirement.service === "crewon.project-media-inputs" ||
            requirement.service === "crewon.project-media-results" ||
            requirement.service === "crewon.project-media-result-actions") &&
            requirement.apiVersion === "1" &&
            (requirement.optional || hostUiServices !== undefined)) ||
          (requirement.service === "crewon.project-text-recovery" &&
            requirement.apiVersion === "1" &&
            (requirement.optional || hostUiServices !== undefined)) ||
          (((requirement.service === "crewon.project-assets" &&
            ["1", "2"].includes(requirement.apiVersion)) ||
            (requirement.service === "crewon.project-asset-recovery" &&
              ["1", "2"].includes(requirement.apiVersion))) &&
            (requirement.optional || hostUiServices !== undefined)) ||
          ((requirement.service === "crewon.project-conversations" ||
            requirement.service ===
              "crewon.project-conversation-association") &&
            requirement.apiVersion === "1" &&
            (requirement.optional || hostUiServices !== undefined)) ||
          (requirement.service === "crewon.project-text-plans" &&
            requirement.apiVersion === "1" &&
            (requirement.optional || hostUiServices !== undefined)) ||
          (requirement.service === CREWON_PROJECT_GENERATIONS_SERVICE &&
            requirement.apiVersion === CREWON_PROJECT_GENERATIONS_API_VERSION &&
            (requirement.optional ||
              (hostUiServices !== undefined &&
                hasProjectGenerationHostAvailability(hostUiServices)))) ||
          (requirement.service === CREWON_PROJECT_GENERATION_CONTEXTS_SERVICE &&
            requirement.apiVersion ===
              CREWON_PROJECT_GENERATION_CONTEXTS_API_VERSION &&
            (requirement.optional ||
              (hostUiServices !== undefined &&
                hasProjectGenerationContextHostAvailability(
                  hostUiServices,
                )))) ||
          (requirement.service === CREWON_PROJECT_HISTORICAL_QUERIES_SERVICE &&
            requirement.apiVersion ===
              CREWON_PROJECT_HISTORICAL_QUERIES_API_VERSION &&
            (requirement.optional ||
              (hostUiServices !== undefined &&
                hasProjectHistoricalQueryHostAvailability(hostUiServices)))) ||
          (requirement.service === CREWON_PROJECT_GENERATION_QUERIES_SERVICE &&
            requirement.apiVersion ===
              CREWON_PROJECT_GENERATION_QUERIES_API_VERSION &&
            (requirement.optional ||
              (hostUiServices !== undefined &&
                hasProjectGenerationQueryHostAvailability(hostUiServices)))) ||
          (hostUiServices !== undefined &&
            requirement.service === CREWON_CREATIVE_PROJECTS_SERVICE &&
            requirement.apiVersion === CREWON_CREATIVE_PROJECTS_API_VERSION)
        ),
    )
  )
    unsupported();
}

/** Invoke at enabled preparation, every recovery preflight and the final synchronous publication fence. */
export function assertPluginUiHostServiceAvailability(
  input: Readonly<{
    scope: PluginProfileScope;
    candidate: PluginActivationCandidate;
    hostUiServices?: PluginUiHostServiceAvailabilityPort;
  }>,
): void {
  const { descriptor } = input.candidate;
  assertUiOnlyServiceDeclarations(descriptor, input.hostUiServices);
  if (descriptor.entrypoints.node !== null) return;
  const scope = parsePluginProfileScope(input.scope);
  const candidate = Object.freeze({
    descriptor,
    packageDigest: pluginInstallationDigest(input.candidate.packageDigest),
  });
  for (const requirement of descriptor.requires) {
    if (requirement.optional) continue;
    let available = false;
    try {
      available = synchronousAvailable(
        input.hostUiServices?.isAvailable(
          Object.freeze({ scope, candidate, requirement }),
        ),
      );
    } catch {
      /* Availability failures never broaden an enabled selection. */
    }
    if (!available)
      throw new ApplicationError("conflict", "plugin_dependency_unavailable");
  }
}
function synchronousAvailable(answer: unknown): boolean {
  if (answer === true) return true;
  // Observe a real Promise's late rejection without consulting arbitrary then getters.
  // Async or thenable answers never postpone the synchronous publication decision.
  if (
    (typeof answer === "object" && answer !== null) ||
    typeof answer === "function"
  ) {
    try {
      Promise.prototype.then.call(
        answer,
        () => undefined,
        () => undefined,
      );
    } catch {
      /* A non-Promise answer is unavailable. */
    }
  }
  return false;
}
function unsupported(): never {
  throw new ApplicationError("conflict", "plugin_ui_only_services_unsupported");
}
function invalidPort(): never {
  throw new ApplicationError(
    "internal",
    "plugin_ui_host_service_availability_invalid",
  );
}
