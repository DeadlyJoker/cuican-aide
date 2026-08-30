import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const MAX_PARENT_DEPTH = 10;

type PathExists = (path: string) => boolean;

export function findLocalPackagedRepositoryRoot(
  resourcesPath: string,
  pathExists: PathExists = existsSync,
): string | null {
  const resolvedResourcesPath = resolve(resourcesPath);
  let candidate = resolvedResourcesPath;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    const releaseRoot = join(candidate, "apps", "crewon-ui", "release");
    const releaseRelativePath = relative(releaseRoot, resolvedResourcesPath);
    const isLocalPackage =
      releaseRelativePath !== "" &&
      releaseRelativePath !== ".." &&
      !releaseRelativePath.startsWith(`..${sep}`) &&
      pathExists(join(candidate, "apps", "crewon-ui", "package.json")) &&
      pathExists(join(candidate, ".crewon", ".env"));
    if (isLocalPackage) return candidate;

    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return null;
}

export function localEnvironmentPaths(options: {
  packaged: boolean;
  repositoryRoot: string | null;
  resourcesPath: string;
  pathExists?: PathExists;
}): string[] {
  const root = options.packaged
    ? findLocalPackagedRepositoryRoot(options.resourcesPath, options.pathExists)
    : options.repositoryRoot;
  if (root === null) return [];
  return [join(root, ".crewon", ".env"), join(root, ".crewon", "dev-ui.env")];
}

export function loadLocalEnvironment(options: {
  packaged: boolean;
  repositoryRoot: string | null;
  resourcesPath: string;
}): void {
  for (const path of localEnvironmentPaths(options)) {
    if (existsSync(path)) process.loadEnvFile(path);
  }
}
