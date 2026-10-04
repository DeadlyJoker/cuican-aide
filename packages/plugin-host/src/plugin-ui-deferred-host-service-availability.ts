import { ApplicationError } from "@crewon/application";
import {
  capturePluginUiHostServiceAvailability,
  type PluginUiHostServiceAvailabilityPort,
} from "./plugin-ui-host-service-availability.ts";

export type DeferredPluginUiHostServiceAvailability = Readonly<{
  port: PluginUiHostServiceAvailabilityPort;
  bind(actual: PluginUiHostServiceAvailabilityPort): void;
  close(): void;
}>;

type Binding = {
  current: PluginUiHostServiceAvailabilityPort | undefined;
  bound: boolean;
  closed: boolean;
  reading: boolean;
};
const bindings = new WeakMap<object, Binding>();
const MAX_DEPTH = 64;
let readingDepth = 0;

/** A Host composition seam only: no protocol brand, invocation, task or funding is manufactured. */
export function createDeferredPluginUiHostServiceAvailability(): DeferredPluginUiHostServiceAvailability {
  const binding: Binding = {
    current: undefined,
    bound: false,
    closed: false,
    reading: false,
  };
  const port: PluginUiHostServiceAvailabilityPort = Object.freeze({
    isAvailable: (input) => {
      const actual = binding.current;
      if (
        binding.closed ||
        actual === undefined ||
        binding.reading ||
        readingDepth >= MAX_DEPTH
      )
        return false;
      binding.reading = true;
      readingDepth++;
      try {
        return (
          actual.isAvailable(input) === true &&
          !binding.closed &&
          binding.current === actual
        );
      } finally {
        readingDepth--;
        binding.reading = false;
      }
    },
  });
  bindings.set(port, binding);
  return Object.freeze({
    port,
    bind: (actual: PluginUiHostServiceAvailabilityPort) => {
      if (
        binding.closed ||
        binding.bound ||
        actual === undefined ||
        actual === null ||
        bindings.get(actual) === binding
      )
        invalidBinding();
      const captured = capturePluginUiHostServiceAvailability(actual)!;
      // Descriptor/prototype inspection may reenter trusted Host code; withdrawal is permanent.
      if (binding.closed || binding.bound || bindings.get(captured) === binding)
        invalidBinding();
      binding.current = captured;
      binding.bound = true;
    },
    close: () => {
      binding.closed = true;
      binding.current = undefined;
    },
  });
}

/** Private capture provenance; never export this helper through the package entrypoint. */
export function preserveDeferredPluginUiHostServiceAvailability(
  original: PluginUiHostServiceAvailabilityPort,
  captured: PluginUiHostServiceAvailabilityPort,
): PluginUiHostServiceAvailabilityPort {
  const binding = bindings.get(original);
  if (binding !== undefined) bindings.set(captured, binding);
  return captured;
}

/** Private protocol markers follow actual preserved owners and current deferred bindings without callbacks. */
export function hasDeferredPluginUiHostServiceAvailabilityBrand(
  port: PluginUiHostServiceAvailabilityPort | undefined,
  assembled: WeakSet<object>,
  preserved: WeakMap<object, PluginUiHostServiceAvailabilityPort>,
): boolean {
  const seen = new Set<object>();
  let current = port;
  for (let depth = 0; current !== undefined && depth < MAX_DEPTH; depth++) {
    if (seen.has(current)) return false;
    seen.add(current);
    const binding = bindings.get(current);
    if (binding !== undefined) {
      if (binding.closed || binding.current === undefined) return false;
      current = binding.current;
    } else {
      if (assembled.has(current)) return true;
      current = preserved.get(current);
    }
  }
  return false;
}

function invalidBinding(): never {
  throw new ApplicationError(
    "internal",
    "plugin_ui_deferred_host_service_availability_invalid",
  );
}
