import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  findLocalPackagedRepositoryRoot,
  localEnvironmentPaths,
} from "./localEnvironment.ts";

describe("local packaged environment", () => {
  it("finds the repository only for an app bundle built inside its release directory", () => {
    const root = resolve("/workspace/crewon");
    const resourcesPath = join(
      root,
      "apps/crewon-ui/release/mac-arm64/CrewON.app/Contents/Resources",
    );
    const existing = new Set([
      join(root, ".crewon", ".env"),
      join(root, "apps", "crewon-ui", "package.json"),
    ]);
    const pathExists = (path: string) => existing.has(path);

    expect(findLocalPackagedRepositoryRoot(resourcesPath, pathExists)).toBe(
      root,
    );
    expect(
      findLocalPackagedRepositoryRoot(
        resolve("/Applications/CrewON.app/Contents/Resources"),
        pathExists,
      ),
    ).toBeNull();
  });

  it("keeps local secrets outside the package and returns only repository env paths", () => {
    const root = resolve("/workspace/crewon");
    const resourcesPath = join(
      root,
      "apps/crewon-ui/release/mac-arm64/CrewON.app/Contents/Resources",
    );
    const existing = new Set([
      join(root, ".crewon", ".env"),
      join(root, "apps", "crewon-ui", "package.json"),
    ]);

    expect(
      localEnvironmentPaths({
        packaged: true,
        repositoryRoot: null,
        resourcesPath,
        pathExists: (path) => existing.has(path),
      }),
    ).toEqual([
      join(root, ".crewon", ".env"),
      join(root, ".crewon", "dev-ui.env"),
    ]);
  });
});
