import type { ControlApiClient } from "@crewon/control-client";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type {
  DesktopWorkspaceAuthorityPort,
  DesktopWorkspaceAvailability,
  DesktopWorkspaceStatus,
} from "../desktop/desktopWorkspaceAuthorityAdapter";
import {
  DesktopWorkspaceAuthorityConflictError,
  DesktopWorkspaceNativeMutationError,
  DesktopWorkspaceTransitioningError,
  DesktopWorkspaceUnavailableError,
} from "../desktop/desktopWorkspaceAuthorityAdapter";
import {
  ControlWorkspaceRuntime,
  type ControlWorkspaceState,
} from "./controlWorkspaceRuntime";

const SAFE_WORKSPACE_LIST_MAX_ENTRIES = 200;

export type ControlWorkspaceMutationAuthority =
  | "desktop"
  | "readOnly"
  | "unavailable";

export type SafeNativeWorkspaceSnapshot = Readonly<{
  availability: DesktopWorkspaceAvailability;
  displayName: string | null;
}>;

export type ControlWorkspaceSafeError =
  | "nativeActiveAuthority"
  | "nativeConflict"
  | "nativeUnavailable"
  | "nativeUnknown"
  | "rehydrationFailed";

export type ControlWorkspaceCompositionSnapshot = Readonly<{
  control: ControlWorkspaceState;
  mutationAuthority: ControlWorkspaceMutationAuthority;
  nativeBusy: boolean;
  safeError: ControlWorkspaceSafeError | null;
  nativeWorkspace: SafeNativeWorkspaceSnapshot | null;
}>;

export interface ControlWorkspaceRuntimePort {
  getSnapshot(): ControlWorkspaceState;
  subscribe(listener: () => void): () => void;
  selectThread(threadId: string | null): Promise<void>;
  create(threadId: string, maxEntries: number): Promise<unknown>;
  reconcile(threadId: string, executionId: string): Promise<unknown>;
  cancel(threadId: string, executionId: string): Promise<unknown>;
  close(): void;
}

/**
 * Composes redacted Control operation state with native Workspace authority.
 * It has no legacy backend or filesystem fallback: missing Control is unavailable,
 * while Control without an OS-native authority is intentionally read-only.
 */
export class ControlWorkspaceRuntimeComposition {
  readonly #controlConfigured: boolean;
  readonly #idempotencyKey: (operation: "clear" | "select") => string;
  readonly #nativeAuthority: DesktopWorkspaceAuthorityPort | null;
  readonly #rehydrateThreadAuthority:
    | ((threadId: string) => Promise<void>)
    | null;
  readonly #runtime: ControlWorkspaceRuntimePort;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribeRuntime: () => void;
  #authorityGeneration = 0;
  #closed = false;
  #nativeBusy = false;
  #nativeMutationGeneration: number | null = null;
  #nativeStatus: DesktopWorkspaceStatus | null = null;
  #safeError: ControlWorkspaceSafeError | null = null;
  #selectedThreadId: string | null = null;
  #threadGeneration = 0;
  #snapshot: ControlWorkspaceCompositionSnapshot;

  constructor(config: {
    controlConfigured: boolean;
    nativeAuthority: DesktopWorkspaceAuthorityPort | null;
    runtime: ControlWorkspaceRuntimePort;
    idempotencyKey?: (operation: "clear" | "select") => string;
    rehydrateThreadAuthority?: (threadId: string) => Promise<void>;
  }) {
    this.#controlConfigured = config.controlConfigured;
    this.#nativeAuthority = config.nativeAuthority;
    this.#runtime = config.runtime;
    this.#rehydrateThreadAuthority = config.rehydrateThreadAuthority ?? null;
    this.#idempotencyKey =
      config.idempotencyKey ??
      ((operation) =>
        `desktop.workspace.${operation}:${globalThis.crypto.randomUUID()}`);
    this.#snapshot = this.#projectSnapshot();
    this.#unsubscribeRuntime = this.#runtime.subscribe(() => this.#publish());
  }

  getSnapshot = (): ControlWorkspaceCompositionSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async refreshNativeAuthority(): Promise<void> {
    if (this.#nativeAuthority === null || this.#closed) return;
    const generation = ++this.#authorityGeneration;
    try {
      const status = await this.#nativeAuthority.status();
      if (this.#isAuthorityCurrent(generation)) {
        this.#nativeStatus = status;
        this.#safeError = null;
        this.#publish();
      }
    } catch {
      if (this.#isAuthorityCurrent(generation)) {
        this.#nativeStatus = null;
        this.#safeError = "nativeUnavailable";
        this.#publish();
      }
    }
  }

  async selectThread(threadId: string | null): Promise<void> {
    if (this.#closed) return;
    this.#threadGeneration += 1;
    this.#selectedThreadId = threadId;
    await this.#runtime.selectThread(threadId);
  }

  async create(): Promise<void> {
    await this.#runtime.create(
      this.#requireSelectedThread(),
      SAFE_WORKSPACE_LIST_MAX_ENTRIES,
    );
  }

  async reconcile(executionId: string): Promise<void> {
    await this.#runtime.reconcile(this.#requireSelectedThread(), executionId);
  }

  async cancel(executionId: string): Promise<void> {
    await this.#runtime.cancel(this.#requireSelectedThread(), executionId);
  }

  async selectNativeWorkspace(): Promise<void> {
    const authority = this.#requireNativeAuthority();
    const before = this.#requireAvailableNativeStatus();
    const generation = this.#beginNativeMutation();
    try {
      const response = await authority.selectAndRegister({
        expectedRevision: before.revision,
        idempotencyKey: this.#idempotencyKey("select"),
      });
      if (!this.#isAuthorityCurrent(generation)) return;
      this.#nativeStatus = response.snapshot;
      if (response.outcome === "committed") {
        await this.#rehydrateAfterNativeMutation(authority, generation);
      }
    } catch (error) {
      this.#recordNativeError(error, generation);
      throw error;
    } finally {
      this.#finishNativeMutation(generation);
    }
  }

  async clearNativeWorkspace(): Promise<void> {
    const authority = this.#requireNativeAuthority();
    const before = this.#requireAvailableNativeStatus();
    const generation = this.#beginNativeMutation();
    try {
      const response = await authority.clear({
        expectedRevision: before.revision,
        idempotencyKey: this.#idempotencyKey("clear"),
      });
      if (!this.#isAuthorityCurrent(generation)) return;
      this.#nativeStatus = response.snapshot;
      await this.#rehydrateAfterNativeMutation(authority, generation);
    } catch (error) {
      this.#recordNativeError(error, generation);
      throw error;
    } finally {
      this.#finishNativeMutation(generation);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#authorityGeneration += 1;
    this.#unsubscribeRuntime();
    this.#runtime.close();
    this.#listeners.clear();
  }

  async #rehydrateAfterNativeMutation(
    authority: DesktopWorkspaceAuthorityPort,
    generation: number,
  ): Promise<void> {
    let confirmed: DesktopWorkspaceStatus;
    try {
      confirmed = await authority.status();
    } catch {
      if (this.#isAuthorityCurrent(generation)) {
        this.#safeError = "rehydrationFailed";
        this.#publish();
      }
      return;
    }
    if (!this.#isAuthorityCurrent(generation)) return;
    this.#nativeStatus = confirmed;
    if (confirmed.availability !== "available") {
      this.#safeError = "nativeUnavailable";
      this.#publish();
      return;
    }
    this.#publish();
    const selectedThreadId = this.#selectedThreadId;
    const threadGeneration = this.#threadGeneration;
    try {
      if (
        selectedThreadId !== null &&
        this.#rehydrateThreadAuthority !== null
      ) {
        await this.#rehydrateThreadAuthority(selectedThreadId);
      }
      if (
        !this.#isAuthorityCurrent(generation) ||
        threadGeneration !== this.#threadGeneration
      ) {
        return;
      }
      await this.#runtime.selectThread(selectedThreadId);
      this.#safeError = null;
      this.#publish();
    } catch {
      this.#safeError = "rehydrationFailed";
      this.#publish();
    }
  }

  #beginNativeMutation(): number {
    if (this.#nativeBusy) {
      throw new Error("control_workspace_native_mutation_in_progress");
    }
    const generation = ++this.#authorityGeneration;
    this.#nativeBusy = true;
    this.#nativeMutationGeneration = generation;
    this.#safeError = null;
    this.#publish();
    return generation;
  }

  #finishNativeMutation(generation: number): void {
    if (this.#closed || this.#nativeMutationGeneration !== generation) return;
    this.#nativeBusy = false;
    this.#nativeMutationGeneration = null;
    this.#publish();
  }

  #requireNativeAuthority(): DesktopWorkspaceAuthorityPort {
    if (this.#nativeAuthority === null) {
      throw new Error("control_workspace_native_authority_unavailable");
    }
    return this.#nativeAuthority;
  }

  #requireAvailableNativeStatus(): DesktopWorkspaceStatus {
    if (this.#nativeStatus?.availability !== "available") {
      throw new Error("control_workspace_native_authority_unavailable");
    }
    return this.#nativeStatus;
  }

  #requireSelectedThread(): string {
    if (this.#selectedThreadId === null) {
      throw new Error("control_workspace_thread_not_selected");
    }
    return this.#selectedThreadId;
  }

  #isAuthorityCurrent(generation: number): boolean {
    return !this.#closed && generation === this.#authorityGeneration;
  }

  #recordNativeError(error: unknown, generation: number): void {
    if (!this.#isAuthorityCurrent(generation)) return;
    if (error instanceof DesktopWorkspaceAuthorityConflictError) {
      this.#nativeStatus = error.snapshot;
      this.#safeError = "nativeConflict";
    } else if (
      error instanceof DesktopWorkspaceUnavailableError ||
      error instanceof DesktopWorkspaceTransitioningError ||
      (error instanceof DesktopWorkspaceNativeMutationError &&
        error.certainty === "notSent" &&
        error.code === "desktop_workspace_transitioning")
    ) {
      if (!(error instanceof DesktopWorkspaceNativeMutationError)) {
        this.#nativeStatus = error.snapshot;
      }
      this.#safeError = "nativeUnavailable";
    } else if (
      error instanceof DesktopWorkspaceNativeMutationError &&
      error.status === 409 &&
      error.certainty === "notSent" &&
      error.code === "desktop_workspace_active_authority"
    ) {
      this.#safeError = "nativeActiveAuthority";
    } else {
      this.#safeError = "nativeUnknown";
    }
    this.#publish();
  }

  #projectSnapshot(): ControlWorkspaceCompositionSnapshot {
    const nativeWorkspace =
      this.#nativeAuthority === null
        ? null
        : {
            availability: this.#nativeStatus?.availability ?? "unavailable",
            displayName: this.#nativeStatus?.current?.displayName ?? null,
          };
    const unsafeOutcome =
      this.#safeError === "nativeUnavailable" ||
      this.#safeError === "nativeUnknown" ||
      this.#safeError === "rehydrationFailed";
    const mutationAuthority =
      !this.#controlConfigured || unsafeOutcome
        ? "unavailable"
        : this.#nativeAuthority === null
          ? "readOnly"
          : this.#nativeStatus?.availability === "available"
            ? "desktop"
            : "unavailable";
    const control = this.#runtime.getSnapshot();
    return {
      control:
        this.#safeError === "rehydrationFailed"
          ? { ...control, status: "error" }
          : control,
      mutationAuthority,
      nativeBusy: this.#nativeBusy,
      safeError: this.#safeError,
      nativeWorkspace,
    };
  }

  #publish(): void {
    if (this.#closed) return;
    this.#snapshot = this.#projectSnapshot();
    for (const listener of this.#listeners) listener();
  }
}

export function useControlWorkspaceRuntime(params: {
  client: ControlApiClient | null;
  nativeAuthority: DesktopWorkspaceAuthorityPort | null;
  rehydrateThreadAuthority?: (threadId: string) => Promise<void>;
  selectedThreadId: string | null;
}): Readonly<{
  state: ControlWorkspaceState;
  mutationAuthority: ControlWorkspaceMutationAuthority;
  nativeBusy: boolean;
  safeError: ControlWorkspaceSafeError | null;
  nativeWorkspace: SafeNativeWorkspaceSnapshot | null;
  create: () => Promise<void>;
  reconcile: (executionId: string) => Promise<void>;
  cancel: (executionId: string) => Promise<void>;
  refreshNativeAuthority: () => Promise<void>;
  selectNativeWorkspace: () => Promise<void>;
  clearNativeWorkspace: () => Promise<void>;
}> {
  const composition = useMemo(
    () =>
      new ControlWorkspaceRuntimeComposition({
        controlConfigured: params.client !== null,
        nativeAuthority: params.nativeAuthority,
        runtime: new ControlWorkspaceRuntime({ client: params.client }),
        rehydrateThreadAuthority: params.rehydrateThreadAuthority,
      }),
    [params.client, params.nativeAuthority, params.rehydrateThreadAuthority],
  );
  const subscribe = useCallback(
    (listener: () => void) => composition.subscribe(listener),
    [composition],
  );
  const getSnapshot = useCallback(
    () => composition.getSnapshot(),
    [composition],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    void composition.refreshNativeAuthority();
    return () => composition.close();
  }, [composition]);

  useEffect(() => {
    void composition
      .selectThread(params.client === null ? null : params.selectedThreadId)
      .catch(() => undefined);
    return () => {
      void composition.selectThread(null).catch(() => undefined);
    };
  }, [composition, params.selectedThreadId]);

  return useMemo(
    () => ({
      state: snapshot.control,
      mutationAuthority: snapshot.mutationAuthority,
      nativeBusy: snapshot.nativeBusy,
      safeError: snapshot.safeError,
      nativeWorkspace: snapshot.nativeWorkspace,
      create: () => composition.create(),
      reconcile: (executionId: string) => composition.reconcile(executionId),
      cancel: (executionId: string) => composition.cancel(executionId),
      refreshNativeAuthority: () => composition.refreshNativeAuthority(),
      selectNativeWorkspace: () => composition.selectNativeWorkspace(),
      clearNativeWorkspace: () => composition.clearNativeWorkspace(),
    }),
    [composition, snapshot],
  );
}
