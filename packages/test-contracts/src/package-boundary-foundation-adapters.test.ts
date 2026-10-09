import { boundaries } from "./package-boundary-policy.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  controlApiBoundary,
  runtimeWorkerBoundary,
} from "./app-boundary-policy.ts";
import {
  boundaryAllowsImport,
  isForbiddenRendererImport,
} from "./package-boundary-imports.ts";

test("Native Foundation UI composition permits only its existing host availability entrypoint", () => {
  const file = "desktop-project-foundation-plugin-runtime.ts";
  assert.equal(
    boundaryAllowsImport(controlApiBoundary, file, "@crewon/plugin-host"),
    true,
  );
  for (const adjacent of [
    "project-foundation-controller.ts",
    "new-foundation-service.ts",
    `nested/${file}`,
  ])
    assert.equal(
      boundaryAllowsImport(controlApiBoundary, adjacent, "@crewon/plugin-host"),
      false,
    );
  for (const specifier of [
    "@crewon/plugin-host/package-snapshot",
    "@crewon/plugin-host/loader",
    "@crewon/plugin-sdk/node",
    "@crewon/plugin-sdk/ui",
    "@crewon/media-runtime",
    "node:fs",
  ])
    assert.equal(
      boundaryAllowsImport(controlApiBoundary, file, specifier),
      false,
      `${file} -> ${specifier}`,
    );
});
test("original Foundation Node compositions use precise host and SDK context types without widening defaults", () => {
  const hostFiles = [
    "plugins/installed-plugin-project-foundation-tools.ts",
    "plugins/installed-plugin-runtime-project-services.ts",
    "plugins/project-foundation-tools-service-owner.ts",
  ];
  const contextFiles = [
    "plugins/installed-plugin-project-foundation-tools.ts",
    "plugins/project-foundation-runtime-scope.ts",
    "plugins/project-foundation-tools-service-owner.ts",
  ];
  for (const file of hostFiles)
    assert.equal(
      boundaryAllowsImport(runtimeWorkerBoundary, file, "@crewon/plugin-host"),
      true,
      file,
    );
  for (const file of contextFiles)
    assert.equal(
      boundaryAllowsImport(
        runtimeWorkerBoundary,
        file,
        "@crewon/plugin-sdk/node",
      ),
      true,
      file,
    );
  assert.equal(
    boundaryAllowsImport(
      runtimeWorkerBoundary,
      "plugins/project-foundation-runtime-scope.ts",
      "@crewon/plugin-host",
    ),
    false,
  );
  assert.equal(
    boundaryAllowsImport(
      runtimeWorkerBoundary,
      "plugins/installed-plugin-runtime-project-services.ts",
      "@crewon/plugin-sdk/node",
    ),
    false,
  );
  for (const file of new Set([...hostFiles, ...contextFiles])) {
    for (const specifier of [
      "@crewon/plugin-host/package-snapshot",
      "@crewon/plugin-host/loader",
      "@crewon/plugin-sdk",
      "@crewon/plugin-sdk/ui",
      "@crewon/plugin-sdk/contracts",
      "@crewon/media-runtime",
    ])
      assert.equal(
        boundaryAllowsImport(runtimeWorkerBoundary, file, specifier),
        false,
        `${file} -> ${specifier}`,
      );
    for (const adjacent of [
      `nested/${file}`,
      "plugins/new-foundation-helper.ts",
      `${file}.copy.ts`,
    ])
      for (const specifier of [
        "@crewon/plugin-host",
        "@crewon/plugin-sdk/node",
      ])
        assert.equal(
          boundaryAllowsImport(runtimeWorkerBoundary, adjacent, specifier),
          false,
          `${adjacent} -> ${specifier}`,
        );
  }
  for (const specifier of [
    "@crewon/plugin-host",
    "@crewon/plugin-host/package-snapshot",
    "@crewon/plugin-sdk/node",
  ])
    assert.equal(isForbiddenRendererImport(specifier), true, specifier);
  assert.equal(
    runtimeWorkerBoundary.allowedRuntimeDependencies.includes(
      "@crewon/plugin-sdk" as never,
    ),
    false,
  );
});

test("structured outline host adapters permit only their public host/context types", () => {
  for (const file of [
    "plugins/installed-plugin-project-outline-tools.ts",
    "plugins/project-outline-tools-service-owner.ts",
  ]) {
    for (const approved of ["@crewon/plugin-host", "@crewon/plugin-sdk/node"]) {
      assert.equal(
        boundaryAllowsImport(runtimeWorkerBoundary, file, approved),
        true,
      );
      for (const adjacent of [
        "plugins/new-outline-service.ts",
        `nested/${file}`,
        "plugins/outline-reader.ts",
      ])
        assert.equal(
          boundaryAllowsImport(runtimeWorkerBoundary, adjacent, approved),
          false,
        );
    }
    for (const forbidden of [
      "@crewon/plugin-host/loader",
      "@crewon/plugin-host/package-snapshot",
      "@crewon/plugin-sdk",
      "@crewon/plugin-sdk/ui",
      "@crewon/media-runtime",
    ])
      assert.equal(
        boundaryAllowsImport(runtimeWorkerBoundary, file, forbidden),
        false,
      );
    assert.equal(isForbiddenRendererImport("@crewon/plugin-host"), true);
    assert.equal(isForbiddenRendererImport("@crewon/plugin-sdk/node"), true);
  }
});

test("outline availability exposes only its named public protocol constants", () => {
  const boundary = boundaries.find((b) => b.packageName === "plugin-host")!;
  for (const approved of [
    "@crewon/contracts/project-outlines",
    "@crewon/contracts/project-outline-edits",
  ]) {
    assert.equal(
      boundaryAllowsImport(
        boundary,
        "plugin-ui-host-service-availability.ts",
        approved,
      ),
      true,
    );
    for (const adjacent of [
      "plugin-outline-reader.ts",
      "nested/plugin-ui-host-service-availability.ts",
    ])
      assert.equal(boundaryAllowsImport(boundary, adjacent, approved), false);
  }
  const store = boundaries.find((b) => b.packageName === "store")!;
  assert.equal(
    boundaryAllowsImport(
      store,
      "project-structured-outline-store-support.ts",
      "node:util",
    ),
    false,
  );
});
