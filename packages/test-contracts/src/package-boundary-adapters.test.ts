import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  controlApiBoundary,
  runtimeWorkerBoundary,
} from "./app-boundary-policy.ts";
import {
  boundaryAllowsImport,
  isForbiddenRendererImport,
  isTestSource,
  mergeFileImports,
  rendererTestSourceDependencies,
} from "./package-boundary-imports.ts";
import { boundaries } from "./package-boundary-policy.ts";

test("host qualification intrinsics do not grant I/O to Application ports or records", () => {
  const application = boundaries.find(
    (boundary) => boundary.packageName === "application",
  )!;
  assert.equal(
    boundaryAllowsImport(
      application,
      "project-media-input-run-commit-authority.ts",
      "node:crypto",
    ),
    true,
  );
  assert.equal(
    boundaryAllowsImport(
      application,
      "project-media-input-record.ts",
      "node:util",
    ),
    true,
  );
  for (const file of [
    "project-media-input-run-commit-authority.ts",
    "project-media-input-record.ts",
    "project-foundation-store-port.ts",
    "project-source-preparation-port.ts",
  ]) {
    for (const specifier of [
      "node:fs",
      "node:http",
      "node:child_process",
      "@crewon/store",
      "@crewon/media-runtime",
    ]) {
      assert.equal(
        boundaryAllowsImport(application, file, specifier),
        false,
        `${file} -> ${specifier}`,
      );
    }
  }
  for (const file of [
    "project-foundation-store-port.ts",
    "project-source-preparation-port.ts",
    "authorization-port.ts",
  ]) {
    for (const specifier of ["node:crypto", "node:util"]) {
      assert.equal(
        boundaryAllowsImport(application, file, specifier),
        false,
        `${file} -> ${specifier}`,
      );
    }
  }
});

test("shared media runtime keeps transport and HTML parsing capabilities in their own adapters", () => {
  const media = boundaries.find(
    (boundary) => boundary.packageName === "media-runtime",
  )!;
  assert.equal(
    boundaryAllowsImport(media, "pinned-node-http.ts", "node:https"),
    true,
  );
  assert.equal(
    boundaryAllowsImport(media, "project-source-import.ts", "node:crypto"),
    true,
  );
  assert.equal(
    boundaryAllowsImport(
      media,
      "project-source-import-validation.ts",
      "node:util",
    ),
    true,
  );
  assert.equal(
    boundaryAllowsImport(media, "project-source-html-parser.ts", "parse5"),
    true,
  );
  for (const intrinsic of ["node:crypto", "node:util"]) {
    assert.equal(
      boundaryAllowsImport(
        media,
        "project-source-upload-preparation-adapter.ts",
        intrinsic,
      ),
      true,
    );
    assert.equal(
      boundaryAllowsImport(
        media,
        "project-source-upload-controller.ts",
        intrinsic,
      ),
      false,
    );
  }
  for (const file of [
    "project-source-import.ts",
    "project-source-import-validation.ts",
    "project-source-html-parser.ts",
    "project-source-text-chapters.ts",
    "project-source-upload-preparation-adapter.ts",
  ]) {
    for (const specifier of [
      "node:fs",
      "node:http",
      "node:https",
      "node:child_process",
      "@crewon/plugin-host",
      "@crewon/plugin-sdk/node",
    ]) {
      assert.equal(
        boundaryAllowsImport(media, file, specifier),
        false,
        `${file} -> ${specifier}`,
      );
    }
  }
  for (const file of [
    "project-source-import.ts",
    "project-source-text-chapters.ts",
    "other-parser.ts",
  ]) {
    assert.equal(boundaryAllowsImport(media, file, "parse5"), false);
  }
  assert.equal(
    boundaryAllowsImport(
      media,
      "project-source-html-parser.ts",
      "parse5/internal",
    ),
    false,
  );
  assert.equal(media.allowedRuntimeDependencies.includes("parse5"), true);
});

test("installed project bridges do not grant generic plugin loaders application authority", () => {
  const host = boundaries.find(
    (boundary) => boundary.packageName === "plugin-host",
  )!;
  assert.equal(
    boundaryAllowsImport(
      host,
      "plugin-task-action-bridge.ts",
      "@crewon/application",
    ),
    true,
  );
  assert.equal(
    boundaryAllowsImport(
      host,
      "plugin-project-media-input-host-service-availability.ts",
      "@crewon/contracts/project-media-inputs-ui",
    ),
    true,
  );
  for (const file of [
    "plugin-node-host.ts",
    "loader.ts",
    "new-action-bridge.ts",
  ]) {
    for (const specifier of [
      "@crewon/application",
      "@crewon/domain",
      "@crewon/contracts/project-media-inputs-ui",
      "@crewon/store",
      "@crewon/media-runtime",
    ]) {
      assert.equal(
        boundaryAllowsImport(host, file, specifier),
        false,
        `${file} -> ${specifier}`,
      );
    }
  }
});

test("media and installation compositions retain exact entrypoints without widening app defaults", () => {
  assert.equal(
    boundaryAllowsImport(
      controlApiBoundary,
      "desktop-native-plugin-task-runtime.ts",
      "@crewon/plugin-host",
    ),
    true,
  );
  assert.equal(
    boundaryAllowsImport(
      runtimeWorkerBoundary,
      "project-media-execution-review.ts",
      "@crewon/plugin-sdk/node",
    ),
    true,
  );
  assert.equal(
    boundaryAllowsImport(controlApiBoundary, "main.ts", "node:net"),
    true,
  );
  assert.equal(
    boundaryAllowsImport(
      controlApiBoundary,
      "main.ts",
      "@crewon/process-lifecycle",
    ),
    true,
  );
  assert.equal(
    boundaryAllowsImport(
      controlApiBoundary,
      "main.ts",
      "@crewon/media-runtime/desktop-project-material-archive",
    ),
    true,
  );
  for (const boundary of [controlApiBoundary, runtimeWorkerBoundary]) {
    for (const specifier of [
      "@crewon/plugin-host",
      "@crewon/plugin-host/package-snapshot",
      "@crewon/plugin-sdk/node",
      "@crewon/media-runtime",
      "@crewon/media-runtime/project-source-import",
      "parse5",
    ]) {
      assert.equal(
        boundaryAllowsImport(boundary, "new-service.ts", specifier),
        false,
        specifier,
      );
    }
  }
  assert.equal(
    boundaryAllowsImport(
      controlApiBoundary,
      "desktop-native-plugin-task-runtime.ts",
      "@crewon/plugin-host/loader",
    ),
    false,
  );
  assert.equal(
    boundaryAllowsImport(
      runtimeWorkerBoundary,
      "project-media-execution-review.ts",
      "@crewon/plugin-sdk/ui",
    ),
    false,
  );
  assert.equal(
    boundaryAllowsImport(controlApiBoundary, "new-service.ts", "node:fs"),
    false,
  );
});

test("merging precise adapter declarations preserves the old CLI imports without expanding files", () => {
  assert.deepEqual(
    mergeFileImports(
      { "main.ts": ["node:net"] },
      { "main.ts": ["node:net", "@crewon/media-runtime"] },
    ),
    { "main.ts": ["node:net", "@crewon/media-runtime"] },
  );
});

test("TSX test helpers are recognized exactly and remain unreachable from production renderers", () => {
  for (const file of [
    "fixture.test.ts",
    "fixture.test.tsx",
    "fixture.test-support.ts",
    "fixture.test-support.tsx",
  ]) {
    assert.equal(isTestSource(file), true);
  }
  for (const file of [
    "fixture.tsx",
    "fixture.test-support.tsx.js",
    "test-support.tsx",
    "fixture.test-support-view.tsx",
  ]) {
    assert.equal(isTestSource(file), false);
  }
  const directory = path.resolve("renderer-boundary-fixture");
  const entry = path.join(directory, "main.tsx");
  const sources = new Map([
    [entry, 'import "./component";'],
    [
      path.join(directory, "component.tsx"),
      'export { helper } from "./fixture.test-support"; const lazy = import("./nested");',
    ],
    [path.join(directory, "fixture.test-support.tsx"), 'import "node:fs";'],
    [
      path.join(directory, "nested", "index.tsx"),
      'import "../component"; import "../other.test-support.js";',
    ],
    [path.join(directory, "other.test-support.ts"), 'import "node:crypto";'],
    [path.join(directory, "unreachable.test-support.tsx"), 'import "node:fs";'],
  ]);
  assert.deepEqual(rendererTestSourceDependencies(entry, sources), [
    `${path.join(directory, "component.tsx")} -> ./fixture.test-support`,
    `${path.join(directory, "nested", "index.tsx")} -> ../other.test-support.js`,
  ]);
  sources.set(
    path.join(directory, "component.tsx"),
    'const lazy = import("./nested");',
  );
  sources.set(
    path.join(directory, "nested", "index.tsx"),
    'import "../component";',
  );
  assert.deepEqual(rendererTestSourceDependencies(entry, sources), []);
});

test("host Run authority and shared media remain forbidden in the renderer", () => {
  for (const specifier of [
    "@crewon/application",
    "@crewon/application/project-text-plan-authority",
    "@crewon/media-runtime",
    "@crewon/media-runtime/project-source-import",
    "@crewon/plugin-host",
    "@crewon/plugin-sdk/node",
    "node:crypto",
  ]) {
    assert.equal(isForbiddenRendererImport(specifier), true, specifier);
  }
  assert.equal(isForbiddenRendererImport("@crewon/plugin-sdk/ui"), false);
  assert.equal(
    isForbiddenRendererImport("@crewon/plugin-sdk/contracts"),
    false,
  );
});
