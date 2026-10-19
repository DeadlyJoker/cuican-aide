import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectMediaResultSource } from "@crewon/application";
import { assertNativeProjectMediaResultOutput as approve } from "./native-project-media-result-output-approval.ts";

const digest = `sha256:${"a".repeat(64)}`;
const oldDigest = `sha256:${"b".repeat(64)}`;
const publication = {
  pluginId: "crewon.short-drama" as const,
  packageDigest: digest,
  contributionId: "workbench",
};
const previous = { ...publication, packageDigest: oldDigest };
const targetIdentity = {
  pluginId: publication.pluginId,
  publisherId: "example.publisher",
  version: "50.2.16",
  packageDigest: digest,
  manifestDigest: digest,
  implementationDigest: digest,
};
const workflow = {
  workflowId: "krea2-reference-four-view" as const,
  workflowDigest: digest,
  output: {
    kind: "image" as const,
    nodeId: "129" as const,
    dimensions: "workflow-native" as const,
  },
};

for (const path of ["/view", "/api/comfy/view"])
  test(`only the consented package can publish through its exact ${path} grant`, () => {
    const origin = "https://named.provider.example:8443/";
    // Only fields consumed by this approval boundary are constructed; source decoding is tested separately.
    const source = {
      targetIdentity,
      workflow,
      configuration: { origin },
      image: {
        url: `${origin.slice(0, -1)}${path}?filename=output.png&type=output`,
      },
    } as ProjectMediaResultSource;
    const input = {
      declared: {
        version: "crewon.desktop-project-media-results.v1" as const,
        purposes: ["read", "publish"] as const,
        publications: [previous, publication],
        publishPublications: [publication],
      },
      reviews: [
        { targetIdentity, workflow },
        {
          targetIdentity: { ...targetIdentity, packageDigest: oldDigest },
          workflow,
        },
      ],
      networkGrants: [
        {
          ...targetIdentity,
          baseUrl: origin,
          baseUrlParameter: "baseUrl",
          paths: [{ method: "GET" as const, path }],
        },
      ],
      source,
    };
    approve(input);
    const oldSource = {
      ...source,
      targetIdentity: { ...targetIdentity, packageDigest: oldDigest },
    };
    const oldGrant = { ...input.networkGrants[0]!, packageDigest: oldDigest };
    assert.throws(
      () => approve({ ...input, source: oldSource, networkGrants: [oldGrant] }),
      /desktop_native_project_media_result_denied/,
    );
    assert.throws(
      () =>
        approve({
          ...input,
          declared: { ...input.declared, purposes: ["read"] },
        }),
      /desktop_native_project_media_result_denied/,
    );
    for (const grant of [
      { ...input.networkGrants[0]!, baseUrlParameter: "foreign" },
      { ...input.networkGrants[0]!, version: "50.2.13" },
      {
        ...input.networkGrants[0]!,
        paths: [
          {
            method: "GET" as const,
            path: path === "/view" ? "/api/comfy/view" : "/view",
          },
        ],
      },
    ])
      assert.throws(
        () => approve({ ...input, networkGrants: [grant] }),
        /desktop_native_project_media_result_denied/,
      );
    for (const url of [
      `https://other.example${path}`,
      `${origin}admin`,
      `${origin.slice(0, -1)}${path}#extra`,
      `https://user@named.provider.example:8443${path}`,
    ]) {
      assert.throws(
        () =>
          approve({
            ...input,
            source: { ...source, image: { ...source.image, url } },
          }),
        /desktop_native_project_media_result_denied/,
      );
    }
    approve({
      ...input,
      declared: {
        version: input.declared.version,
        purposes: input.declared.purposes,
        publications: [publication],
      },
    });
  });
