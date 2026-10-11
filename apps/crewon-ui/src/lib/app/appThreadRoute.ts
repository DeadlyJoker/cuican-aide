/** The URL owns this page's initial selection; it is never shared across tabs. */
export function threadSelectionFromSearch(search: string): string | null {
  const query = new URLSearchParams(search);
  // sceneThread identifies the displayed conversation. The execution target
  // is only a fallback for older links that do not have a scene binding.
  const key = query.has("sceneThread")
    ? "sceneThread"
    : "executionTargetThread";
  const values = query.getAll(key);
  if (values.length !== 1) return null;
  const id = values[0]!;
  return id.length > 0 &&
    id.trim() === id &&
    new TextEncoder().encode(id).byteLength <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(id)
    ? id
    : null;
}

export function initialThreadRouteSelection(): string | null {
  return typeof window === "undefined"
    ? null
    : threadSelectionFromSearch(window.location.search);
}
