import { randomBytes } from "node:crypto";
import {
  ApplicationError,
  PluginUiApplicationService,
  type ApplicationClock,
  type PluginInstallationStore,
  type PluginUiActionPort,
  type PluginUiCommittedTaskPort,
  type PluginUiPackageContext,
  type PluginUiPackagePort,
} from "@crewon/application";
import { LocalPluginUiPackageReader } from "@crewon/plugin-host";
import type { PluginUiControlService } from "./plugin-control-route.ts";
import {
  AuthorityPluginHostProfile,
  DynamicPluginUiAuthorization,
} from "./plugin-security-adapters.ts";
import {
  HttpPluginProfileAuthorityPort,
  HttpPluginUiPolicyDecisionPort,
} from "./plugin-security-http-ports.ts";
import { AbortSecurityDeadline } from "./production-security-adapters.ts";
import {
  parseProductionPluginUiConfiguration,
  type ProductionPluginUiConfiguration,
} from "./production-plugin-ui-environment.ts";

export type ProductionPluginUiConfig = Readonly<{
  configuration: ProductionPluginUiConfiguration;
  /** Must enter the existing authorized business/Run boundary; no automatic Node dispatch. */
  actions?: PluginUiActionPort;
  /** Trusted verifier for original durable task receipts; absent for read-only deployments. */
  committedTasks?: PluginUiCommittedTaskPort;
}>;
export type ProductionPluginUiRuntime = Readonly<{
  service: PluginUiControlService;
  close(): void;
}>;

/** Stateless scoped readers share installed bytes, never authority, profile selection or leases. */
export function createProductionPluginUiRuntime(
  input: ProductionPluginUiConfig,
  dependencies: Readonly<{
    ledger: PluginInstallationStore;
    clock: ApplicationClock;
    fetch?: typeof globalThis.fetch;
  }>,
): ProductionPluginUiRuntime {
  const configuration = parseProductionPluginUiConfiguration(
    input.configuration,
  );
  if (
    input.actions !== undefined &&
    typeof input.actions?.invoke !== "function"
  )
    throw new Error("production_plugin_ui_actions_invalid");
  const invokeAction = input.actions?.invoke.bind(input.actions);
  const committedTasks = input.committedTasks;
  if (
    committedTasks !== undefined &&
    (typeof committedTasks.isOutcome !== "function" ||
      typeof committedTasks.verify !== "function")
  )
    throw new Error("production_plugin_ui_committed_tasks_invalid");
  const committedSnapshot =
    committedTasks === undefined
      ? undefined
      : Object.freeze({
          isOutcome: committedTasks.isOutcome.bind(committedTasks),
          verify: committedTasks.verify.bind(committedTasks),
        });
  const lifetime = new AbortController();
  const available = () => {
    if (lifetime.signal.aborted) unavailable();
  };
  const deadline = new AbortSecurityDeadline();
  const scopedDeadline = {
    run: <T>(timeoutMs: number, task: (signal: AbortSignal) => Promise<T>) => {
      available();
      return deadline.run(timeoutMs, (signal) =>
        task(AbortSignal.any([signal, lifetime.signal])),
      );
    },
  };
  const reader = (context: PluginUiPackageContext) => {
    available();
    return new LocalPluginUiPackageReader({
      profile: context.scope,
      installRoot: configuration.installRoot,
      authorizePublication: async ({ package: pkg, descriptor }) => {
        available();
        const approved = configuration.publications.find(
          (item) =>
            item.packageDigest === pkg.packageDigest &&
            item.pluginId === descriptor.pluginId &&
            item.publisherId === descriptor.publisherId,
        );
        if (!approved)
          throw new ApplicationError(
            "authorization",
            "plugin_ui_publication_denied",
          );
        // Local reader validates every approved path against the verified inventory,
        // requires the actual UI entry and repeats this check around asset reads.
        return approved.publicAssets;
      },
    });
  };
  const packages: PluginUiPackagePort = {
    verify: (context) => reader(context).verify(context),
    readAsset: (context) => reader(context).readAsset(context),
  };
  let application: PluginUiApplicationService | null =
    new PluginUiApplicationService({
      store: dependencies.ledger,
      clock: dependencies.clock,
      packages,
      profiles: new AuthorityPluginHostProfile({
        authority: new HttpPluginProfileAuthorityPort({
          ...configuration.profileAuthority,
          fetch: dependencies.fetch,
        }),
        timeoutMs: configuration.timeoutMs,
        deadline: scopedDeadline,
      }),
      authorization: new DynamicPluginUiAuthorization({
        policy: new HttpPluginUiPolicyDecisionPort({
          ...configuration.policyAuthority,
          fetch: dependencies.fetch,
        }),
        timeoutMs: configuration.timeoutMs,
        deadline: scopedDeadline,
      }),
      ids: { nextId: () => randomBytes(32).toString("base64url") },
      actions: {
        invoke: async (request) => {
          available();
          if (invokeAction === undefined)
            throw new ApplicationError(
              "conflict",
              "plugin_ui_actions_unavailable",
            );
          return invokeAction(request);
        },
      },
      ...(committedSnapshot === undefined
        ? {}
        : { committedTasks: committedSnapshot }),
    });
  const call = async <T>(
    work: (service: PluginUiApplicationService) => Promise<T>,
  ): Promise<T> => {
    available();
    const current = application;
    if (current === null) unavailable();
    return new Promise<T>((resolve, reject) => {
      const abort = () =>
        reject(
          new ApplicationError("conflict", "plugin_ui_service_unavailable"),
        );
      lifetime.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          available();
          return work(current);
        })
        .then((result) => {
          available();
          resolve(result);
        })
        .catch(reject)
        .finally(() => lifetime.signal.removeEventListener("abort", abort));
      if (lifetime.signal.aborted) abort();
    });
  };
  const service: PluginUiControlService = Object.freeze({
    catalog: (...args) => call((current) => current.catalog(...args)),
    openMount: (...args) => call((current) => current.openMount(...args)),
    validateMount: (...args) =>
      call((current) => current.validateMount(...args)),
    readAsset: (...args) => call((current) => current.readAsset(...args)),
    closeMount: (...args) => call((current) => current.closeMount(...args)),
    invoke: (...args) => {
      if (committedSnapshot === undefined)
        return call((current) => current.invoke(...args));
      available();
      const current = application;
      if (current === null) unavailable();
      // The application returns late success only for a verified durable receipt. JSON results
      // still run its policy fence, whose requests are cancelled by this runtime's lifetime.
      return current.invoke(...args);
    },
  });
  return Object.freeze({
    service,
    close: () => {
      lifetime.abort();
      application = null;
    },
  });
}
function unavailable(): never {
  throw new ApplicationError("conflict", "plugin_ui_service_unavailable");
}
