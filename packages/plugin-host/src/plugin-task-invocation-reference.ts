/** Inspect only an own data reference. This does not issue or authorize an invocation. */
export function ownsTaskInvocationReference(
  input: unknown,
  invocations: ReadonlyMap<string, unknown>,
  closed: boolean,
): boolean {
  if (closed || input === null || typeof input !== "object") return false;
  const ref = Object.getOwnPropertyDescriptor(input, "invocationRef");
  return (
    ref !== undefined &&
    Object.hasOwn(ref, "value") &&
    typeof ref.value === "string" &&
    /^[A-Za-z0-9_-]{32,128}$/u.test(ref.value) &&
    invocations.has(ref.value)
  );
}
