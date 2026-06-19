export function joinPath(basePath: string, childName: string): string {
  const separator = basePath.includes("\\") ? "\\" : "/";
  return `${basePath.replace(/[\\/]+$/, "")}${separator}${childName}`;
}

export function resolveSearchPath(root: string, resultPath: string): string {
  if (/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(resultPath)) {
    return resultPath;
  }

  return joinPath(root, resultPath);
}

export function pathBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function pathDirName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  return index > 0 ? normalized.slice(0, index) : normalized;
}
