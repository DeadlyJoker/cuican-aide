import {
  parsePluginUiLease,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import type {
  PluginIdentity,
  PluginJsonValue,
} from "@crewon/plugin-sdk/contracts";
import {
  parsePluginUiDefinition,
  type PluginUiInstance,
  type PluginUiProps,
  type PluginUiServices,
} from "@crewon/plugin-sdk/ui";
import {
  abortedPluginUiOperation,
  awaitPluginUiOperation,
  checkedPluginUiAction,
  checkedPluginUiAssetBase,
  checkedPluginUiInstance,
  checkedPluginUiProps,
  copyPluginUiJson,
  PluginUiLoaderError,
  pluginUiAssetUrl,
  uiFailure,
  uiRecord,
  type PluginUiAssetRouteStyle,
} from "./pluginUiValidation";

export type PluginUiHostPorts = Readonly<{
  validateMount(lease: PluginUiLease, signal: AbortSignal): Promise<void>;
  invoke(
    lease: PluginUiLease,
    input: Readonly<{
      action: string;
      input: PluginJsonValue;
      signal: AbortSignal;
    }>,
  ): Promise<PluginJsonValue>;
  closeMount(lease: PluginUiLease): Promise<void>;
  onDiagnostic(error: unknown): void;
}>;

/** Native import is deliberately separate from the unit-test importer. The asset host verifies bytes. */
export async function importTrustedPluginUiModule(
  url: string,
): Promise<unknown> {
  return import(/* @vite-ignore */ url);
}

export type PluginUiModuleImporter = (url: string) => Promise<unknown>;
export type PluginUiMountInput = Readonly<{
  root: HTMLElement;
  lease: PluginUiLease;
  props: PluginUiProps;
  signal?: AbortSignal;
}>;
export type PluginUiMountHandle = Readonly<{
  identity: PluginIdentity;
  contributionId: string;
  update(props: PluginUiProps): Promise<void>;
  stop(): Promise<void>;
}>;

type UpdateRequest = {
  props: PluginUiProps;
  resolve(): void;
  reject(error: unknown): void;
};
type Slot = { current: Candidate | null; candidate: Candidate | null };
type Candidate = {
  slot: Slot;
  root: HTMLElement;
  child: HTMLDivElement;
  lease: PluginUiLease;
  identity: PluginIdentity;
  controller: AbortController;
  state: "staged" | "active" | "stopped";
  instance: PluginUiInstance | null;
  unmanagedInstance: boolean;
  instanceTask: Promise<PluginUiInstance> | null;
  closeTask: Promise<void> | null;
  disposeTask: Promise<void> | null;
  cleanupTask: Promise<void> | null;
  unlinkSignal(): void;
  actions: Set<AbortController>;
  instanceWork: Set<Promise<void>>;
  updating: boolean;
  pendingUpdate: UpdateRequest | null;
};

/** Trusted same-origin JavaScript has normal renderer privileges; these ports are not a sandbox. */
export class TrustedPluginUiLoader {
  readonly #ports: PluginUiHostPorts;
  readonly #assetBasePath: string;
  readonly #routeStyle: PluginUiAssetRouteStyle;
  readonly #importer: PluginUiModuleImporter;
  readonly #slots = new WeakMap<HTMLElement, Slot>();
  readonly #cleanupPending = new Set<Candidate>();
  readonly #unusedCleanup = new Map<string, Promise<void>>();
  readonly #inflight = new Set<AbortController>();

  constructor(
    options: Readonly<{
      ports: PluginUiHostPorts;
      assetBasePath: string;
      routeStyle?: PluginUiAssetRouteStyle;
      importer?: PluginUiModuleImporter;
    }>,
  ) {
    const ports = uiRecord(options.ports);
    for (const key of [
      "validateMount",
      "invoke",
      "closeMount",
      "onDiagnostic",
    ]) {
      if (typeof ports[key] !== "function")
        uiFailure("plugin_ui_host_port_missing");
    }
    this.#ports = Object.freeze({
      validateMount: options.ports.validateMount.bind(options.ports),
      invoke: options.ports.invoke.bind(options.ports),
      closeMount: options.ports.closeMount.bind(options.ports),
      onDiagnostic: options.ports.onDiagnostic.bind(options.ports),
    });
    this.#assetBasePath = checkedPluginUiAssetBase(options.assetBasePath);
    this.#routeStyle =
      options.routeStyle === undefined ? "mount-root" : options.routeStyle;
    if (
      this.#routeStyle !== "mount-root" &&
      this.#routeStyle !== "control-mount-assets"
    )
      uiFailure("plugin_ui_asset_route_invalid");
    this.#importer = options.importer ?? importTrustedPluginUiModule;
  }

  /** Failed or still-running disposal remains observable; stop never claims those instances were purged. */
  get pendingCleanupCount(): number {
    return this.#cleanupPending.size + this.#unusedCleanup.size;
  }

  /** An acquire result arriving after its caller cancelled has no DOM instance to stop. */
  async closeUnusedMount(input: PluginUiLease): Promise<void> {
    const lease = parsePluginUiLease(input);
    const existing = this.#unusedCleanup.get(lease.mountRef);
    if (existing) return existing;
    const actual = Promise.resolve()
      .then(() => this.#ports.closeMount(lease))
      .then(
        () => {
          this.#unusedCleanup.delete(lease.mountRef);
        },
        (error: unknown) => {
          this.#diagnostic(error);
          throw error;
        },
      );
    const bounded = this.#boundedCleanup(actual);
    this.#unusedCleanup.set(lease.mountRef, bounded);
    return bounded;
  }

  async mount(input: PluginUiMountInput): Promise<PluginUiMountHandle> {
    const lease = parsePluginUiLease(input.lease);
    let props: PluginUiProps;
    const entry = lease.descriptor.entrypoints.ui;
    const contribution = lease.descriptor.contributions.find(
      (item) => item.id === lease.contributionId,
    );
    let url: string;
    const root = input.root;
    try {
      props = checkedPluginUiProps(input.props, lease.contributionId);
      if (
        entry?.mode !== "trustedModule" ||
        contribution?.kind !== "module" ||
        contribution.slot !== "main.content"
      )
        uiFailure("plugin_ui_mode_unsupported");
      if (!lease.publicAssets.includes(entry.path))
        uiFailure("plugin_ui_entry_not_public");
      url = pluginUiAssetUrl(
        this.#assetBasePath,
        lease.mountRef,
        entry.path,
        this.#routeStyle,
      );
      if (
        !root ||
        root.nodeType !== 1 ||
        typeof root.ownerDocument?.createElement !== "function"
      )
        uiFailure("plugin_ui_root_invalid");
      if (input.signal?.aborted) throw abortedPluginUiOperation();
    } catch (error) {
      void this.closeUnusedMount(lease).catch(() => undefined);
      throw error;
    }
    const slot = this.#slots.get(root) ?? { current: null, candidate: null };
    this.#slots.set(root, slot);
    if (slot.candidate) this.#discard(slot.candidate);
    const child = root.ownerDocument.createElement("div");
    child.dataset.pluginUiRoot = lease.contributionId;
    child.dataset.pluginId = lease.descriptor.pluginId;
    const candidate: Candidate = {
      slot,
      root,
      child,
      lease,
      identity: Object.freeze({
        pluginId: lease.descriptor.pluginId,
        version: lease.descriptor.version,
        packageDigest: lease.packageDigest,
      }),
      controller: new AbortController(),
      state: "staged",
      instance: null,
      unmanagedInstance: false,
      instanceTask: null,
      closeTask: null,
      disposeTask: null,
      cleanupTask: null,
      unlinkSignal: () => undefined,
      actions: new Set(),
      instanceWork: new Set(),
      updating: false,
      pendingUpdate: null,
    };
    slot.candidate = candidate;
    if (input.signal) {
      const abort = () => this.#discard(candidate);
      input.signal.addEventListener("abort", abort, { once: true });
      candidate.unlinkSignal = () =>
        input.signal?.removeEventListener("abort", abort);
    }
    try {
      await this.#fence(candidate);
      const imported = await this.#await(
        candidate,
        Promise.resolve().then(() => this.#importer(url)),
      );
      await this.#fence(candidate);
      if (!imported || typeof imported !== "object")
        uiFailure("plugin_ui_module_invalid");
      const descriptor = Object.getOwnPropertyDescriptor(imported, "default");
      if (!descriptor || !("value" in descriptor))
        uiFailure("plugin_ui_module_invalid");
      const definition = parsePluginUiDefinition(descriptor.value);
      if (definition.pluginId !== candidate.identity.pluginId)
        uiFailure("plugin_ui_module_identity_invalid");
      const services: PluginUiServices = Object.freeze({
        invoke: (action, value, options) =>
          this.#invoke(candidate, action, value, options),
      });
      candidate.instanceTask = Promise.resolve()
        .then(() => {
          this.#current(candidate);
          return definition.mount(child, props, services);
        })
        .then((instance) => {
          try {
            candidate.instance = checkedPluginUiInstance(instance);
          } catch (error) {
            candidate.unmanagedInstance = true;
            throw error;
          }
          return candidate.instance;
        });
      const instance = await this.#await(candidate, candidate.instanceTask);
      candidate.instance = instance;
      await this.#fence(candidate);
      this.#current(candidate);
      const previous = slot.current;
      // This publication is synchronous. All asynchronous preflight happens on a detached root.
      if (previous) previous.child.replaceWith(child);
      else root.append(child);
      candidate.state = "active";
      slot.current = candidate;
      slot.candidate = null;
      if (previous) this.#discard(previous);
      return Object.freeze({
        identity: candidate.identity,
        contributionId: lease.contributionId,
        update: (next: PluginUiProps) => this.#queueUpdate(candidate, next),
        stop: () => this.#stop(candidate),
      });
    } catch (error) {
      this.#discard(candidate);
      throw error;
    }
  }

  #current(candidate: Candidate, active = false): void {
    if (
      candidate.controller.signal.aborted ||
      candidate.state === "stopped" ||
      (candidate.state === "staged"
        ? candidate.slot.candidate !== candidate
        : candidate.slot.current !== candidate) ||
      (active && candidate.state !== "active")
    )
      throw abortedPluginUiOperation();
    if (Date.parse(candidate.lease.expiresAt) <= Date.now())
      uiFailure("plugin_ui_lease_expired");
  }

  #await<T>(candidate: Candidate, task: Promise<T>): Promise<T> {
    return awaitPluginUiOperation(task, candidate.controller.signal);
  }

  async #fence(
    candidate: Candidate,
    signal = candidate.controller.signal,
  ): Promise<void> {
    this.#current(candidate);
    await awaitPluginUiOperation(
      Promise.resolve().then(() =>
        this.#ports.validateMount(candidate.lease, signal),
      ),
      signal,
    );
    this.#current(candidate);
    if (signal.aborted) throw abortedPluginUiOperation();
  }

  async #invoke(
    candidate: Candidate,
    rawAction: unknown,
    rawInput: unknown,
    rawOptions: unknown,
  ): Promise<PluginJsonValue> {
    this.#current(candidate, true);
    const action = checkedPluginUiAction(rawAction);
    const input = copyPluginUiJson(rawInput, 24 * 1024);
    const options = uiRecord(rawOptions);
    if (Object.keys(options).some((key) => key !== "signal"))
      uiFailure("plugin_ui_invocation_options_invalid");
    const external = options.signal as AbortSignal | undefined;
    if (external !== undefined && !(external instanceof AbortSignal))
      uiFailure("plugin_ui_invocation_options_invalid");
    if (external?.aborted) throw abortedPluginUiOperation();
    if (this.#inflight.size >= 16) uiFailure("plugin_ui_inflight_limit");
    const controller = new AbortController();
    const abort = () => controller.abort();
    candidate.controller.signal.addEventListener("abort", abort, {
      once: true,
    });
    external?.addEventListener("abort", abort, { once: true });
    candidate.actions.add(controller);
    this.#inflight.add(controller);
    let work: Promise<PluginJsonValue> | null = null;
    try {
      await this.#fence(candidate, controller.signal);
      this.#current(candidate, true);
      work = Promise.resolve().then(() => {
        this.#current(candidate, true);
        return this.#ports.invoke(candidate.lease, {
          action,
          input,
          signal: controller.signal,
        });
      });
      const result = await awaitPluginUiOperation(work, controller.signal);
      await this.#fence(candidate, controller.signal);
      this.#current(candidate, true);
      return copyPluginUiJson(result, 64 * 1024);
    } finally {
      const release = () => {
        candidate.actions.delete(controller);
        this.#inflight.delete(controller);
      };
      if (work) void work.then(release, release);
      else release();
      candidate.controller.signal.removeEventListener("abort", abort);
      external?.removeEventListener("abort", abort);
    }
  }

  #queueUpdate(candidate: Candidate, rawProps: PluginUiProps): Promise<void> {
    try {
      this.#current(candidate, true);
      const props = checkedPluginUiProps(
        rawProps,
        candidate.lease.contributionId,
      );
      return new Promise<void>((resolve, reject) => {
        // At most one executing and one latest queued update. Superseded callers are explicitly cancelled.
        candidate.pendingUpdate?.reject(
          new PluginUiLoaderError("plugin_ui_update_superseded"),
        );
        candidate.pendingUpdate = { props, resolve, reject };
        if (!candidate.updating) void this.#flushUpdates(candidate);
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async #flushUpdates(candidate: Candidate): Promise<void> {
    candidate.updating = true;
    try {
      while (candidate.pendingUpdate) {
        const request = candidate.pendingUpdate;
        candidate.pendingUpdate = null;
        try {
          await this.#fence(candidate);
          this.#current(candidate, true);
          const work = Promise.resolve().then(() => {
            this.#current(candidate, true);
            return candidate.instance!.update(request.props);
          });
          candidate.instanceWork.add(work);
          void work.then(
            () => candidate.instanceWork.delete(work),
            () => candidate.instanceWork.delete(work),
          );
          await this.#await(candidate, work);
          await this.#fence(candidate);
          this.#current(candidate, true);
          request.resolve();
        } catch (error) {
          request.reject(error);
          this.#discard(candidate);
        }
      }
    } finally {
      candidate.updating = false;
    }
  }

  #discard(candidate: Candidate): void {
    void this.#stop(candidate).catch(() => undefined); // #stop reports and retains every cleanup failure.
  }

  #stop(candidate: Candidate): Promise<void> {
    if (candidate.cleanupTask) return candidate.cleanupTask;
    // Publish the cleanup promise before abort events: an action's abort listener may re-enter stop.
    candidate.cleanupTask = Promise.resolve().then(() =>
      this.#cleanup(candidate),
    );
    candidate.state = "stopped";
    candidate.controller.abort();
    candidate.unlinkSignal();
    candidate.pendingUpdate?.reject(abortedPluginUiOperation());
    candidate.pendingUpdate = null;
    if (candidate.slot.candidate === candidate) candidate.slot.candidate = null;
    if (candidate.slot.current === candidate) candidate.slot.current = null;
    candidate.child.remove();
    this.#cleanupPending.add(candidate);
    return candidate.cleanupTask;
  }

  async #cleanup(candidate: Candidate): Promise<void> {
    candidate.closeTask = Promise.resolve().then(() =>
      this.#ports.closeMount(candidate.lease),
    );
    const dispose = async () => {
      if (candidate.instanceTask) {
        try {
          await candidate.instanceTask;
        } catch {
          /* No valid mounted instance was returned. */
        }
      }
      await Promise.allSettled([...candidate.instanceWork]);
      if (candidate.unmanagedInstance)
        uiFailure("plugin_ui_instance_cleanup_unavailable");
      if (candidate.instance && !candidate.disposeTask)
        candidate.disposeTask = Promise.resolve().then(() =>
          candidate.instance!.dispose(),
        );
      await candidate.disposeTask;
    };
    const actual = Promise.allSettled([candidate.closeTask, dispose()]).then(
      (results) => {
        const failures = results.filter(
          (result) => result.status === "rejected",
        );
        if (failures.length) {
          for (const failure of failures) this.#diagnostic(failure.reason);
          throw new PluginUiLoaderError("plugin_ui_cleanup_failed", {
            cause: failures[0].reason,
          });
        }
        this.#cleanupPending.delete(candidate);
      },
    );
    await this.#boundedCleanup(actual);
  }

  async #boundedCleanup(actual: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<void>((_, reject) => {
      timer = setTimeout(() => {
        const error = new PluginUiLoaderError("plugin_ui_cleanup_pending");
        this.#diagnostic(error);
        reject(error);
      }, 5000);
    });
    try {
      await Promise.race([actual, bounded]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #diagnostic(error: unknown): void {
    try {
      this.#ports.onDiagnostic(error);
    } catch {
      /* Diagnostics cannot re-authorize or interrupt cleanup. */
    }
  }
}
