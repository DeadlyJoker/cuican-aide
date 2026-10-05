import type {
  ProjectTextPlanCoordinator,
  ProjectTextPlanStore,
  ContentDigester,
} from "@crewon/application";
import {
  parseProjectTextPlanRunAdmission,
  type PluginProfileScope,
  type RunLifecycleEvent,
} from "@crewon/domain";

/** Original Control lifetime owns one bounded checkpoint at a time; SQL state is the durable wake source. */
export class ProjectTextPlanDurableCoordinator {
  readonly #store: Pick<
    ProjectTextPlanStore,
    "scanRecoverable" | "loadRunAdmission" | "readRequiredPlanDigest"
  >;
  readonly #process: ProjectTextPlanCoordinator["process"];
  readonly #scope: PluginProfileScope;
  readonly #digester: ContentDigester;
  readonly #controller = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #scan: Promise<void> | undefined;
  #tail: Promise<void> = Promise.resolve();
  #cursor: string | null = null;
  #lastFailure: string | null = null;
  #closing: Promise<void> | undefined;
  constructor(
    input: Readonly<{
      store: Pick<
        ProjectTextPlanStore,
        "scanRecoverable" | "loadRunAdmission" | "readRequiredPlanDigest"
      >;
      coordinator: Pick<ProjectTextPlanCoordinator, "process">;
      scope: PluginProfileScope;
      digester: ContentDigester;
      intervalMs?: number;
    }>,
  ) {
    this.#store = Object.freeze({
      scanRecoverable: input.store.scanRecoverable.bind(input.store),
      loadRunAdmission: input.store.loadRunAdmission.bind(input.store),
      readRequiredPlanDigest: input.store.readRequiredPlanDigest.bind(
        input.store,
      ),
    });
    this.#process = input.coordinator.process.bind(input.coordinator);
    this.#scope = Object.freeze({ ...input.scope });
    this.#digester = Object.freeze({
      sha256: input.digester.sha256.bind(input.digester),
    });
    this.#intervalMs = input.intervalMs ?? 1000;
    if (
      !Number.isSafeInteger(this.#intervalMs) ||
      this.#intervalMs < 100 ||
      this.#intervalMs > 60000
    )
      throw new Error("project_text_plan_scan_interval_invalid");
  }
  start(): void {
    if (this.#controller.signal.aborted || this.#timer !== undefined) return;
    void this.wake();
    this.#timer = setInterval(() => void this.wake(), this.#intervalMs);
    this.#timer.unref();
  }
  wake(): Promise<void> {
    if (this.#controller.signal.aborted) return Promise.resolve();
    if (this.#scan !== undefined) return this.#scan;
    const work = this.#enqueue(async () => {
      const page = await this.#store.scanRecoverable({
        ...this.#scope,
        afterPlanId: this.#cursor,
        limit: 1,
      });
      this.#controller.signal.throwIfAborted();
      if (page.locators.length > 1)
        throw new Error("project_text_plan_scan_result_invalid");
      this.#cursor = page.nextPlanId;
      const locator = page.locators[0];
      if (locator !== undefined) {
        if (
          locator.actor.tenantId !== this.#scope.tenantId ||
          locator.actor.spaceId !== this.#scope.spaceId ||
          locator.profileId !== this.#scope.profileId
        )
          throw new Error("project_text_plan_scan_scope_invalid");
        await this.#process(locator, this.#controller.signal);
      }
    });
    this.#scan = work;
    void work.then(
      () => {
        if (this.#scan === work) this.#scan = undefined;
      },
      () => {
        if (this.#scan === work) this.#scan = undefined;
      },
    );
    return work;
  }
  /** Called only after the original OutboxDispatcher has reloaded and verified the actual referenced event range. */
  consumeRunEvents(events: readonly RunLifecycleEvent[]): Promise<void> {
    if (this.#controller.signal.aborted) return Promise.resolve();
    const terminal = [...events]
      .reverse()
      .find((x) =>
        ["run.completed", "run.failed", "run.canceled"].includes(x.type),
      );
    if (terminal === undefined) return Promise.resolve();
    return this.#enqueue(async () => {
      const runId = terminal.identity.runId;
      const digest = await this.#store.readRequiredPlanDigest({
        tenantId: this.#scope.tenantId,
        spaceId: this.#scope.spaceId,
        runId,
      });
      this.#controller.signal.throwIfAborted();
      if (digest === null) return;
      const raw = await this.#store.loadRunAdmission({
        tenantId: this.#scope.tenantId,
        spaceId: this.#scope.spaceId,
        runId,
      });
      if (raw === null) throw new Error("project_text_plan_admission_required");
      const admission = parseProjectTextPlanRunAdmission(raw, this.#digester);
      if (
        admission.contentDigest !== digest ||
        admission.runId !== runId ||
        admission.actor.tenantId !== this.#scope.tenantId ||
        admission.actor.spaceId !== this.#scope.spaceId ||
        admission.installation.profileId !== this.#scope.profileId
      )
        throw new Error("project_text_plan_admission_invalid");
      await this.#process(
        {
          actor: admission.actor,
          profileId: admission.installation.profileId,
          planId: admission.planId,
        },
        this.#controller.signal,
      );
    });
  }
  status(): Readonly<{ pending: number; lastFailureCode: string | null }> {
    return Object.freeze({
      pending: this.#pending.size,
      lastFailureCode: this.#lastFailure,
    });
  }
  close(): Promise<void> {
    this.#controller.abort();
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    return (this.#closing ??= Promise.allSettled([...this.#pending]).then(
      () => {},
    ));
  }
  #enqueue(work: () => Promise<void>): Promise<void> {
    if (this.#controller.signal.aborted) return Promise.resolve();
    if (this.#pending.size >= 32)
      return Promise.reject(new Error("project_text_plan_checkpoint_capacity"));
    const promise = this.#tail.then(async () => {
      this.#controller.signal.throwIfAborted();
      await work();
    });
    this.#pending.add(promise);
    this.#tail = promise.catch(() => {});
    void promise.then(
      () => {
        this.#pending.delete(promise);
        this.#lastFailure = null;
      },
      (error) => {
        this.#pending.delete(promise);
        if (!this.#controller.signal.aborted)
          this.#lastFailure =
            error instanceof Error &&
            /^[A-Za-z0-9_]{1,128}$/u.test(error.message)
              ? error.message
              : "project_text_plan_checkpoint_failed";
      },
    );
    return promise;
  }
}
