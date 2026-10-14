import type { ControlApiClient } from "@crewon/control-client";

const qualified = new WeakSet<ControlApiClient>();
/** Only the verified same-origin bootstrap response can opt a client in. */
export function enablePluginEntryByteCache(client: ControlApiClient): void {
  qualified.add(client);
}
export function hasPluginEntryByteCache(client: ControlApiClient): boolean {
  return qualified.has(client);
}
