import assert from "node:assert/strict";
import { ContractValidationError } from "./contract-validation-error.ts";

export const ID = "example.story";
export const DIGEST = `sha256:${"1".repeat(64)}`;
export const OTHER_DIGEST = `sha256:${"2".repeat(64)}`;
export const NOW = "2026-10-03T00:00:00.000Z";
export function pkg() {
  return {
    pluginId: ID,
    version: "1.0.0-alpha.1+build.2",
    publisherId: "example.publisher",
    packageDigest: DIGEST,
    installedAt: NOW,
  };
}
export function selection() {
  return {
    pluginId: ID,
    publisherId: pkg().publisherId,
    revision: 1,
    state: "disabled" as "disabled" | "enabled" | "uninstalled",
    selectedPackageDigest: DIGEST as string | null,
    updatedAt: NOW,
  };
}
export function installRequest() {
  return {
    sourceId: "host-issued-source-1",
    expectedPluginId: ID,
    expectedPackageDigest: DIGEST,
    expectedSelectionRevision: null as number | null,
  };
}
export function openRequest() {
  return {
    pluginId: ID,
    contributionId: "workbench",
    expectedSelectionRevision: 1,
    expectedPackageDigest: DIGEST,
  };
}
export function descriptor() {
  return {
    schemaVersion: "crewon.plugin-package.v1",
    hostApi: "crewon.plugin-host.v1",
    pluginId: ID,
    version: pkg().version,
    title: "Story",
    description: "An independently built module.",
    publisherId: pkg().publisherId,
    entrypoints: {
      node: "node.mjs",
      ui: { mode: "trustedModule", path: "ui/entry.mjs" },
    },
    businessManifestPath: null,
    requires: [],
    provides: [],
    contributions: [
      {
        id: "workbench",
        kind: "module",
        slot: "main.content",
        title: "Studio",
      },
    ],
    files: [
      { path: "node.mjs", byteLength: 10, sha256: "a".repeat(64) },
      { path: "ui/entry.mjs", byteLength: 20, sha256: "b".repeat(64) },
      { path: "ui/helper.mjs", byteLength: 30, sha256: "c".repeat(64) },
    ],
  };
}
export function lease() {
  return {
    schemaVersion: "crewon.plugin-ui-lease.v1",
    mountRef: "host-issued-unique-reference-00001",
    expiresAt: NOW,
    selectionRevision: 1,
    packageDigest: DIGEST,
    descriptor: descriptor(),
    contributionId: "workbench",
    publicAssets: ["ui/entry.mjs", "ui/helper.mjs"],
  };
}
export function catalogItem() {
  const { descriptor, publicAssets, selectionRevision, packageDigest } =
    lease();
  return { descriptor, publicAssets, selectionRevision, packageDigest };
}
export function rejected(operation: () => unknown, code?: string) {
  assert.throws(
    operation,
    (error: unknown) =>
      error instanceof ContractValidationError &&
      (code === undefined || error.code === code),
  );
}
