import assert from "node:assert/strict";
import test from "node:test";
import { extensionCanonicalJson } from "@crewon/domain";
import type { ProjectAssetReferenceImageSource } from "@crewon/application";
import { createComfyUiProjectReferenceMaterialAdapter } from "./comfyui-project-reference-material-adapter.ts";
const digest = `sha256:${"a".repeat(64)}`;
const identity = {
  pluginId: "crewon.short-drama" as const,
  pluginVersion: "20.0.2",
  manifestDigest: digest,
  implementationDigest: digest,
};
/** Pure decoder fixture. It is not an owned project, byte proof or read grant. */
function fixture(
  output = { filename: "image.png", subfolder: "characters", type: "output" },
) {
  const base = "https://comfy.example:8443/",
    url = new URL(`/view?${new URLSearchParams(output)}`, base).href;
  return {
    asset: { tenantId: "tenant", spaceId: "space" },
    configuration: {
      ...identity,
      tenantId: "tenant",
      spaceId: "space",
      revision: 1,
      contentDigest: digest,
      parameters: { baseUrl: base },
    },
    resultLink: {
      pluginId: identity.pluginId,
      pluginVersion: identity.pluginVersion,
      configurationRevision: 1,
      configurationDigest: digest,
      image: {
        filename: output.filename,
        url,
        providerReferenceJson: extensionCanonicalJson(output),
      },
    },
  } as unknown as ProjectAssetReferenceImageSource;
}
test("Comfy material destination comes from the exact historical configuration and output reference", () => {
  const input = { identities: [{ ...identity }] },
    adapter = createComfyUiProjectReferenceMaterialAdapter(input);
  input.identities[0]!.pluginVersion = "21.0.0";
  const actual = adapter.deriveReadDestination(fixture());
  assert.equal(actual.origin, "https://comfy.example:8443/");
  assert.equal(
    actual.path,
    "/view?filename=image.png&subfolder=characters&type=output",
  );
  assert.ok(Object.isFrozen(actual.output));
});
test("current config substitutions, unknown identities and forged image URLs fail closed", () => {
  const adapter = createComfyUiProjectReferenceMaterialAdapter({
    identities: [identity],
  });
  for (const c of [
    { parameters: { baseUrl: "https://other.example/" } },
    { revision: 2 },
    { pluginVersion: "21.0.0" },
    { pluginId: "other.plugin" },
    { manifestDigest: `sha256:${"b".repeat(64)}` },
    { parameters: { baseUrl: "http://comfy.example:8443/" } },
    { parameters: { baseUrl: "https://secret@comfy.example:8443/" } },
  ]) {
    const f = fixture();
    assert.throws(() =>
      adapter.deriveReadDestination({
        ...f,
        configuration: { ...f.configuration, ...c },
      }),
    );
  }
  const f = fixture();
  assert.throws(() =>
    adapter.deriveReadDestination({
      ...f,
      resultLink: {
        ...f.resultLink,
        image: {
          ...f.resultLink.image,
          url: "https://foreign.example/image.png",
        },
      },
    }),
  );
});
test("reference paths cannot become URL, directory traversal, output annotation or Windows path injection", () => {
  const adapter = createComfyUiProjectReferenceMaterialAdapter({
    identities: [identity],
  });
  for (const o of [
    { filename: "../x.png", subfolder: "", type: "output" },
    { filename: "x.png [input]", subfolder: "", type: "output" },
    { filename: "x.png", subfolder: "../private", type: "output" },
    { filename: "x.png", subfolder: "C:private", type: "output" },
    { filename: "x.png", subfolder: "a//b", type: "output" },
    { filename: "x.png", subfolder: "", type: "temp" },
  ])
    assert.throws(() => adapter.deriveReadDestination(fixture(o)));
});
test("registry data is bounded, detached and does not execute getters", () => {
  let reads = 0;
  const bad = Object.defineProperty({ ...identity }, "pluginVersion", {
    enumerable: true,
    get() {
      reads++;
      return "20.0.2";
    },
  });
  for (const identities of [
    [],
    [identity, identity],
    [bad],
    new Array(1),
    [{ ...identity, extra: true }],
  ])
    assert.throws(() =>
      createComfyUiProjectReferenceMaterialAdapter({ identities } as never),
    );
  assert.equal(reads, 0);
});
