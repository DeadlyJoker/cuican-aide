import type { ToolRuntimePort } from "@crewon/tool-broker";
import type { RuntimeResourceLease } from "./runtime-resource-lease.ts";

type Source = () => RuntimeResourceLease<ToolRuntimePort> | null;

/** One lease per pass, with bounded fair visits to the original and admitted installed owners. */
export function toolResultMaintenanceSources(
  input: Readonly<{
    base: Source;
    installed?: Source;
  }>,
): Source {
  const { base, installed } = input;
  if (installed === undefined) return base;
  let installedTurn = false;
  return () => {
    installedTurn = !installedTurn;
    return installedTurn ? (installed() ?? base()) : (base() ?? installed());
  };
}
