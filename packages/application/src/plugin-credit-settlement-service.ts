import { pluginInstallationOpaqueId } from "@crewon/domain";
import type {
  PluginCreditSettlementAuthority,
  PluginCreditSettlementCommitResult,
  PluginCreditSettlementFinalization,
  PluginCreditSettlementLocator,
  PluginCreditSettlementStore,
} from "./plugin-credit-settlement-port.ts";

export type PluginCreditSettlementResult =
  | PluginCreditSettlementCommitResult
  | Readonly<{ disposition: "disabled" | "hold" | "not_paid" }>
  | Readonly<{
      disposition: "existing";
      finalization: PluginCreditSettlementFinalization;
    }>;

/** Explicit billing authority, bounded work, and physical close. It does not infer prices or refunds. */
export class PluginCreditSettlementService {
  readonly #store: PluginCreditSettlementStore;
  readonly #authority: PluginCreditSettlementAuthority | undefined;
  readonly #assertCurrent: (signal: AbortSignal) => Promise<void>;
  readonly #lifetime = new AbortController();
  readonly #pending = new Map<string, Promise<PluginCreditSettlementResult>>();
  #closing: Promise<void> | undefined;

  constructor(
    input: Readonly<{
      store: PluginCreditSettlementStore;
      authority?: PluginCreditSettlementAuthority;
      assertCurrent(signal: AbortSignal): Promise<void>;
    }>,
  ) {
    this.#store = input.store;
    this.#authority = input.authority;
    this.#assertCurrent = input.assertCurrent.bind(input);
  }

  /** The owner supplies the original Run locator; no payer, amount or UI decision is accepted. */
  reconcile(
    locatorInput: PluginCreditSettlementLocator,
  ): Promise<PluginCreditSettlementResult> {
    const locator = captureLocator(locatorInput);
    if (this.#lifetime.signal.aborted)
      return Promise.reject(new Error("plugin_credit_settlement_closed"));
    // Missing authority must not even migrate, scan, or read billing state.
    if (this.#authority === undefined)
      return Promise.resolve({ disposition: "disabled" });
    const key = JSON.stringify([locator.tenantId, locator.runId]);
    const existing = this.#pending.get(key);
    if (existing !== undefined) return existing;
    if (this.#pending.size >= 16)
      return Promise.reject(new Error("plugin_credit_settlement_busy"));
    const physical = Promise.resolve()
      .then(() => this.#reconcile(locator))
      .finally(() => this.#pending.delete(key));
    this.#pending.set(key, physical);
    return physical;
  }

  /** Abort new decisions, then wait for original authority and Store promises to physically finish. */
  close(): Promise<void> {
    this.#lifetime.abort();
    return (this.#closing ??= Promise.allSettled([
      ...this.#pending.values(),
    ]).then(() => {}));
  }

  async #current(): Promise<void> {
    this.#lifetime.signal.throwIfAborted();
    await this.#assertCurrent(this.#lifetime.signal);
    this.#lifetime.signal.throwIfAborted();
  }

  async #reconcile(
    locator: PluginCreditSettlementLocator,
  ): Promise<PluginCreditSettlementResult> {
    await this.#current();
    const finalized = await this.#store.getFinalization(locator);
    await this.#current();
    if (finalized !== null)
      return { disposition: "existing", finalization: finalized };
    const evidence = await this.#store.loadEvidence(locator);
    await this.#current();
    if (evidence === null) return { disposition: "not_paid" };
    if (!evidence.readyToFinalize) return { disposition: "not_ready" };
    this.#lifetime.signal.throwIfAborted();
    const response = await this.#authority!.decide({
      evidence,
      signal: this.#lifetime.signal,
    });
    await this.#current();
    if (isHold(response)) return { disposition: "hold" };
    // The adapter independently parses the response and recomputes all facts under its transaction locks.
    const digestField =
      response !== null && typeof response === "object"
        ? Object.getOwnPropertyDescriptor(response, "evidenceDigest")
        : undefined;
    if (
      digestField === undefined ||
      !Object.hasOwn(digestField, "value") ||
      digestField.value !== evidence.evidenceDigest
    )
      throw new Error("plugin_credit_settlement_authority_evidence_mismatch");
    // Do not assert after finalize: a confirmed COMMIT is still success during late close.
    this.#lifetime.signal.throwIfAborted();
    return this.#store.finalize({ locator, decision: response });
  }
}

function isHold(value: unknown): value is Readonly<{ kind: "hold" }> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return (
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.keys(fields).length === 1 &&
    fields.kind?.enumerable === true &&
    Object.hasOwn(fields.kind, "value") &&
    fields.kind.value === "hold"
  );
}

function captureLocator(value: unknown): PluginCreditSettlementLocator {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    throw new Error("plugin_credit_settlement_locator_invalid");
  const fields = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(fields).sort().join("\0") !== "runId\0tenantId" ||
    Object.values(fields).some(
      (field) => !field.enumerable || !Object.hasOwn(field, "value"),
    )
  )
    throw new Error("plugin_credit_settlement_locator_invalid");
  return Object.freeze({
    tenantId: pluginInstallationOpaqueId(fields.tenantId!.value),
    runId: pluginInstallationOpaqueId(fields.runId!.value),
  });
}
