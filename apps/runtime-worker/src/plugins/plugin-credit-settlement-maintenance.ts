import {
  PluginCreditSettlementService,
  type PluginCreditSettlementLocator,
  type PluginCreditSettlementRecoveryPage,
  type PluginCreditSettlementRecoveryScope,
  type PluginCreditSettlementRecoveryStore,
  type PluginCreditSettlementResult,
} from "@crewon/application";
import { pluginInstallationOpaqueId } from "@crewon/domain";
import type {
  PluginCreditSettlementDeploymentAuthority,
  PluginCreditSettlementMaintenancePort,
  PluginCreditSettlementRuntimeConfig,
} from "./plugin-credit-settlement-runtime-types.ts";

type FailureCode =
  | "authorization_unavailable"
  | "scan_failed"
  | "candidate_failed"
  | "round_budget_exhausted"
  | null;
export type PluginCreditSettlementMaintenanceSnapshot = Readonly<{
  pending: boolean;
  closed: boolean;
  withdrawn: boolean;
  afterRunId: string | null;
  retainedCandidates: number;
  rounds: number;
  scans: number;
  inspected: number;
  committed: number;
  replayed: number;
  existing: number;
  held: number;
  notReady: number;
  notPaid: number;
  evidenceChanged: number;
  failures: number;
  budgetExpirations: number;
  lastFailureCode: FailureCode;
}>;
export interface PluginCreditSettlementMaintenance
  extends PluginCreditSettlementMaintenancePort {
  snapshot(): PluginCreditSettlementMaintenanceSnapshot;
}

type StoreOwner = Readonly<{ assertCurrent(): void }>;
type Inputs = Readonly<{
  config: PluginCreditSettlementRuntimeConfig;
  storeFactory(owner: StoreOwner): PluginCreditSettlementRecoveryStore;
}>;
const done = Promise.resolve();

function invalid(): never {
  throw new Error("plugin_credit_settlement_runtime_configuration_invalid");
}
function fields(
  input: unknown,
  names: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.getOwnPropertySymbols(input).length !== 0
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Object.keys(descriptors).sort().join("\0") !==
      [...names].sort().join("\0") ||
    Object.values(descriptors).some(
      (field) => !field.enumerable || !Object.hasOwn(field, "value"),
    )
  )
    invalid();
  return Object.fromEntries(
    Object.entries(descriptors).map(([name, field]) => [name, field.value]),
  );
}
function integer(input: unknown, maximum: number): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 1 ||
    input > maximum
  )
    invalid();
  return input;
}
function captureScope(input: unknown): PluginCreditSettlementRecoveryScope {
  const value = fields(input, ["tenantId", "spaceId", "profileId"]);
  try {
    return Object.freeze({
      tenantId: pluginInstallationOpaqueId(value.tenantId),
      spaceId: pluginInstallationOpaqueId(value.spaceId),
      profileId: pluginInstallationOpaqueId(value.profileId),
    });
  } catch {
    return invalid();
  }
}
function captureAuthority(
  input: unknown,
): PluginCreditSettlementDeploymentAuthority {
  if (input === null || typeof input !== "object") invalid();
  const functions = {} as Record<
    "authorize" | "assertCurrent" | "decide" | "close",
    (...args: never[]) => unknown
  >;
  for (const name of [
    "authorize",
    "assertCurrent",
    "decide",
    "close",
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "function"
    )
      invalid();
    functions[name] = descriptor.value.bind(input);
  }
  return Object.freeze(
    functions,
  ) as unknown as PluginCreditSettlementDeploymentAuthority;
}

/** Capture only explicit own data. No getters, authority calls, Store reads or migrations occur here. */
export function capturePluginCreditSettlementRuntimeConfig(
  input: PluginCreditSettlementRuntimeConfig,
): PluginCreditSettlementRuntimeConfig {
  const value = fields(input, [
    "scope",
    "authority",
    "batchSize",
    "intervalMs",
    "maxRoundMs",
    "migrate",
  ]);
  if (typeof value.migrate !== "boolean") invalid();
  return Object.freeze({
    scope: captureScope(value.scope),
    authority: captureAuthority(value.authority),
    batchSize: integer(value.batchSize, 16),
    intervalMs: integer(value.intervalMs, 3_600_000),
    maxRoundMs: integer(value.maxRoundMs, 30_000),
    migrate: value.migrate,
  });
}

/** Borrows the original Store; the coordinator owns its financial authority and outstanding work only. */
export async function createPluginCreditSettlementMaintenance(
  input: Inputs,
): Promise<PluginCreditSettlementMaintenance> {
  const config = capturePluginCreditSettlementRuntimeConfig(input.config);
  const owner = new SettlementMaintenance(config);
  try {
    await owner.prepare(input.storeFactory.bind(input));
    return owner;
  } catch (error) {
    await owner.close().catch(() => {});
    throw error;
  }
}

class SettlementMaintenance implements PluginCreditSettlementMaintenance {
  readonly #config: PluginCreditSettlementRuntimeConfig;
  readonly #lifetime = new AbortController();
  #store: PluginCreditSettlementRecoveryStore | undefined;
  #service: PluginCreditSettlementService | undefined;
  #round: Promise<void> | null = null;
  #roundController: AbortController | null = null;
  #closing: Promise<void> | null = null;
  #withdrawn = false;
  #nextRoundAt = 0;
  #cursor: string | null = null;
  #page: { value: PluginCreditSettlementRecoveryPage; offset: number } | null =
    null;
  #counts = {
    rounds: 0,
    scans: 0,
    inspected: 0,
    committed: 0,
    replayed: 0,
    existing: 0,
    held: 0,
    notReady: 0,
    notPaid: 0,
    evidenceChanged: 0,
    failures: 0,
    budgetExpirations: 0,
  };
  #lastFailureCode: FailureCode = null;

  constructor(config: PluginCreditSettlementRuntimeConfig) {
    this.#config = config;
  }

  async prepare(factory: Inputs["storeFactory"]): Promise<void> {
    await this.#authorize(this.#lifetime.signal);
    this.#store = factory(
      Object.freeze({ assertCurrent: () => this.#fence() }),
    );
    this.#fence();
    this.#service = new PluginCreditSettlementService({
      store: this.#store,
      authority: {
        decide: (input) =>
          this.#config.authority.decide({
            ...input,
            signal: this.#signal(input.signal),
          }),
      },
      assertCurrent: (signal) => this.#authorize(this.#signal(signal)),
    });
    if (this.#config.migrate) {
      await this.#store.migrate();
      await this.#authorize(this.#lifetime.signal);
      await this.#store.migrateRecovery();
      await this.#authorize(this.#lifetime.signal);
    }
  }

  snapshot(): PluginCreditSettlementMaintenanceSnapshot {
    return Object.freeze({
      ...this.#counts,
      pending: this.#round !== null,
      closed: this.#lifetime.signal.aborted,
      withdrawn: this.#withdrawn,
      afterRunId: this.#cursor,
      retainedCandidates:
        this.#page === null
          ? 0
          : this.#page.value.items.length - this.#page.offset,
      lastFailureCode: this.#lastFailureCode,
    });
  }

  poll(): Promise<void> {
    if (
      this.#lifetime.signal.aborted ||
      this.#withdrawn ||
      this.#round !== null ||
      performance.now() < this.#nextRoundAt
    )
      return done;
    try {
      this.#fence();
    } catch {
      return done;
    }
    const controller = new AbortController();
    this.#roundController = controller;
    this.#counts.rounds++;
    const timeout = setTimeout(() => {
      if (this.#lifetime.signal.aborted) return;
      this.#counts.budgetExpirations++;
      this.#lastFailureCode = "round_budget_exhausted";
      controller.abort();
    }, this.#config.maxRoundMs);
    const physical = Promise.resolve()
      .then(() => this.#runRound(controller.signal))
      .catch(() => {})
      .finally(() => {
        clearTimeout(timeout);
        this.#round = null;
        this.#roundController = null;
        this.#nextRoundAt = performance.now() + this.#config.intervalMs;
      });
    this.#round = physical;
    return done;
  }

  close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#lifetime.abort();
    this.#roundController?.abort();
    // Invoke every closer now, including authority withdrawal, before waiting for a slow original promise.
    const pending: Promise<unknown>[] = [];
    for (const close of [
      () => this.#service?.close(),
      () => this.#config.authority.close(),
    ]) {
      try {
        pending.push(Promise.resolve(close()));
      } catch (error) {
        pending.push(Promise.reject(error));
      }
    }
    if (this.#round !== null) pending.push(this.#round);
    this.#closing = Promise.allSettled(pending).then((results) => {
      this.#page = null;
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length !== 0)
        throw new AggregateError(
          failures,
          "plugin_credit_settlement_maintenance_close_failed",
        );
    });
    return this.#closing;
  }

  #signal(signal: AbortSignal): AbortSignal {
    return AbortSignal.any([
      signal,
      this.#lifetime.signal,
      ...(this.#roundController === null ? [] : [this.#roundController.signal]),
    ]);
  }

  #fence(): void {
    this.#lifetime.signal.throwIfAborted();
    if (this.#withdrawn)
      throw new Error("plugin_credit_settlement_maintenance_withdrawn");
    try {
      this.#config.authority.assertCurrent();
    } catch (error) {
      this.#withdrawn = true;
      this.#lastFailureCode = "authorization_unavailable";
      throw error;
    }
    this.#roundController?.signal.throwIfAborted();
  }

  async #authorize(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    try {
      await this.#config.authority.authorize(signal);
    } catch (error) {
      if (!signal.aborted) {
        this.#withdrawn = true;
        this.#lastFailureCode = "authorization_unavailable";
      }
      throw error;
    }
    this.#fence();
    signal.throwIfAborted();
  }

  async #runRound(signal: AbortSignal): Promise<void> {
    try {
      await this.#authorize(signal);
      if (this.#page === null) {
        this.#counts.scans++;
        const result = await this.#store!.scanRecovery({
          scope: this.#config.scope,
          afterRunId: this.#cursor,
          limit: this.#config.batchSize,
        });
        this.#fence();
        this.#page = {
          value: capturePage(result, this.#config, this.#cursor),
          offset: 0,
        };
      }
    } catch {
      this.#counts.failures++;
      if (!signal.aborted && !this.#withdrawn)
        this.#lastFailureCode = "scan_failed";
      return;
    }
    const page = this.#page;
    while (
      page.offset < page.value.items.length &&
      !signal.aborted &&
      !this.#lifetime.signal.aborted &&
      !this.#withdrawn
    ) {
      const locator = page.value.items[page.offset]!;
      try {
        const result = await this.#service!.reconcile(locator);
        this.#record(result);
      } catch {
        if (signal.aborted || this.#lifetime.signal.aborted || this.#withdrawn)
          return;
        try {
          this.#fence();
        } catch {
          return;
        }
        this.#counts.failures++;
        this.#lastFailureCode = "candidate_failed";
      }
      this.#counts.inspected++;
      page.offset++;
      this.#cursor = locator.runId;
    }
    if (page.offset === page.value.items.length) {
      this.#cursor = page.value.nextRunId;
      this.#page = null;
    }
  }

  #record(result: PluginCreditSettlementResult): void {
    switch (result.disposition) {
      case "committed":
        this.#counts.committed++;
        break;
      case "replayed":
        this.#counts.replayed++;
        break;
      case "existing":
        this.#counts.existing++;
        break;
      case "hold":
        this.#counts.held++;
        break;
      case "not_ready":
        this.#counts.notReady++;
        break;
      case "not_paid":
        this.#counts.notPaid++;
        break;
      case "evidence_changed":
        this.#counts.evidenceChanged++;
        break;
      case "disabled":
        throw new Error(
          "plugin_credit_settlement_maintenance_authority_missing",
        );
    }
  }
}

function capturePage(
  input: unknown,
  config: PluginCreditSettlementRuntimeConfig,
  previous: string | null,
): PluginCreditSettlementRecoveryPage {
  const value = fields(input, ["items", "nextRunId"]);
  if (
    !Array.isArray(value.items) ||
    value.items.length > config.batchSize ||
    Object.getOwnPropertySymbols(value.items).length !== 0
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value.items);
  if (Object.keys(descriptors).length !== value.items.length + 1) invalid();
  const seen = new Set<string>();
  const items: PluginCreditSettlementLocator[] = [];
  for (let index = 0; index < value.items.length; index++) {
    const item = descriptors[String(index)];
    if (item === undefined || !item.enumerable || !Object.hasOwn(item, "value"))
      invalid();
    const locator = fields(item.value, ["tenantId", "runId"]);
    const tenantId = pluginInstallationOpaqueId(locator.tenantId),
      runId = pluginInstallationOpaqueId(locator.runId);
    if (
      tenantId !== config.scope.tenantId ||
      runId === previous ||
      seen.has(runId)
    )
      invalid();
    seen.add(runId);
    items.push(Object.freeze({ tenantId, runId }));
  }
  const nextRunId =
    value.nextRunId === null
      ? null
      : pluginInstallationOpaqueId(value.nextRunId);
  if (nextRunId !== null && nextRunId === previous) invalid();
  return Object.freeze({ items: Object.freeze(items), nextRunId });
}
