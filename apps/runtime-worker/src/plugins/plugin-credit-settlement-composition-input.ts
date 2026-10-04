import type { RuntimeCompositionLifetime } from "../runtime-composition-lifetime.ts";
import { capturePluginCreditSettlementRuntimeConfig } from "./plugin-credit-settlement-maintenance.ts";
import type { PluginCreditSettlementRuntimeConfig } from "./plugin-credit-settlement-runtime-types.ts";

function ownData(input: unknown, key: string): unknown {
  if (input === null || typeof input !== "object") return undefined;
  const field = Object.getOwnPropertyDescriptor(input, key);
  return field !== undefined && Object.hasOwn(field, "value")
    ? field.value
    : undefined;
}

/** Capture the optional financial field before the ordinary composition object is spread. */
export function capturePluginCreditSettlementCompositionInput(
  input: object,
): PluginCreditSettlementRuntimeConfig | undefined {
  const field = Object.getOwnPropertyDescriptor(
    input,
    "pluginCreditSettlement",
  );
  if (
    field === undefined ||
    (Object.hasOwn(field, "value") && field.value === undefined)
  )
    return undefined;
  if (!Object.hasOwn(field, "value") || !field.enumerable)
    throw new Error("plugin_credit_settlement_configuration_invalid");
  return capturePluginCreditSettlementRuntimeConfig(field.value);
}

/** Own an already supplied closer on startup failure without evaluating invalid configuration getters. */
export function ownPluginCreditSettlementCompositionAuthority(
  input: object,
  lifetime: RuntimeCompositionLifetime,
): void {
  const configured = ownData(input, "pluginCreditSettlement");
  const authority = ownData(configured, "authority");
  const close = ownData(authority, "close");
  if (typeof close !== "function") return;
  lifetime.own(
    { close: () => Reflect.apply(close, authority, []) },
    { phase: "stop" },
  );
}
