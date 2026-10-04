/** Capture the trusted owner's synchronous fence without invoking caller-owned accessors. */
export function capturePluginCreditSettlementOwnerFence(
  owner: Readonly<{ assertCurrent(): void }> | undefined,
): (() => void) | undefined {
  if (owner === undefined) return undefined;
  if (
    owner === null ||
    typeof owner !== "object" ||
    Array.isArray(owner) ||
    (Object.getPrototypeOf(owner) !== Object.prototype &&
      Object.getPrototypeOf(owner) !== null) ||
    Reflect.ownKeys(owner).length !== 1
  )
    throw new Error("plugin_credit_settlement_owner_invalid");
  const field = Object.getOwnPropertyDescriptor(owner, "assertCurrent");
  if (
    field === undefined ||
    !field.enumerable ||
    !Object.hasOwn(field, "value") ||
    typeof field.value !== "function"
  )
    throw new Error("plugin_credit_settlement_owner_invalid");
  return (field.value as () => void).bind(owner);
}
