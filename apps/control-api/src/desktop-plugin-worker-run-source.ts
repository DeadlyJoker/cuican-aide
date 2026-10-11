import {
  ApplicationError,
  assertPluginTaskRunReceipt,
  assertPluginTaskRunSnapshot,
  readPluginQuerySourceStorageProof,
  readPluginTaskRunComposition,
  type ActorContext,
  type ApplicationClock,
  type ContentDigester,
} from "@crewon/application";
import {
  assertPluginTaskAdmission,
  assertPluginQueryTaskAdmission,
  effectivePluginQueryTaskAdmission,
  extensionCanonicalJson,
  extensionOpaqueId,
  parseExtensionRunBinding,
  parsePluginTaskAdmission,
  parsePluginQueryTaskAdmission,
  parsePluginProfileScope,
  type PluginProfileScope,
  type PluginTaskAdmission,
  type PluginQueryTaskAdmission,
  type ExtensionRunBinding,
} from "@crewon/domain";
import type { PluginCompositionLock } from "@crewon/contracts/plugins";
import { SqliteRunStore } from "@crewon/store";
import { DesktopPluginTaskServiceBinding } from "./desktop-plugin-task-service-binding.ts";
import { pluginSecurityActor } from "./plugin-security-validation.ts";

/** Host-only metadata reference. Copies and serialized DTOs do not qualify an instance or task. */
export type DesktopPluginWorkerRunQualification = Readonly<{
  schemaVersion: "crewon.desktop-worker-run-qualification.v1";
}>;
type Snapshot = Readonly<{
  admission: PluginTaskAdmission;
  binding: ExtensionRunBinding;
  query: PluginQueryTaskAdmission | null;
  composition: PluginCompositionLock | null;
}>;

/** Same actual ledger and original receipt/lock readers; owns no tasks, Node instances or execution grants. */
export class DesktopPluginWorkerRunSource {
  readonly #binding: DesktopPluginTaskServiceBinding;
  readonly #store: SqliteRunStore;
  readonly #actor: ActorContext;
  readonly #scope: PluginProfileScope;
  readonly #clock: ApplicationClock;
  readonly #digester: ContentDigester;
  readonly #records = new Map<
    object,
    Readonly<{ snapshot: Snapshot; expiresAt: number }>
  >();
  readonly #pending = new Set<Promise<unknown>>();
  #closed = false;
  #closing: Promise<void> | null = null;

  constructor(
    input: Readonly<{
      binding: DesktopPluginTaskServiceBinding;
      store: SqliteRunStore;
      actor: ActorContext;
      scope: PluginProfileScope;
      clock: ApplicationClock;
      digester: ContentDigester;
    }>,
  ) {
    if (
      !DesktopPluginTaskServiceBinding.isOwner(input.binding) ||
      !(input.store instanceof SqliteRunStore) ||
      typeof input.clock?.now !== "function" ||
      typeof input.digester?.sha256 !== "function"
    )
      unavailable("desktop_worker_run_source_invalid");
    input.binding.assertStore(input.store);
    this.#binding = input.binding;
    this.#store = input.store;
    this.#actor = pluginSecurityActor(input.actor);
    this.#scope = parsePluginProfileScope(input.scope);
    this.#clock = Object.freeze({ now: input.clock.now.bind(input.clock) });
    this.#digester = Object.freeze({
      sha256: input.digester.sha256.bind(input.digester),
    });
    this.#current();
    Object.freeze(this);
  }

  capture(
    runId: string,
    signal: AbortSignal,
  ): Promise<DesktopPluginWorkerRunQualification> {
    return this.#work(async () => {
      this.#current();
      for (const [key, record] of this.#records)
        if (record.expiresAt <= this.#now()) this.#records.delete(key);
      if (this.#records.size >= 64)
        unavailable("desktop_worker_run_source_capacity");
      const snapshot = await this.#readSnapshot(runId, signal);
      this.#current();
      signal.throwIfAborted();
      if (this.#records.size >= 64)
        unavailable("desktop_worker_run_source_capacity");
      const qualification = Object.freeze({
        schemaVersion: "crewon.desktop-worker-run-qualification.v1" as const,
      });
      this.#records.set(
        qualification,
        Object.freeze({ snapshot, expiresAt: this.#now() + 30_000 }),
      );
      return qualification;
    });
  }

  verify(
    qualification: DesktopPluginWorkerRunQualification,
    signal: AbortSignal,
  ): Promise<Snapshot> {
    return this.#work(async () => {
      this.#current();
      const record = this.#records.get(qualification);
      if (!record || record.expiresAt <= this.#now())
        unavailable("desktop_worker_run_qualification_invalid");
      const current = await this.#readSnapshot(
        record.snapshot.admission.runId,
        signal,
      );
      this.#current();
      signal.throwIfAborted();
      if (
        this.#records.get(qualification) !== record ||
        record.expiresAt <= this.#now() ||
        extensionCanonicalJson(current) !==
          extensionCanonicalJson(record.snapshot)
      )
        unavailable("desktop_worker_run_qualification_changed");
      return current;
    });
  }

  release(qualification: DesktopPluginWorkerRunQualification): void {
    if (!this.#records.delete(qualification))
      unavailable("desktop_worker_run_qualification_invalid");
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#records.clear();
    return (this.#closing = Promise.allSettled([...this.#pending]).then(
      () => undefined,
    ));
  }

  /** Storage/ownership proof only; callers still need authenticated transport, Node and Run/Tool authority. */
  async #readSnapshot(
    runIdInput: string,
    signal: AbortSignal,
  ): Promise<Snapshot> {
    this.#current();
    if (!(signal instanceof AbortSignal))
      unavailable("desktop_worker_run_source_signal_invalid");
    signal.throwIfAborted();
    const runId = extensionOpaqueId(runIdInput);
    const locator = {
      tenantId: this.#actor.tenantId,
      spaceId: this.#actor.spaceId,
      runId,
    };
    const extensions = this.#store.extensionStore();
    const check = () => {
      signal.throwIfAborted();
      this.#current();
    };
    const rawAdmission = await extensions.loadPluginTaskAdmission!(locator);
    check();
    const rawQuery = await extensions.loadPluginQueryTaskAdmission!(locator);
    check();
    if ((rawAdmission === null) === (rawQuery === null))
      unavailable("desktop_worker_run_admission_unavailable");
    const query =
      rawQuery === null ? null : parsePluginQueryTaskAdmission(rawQuery);
    const admission =
      query === null
        ? parsePluginTaskAdmission(rawAdmission)
        : effectivePluginQueryTaskAdmission(query);
    if (
      admission.runId !== runId ||
      admission.tenantId !== locator.tenantId ||
      admission.spaceId !== locator.spaceId ||
      admission.actorId !== this.#actor.actorId ||
      admission.principalId !== this.#actor.principalId ||
      admission.profileId !== this.#scope.profileId
    )
      unavailable("desktop_worker_run_owner_mismatch");
    const rawBinding = await extensions.loadExtensionRunBinding(locator);
    check();
    if (!rawBinding) unavailable("desktop_worker_run_binding_missing");
    const binding = parseExtensionRunBinding(rawBinding, this.#digester);
    if (binding.schemaVersion !== "crewon.extension-run-binding.v1")
      unavailable("desktop_worker_run_composition_required");
    const receipt = {
      actorId: admission.actorId,
      idempotencyKey: admission.idempotencyKey,
      requestDigest: admission.requestDigest,
    };
    if (query === null)
      assertPluginTaskAdmission(
        { admission, binding, receipt },
        this.#digester,
      );
    else {
      const source = await readPluginQuerySourceStorageProof({
        actor: this.#actor,
        pluginId: query.pluginId,
        profileId: query.profileId,
        publisherId: query.publisherId,
        sourceRunId: query.source.runId,
        operationId: query.operationId,
        extensions,
        runs: this.#store,
        operations: this.#store.externalOperationStore(),
        digester: this.#digester,
      });
      check();
      assertPluginQueryTaskAdmission(
        { admission: query, binding, sourceBinding: source.binding, receipt },
        this.#digester,
      );
      if (
        extensionCanonicalJson(query.source) !==
        extensionCanonicalJson(source.admission)
      )
        unavailable("desktop_worker_run_query_source_changed");
    }
    const original = await extensions.loadExtensionTurnReceipt({
      ...binding,
      receipt,
    });
    check();
    if (!original) unavailable("desktop_worker_run_receipt_missing");
    const initial = assertPluginTaskRunReceipt(
      original,
      binding,
      admission,
      receipt,
      query,
      unavailable,
    );
    const run = await this.#store.loadRunInSpace(locator);
    check();
    if (!run) unavailable("desktop_worker_run_missing");
    assertPluginTaskRunSnapshot(run, binding, initial, unavailable);
    const composition = await readPluginTaskRunComposition({
      binding,
      admission,
      query,
      compositions: this.#store.pluginInstallationStore().compositionStore!(),
      signal,
      fail: unavailable,
    });
    check();
    return Object.freeze({ admission, binding, query, composition });
  }

  #current(): void {
    if (this.#closed) unavailable("desktop_worker_run_source_closed");
    this.#binding.assertStore(this.#store);
    this.#binding.assertWorkerOwner({ actor: this.#actor, scope: this.#scope });
  }
  #now(): number {
    const value = Date.parse(this.#clock.now());
    if (!Number.isFinite(value))
      unavailable("desktop_worker_run_source_clock_invalid");
    return value;
  }
  #work<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed)
      return Promise.reject(
        new ApplicationError(
          "authorization",
          "desktop_worker_run_source_closed",
        ),
      );
    if (this.#pending.size >= 64)
      return Promise.reject(
        new ApplicationError(
          "authorization",
          "desktop_worker_run_source_capacity",
        ),
      );
    const work = Promise.resolve().then(operation);
    this.#pending.add(work);
    void work.then(
      () => this.#pending.delete(work),
      () => this.#pending.delete(work),
    );
    return work;
  }
}

function unavailable(code: string): never {
  throw new ApplicationError("authorization", code);
}
