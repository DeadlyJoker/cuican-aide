import { getDesktopBridge } from "./desktopBridge";

declare const localManagementBrand: unique symbol;
/** This renderer-local brand is issued only after the actual Native IPC reply. */
export type DesktopLocalManagementAccess = Readonly<{
  generation: number;
  [localManagementBrand]: true;
}>;

const issued = new WeakSet<object>();
const TIMEOUT_MS = 5_000;

export function isDesktopLocalManagementAccess(
  value: unknown,
): value is DesktopLocalManagementAccess {
  return typeof value === "object" && value !== null && issued.has(value);
}

/** No URL, storage, model credential, or renderer-provided boolean can grant this access. */
export function subscribeDesktopLocalManagementAccess(
  listener: (access: DesktopLocalManagementAccess | null) => void,
): () => void {
  const runtime = getDesktopBridge()?.runtime;
  const read = runtime?.localManagementAccess;
  const subscribe = runtime?.onLocalManagementAccessChanged;
  if (typeof read !== "function" || typeof subscribe !== "function") {
    listener(null);
    return () => {};
  }
  const readCurrent = read.bind(runtime);
  let disposed = false;
  let epoch = 0;
  let pending = false;
  let current: DesktopLocalManagementAccess | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopDeadline: (() => void) | undefined;

  function withdraw() {
    if (current !== null) issued.delete(current);
    current = null;
    listener(null);
  }

  async function refresh() {
    if (disposed || pending) return;
    pending = true;
    const requestedEpoch = epoch;
    const expiry = new Promise<never>((_resolve, reject) => {
      const stop = () =>
        reject(new Error("desktop_local_management_unavailable"));
      stopDeadline = stop;
      timer = setTimeout(stop, TIMEOUT_MS);
    });
    try {
      const value = await Promise.race([
        Promise.resolve().then(readCurrent),
        expiry,
      ]);
      if (disposed || requestedEpoch !== epoch) return;
      const generation = readGeneration(value);
      if (generation === null) return;
      const access = Object.freeze({
        generation,
      }) as DesktopLocalManagementAccess;
      issued.add(access);
      current = access;
      listener(access);
    } catch {
      // A missing/closed Native session leaves the original enterprise login path in place.
    } finally {
      clearTimeout(timer);
      stopDeadline = undefined;
      pending = false;
      if (!disposed && requestedEpoch !== epoch) void refresh();
    }
  }

  const changed = () => {
    if (disposed) return;
    epoch++;
    withdraw();
    // Retire a stale waiting reply immediately, then request the new Native generation.
    stopDeadline?.();
    void refresh();
  };
  let unsubscribe: () => void;
  try {
    unsubscribe = subscribe.call(runtime, changed);
    if (typeof unsubscribe !== "function")
      throw new Error("desktop_local_management_invalid");
  } catch {
    listener(null);
    return () => {};
  }
  withdraw();
  void refresh();
  return () => {
    if (disposed) return;
    disposed = true;
    epoch++;
    if (current !== null) issued.delete(current);
    current = null;
    stopDeadline?.();
    clearTimeout(timer);
    unsubscribe();
  };
}

function readGeneration(value: unknown): number | null {
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("desktop_local_management_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 2 ||
    !keys.includes("schemaVersion") ||
    !keys.includes("generation")
  )
    throw new Error("desktop_local_management_invalid");
  for (const key of ["schemaVersion", "generation"])
    if (!("value" in descriptors[key]!) || !descriptors[key]!.enumerable)
      throw new Error("desktop_local_management_invalid");
  const generation: unknown = descriptors.generation!.value;
  if (
    descriptors.schemaVersion!.value !==
      "crewon.desktop-local-management-access.v1" ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  )
    throw new Error("desktop_local_management_invalid");
  return generation;
}
