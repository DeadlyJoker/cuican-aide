import { performance } from "node:perf_hooks";
import {
  extensionDigest,
  extensionOpaqueId,
  parsePluginProfileScope,
} from "@crewon/domain";
import type {
  PluginCreditSettlementAuthority,
  PluginCreditSettlementDecision,
  PluginCreditSettlementEvidence,
} from "@crewon/application";
import type { PluginCreditSettlementDeploymentAuthority } from "./plugin-credit-settlement-runtime-types.ts";
import {
  assertPluginCreditSettlementWorkerConfig,
  type PluginCreditSettlementWorkerConfig,
  type PluginCreditSettlementWorkerEndpoint,
} from "./plugin-credit-settlement-worker-config.ts";
import { ioJson, ioRecord } from "./plugin-execution-io-network.ts";

export const PLUGIN_CREDIT_SETTLEMENT_AUTHORIZATION_SCHEMA =
  "crewon.plugin-credit-settlement-authorization.v1";
export const PLUGIN_CREDIT_SETTLEMENT_DECISION_REQUEST_SCHEMA =
  "crewon.plugin-credit-settlement-decision-request.v1";
const DECISION_SCHEMA = "crewon.plugin-credit-settlement-decision.v1";
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const publicFailures = new Set([
  "not_authorized",
  "authorization_expired",
  "epoch_changed",
  "denied",
  "decision_mismatch",
  "quote_exceeded",
  "decision_invalid",
  "response_invalid",
  "authorization_invalid",
  "scope_mismatch",
  "amount_invalid",
]);
type Grant = Readonly<{
  epoch: string;
  expiresAt: number;
  monotonicExpiry: number;
}>;
function failure(code: string): never {
  throw new Error(`plugin_credit_settlement_worker_authority_${code}`);
}
function amount(input: unknown, positive = false): string {
  if (
    typeof input !== "string" ||
    !/^(?:0|[1-9][0-9]{0,47})$/u.test(input) ||
    (positive && input === "0")
  )
    failure("amount_invalid");
  return input;
}
function exactScope(
  input: unknown,
  config: PluginCreditSettlementWorkerConfig,
): void {
  const scope = parsePluginProfileScope(input);
  if (
    scope.tenantId !== config.scope.tenantId ||
    scope.spaceId !== config.scope.spaceId ||
    scope.profileId !== config.scope.profileId
  )
    failure("scope_mismatch");
}
function evidence(
  input: unknown,
  config: PluginCreditSettlementWorkerConfig,
): PluginCreditSettlementEvidence {
  const value = ioRecord(ioJson(input, MAX_REQUEST_BYTES), [
    "schemaVersion",
    "locator",
    "spaceId",
    "actorId",
    "pluginId",
    "bindingDigest",
    "admissionDigest",
    "taskReceiptDigest",
    "installedAdmissionDigest",
    "scope",
    "reservationId",
    "priceRevision",
    "quotedCredits",
    "run",
    "operations",
    "mutationReceipts",
    "attempts",
    "workItems",
    "readyToFinalize",
    "evidenceDigest",
  ]);
  const locator = ioRecord(value.locator, ["tenantId", "runId"]);
  const payer = ioRecord(value.scope, ["tenantId", "principalId", "poolId"]);
  const run = ioRecord(value.run, [
    "revision",
    "status",
    "terminalAt",
    "cancelRequested",
  ]);
  if (
    value.schemaVersion !== "crewon.plugin-credit-settlement-evidence.v1" ||
    locator.tenantId !== config.scope.tenantId ||
    payer.tenantId !== config.scope.tenantId ||
    value.spaceId !== config.scope.spaceId ||
    value.readyToFinalize !== true ||
    value.installedAdmissionDigest === null ||
    !["completed", "failed", "canceled"].includes(String(run.status)) ||
    typeof run.terminalAt !== "string" ||
    value.reservationId !== locator.runId
  )
    failure("evidence_invalid");
  for (const id of [
    locator.tenantId,
    locator.runId,
    payer.principalId,
    payer.poolId,
    value.actorId,
    value.pluginId,
  ])
    extensionOpaqueId(id);
  for (const digest of [
    value.bindingDigest,
    value.admissionDigest,
    value.taskReceiptDigest,
    value.installedAdmissionDigest,
    value.evidenceDigest,
  ])
    extensionDigest(digest);
  amount(value.quotedCredits, true);
  if (
    typeof value.priceRevision !== "number" ||
    !Number.isSafeInteger(value.priceRevision) ||
    value.priceRevision < 1
  )
    failure("evidence_invalid");
  return value as unknown as PluginCreditSettlementEvidence;
}

/** A changed epoch, deny, expiry or transport failure permanently withdraws this owner. Rebuild an explicit new owner to authorize a new epoch. */
class FinancialHttpAuthority
  implements PluginCreditSettlementDeploymentAuthority
{
  readonly #config: PluginCreditSettlementWorkerConfig;
  readonly #fetch: typeof globalThis.fetch;
  readonly #controllers = new Set<AbortController>();
  readonly #physical = new Set<Promise<unknown>>();
  #grant: Grant | null = null;
  #epoch: string | null = null;
  #expiryTimer: ReturnType<typeof setTimeout> | undefined;
  #revoked: string | null = null;
  #closed = false;
  #closing: Promise<void> | undefined;
  constructor(
    config: PluginCreditSettlementWorkerConfig,
    fetch: typeof globalThis.fetch,
  ) {
    this.#config = config;
    this.#fetch = fetch;
  }

  assertCurrent(): void {
    this.#alive();
    if (this.#grant === null) failure("not_authorized");
    this.#assertUnexpired(this.#grant);
  }

  authorize(signal: AbortSignal): Promise<void> {
    return this.#perform(signal, async (httpSignal) => {
      const previousGrant = this.#grant;
      if (previousGrant !== null) this.assertCurrent();
      // Refresh suspends permission, but the old deadline still withdraws this owner.
      this.#grant = null;
      const requestedAt = Date.now(),
        monotonicAt = performance.now();
      const response = ioRecord(
        await this.#http(
          this.#config.authorizationAuthority,
          {
            schemaVersion: PLUGIN_CREDIT_SETTLEMENT_AUTHORIZATION_SCHEMA,
            scope: this.#config.scope,
            authorityId: this.#config.authorityId,
            authorityRevision: this.#config.authorityRevision,
          },
          httpSignal,
        ),
        [
          "schemaVersion",
          "scope",
          "authorityId",
          "authorityRevision",
          "outcome",
        ],
        ["authorityEpoch", "expiresAt"],
      );
      this.#alive();
      if (previousGrant !== null) this.#assertUnexpired(previousGrant);
      if (
        response.schemaVersion !==
          PLUGIN_CREDIT_SETTLEMENT_AUTHORIZATION_SCHEMA ||
        response.authorityId !== this.#config.authorityId ||
        response.authorityRevision !== this.#config.authorityRevision
      )
        failure("authorization_invalid");
      exactScope(response.scope, this.#config);
      if (response.outcome === "deny") {
        ioRecord(response, [
          "schemaVersion",
          "scope",
          "authorityId",
          "authorityRevision",
          "outcome",
        ]);
        this.#revoke("denied");
        failure("denied");
      }
      ioRecord(response, [
        "schemaVersion",
        "scope",
        "authorityId",
        "authorityRevision",
        "outcome",
        "authorityEpoch",
        "expiresAt",
      ]);
      if (
        response.outcome !== "allow" ||
        typeof response.expiresAt !== "string"
      )
        failure("authorization_invalid");
      const epoch = extensionOpaqueId(response.authorityEpoch),
        expiresAt = Date.parse(response.expiresAt);
      if (
        !Number.isFinite(expiresAt) ||
        new Date(expiresAt).toISOString() !== response.expiresAt ||
        expiresAt <= Date.now() ||
        expiresAt > requestedAt + this.#config.maxAuthorizationAgeMs
      )
        failure("authorization_expired");
      const monotonicExpiry = monotonicAt + (expiresAt - requestedAt);
      if (performance.now() >= monotonicExpiry)
        failure("authorization_expired");
      if (this.#epoch !== null && this.#epoch !== epoch) {
        this.#revoke("epoch_changed");
        failure("epoch_changed");
      }
      this.#alive();
      if (previousGrant !== null) this.#assertUnexpired(previousGrant);
      this.#clearGrant();
      this.#epoch = epoch;
      this.#grant = Object.freeze({ epoch, expiresAt, monotonicExpiry });
      this.#expiryTimer = setTimeout(
        () => this.#revoke("authorization_expired"),
        Math.max(
          1,
          Math.min(expiresAt - Date.now(), monotonicExpiry - performance.now()),
        ),
      );
      this.#expiryTimer.unref();
      this.assertCurrent();
    });
  }

  async decide(
    input: Parameters<PluginCreditSettlementAuthority["decide"]>[0],
  ): Promise<PluginCreditSettlementDecision | Readonly<{ kind: "hold" }>> {
    const fields = ioRecord(input, ["evidence", "signal"]);
    const captured = evidence(fields.evidence, this.#config);
    if (!(fields.signal instanceof AbortSignal)) failure("signal_invalid");
    this.assertCurrent();
    const grant = this.#grant!;
    return this.#perform(fields.signal, async (signal) => {
      this.assertCurrent();
      const value = ioRecord(
        await this.#http(
          this.#config.decisionAuthority,
          {
            schemaVersion: PLUGIN_CREDIT_SETTLEMENT_DECISION_REQUEST_SCHEMA,
            scope: this.#config.scope,
            authorityId: this.#config.authorityId,
            authorityRevision: this.#config.authorityRevision,
            authorityEpoch: grant.epoch,
            evidence: captured,
          },
          signal,
        ),
        [
          "schemaVersion",
          "evidenceDigest",
          "authorityId",
          "authorityRevision",
          "decisionId",
          "outcome",
        ],
      );
      this.assertCurrent();
      if (
        this.#grant !== grant ||
        value.schemaVersion !== DECISION_SCHEMA ||
        value.evidenceDigest !== captured.evidenceDigest ||
        value.authorityId !== this.#config.authorityId ||
        value.authorityRevision !== this.#config.authorityRevision
      )
        failure("decision_mismatch");
      const decisionId = extensionOpaqueId(value.decisionId);
      const outcome = ioRecord(value.outcome, ["kind"], ["actualCredits"]);
      if (outcome.kind === "hold") {
        ioRecord(outcome, ["kind"]);
        return Object.freeze({ kind: "hold" });
      }
      let parsed: PluginCreditSettlementDecision["outcome"];
      if (outcome.kind === "release") {
        ioRecord(outcome, ["kind"]);
        parsed = Object.freeze({ kind: "release" });
      } else if (outcome.kind === "settle") {
        ioRecord(outcome, ["kind", "actualCredits"]);
        const actualCredits = amount(outcome.actualCredits);
        if (BigInt(actualCredits) > BigInt(captured.quotedCredits))
          failure("quote_exceeded");
        parsed = Object.freeze({ kind: "settle", actualCredits });
      } else failure("decision_invalid");
      return Object.freeze({
        schemaVersion: DECISION_SCHEMA,
        evidenceDigest: captured.evidenceDigest,
        authorityId: this.#config.authorityId,
        authorityRevision: this.#config.authorityRevision,
        decisionId,
        outcome: parsed,
      });
    });
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    this.#revoke("closed");
    return (this.#closing = Promise.allSettled([...this.#physical]).then(
      () => {},
    ));
  }
  #alive(): void {
    if (this.#closed) failure("closed");
    if (this.#revoked !== null) failure(this.#revoked);
  }
  #assertUnexpired(grant: Grant): void {
    if (
      Date.now() >= grant.expiresAt ||
      performance.now() >= grant.monotonicExpiry
    ) {
      this.#revoke("authorization_expired");
      failure("authorization_expired");
    }
  }
  #clearGrant(): void {
    this.#grant = null;
    clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
  }
  #revoke(reason: string): void {
    this.#revoked ??= reason;
    this.#clearGrant();
    for (const controller of this.#controllers) controller.abort();
  }

  /** Timeout only revokes/aborts. The returned promise and occupied slot live through actual fetch/body termination. */
  #perform<T>(
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    try {
      this.#alive();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#physical.size !== 0)
      return Promise.reject(
        new Error("plugin_credit_settlement_worker_authority_busy"),
      );
    if (!(signal instanceof AbortSignal))
      return Promise.reject(
        new Error("plugin_credit_settlement_worker_authority_signal_invalid"),
      );
    if (signal.aborted) {
      this.#revoke("unavailable");
      return Promise.reject(
        new Error("plugin_credit_settlement_worker_authority_unavailable"),
      );
    }
    const controller = new AbortController();
    const abort = () => this.#revoke("unavailable");
    signal.addEventListener("abort", abort, { once: true });
    this.#controllers.add(controller);
    const timer = setTimeout(
      () => this.#revoke("timeout"),
      this.#config.timeoutMs,
    );
    let physical: Promise<T>;
    physical = Promise.resolve()
      .then(async () => {
        this.#alive();
        if (controller.signal.aborted || signal.aborted) failure("unavailable");
        const result = await operation(controller.signal);
        this.#alive();
        if (controller.signal.aborted || signal.aborted) failure("unavailable");
        return result;
      })
      .catch((error: unknown) => {
        const prefix = "plugin_credit_settlement_worker_authority_";
        const candidate =
          error instanceof Error && error.message.startsWith(prefix)
            ? error.message.slice(prefix.length)
            : null;
        this.#revoke(
          candidate !== null && publicFailures.has(candidate)
            ? candidate
            : "unavailable",
        );
        // Do not expose transport errors, URLs, credentials, remote text or causes.
        failure(this.#closed ? "closed" : this.#revoked!);
      })
      .finally(() => {
        this.#physical.delete(physical);
        this.#controllers.delete(controller);
        signal.removeEventListener("abort", abort);
        clearTimeout(timer);
      });
    this.#physical.add(physical);
    if (signal.aborted) abort();
    return physical;
  }

  async #http(
    endpoint: PluginCreditSettlementWorkerEndpoint,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await this.#fetch(endpoint.url, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal,
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "authorization": `Bearer ${endpoint.serviceToken}`,
      },
      body: JSON.stringify(ioJson(payload, MAX_REQUEST_BYTES)),
    });
    const media = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    const length = response.headers.get("content-length");
    if (
      signal.aborted ||
      response.status !== 200 ||
      (media !== "application/json" && media?.endsWith("+json") !== true) ||
      (length !== null &&
        (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES))
    ) {
      await response.body?.cancel();
      failure("response_invalid");
    }
    if (response.body === null) failure("response_invalid");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let cancellation: Promise<void> | undefined;
    const cancel = () => (cancellation ??= reader.cancel());
    const onAbort = () => {
      void cancel().catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    let total = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (signal.aborted || total > MAX_RESPONSE_BYTES) {
          await cancel();
          failure("response_invalid");
        }
        chunks.push(part.value);
      }
      if (signal.aborted) failure("unavailable");
      return ioJson(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks, total),
          ),
        ),
        MAX_RESPONSE_BYTES,
      );
    } catch (error) {
      await cancel();
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      try {
        if (cancellation !== undefined) await cancellation;
      } finally {
        reader.releaseLock();
      }
    }
  }
}

/** Only parser-branded independent financial configuration can create this deployment authority. */
export function createPluginCreditSettlementWorkerAuthority(
  config: PluginCreditSettlementWorkerConfig,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): PluginCreditSettlementDeploymentAuthority {
  assertPluginCreditSettlementWorkerConfig(config);
  const owner = new FinancialHttpAuthority(config, fetch);
  return Object.freeze({
    authorize: owner.authorize.bind(owner),
    assertCurrent: owner.assertCurrent.bind(owner),
    decide: owner.decide.bind(owner),
    close: owner.close.bind(owner),
  });
}
