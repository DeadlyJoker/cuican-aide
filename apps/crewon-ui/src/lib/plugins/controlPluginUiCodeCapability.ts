import type { ControlApiClient } from "@crewon/control-client";

const qualified = new WeakMap<
  ControlApiClient,
  typeof globalThis.fetch | undefined
>();
/** Only the verified same-origin bootstrap response can opt a client in. */
export function enablePluginEntryByteCache(
  client: ControlApiClient,
  fetch?: typeof globalThis.fetch,
): void {
  qualified.set(client, fetch);
}
export function hasPluginEntryByteCache(client: ControlApiClient): boolean {
  return qualified.has(client);
}

/** The captured account/session transport also renews expired asset requests. */
export function pluginEntryByteCacheFetch(
  client: ControlApiClient,
): typeof globalThis.fetch | undefined {
  return qualified.get(client);
}
