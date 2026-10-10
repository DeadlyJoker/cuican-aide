import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

import { boundaries } from "./package-boundary-policy.ts";
import {
  controlApiBoundary,
  runtimeWorkerBoundary,
  deviceGatewayBoundary,
} from "./app-boundary-policy.ts";
import type { ImportBoundary } from "./package-boundary-types.ts";
import {
  boundaryAllowsImport,
  importSpecifiers,
  isForbiddenRendererImport,
  isTestSource,
  rendererTestSourceDependencies,
} from "./package-boundary-imports.ts";

test("every architecture package has an explicit dependency boundary", () => {
  const packageNames = readdirSync(path.join(repositoryRoot, "packages"), {
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsPackageManifest(
          path.join(repositoryRoot, "packages", entry.name),
        ),
    )
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(
    boundaries.map((boundary) => boundary.packageName).sort(),
    packageNames,
  );
});

test("new architecture packages respect dependency direction", () => {
  const violations: string[] = [];

  for (const boundary of boundaries) {
    const sourceDirectory = path.join(
      repositoryRoot,
      "packages",
      boundary.packageName,
      "src",
    );
    for (const file of sourceFiles(sourceDirectory)) {
      if (isTestSource(file)) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith(".")) {
          continue;
        }
        if (
          boundaryAllowsImport(
            boundary,
            path.relative(sourceDirectory, file),
            specifier,
          )
        ) {
          continue;
        }
        violations.push(
          `${path.relative(repositoryRoot, file)} -> ${specifier}`,
        );
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("core values and application ports cannot acquire runtime or outward dependencies", () => {
  for (const name of ["domain", "contracts", "application"]) {
    const boundary = boundaries.find((value) => value.packageName === name)!;
    for (const specifier of [
      "node:crypto",
      "node:fs",
      "@crewon/store",
      "@crewon/agent-kernel",
      "fastify",
      "pg",
    ]) {
      assert.equal(
        boundaryAllowsImport(boundary, "new-service.ts", specifier),
        false,
        `${name} -> ${specifier}`,
      );
    }
  }
  assert.equal(
    boundaryAllowsImport(
      boundaries.find((value) => value.packageName === "domain")!,
      "execution-lifecycle.ts",
      "@crewon/contracts",
    ),
    false,
  );
});

test("adapter import exceptions do not authorize neighboring files, nested files or subpaths", () => {
  for (const boundary of [
    ...boundaries,
    controlApiBoundary,
    runtimeWorkerBoundary,
    deviceGatewayBoundary,
  ]) {
    for (const [file, imports] of Object.entries(
      boundary.allowedFileImports ?? {},
    )) {
      for (const specifier of imports) {
        assert.equal(boundaryAllowsImport(boundary, file, specifier), true);
        assert.equal(
          boundaryAllowsImport(boundary, `nested/${file}`, specifier),
          false,
        );
        assert.equal(
          boundaryAllowsImport(boundary, `other-${file}`, specifier),
          false,
        );
        assert.equal(
          boundaryAllowsImport(boundary, file, `${specifier}/unapproved`),
          false,
        );
      }
    }
  }
});

test("SQLite Outbox metadata hints permit only the exact file watcher adapter imports", () => {
  const adapter = "sqlite-outbox-wakeup.ts";
  const imports = ["node:fs", "node:path"];
  assert.deepEqual(controlApiBoundary.allowedFileImports[adapter], imports);
  for (const specifier of imports) {
    assert.equal(
      boundaryAllowsImport(controlApiBoundary, adapter, specifier),
      true,
    );
    for (const file of [
      "sqlite-outbox-wakeup-support.ts",
      "sqlite-outbox-writer.ts",
      "outbox-dispatcher.ts",
      "nested/sqlite-outbox-wakeup.ts",
      "nested/deeper/sqlite-outbox-wakeup.ts",
    ])
      assert.equal(
        boundaryAllowsImport(controlApiBoundary, file, specifier),
        false,
        `${file} -> ${specifier}`,
      );
  }
  for (const specifier of [
    "node:fs/promises",
    "node:fs/unapproved",
    "node:path/posix",
    "node:path/win32",
    "node:sqlite",
    "node:child_process",
    "node:worker_threads",
    "node:net",
    "node:stream",
    "node:util",
  ])
    assert.equal(
      boundaryAllowsImport(controlApiBoundary, adapter, specifier),
      false,
      `${adapter} -> ${specifier}`,
    );
});

test("public plugin SDK cannot acquire Node, host, application or private package subtrees", () => {
  const sdk = boundaries.find((value) => value.packageName === "plugin-sdk")!;
  assert.deepEqual(sdk.allowedRuntimeDependencies, []);
  assert.equal(
    boundaryAllowsImport(sdk, "node.ts", "@crewon/contracts/plugins"),
    true,
  );
  for (const specifier of [
    "node:crypto",
    "node:fs",
    "@crewon/plugin-host",
    "@crewon/plugin-host/loader",
    "@crewon/application",
    "@crewon/store",
    "@crewon/tool-broker",
    "@crewon/contracts",
    "@crewon/contracts/runtime",
    "@crewon/contracts/plugins/unapproved",
    "fastify",
    "pg",
  ])
    assert.equal(
      boundaryAllowsImport(sdk, "node.ts", specifier),
      false,
      `plugin-sdk -> ${specifier}`,
    );
});

test("plugin host only imports the exact approved SDK and plugin contract entrypoints", () => {
  const host = boundaries.find((value) => value.packageName === "plugin-host")!;
  for (const specifier of [
    "node:fs",
    "@crewon/contracts/plugins",
    "@crewon/plugin-sdk/node",
    "@crewon/plugin-sdk/contracts",
  ])
    assert.equal(boundaryAllowsImport(host, "loader.ts", specifier), true);
  for (const specifier of [
    "@crewon/contracts",
    "@crewon/contracts/runtime",
    "@crewon/contracts/plugins/unapproved",
    "@crewon/plugin-sdk",
    "@crewon/plugin-sdk/ui",
    "@crewon/plugin-sdk/node/unapproved",
    "@crewon/plugin-sdk/contracts/unapproved",
    "@crewon/plugin-sdk/types",
    "@crewon/application",
    "@crewon/store",
  ])
    assert.equal(
      boundaryAllowsImport(host, "loader.ts", specifier),
      false,
      `plugin-host -> ${specifier}`,
    );
});

test("the existing installation, recovery and UI asset adapters retain their explicit Application and Domain bridges", () => {
  const host = boundaries.find((value) => value.packageName === "plugin-host")!;
  for (const specifier of ["@crewon/application", "@crewon/domain"]) {
    for (const file of [
      "plugin-installation-local-host.ts",
      "plugin-installation-recovery.ts",
      "plugin-installation-recovery-support.ts",
      "plugin-ui-package-reader.ts",
      "plugin-ui-package-reader-support.ts",
    ])
      assert.equal(boundaryAllowsImport(host, file, specifier), true);
    assert.equal(
      boundaryAllowsImport(host, "plugin-node-host.ts", specifier),
      false,
    );
  }
  for (const specifier of [
    "@crewon/store",
    "@crewon/application/internal",
    "@crewon/domain/internal",
  ])
    for (const file of [
      "plugin-installation-local-host.ts",
      "plugin-installation-recovery.ts",
      "plugin-installation-recovery-support.ts",
      "plugin-ui-package-reader.ts",
      "plugin-ui-package-reader-support.ts",
    ])
      assert.equal(boundaryAllowsImport(host, file, specifier), false);
});

test("AgentVersion Node subpaths cannot become compiler dependencies or acquire unrelated Node capabilities", () => {
  const boundary = boundaries.find(
    (value) => value.packageName === "agent-version",
  )!;
  const adapters = Object.keys(boundary.allowedFileImports!);
  const sourceDirectory = path.join(
    repositoryRoot,
    "packages",
    "agent-version",
    "src",
  );
  const manifest = JSON.parse(
    readFileSync(path.join(sourceDirectory, "../package.json"), "utf8"),
  ) as {
    exports: Record<string, string>;
  };
  assert.equal(manifest.exports["."], "./src/index.ts");
  assert.equal(
    manifest.exports["./extension-build"],
    "./src/extension-build.ts",
  );
  assert.equal(
    manifest.exports["./extension-recovery"],
    "./src/extension-recovery.ts",
  );
  assert.equal(
    manifest.exports["./extension-recovery-inputs"],
    "./src/extension-recovery-inputs.ts",
  );
  assert.equal(
    manifest.exports["./runtime-bindings"],
    "./src/runtime-binding-schema.ts",
  );
  for (const specifier of [
    "node:crypto",
    "node:fs",
    "node:fs/promises",
    "node:path",
    "@crewon/contracts",
    "@crewon/domain",
  ])
    assert.equal(
      boundaryAllowsImport(boundary, "runtime-binding-schema.ts", specifier),
      false,
    );
  for (const file of sourceFiles(sourceDirectory)) {
    if (isTestSource(file)) continue;
    const relativeFile = path.relative(sourceDirectory, file);
    for (const specifier of [
      "node:child_process",
      "node:net",
      "node:worker_threads",
    ])
      assert.equal(
        boundaryAllowsImport(boundary, relativeFile, specifier),
        false,
      );
    if (adapters.includes(relativeFile)) continue;
    for (const specifier of [
      "node:crypto",
      "node:fs",
      "node:fs/promises",
      "node:path",
      "node:url",
      "@crewon/contracts",
      "@crewon/domain",
    ])
      assert.equal(
        boundaryAllowsImport(boundary, relativeFile, specifier),
        false,
      );
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) continue;
      const importedFile = path.relative(
        sourceDirectory,
        path.resolve(path.dirname(file), specifier),
      );
      assert.equal(
        adapters.includes(importedFile),
        false,
        `${relativeFile} -> ${specifier}`,
      );
    }
  }
});

test("process shutdown ports are limited to the owning CLI adapters", () => {
  const lifecycle = boundaries.find(
    (value) => value.packageName === "process-lifecycle",
  )!;
  assert.deepEqual(lifecycle.allowedRuntimeDependencies, []);
  for (const specifier of [
    "node:process",
    "node:fs",
    "@crewon/application",
    "@crewon/store",
  ])
    assert.equal(
      boundaryAllowsImport(lifecycle, "process-shutdown.ts", specifier),
      false,
    );
  for (const boundary of [
    controlApiBoundary,
    runtimeWorkerBoundary,
    deviceGatewayBoundary,
  ])
    assert.equal(
      boundaryAllowsImport(
        boundary,
        "new-service.ts",
        "@crewon/process-lifecycle",
      ),
      false,
    );
});

test("boundary inspection includes type imports, dynamic imports and re-exports", () => {
  assert.deepEqual(
    importSpecifiers(`
    import type { AddressInfo } from "node:net";
    const driver = import("pg");
    export { service } from "@crewon/application";
    import "node:fs";
  `).sort(),
    ["@crewon/application", "node:fs", "node:net", "pg"],
  );
});

test("new architecture packages only use allowed runtime dependencies", () => {
  const violations = boundaries.flatMap(
    ({ packageName, allowedRuntimeDependencies }) => {
      const manifestPath = path.join(
        repositoryRoot,
        "packages",
        packageName,
        "package.json",
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        dependencies?: Record<string, string>;
      };
      return Object.keys(manifest.dependencies ?? {})
        .filter(
          (dependency) => !allowedRuntimeDependencies.includes(dependency),
        )
        .map((dependency) => `${packageName} -> ${dependency}`);
    },
  );

  assert.deepEqual(violations, []);
});

test("new architecture runtime dependency graph is acyclic", () => {
  const packageByDependency = new Map(
    boundaries.map((boundary) => [
      `@crewon/${boundary.packageName}`,
      boundary.packageName,
    ]),
  );
  const graph = new Map(
    boundaries.map(({ packageName }) => {
      const manifest = readPackageManifest(packageName);
      return [
        packageName,
        Object.keys(manifest.dependencies ?? {}).flatMap((dependency) => {
          const target = packageByDependency.get(dependency);
          return target === undefined ? [] : [target];
        }),
      ];
    }),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[] = [];

  for (const packageName of graph.keys()) {
    visit(packageName, [], graph, visiting, visited, cycles);
  }
  assert.deepEqual(cycles, []);
});

test("Control API composition only imports approved ports and open runtime adapters", () => {
  const violations = importViolations(
    path.join(repositoryRoot, "apps", "control-api", "src"),
    controlApiBoundary,
  );
  assert.deepEqual(violations, []);

  const manifest = JSON.parse(
    readFileSync(
      path.join(repositoryRoot, "apps", "control-api", "package.json"),
      "utf8",
    ),
  ) as { dependencies?: Record<string, string> };
  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}).sort(),
    [...controlApiBoundary.allowedRuntimeDependencies].sort(),
  );
});

test("Runtime Worker composition only imports owned Kernel and application ports", () => {
  const violations = importViolations(
    path.join(repositoryRoot, "apps", "runtime-worker", "src"),
    runtimeWorkerBoundary,
  );
  assert.deepEqual(violations, []);

  const manifest = JSON.parse(
    readFileSync(
      path.join(repositoryRoot, "apps", "runtime-worker", "package.json"),
      "utf8",
    ),
  ) as { dependencies?: Record<string, string> };
  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}).sort(),
    [...runtimeWorkerBoundary.allowedRuntimeDependencies].sort(),
  );
});

test("Device Gateway only imports protocol contracts, PostgreSQL authority and its open WebSocket transport", () => {
  const violations = importViolations(
    path.join(repositoryRoot, "apps", "device-gateway", "src"),
    deviceGatewayBoundary,
  );
  assert.deepEqual(violations, []);

  const manifest = JSON.parse(
    readFileSync(
      path.join(repositoryRoot, "apps", "device-gateway", "package.json"),
      "utf8",
    ),
  ) as { dependencies?: Record<string, string> };
  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}).sort(),
    [...deviceGatewayBoundary.allowedRuntimeDependencies].sort(),
  );
});

test("default Direct Responses path remains removable from OpenAI SDK packages", () => {
  const sdkPackages = new Set(["@openai/agents", "openai"]);
  const violations = [
    path.join(repositoryRoot, "packages", "agent-kernel", "package.json"),
    path.join(repositoryRoot, "packages", "agent-responses", "package.json"),
    path.join(repositoryRoot, "apps", "runtime-worker", "package.json"),
  ].flatMap((manifestPath) => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]
      .filter((dependency) => sdkPackages.has(dependency))
      .map(
        (dependency) =>
          `${path.relative(repositoryRoot, manifestPath)} -> ${dependency}`,
      );
  });

  assert.deepEqual(violations, []);
});

test("React renderer cannot import server, store or Node runtime modules", () => {
  const violations = sourceFiles(
    path.join(repositoryRoot, "apps", "crewon-ui", "src"),
  ).flatMap((file) => {
    if (isTestSource(file)) {
      return [];
    }
    return importSpecifiers(readFileSync(file, "utf8"))
      .filter(isForbiddenRendererImport)
      .map(
        (specifier) => `${path.relative(repositoryRoot, file)} -> ${specifier}`,
      );
  });
  assert.deepEqual(violations, []);
});

test("production renderer entrypoint cannot reach Node-enabled test fixtures", () => {
  const directory = path.join(repositoryRoot, "apps", "crewon-ui", "src");
  const sources = new Map(
    sourceFiles(directory).map((file) => [file, readFileSync(file, "utf8")]),
  );
  assert.equal(sources.has(path.join(directory, "main.tsx")), true);
  assert.deepEqual(
    rendererTestSourceDependencies(path.join(directory, "main.tsx"), sources),
    [],
  );
});

test("renderer plugin entrypoints exclude Node lifecycle and private host imports", () => {
  for (const specifier of [
    "@crewon/plugin-sdk/node",
    "@crewon/plugin-sdk/node/unapproved",
    "@crewon/plugin-host",
    "@crewon/plugin-host/loader",
    "@crewon/application",
    "@crewon/application/project-text-plan-authority",
    "@crewon/media-runtime",
    "@crewon/media-runtime/project-source-import",
  ])
    assert.equal(isForbiddenRendererImport(specifier), true, specifier);
  for (const specifier of [
    "@crewon/plugin-sdk/ui",
    "@crewon/plugin-sdk/contracts",
  ])
    assert.equal(isForbiddenRendererImport(specifier), false, specifier);
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(entryPath);
    }
    return entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      ? [entryPath]
      : [];
  });
}

function importViolations(
  directory: string,
  boundary: ImportBoundary,
): string[] {
  return sourceFiles(directory).flatMap((file) => {
    if (isTestSource(file)) {
      return [];
    }
    return importSpecifiers(readFileSync(file, "utf8")).flatMap((specifier) => {
      if (
        specifier.startsWith(".") ||
        boundaryAllowsImport(
          boundary,
          path.relative(directory, file),
          specifier,
        )
      ) {
        return [];
      }
      return [`${path.relative(repositoryRoot, file)} -> ${specifier}`];
    });
  });
}

function existsPackageManifest(directory: string): boolean {
  try {
    readFileSync(path.join(directory, "package.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

function readPackageManifest(packageName: string): {
  dependencies?: Record<string, string>;
} {
  return JSON.parse(
    readFileSync(
      path.join(repositoryRoot, "packages", packageName, "package.json"),
      "utf8",
    ),
  ) as { dependencies?: Record<string, string> };
}

function visit(
  packageName: string,
  pathToPackage: string[],
  graph: ReadonlyMap<string, readonly string[]>,
  visiting: Set<string>,
  visited: Set<string>,
  cycles: string[],
): void {
  if (visiting.has(packageName)) {
    cycles.push([...pathToPackage, packageName].join(" -> "));
    return;
  }
  if (visited.has(packageName)) {
    return;
  }
  visiting.add(packageName);
  for (const dependency of graph.get(packageName) ?? []) {
    visit(
      dependency,
      [...pathToPackage, packageName],
      graph,
      visiting,
      visited,
      cycles,
    );
  }
  visiting.delete(packageName);
  visited.add(packageName);
}
