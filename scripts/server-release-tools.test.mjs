import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildServerReleaseManifest,
  imageFromBuildMetadata,
  parseServerReleaseManifest,
} from "./server-release-tools.mjs";

const commit = "a".repeat(40);
const publishedAt = "2026-08-19T00:00:00.000Z";
const components = ["control-api", "runtime-worker", "web-bff", "web"];

test("binds the four production images to one immutable server release", () => {
  const manifest = buildServerReleaseManifest({
    commit,
    images: components.map((component, index) => ({
      component,
      image: `ghcr.io/crewon/crewon-${component}`,
      digest: `sha256:${String(index + 1).repeat(64)}`,
    })),
    publishedAt,
    repository: "crewon/cuican-aide",
    tag: "server-v1.2.3",
  });
  assert.deepEqual(manifest, {
    schemaVersion: "crewon.server-release.v0",
    tag: "server-v1.2.3",
    version: "1.2.3",
    commit,
    repository: "crewon/cuican-aide",
    publishedAt,
    images: Object.fromEntries(
      components.map((component, index) => {
        const image = `ghcr.io/crewon/crewon-${component}`;
        const digest = `sha256:${String(index + 1).repeat(64)}`;
        return [
          component,
          {
            digest,
            image,
            reference: `${image}@${digest}`,
            sbom: "registry-attestation",
            provenance: "registry-attestation",
            signature: "sigstore-keyless",
          },
        ];
      }),
    ),
  });
  assert.deepEqual(parseServerReleaseManifest(manifest), manifest);
});

test("reads only an exact BuildKit image digest", () => {
  assert.deepEqual(
    imageFromBuildMetadata({
      component: "control-api",
      image: "ghcr.io/crewon/crewon-control-api",
      metadata: {
        "containerimage.digest": `sha256:${"b".repeat(64)}`,
        "buildx.build.ref": "opaque",
      },
    }),
    {
      component: "control-api",
      image: "ghcr.io/crewon/crewon-control-api",
      digest: `sha256:${"b".repeat(64)}`,
    },
  );
  assert.throws(
    () =>
      imageFromBuildMetadata({
        component: "control-api",
        image: "ghcr.io/crewon/crewon-control-api",
        metadata: { "containerimage.digest": "latest" },
      }),
    /metadata_invalid/u,
  );
});

test("rejects incomplete, duplicate, mutable and non-canonical manifests", () => {
  const images = components.map((component) => ({
    component,
    image: `ghcr.io/crewon/crewon-${component}`,
    digest: `sha256:${"c".repeat(64)}`,
  }));
  for (const invalidImages of [
    images.slice(0, 3),
    [...images.slice(0, 3), images[0]],
    images.map((image, index) =>
      index === 0 ? { ...image, digest: "latest" } : image,
    ),
  ]) {
    assert.throws(
      () =>
        buildServerReleaseManifest({
          commit,
          images: invalidImages,
          publishedAt,
          repository: "crewon/cuican-aide",
          tag: "server-v1.2.3",
        }),
      /image/u,
    );
  }
  const valid = buildServerReleaseManifest({
    commit,
    images,
    publishedAt,
    repository: "crewon/cuican-aide",
    tag: "server-v1.2.3",
  });
  assert.throws(
    () => parseServerReleaseManifest({ ...valid, unexpected: true }),
    /manifest_invalid/u,
  );
});

test("CLI materializes and verifies one canonical manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "crewon-server-release-"));
  try {
    const output = join(root, "manifest.json");
    const imageArguments = [];
    for (const [index, component] of components.entries()) {
      const metadata = join(root, `${component}.json`);
      writeFileSync(
        metadata,
        JSON.stringify({
          "containerimage.digest": `sha256:${String(index + 1).repeat(64)}`,
        }),
      );
      imageArguments.push(
        "--image",
        `${component},ghcr.io/crewon/crewon-${component},${metadata}`,
      );
    }
    const { spawnSync } = await import("node:child_process");
    const manifest = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "server-release-tools.mjs"),
        "manifest",
        "--tag",
        "server-v1.2.3",
        "--commit",
        commit,
        "--repository",
        "crewon/cuican-aide",
        "--published-at",
        publishedAt,
        ...imageArguments,
        "--output",
        output,
      ],
      { encoding: "utf8" },
    );
    assert.deepEqual(
      { status: manifest.status, stderr: manifest.stderr },
      { status: 0, stderr: "" },
    );
    assert.deepEqual(
      parseServerReleaseManifest(JSON.parse(readFileSync(output, "utf8"))).tag,
      "server-v1.2.3",
    );
    const verify = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "server-release-tools.mjs"),
        "verify",
        "--manifest",
        output,
      ],
      { encoding: "utf8" },
    );
    assert.deepEqual(
      { status: verify.status, stderr: verify.stderr },
      { status: 0, stderr: "" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
