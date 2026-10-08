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
