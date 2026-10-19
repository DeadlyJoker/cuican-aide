import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectAssetReferenceImageSource } from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import { createComfyUiProjectReferenceMaterialAdapter } from "./comfyui-project-reference-material-adapter.ts";

const identity = {
  pluginId: "crewon.short-drama" as const,
  pluginVersion: "50.2.12",
  manifestDigest: `sha256:${"a".repeat(64)}`,
  implementationDigest: `sha256:${"b".repeat(64)}`,
};
const adapter = createComfyUiProjectReferenceMaterialAdapter({
  identities: [identity],
});
const origin = "https://images.example.test:8443/";
const output = {
  filename: "counter.png",
  subfolder: "scene/夜",
  type: "output",
};
const path = (view: string) => `${view}?${new URLSearchParams(output)}`;

// Pure destination decoder fixture, not evidence of authorization or a byte read.
function source(
  protocol: unknown,
  view: string,
): ProjectAssetReferenceImageSource {
  return {
    asset: { tenantId: "tenant", spaceId: "space" },
    configuration: {
      ...identity,
      tenantId: "tenant",
      spaceId: "space",
      revision: 23,
      contentDigest: `sha256:${"c".repeat(64)}`,
      parameters: { baseUrl: origin, serviceProtocol: protocol },
    },
    resultLink: {
      pluginId: identity.pluginId,
      pluginVersion: identity.pluginVersion,
      configurationRevision: 23,
      configurationDigest: `sha256:${"c".repeat(64)}`,
      image: {
        filename: output.filename,
        providerReferenceJson: extensionCanonicalJson(output),
        url: new URL(path(view), origin).href,
      },
    },
  } as unknown as ProjectAssetReferenceImageSource;
}

test("reference reads use the original configuration protocol and exact canonical result address", () => {
  for (const protocol of [
    undefined,
    "native",
    "workflow-panel-v1",
    "workflow-api-v1",
  ]) {
    const view =
      protocol === undefined || protocol === "native"
        ? "/view"
        : "/api/comfy/view";
    assert.deepEqual(adapter.deriveReadDestination(source(protocol, view)), {
      origin,
      path: path(view),
      output,
    });
    assert.throws(
      () =>
        adapter.deriveReadDestination(
          source(protocol, view === "/view" ? "/api/comfy/view" : "/view"),
        ),
      /comfyui_project_material_source_invalid/u,
    );
  }
});

test("unknown protocols and changed result origins never become material read destinations", () => {
  for (const protocol of [
    null,
    false,
    "workflow-api-v2",
    { mode: "workflow-api-v1" },
  ])
    assert.throws(
      () => adapter.deriveReadDestination(source(protocol, "/view")),
      /comfyui_project_material_source_invalid/u,
    );
  const original = source("workflow-api-v1", "/api/comfy/view");
  assert.throws(
    () =>
      adapter.deriveReadDestination({
        ...original,
        resultLink: {
          ...original.resultLink,
          image: {
            ...original.resultLink.image,
            url: `https://other.example.test${path("/api/comfy/view")}`,
          },
        },
      }),
    /comfyui_project_material_source_invalid/u,
  );
});
