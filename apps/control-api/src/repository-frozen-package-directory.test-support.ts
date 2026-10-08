import { fileURLToPath } from "node:url";

/** Only named repository fixtures use this locator. Explicit caller/env paths keep cwd semantics. */
export function repositoryFrozenPackageDirectory(
  directoryFromRepositoryRoot: string,
): string {
  if (
    !directoryFromRepositoryRoot.startsWith(
      "output/extensions/installable-plugins/",
    ) ||
    /[\\?#%]/u.test(directoryFromRepositoryRoot) ||
    directoryFromRepositoryRoot
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  )
    throw new Error("repository_frozen_package_directory_invalid");
  return fileURLToPath(
    new URL(`../../../${directoryFromRepositoryRoot}`, import.meta.url),
  );
}
