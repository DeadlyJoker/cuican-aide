/** Remove conversation bindings from the new-task route, preserving host options. */
export function commandNewTaskDraftRoute(location: {
  pathname: string;
  search: string;
  hash: string;
}): string {
  const query = new URLSearchParams(location.search);
  for (const key of [
    "sceneThread",
    "scene",
    "executionTargetThread",
    "executionTarget",
  ])
    query.delete(key);
  const search = query.toString();
  return `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
}
