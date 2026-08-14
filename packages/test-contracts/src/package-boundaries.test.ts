import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

type Boundary = Readonly<{
  packageName: string;
  allowedBareImports: readonly string[];
  allowedRuntimeDependencies: readonly string[];
}>;

const boundaries: readonly Boundary[] = [
  {
    packageName: "artifacts",
    allowedBareImports: ["node:", "@crewon/application", "@crewon/domain"],
    allowedRuntimeDependencies: ["@crewon/application", "@crewon/domain"],
  },
  {
    packageName: "agent-kernel",
    allowedBareImports: ["@crewon/contracts", "@crewon/tool-broker"],
    allowedRuntimeDependencies: ["@crewon/contracts", "@crewon/tool-broker"],
  },
  {
    packageName: "agent-responses",
    allowedBareImports: [
      "node:http",
      "@crewon/agent-kernel",
      "@crewon/contracts",
      "ws",
    ],
    allowedRuntimeDependencies: [
      "@crewon/agent-kernel",
      "@crewon/contracts",
      "ws",
    ],
  },
  {
    packageName: "agent-version",
    allowedBareImports: ["@crewon/application", "@crewon/tool-broker"],
    allowedRuntimeDependencies: ["@crewon/application", "@crewon/tool-broker"],
  },
  {
    packageName: "contracts",
    allowedBareImports: [],
    allowedRuntimeDependencies: [],
  },
  {
    packageName: "control-client",
    allowedBareImports: ["@crewon/contracts"],
    allowedRuntimeDependencies: ["@crewon/contracts"],
  },
  {
    packageName: "context",
    allowedBareImports: ["@crewon/domain"],
    allowedRuntimeDependencies: ["@crewon/domain"],
  },
  {
    packageName: "domain",
    allowedBareImports: [],
    allowedRuntimeDependencies: [],
  },
  {
    packageName: "device-dispatch",
    allowedBareImports: [
      "node:crypto",
      "node:https",
      "@crewon/contracts",
      "@crewon/tool-broker",
    ],
    allowedRuntimeDependencies: ["@crewon/contracts", "@crewon/tool-broker"],
  },
  {
    packageName: "mcp-runtime",
    allowedBareImports: [
      "node:path",
      "@crewon/tool-broker",
      "@modelcontextprotocol/sdk",
    ],
    allowedRuntimeDependencies: [
      "@crewon/tool-broker",
      "@modelcontextprotocol/sdk",
    ],
  },
  {
    packageName: "application",
    allowedBareImports: ["@crewon/contracts", "@crewon/domain"],
    allowedRuntimeDependencies: ["@crewon/contracts", "@crewon/domain"],
  },
  {
    packageName: "store",
    allowedBareImports: [
      "node:crypto",
      "node:sqlite",
      "@crewon/application",
      "@crewon/domain",
      "pg",
    ],
    allowedRuntimeDependencies: ["@crewon/application", "@crewon/domain", "pg"],
  },
  {
    packageName: "tool-broker",
    allowedBareImports: ["node:crypto", "@crewon/contracts"],
    allowedRuntimeDependencies: ["@crewon/contracts"],
  },
  {
    packageName: "test-contracts",
    allowedBareImports: ["node:", "@crewon/contracts"],
    allowedRuntimeDependencies: [],
  },
];

const controlApiBoundary = {
  allowedBareImports: [
    "node:crypto",
    "node:http",
    "node:sqlite",
    "@crewon/agent-version",
    "@crewon/application",
    "@crewon/artifacts",
    "@crewon/contracts",
    "@crewon/domain",
    "@crewon/store",
    "fastify",
    "uuid",
  ],
  allowedRuntimeDependencies: [
    "@crewon/agent-version",
    "@crewon/application",
    "@crewon/artifacts",
    "@crewon/contracts",
    "@crewon/domain",
    "@crewon/store",
    "fastify",
    "uuid",
  ],
} as const;

const runtimeWorkerBoundary = {
  allowedBareImports: [
    "node:",
    "@crewon/agent-kernel",
    "@crewon/agent-responses",
    "@crewon/agent-version",
    "@crewon/application",
    "@crewon/artifacts",
    "@crewon/contracts",
    "@crewon/context",
    "@crewon/domain",
    "@crewon/mcp-runtime",
    "@crewon/store",
    "@crewon/tool-broker",
    "uuid",
  ],
  allowedRuntimeDependencies: [
    "@crewon/agent-kernel",
    "@crewon/agent-responses",
    "@crewon/agent-version",
    "@crewon/application",
    "@crewon/artifacts",
    "@crewon/contracts",
    "@crewon/context",
    "@crewon/domain",
    "@crewon/mcp-runtime",
    "@crewon/store",
    "@crewon/tool-broker",
    "uuid",
  ],
} as const;

const deviceGatewayBoundary = {
  allowedBareImports: ["node:", "@crewon/contracts", "pg", "ws"],
  allowedRuntimeDependencies: ["@crewon/contracts", "pg", "ws"],
} as const;

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
      if (file.endsWith(".test.ts") || file.endsWith(".test-support.ts")) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith(".")) {
          continue;
        }
        if (
          boundary.allowedBareImports.some((allowed) =>
            matchesAllowedImport(specifier, allowed),
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
    controlApiBoundary.allowedBareImports,
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
    runtimeWorkerBoundary.allowedBareImports,
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
    deviceGatewayBoundary.allowedBareImports,
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
  const forbiddenPrefixes = [
    "node:",
    "@crewon/application",
    "@crewon/control-api",
    "@crewon/store",
    "fastify",
    "uuid",
  ];
  const violations = sourceFiles(
    path.join(repositoryRoot, "apps", "crewon-ui", "src"),
  ).flatMap((file) => {
    if (isTestSource(file)) {
      return [];
    }
    return importSpecifiers(readFileSync(file, "utf8"))
      .filter((specifier) =>
        forbiddenPrefixes.some((prefix) => specifier.startsWith(prefix)),
      )
      .map(
        (specifier) => `${path.relative(repositoryRoot, file)} -> ${specifier}`,
      );
  });
  assert.deepEqual(violations, []);
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
  allowedBareImports: readonly string[],
): string[] {
  return sourceFiles(directory).flatMap((file) => {
    if (isTestSource(file)) {
      return [];
    }
    return importSpecifiers(readFileSync(file, "utf8")).flatMap((specifier) => {
      if (
        specifier.startsWith(".") ||
        allowedBareImports.some((allowed) =>
          matchesAllowedImport(specifier, allowed),
        )
      ) {
        return [];
      }
      return [`${path.relative(repositoryRoot, file)} -> ${specifier}`];
    });
  });
}

function isTestSource(file: string): boolean {
  return (
    file.endsWith(".test.ts") ||
    file.endsWith(".test.tsx") ||
    file.endsWith(".test-support.ts")
  );
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

function matchesAllowedImport(specifier: string, allowed: string): boolean {
  return (
    specifier === allowed ||
    (allowed.endsWith(":") && specifier.startsWith(allowed)) ||
    specifier.startsWith(`${allowed}/`)
  );
}

function importSpecifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
  ];
  return [
    ...new Set(
      patterns.flatMap((pattern) =>
        [...source.matchAll(pattern)].map((match) => match[1]),
      ),
    ),
  ];
}
