import {
  parsePluginUiLease,
  parseRenewPluginUiMountResponse,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import {
  abortedPluginUiOperation,
  awaitPluginUiOperation,
  uiFailure,
} from "./pluginUiValidation";

type Renewal = {
  previous: PluginUiLease;
  controller: AbortController;
  promise: Promise<PluginUiLease>;
  waiters: number;
};
type Owner = {
  lease: PluginUiLease;
  alive: boolean;
  operations: Set<Promise<unknown>>;
  renewal: Renewal | null;
};

const MAX_OWNER_OPERATIONS = 64;
const MAX_RENEWAL_WAITERS = 64;
const MAX_OWNERS = 128;

function sameLease(left: PluginUiLease, right: PluginUiLease): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Local ordering only: every operation and renewal still uses the authenticated host ports. */
export class PluginUiLeaseLifecycle {
  readonly #owners = new Map<string, Owner>();

  register(input: PluginUiLease): void {
    const lease = parsePluginUiLease(input);
    if (Date.parse(lease.expiresAt) <= Date.now())
      uiFailure("plugin_ui_lease_expired");
    if (this.#owners.has(lease.mountRef))
      uiFailure("plugin_ui_mount_ref_already_registered");
    if (this.#owners.size >= MAX_OWNERS)
      uiFailure("plugin_ui_lease_owner_limit");
    this.#owners.set(lease.mountRef, {
      lease,
      alive: true,
      operations: new Set(),
      renewal: null,
    });
  }

  release(input: PluginUiLease): void {
    const lease = parsePluginUiLease(input);
    const owner = this.#owners.get(lease.mountRef);
    if (!owner) return;
    if (!sameLease(owner.lease, lease))
      uiFailure("plugin_ui_lease_identity_mismatch");
    this.#withdraw(owner);
  }

  /** Only the host's read-only validation port may inspect a lease before acquiring its local owner. */
  validate<T>(
    input: PluginUiLease,
    signal: AbortSignal,
    work: (currentLease: PluginUiLease) => T | Promise<T>,
  ): Promise<T> {
    try {
      const lease = parsePluginUiLease(input);
      if (signal.aborted) throw abortedPluginUiOperation();
      if (this.#owners.has(lease.mountRef))
        return this.run(lease, signal, work);
      return awaitPluginUiOperation(Promise.resolve(work(lease)), signal);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async run<T>(
    input: PluginUiLease,
    signal: AbortSignal,
    work: (currentLease: PluginUiLease) => T | Promise<T>,
  ): Promise<T> {
    const lease = parsePluginUiLease(input);
    if (signal.aborted) throw abortedPluginUiOperation();
    const owner = this.#owners.get(lease.mountRef);
    if (!owner) uiFailure("plugin_ui_lease_owner_missing");
    this.#current(owner);
    if (!sameLease(owner.lease, lease))
      uiFailure("plugin_ui_lease_identity_mismatch");
    if (owner.renewal) await this.#wait(owner.renewal, signal);
    this.#current(owner);
    if (signal.aborted) throw abortedPluginUiOperation();
    if (owner.operations.size >= MAX_OWNER_OPERATIONS)
      uiFailure("plugin_ui_lease_operation_limit");
    const currentLease = owner.lease;
    // Register the real work before yielding. Waiting callers are not operations and cannot block renewal.
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const actual = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    owner.operations.add(actual);
    void actual.then(
      () => owner.operations.delete(actual),
      () => owner.operations.delete(actual),
    );
    try {
      this.#current(owner);
      resolve(work(currentLease));
    } catch (error) {
      reject(error);
    }
    const result = await awaitPluginUiOperation(actual, signal);
    this.#current(owner);
    return result;
  }

  async renew(
    input: PluginUiLease,
    signal: AbortSignal,
    request: (
      previousLease: PluginUiLease,
      renewalSignal: AbortSignal,
    ) => Promise<unknown>,
    commit: (previousLease: PluginUiLease, nextLease: PluginUiLease) => void,
  ): Promise<PluginUiLease> {
    const lease = parsePluginUiLease(input);
    if (signal.aborted) throw abortedPluginUiOperation();
    const owner = this.#owners.get(lease.mountRef);
    if (!owner) uiFailure("plugin_ui_lease_owner_missing");
    this.#current(owner);
    if (!sameLease(owner.lease, lease))
      uiFailure("plugin_ui_lease_identity_mismatch");
    if (owner.renewal) return this.#wait(owner.renewal, signal);
    let resolve!: (next: PluginUiLease) => void;
    let reject!: (error: unknown) => void;
    const renewal: Renewal = {
      previous: owner.lease,
      controller: new AbortController(),
      promise: new Promise<PluginUiLease>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
      waiters: 0,
    };
    // Publish the flight synchronously so no new operation can enter the drain set.
    owner.renewal = renewal;
    void this.#renew(owner, renewal, request, commit).then(
      (next) => {
        if (owner.renewal === renewal) owner.renewal = null;
        resolve(next);
      },
      (error: unknown) => {
        this.#withdraw(owner);
        if (owner.renewal === renewal) owner.renewal = null;
        reject(error);
      },
    );
    // The actual flight remains observed even when every waiting caller cancels.
    void renewal.promise.catch(() => undefined);
    return this.#wait(renewal, signal);
  }

  async #renew(
    owner: Owner,
    renewal: Renewal,
    request: (
      previousLease: PluginUiLease,
      renewalSignal: AbortSignal,
    ) => Promise<unknown>,
    commit: (previousLease: PluginUiLease, nextLease: PluginUiLease) => void,
  ): Promise<PluginUiLease> {
    await Promise.allSettled([...owner.operations]);
    this.#current(owner);
    if (!sameLease(owner.lease, renewal.previous))
      uiFailure("plugin_ui_lease_identity_mismatch");
    const response = await request(renewal.previous, renewal.controller.signal);
    const next = parseRenewPluginUiMountResponse(response, renewal.previous);
    this.#current(owner);
    if (!sameLease(owner.lease, renewal.previous))
      uiFailure("plugin_ui_lease_identity_mismatch");
    commit(renewal.previous, next);
    this.#current(owner);
    owner.lease = next;
    return next;
  }

  async #wait(renewal: Renewal, signal: AbortSignal): Promise<PluginUiLease> {
    if (renewal.waiters >= MAX_RENEWAL_WAITERS)
      uiFailure("plugin_ui_lease_renewal_waiter_limit");
    renewal.waiters++;
    try {
      return await awaitPluginUiOperation(renewal.promise, signal);
    } finally {
      renewal.waiters--;
    }
  }

  #current(owner: Owner): void {
    if (!owner.alive || this.#owners.get(owner.lease.mountRef) !== owner)
      throw abortedPluginUiOperation();
    if (Date.parse(owner.lease.expiresAt) <= Date.now())
      uiFailure("plugin_ui_lease_expired");
  }

  #withdraw(owner: Owner): void {
    owner.alive = false;
    owner.renewal?.controller.abort();
    if (this.#owners.get(owner.lease.mountRef) === owner)
      this.#owners.delete(owner.lease.mountRef);
  }
}
