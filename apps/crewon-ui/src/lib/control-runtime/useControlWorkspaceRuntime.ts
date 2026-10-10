import type { ControlApiClient } from "@crewon/control-client";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import type {
  DesktopWorkspaceAuthorityPort,
  DesktopWorkspaceAvailability,
  DesktopWorkspaceStatus,
} from "../desktop/desktopWorkspaceAuthorityAdapter";
import {
  DesktopWorkspaceAuthorityConflictError,
  DesktopWorkspaceDirectoryUnavailableError,
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
  workspaceId: string | null;
  displayName: string | null;
}>;

export type ControlWorkspaceSafeError =
  | "nativeActiveAuthority"
  | "nativeConflict"
  | "nativeUnavailable"
  | "nativeUnknown"
  | "nativeDirectoryMissing"
  | "nativeDirectoryPermissionDenied"
  | "nativeDirectoryUnavailable"
  | "rehydrationFailed";

export function controlWorkspaceSafeErrorMessage(
  error: ControlWorkspaceSafeError | null,
): string | null {
  switch (error) {
    case null:
      return null;
    case "nativeDirectoryMissing":
      return "工作空间目录已被删除或移动。请恢复原目录后重新检查，或选择其他工作空间；历史会话仍保留原归属。";
    case "nativeDirectoryPermissionDenied":
      return "没有权限访问工作空间目录。请检查系统权限后重新检查。";
    case "nativeDirectoryUnavailable":
      return "原工作空间路径已改变，或不再是文件夹。请恢复原目录后重新检查。";
    case "nativeUnavailable":
    case "nativeUnknown":
      return "工作空间状态暂时无法确认，请重新检查后再试。";
    case "nativeConflict":
      return "工作空间选择已发生变化，请重新检查后再试。";
    case "nativeActiveAuthority":
      return "工作空间正在执行任务，请等待任务结束后再切换。";
    case "rehydrationFailed":
      return "工作空间已确认，但会话暂时无法恢复，请重新打开会话。";
  }
}

export type ControlWorkspaceCompositionSnapshot = Readonly<{
  control: ControlWorkspaceState;
  mutationAuthority: ControlWorkspaceMutationAuthority;
  nativeBusy: boolean;
  safeError: ControlWorkspaceSafeError | null;
  nativeWorkspace: SafeNativeWorkspaceSnapshot | null;
  nativeWorkspaces: readonly Readonly<{
    workspaceId: string;
    displayName: string;
  }>[];
  nativeWorkspaceRevision: string | null;
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
  readonly #idempotencyKey: (
    operation: "activate" | "clear" | "select",
  ) => string;
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
  #nativeRefreshing = false;
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
    idempotencyKey?: (operation: "activate" | "clear" | "select") => string;
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
    if (this.#nativeBusy)
      throw new Error("control_workspace_native_mutation_in_progress");
    const generation = ++this.#authorityGeneration;
    this.#nativeRefreshing = true;
    this.#publish();
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
    } finally {
      if (this.#isAuthorityCurrent(generation)) {
        this.#nativeRefreshing = false;
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

  async selectNativeWorkspace(): Promise<boolean> {
    const authority = this.#requireNativeAuthority();
    const before = this.#requireAvailableNativeStatus();
    const generation = this.#beginNativeMutation();
    try {
      const response = await authority.selectAndRegister({
        expectedRevision: before.revision,
        idempotencyKey: this.#idempotencyKey("select"),
      });
      if (!this.#isAuthorityCurrent(generation)) return false;
      this.#nativeStatus = response.snapshot;
      if (response.outcome === "committed") {
        await this.#rehydrateAfterNativeMutation(authority, generation);
      }
      return response.outcome === "committed";
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

  async activateNativeWorkspace(workspaceId: string): Promise<void> {
    const authority = this.#requireNativeAuthority();
    const before = this.#requireAvailableNativeStatus();
    const generation = this.#beginNativeMutation();
    try {
      const response = await authority.activate(workspaceId, {
        expectedRevision: before.revision,
        idempotencyKey: this.#idempotencyKey("activate"),
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
        this.#safeError = "nativeUnavailable";
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
      if (
        !this.#isAuthorityCurrent(generation) ||
        threadGeneration !== this.#threadGeneration
      ) {
        return;
      }
      this.#safeError = null;
      this.#publish();
    } catch (error) {
      if (
        !this.#isAuthorityCurrent(generation) ||
        threadGeneration !== this.#threadGeneration ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        return;
      }
      this.#safeError = "rehydrationFailed";
      this.#publish();
    }
  }

  #beginNativeMutation(): number {
    if (this.#nativeBusy || this.#nativeRefreshing) {
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
    if (this.#nativeAuthority === null || this.#closed) {
      throw new Error("control_workspace_native_authority_unavailable");
    }
    return this.#nativeAuthority;
  }

  #requireAvailableNativeStatus(): DesktopWorkspaceStatus {
    if (
      this.#nativeStatus?.availability !== "available" ||
      this.#snapshot.mutationAuthority !== "desktop"
    ) {
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
    if (error instanceof DesktopWorkspaceDirectoryUnavailableError) {
      this.#safeError =
        error.reason === "missing"
          ? "nativeDirectoryMissing"
          : error.reason === "permissionDenied"
            ? "nativeDirectoryPermissionDenied"
            : "nativeDirectoryUnavailable";
    } else if (error instanceof DesktopWorkspaceAuthorityConflictError) {
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
    // Directory hints and uncertain outcomes never grant native authority.
    // A separate native status read must confirm it before actions can resume.
    const unsafeOutcome =
      this.#nativeRefreshing ||
      this.#safeError === "nativeUnavailable" ||
      this.#safeError === "nativeUnknown" ||
      this.#safeError === "nativeDirectoryMissing" ||
      this.#safeError === "nativeDirectoryPermissionDenied" ||
      this.#safeError === "nativeDirectoryUnavailable";
    const nativeWorkspace =
      this.#nativeAuthority === null
        ? null
        : {
            availability: unsafeOutcome
              ? "unavailable"
              : (this.#nativeStatus?.availability ?? "unavailable"),
            workspaceId: this.#nativeStatus?.current?.workspaceId ?? null,
            displayName: this.#nativeStatus?.current?.displayName ?? null,
          };
    // Thread refresh errors do not revoke independently confirmed native scope.
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
      nativeBusy: this.#nativeBusy || this.#nativeRefreshing,
      safeError: this.#safeError,
      nativeWorkspace,
      nativeWorkspaces: this.#nativeStatus?.workspaces ?? [],
      nativeWorkspaceRevision:
        this.#nativeStatus === null
          ? null
          : `${this.#nativeStatus.revision}:${this.#nativeStatus.supervisorGeneration}`,
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
  nativeWorkspaces: readonly Readonly<{
    workspaceId: string;
    displayName: string;
  }>[];
  nativeWorkspaceRevision: string | null;
  create: () => Promise<void>;
  reconcile: (executionId: string) => Promise<void>;
  cancel: (executionId: string) => Promise<void>;
  refreshNativeAuthority: () => Promise<void>;
  selectNativeWorkspace: () => Promise<boolean>;
  clearNativeWorkspace: () => Promise<void>;
  activateNativeWorkspace: (workspaceId: string) => Promise<void>;
}> {
  const [binding, setBinding] = useState<Readonly<{
    client: ControlApiClient | null;
    nativeAuthority: DesktopWorkspaceAuthorityPort | null;
    rehydrateThreadAuthority: typeof params.rehydrateThreadAuthority;
    composition: ControlWorkspaceRuntimeComposition;
  }> | null>(null);

  useEffect(() => {
    // Each setup owns its composition. StrictMode cleanup permanently closes
    // the first instance, so its replay must not reuse that closed authority.
    const composition = new ControlWorkspaceRuntimeComposition({
      controlConfigured: params.client !== null,
      nativeAuthority: params.nativeAuthority,
      runtime: new ControlWorkspaceRuntime({ client: params.client }),
      rehydrateThreadAuthority: params.rehydrateThreadAuthority,
    });
    setBinding({
      client: params.client,
      nativeAuthority: params.nativeAuthority,
      rehydrateThreadAuthority: params.rehydrateThreadAuthority,
      composition,
    });
    void composition.refreshNativeAuthority();
    return () => composition.close();
  }, [params.client, params.nativeAuthority, params.rehydrateThreadAuthority]);

  // A new connection must never render the previous connection's native grant
  // while its effect is still preparing the replacement composition.
  const composition =
    binding?.client === params.client &&
    binding.nativeAuthority === params.nativeAuthority &&
    binding.rehydrateThreadAuthority === params.rehydrateThreadAuthority
      ? binding.composition
      : null;
  const pendingSnapshot = useMemo<ControlWorkspaceCompositionSnapshot>(
    () => ({
      control: {
        status: params.client === null ? "unavailable" : "available",
        threadId: null,
        threadRevision: null,
        threadStatus: null,
        operations: [],
        eventSequences: {},
      },
      mutationAuthority:
        params.client === null || params.nativeAuthority !== null
          ? "unavailable"
          : "readOnly",
      nativeBusy: false,
      safeError: null,
      nativeWorkspace:
        params.nativeAuthority === null
          ? null
          : {
              availability: "unavailable",
              workspaceId: null,
              displayName: null,
            },
      nativeWorkspaces: [],
      nativeWorkspaceRevision: null,
    }),
    [params.client, params.nativeAuthority],
  );
  const subscribe = useCallback(
    (listener: () => void) =>
      composition?.subscribe(listener) ?? (() => undefined),
    [composition],
  );
  const getSnapshot = useCallback(
    () => composition?.getSnapshot() ?? pendingSnapshot,
    [composition, pendingSnapshot],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const requireComposition = useCallback(() => {
    if (composition === null) throw new Error("control_workspace_initializing");
    return composition;
  }, [composition]);

  useEffect(() => {
    if (composition === null) return;
    void composition
      .selectThread(params.client === null ? null : params.selectedThreadId)
      .catch(() => undefined);
    return () => {
      void composition.selectThread(null).catch(() => undefined);
    };
  }, [composition, params.client, params.selectedThreadId]);

  return useMemo(
    () => ({
      state: snapshot.control,
      mutationAuthority: snapshot.mutationAuthority,
      nativeBusy: snapshot.nativeBusy,
      safeError: snapshot.safeError,
      nativeWorkspace: snapshot.nativeWorkspace,
      nativeWorkspaces: snapshot.nativeWorkspaces,
      nativeWorkspaceRevision: snapshot.nativeWorkspaceRevision,
      create: async () => requireComposition().create(),
      reconcile: async (executionId: string) =>
        requireComposition().reconcile(executionId),
      cancel: async (executionId: string) =>
        requireComposition().cancel(executionId),
      refreshNativeAuthority: async () =>
        requireComposition().refreshNativeAuthority(),
      selectNativeWorkspace: async () =>
        requireComposition().selectNativeWorkspace(),
      clearNativeWorkspace: async () =>
        requireComposition().clearNativeWorkspace(),
      activateNativeWorkspace: async (workspaceId: string) =>
        requireComposition().activateNativeWorkspace(workspaceId),
    }),
    [requireComposition, snapshot],
  );
}
