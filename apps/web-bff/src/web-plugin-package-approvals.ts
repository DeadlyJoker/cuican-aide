/** Explicit immutable byte approvals. Multiple versions support a CAS upgrade;
 * they never approve an arbitrary package under the same plugin name. */
export function readWebPluginPackageApprovals(
  json: string,
): ReadonlyMap<string, readonly string[]> {
  const invalid = () => {
    throw new Error("web_identity_packages_invalid");
  };
  if (Buffer.byteLength(json) > 16384) invalid();
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch {
    return invalid();
  }
  if (!Array.isArray(input) || input.length > 32) return invalid();
  const result = new Map<string, readonly string[]>();
  for (const item of input) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(",") !== "packageDigest,pluginId" ||
      typeof item.pluginId !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(item.pluginId) ||
      typeof item.packageDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(item.packageDigest)
    )
      return invalid();
    const previous = result.get(item.pluginId) ?? [];
    if (previous.includes(item.packageDigest)) return invalid();
    result.set(item.pluginId, Object.freeze([...previous, item.packageDigest]));
  }
  return result;
}
