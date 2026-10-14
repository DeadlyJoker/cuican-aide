import type { PluginUiLease } from "@crewon/contracts/plugins";
import { checkedLeaseIdentity } from "./controlPluginUiSupport";
import {
  abortedPluginUiOperation,
  awaitPluginUiOperation,
  uiFailure,
} from "./pluginUiValidation";

type Flight = {
  key: string;
  controller: AbortController;
  work: Promise<PluginUiLease>;
  waiters: number;
  settled: boolean;
};

/** Share only a currently running observation. A completed result is never an authorization cache. */
export class PluginUiValidationFlights {
  readonly #pending = new Map<string, Flight>();
  readonly #owned = new Set<Flight>();

  async run(
    lease: PluginUiLease,
    signal: AbortSignal,
    request: (signal: AbortSignal) => Promise<PluginUiLease>,
  ): Promise<PluginUiLease> {
    if (signal.aborted) throw abortedPluginUiOperation();
    const key = checkedLeaseIdentity(lease);
    let flight = this.#pending.get(key);
    if (!flight) {
      if (this.#owned.size >= 128) uiFailure("plugin_ui_inflight_limit");
      const controller = new AbortController();
      flight = {
        key,
        controller,
        work: Promise.resolve(lease),
        waiters: 0,
        settled: false,
      };
      const owned = flight;
      this.#pending.set(key, owned);
      this.#owned.add(owned);
      owned.work = Promise.resolve().then(async () => {
        if (controller.signal.aborted) throw abortedPluginUiOperation();
        const result = await request(controller.signal);
        if (controller.signal.aborted) throw abortedPluginUiOperation();
        return result;
      });
      const settle = () => {
        owned.settled = true;
        if (this.#pending.get(key) === owned) this.#pending.delete(key);
        if (owned.waiters === 0) this.#owned.delete(owned);
      };
      void owned.work.then(settle, settle);
    }
    if (flight.waiters >= 64) uiFailure("plugin_ui_inflight_limit");
    flight.waiters++;
    const caller = new AbortController();
    const abort = () => caller.abort();
    signal.addEventListener("abort", abort, { once: true });
    flight.controller.signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted || flight.controller.signal.aborted)
        throw abortedPluginUiOperation();
      const result = await awaitPluginUiOperation(flight.work, caller.signal);
      if (signal.aborted || flight.controller.signal.aborted)
        throw abortedPluginUiOperation();
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
      flight.controller.signal.removeEventListener("abort", abort);
      flight.waiters--;
      if (flight.waiters === 0) {
        this.#owned.delete(flight);
        if (!flight.settled) {
          if (this.#pending.get(key) === flight) this.#pending.delete(key);
          flight.controller.abort();
        }
      }
    }
  }

  withdraw(lease: PluginUiLease): void {
    const key = checkedLeaseIdentity(lease);
    for (const flight of this.#owned) {
      if (flight.key !== key) continue;
      if (this.#pending.get(key) === flight) this.#pending.delete(key);
      flight.controller.abort();
    }
  }
}
