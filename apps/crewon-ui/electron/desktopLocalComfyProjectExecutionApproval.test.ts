import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parsePluginPackageDescriptor,
  type InstalledPluginPeerCatalogEntry,
} from "@crewon/contracts/plugins";
import { createExtensionConfiguration } from "@crewon/domain";
import { desktopInstalledPluginRuntimeFixture } from "./desktopInstalledPluginRuntime.test-support.ts";
import { parseDesktopPluginApproval } from "./desktopPluginBootstrap.ts";
import { composeDesktopLocalComfyProjectExecutionApproval } from "./desktopLocalComfyProjectExecutionApproval.ts";
const root = resolve("../..");
type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;
const hash = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
async function fixture({ unified = false } = {}) {
  const f = await desktopInstalledPluginRuntimeFixture();
  // Contract fixtures only; the process integration suite verifies actual installed artifacts.
  const descriptor = (pluginId: string, version: string, business: boolean) =>
    parsePluginPackageDescriptor({
      schemaVersion: "crewon.plugin-package.v1",
      hostApi: "crewon.plugin-host.v1",
      pluginId,
      publisherId: "crewon",
      version,
      title: "unit plugin",
      description: "unit contract",
      entrypoints: {
        node: business ? "node.mjs" : null,
        ui: { path: "ui.mjs", mode: "trustedModule" },
      },
      businessManifestPath: business ? "business.json" : null,
      requires:
        business && pluginId !== "crewon.short-drama"
          ? []
          : [
              "crewon.creative-projects",
              "crewon.plugin-ui-recovery",
              "crewon.project-generation-reads",
              "crewon.project-generations",
              "crewon.project-generation-queries",
              "crewon.project-generation-selections",
              "crewon.project-generation-contexts",
            ].map((service) => ({
              service,
              apiVersion: "1",
              optional: business,
            })),
      provides: [],
      contributions: [
        {
          id: pluginId === "crewon.short-drama" ? "workbench" : "studio",
          kind: "module",
          title: "unit module",
          slot: "main.content",
        },
      ],
      files: ["ui.mjs", ...(business ? ["node.mjs", "business.json"] : [])].map(
        (path) => ({ path, byteLength: 1, sha256: "a".repeat(64) }),
      ),
    });
  const source = descriptor(
      "crewon.short-drama",
      unified ? "12.0.0" : "11.0.0",
      unified,
    ),
    target = unified
      ? source
      : descriptor("crewon.comfyui-krea2", "1.0.0", true);
  const sourceDigest = hash("unit-source-package"),
    targetDigest = unified ? sourceDigest : hash("unit-target-package");
  const packages = unified ? [source] : [source, target];
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: f.input.sharedEnvironment.CREWON_TENANT_ID!,
      spaceId: f.input.sharedEnvironment.CREWON_SPACE_ID!,
      pluginId: target.pluginId,
      pluginVersion: target.version,
      revision: 1,
      manifestDigest: hash("unit-manifest-identity"),
      implementationDigest: hash("unit-implementation-identity"),
      parameters: { baseUrl: "https://comfy.example/" },
      credentialBindings: [],
      createdByActorId: f.input.sharedEnvironment.CREWON_ACTOR_ID!,
      createdAt: "2026-10-04T00:00:00.000Z",
    },
    { sha256: hash },
  );
  const entry = {
    identity: {
      pluginId: target.pluginId,
      publisherId: target.publisherId,
      version: target.version,
      packageDigest: targetDigest,
      manifestDigest: configuration.manifestDigest,
      implementationDigest: configuration.implementationDigest,
    },
    configuration:
      configuration as unknown as InstalledPluginPeerCatalogEntry["configuration"],
    configuredTarget: f.release.entries[0]!
      .target as unknown as InstalledPluginPeerCatalogEntry["configuredTarget"],
  };
  const approval = parseDesktopPluginApproval({
    schemaVersion: "crewon.desktop-plugin-approval.v2",
    sources: packages.map((pkg, index) => ({
      sourceId: `local-${index}`,
      directory: resolve(
        root,
        "examples/plugins",
        index === 0 ? "short-drama" : "comfyui-krea2",
      ),
      pluginId: pkg.pluginId,
      publisherId: pkg.publisherId,
      version: pkg.version,
      packageDigest: index === 0 ? sourceDigest : targetDigest,
    })),
    publications: packages.map((pkg, index) => ({
      pluginId: pkg.pluginId,
      publisherId: pkg.publisherId,
      packageDigest: index === 0 ? sourceDigest : targetDigest,
      publicAssets: [pkg.entrypoints.ui!.path],
    })),
    projects: {
      version: "crewon.desktop-project-history.v1",
      pluginUi: {
        publications: [
          {
            pluginId: source.pluginId,
            packageDigest: sourceDigest,
            contributionId: "workbench",
          },
        ],
      },
      uiRecovery: {
        version: "crewon.plugin-ui-recovery.v1",
        publications: [
          {
            pluginId: source.pluginId,
            packageDigest: sourceDigest,
            contributionId: "workbench",
            actions: [],
          },
        ],
      },
    },
  });
  const input = {
    approval,
    source: {
      descriptor: source,
      packageDigest: sourceDigest,
      contributionId: "workbench",
    },
    target: {
      descriptor: target,
      contributionId: unified ? "workbench" : "studio",
      entry,
    },
  };
  return {
    input,
    async close() {
      await f.bootstrap.cleanup();
      rmSync(f.directory, { recursive: true, force: true });
    },
  };
}
describe("explicit independent workbench to actual Comfy project binding", () => {
  it("binds the unified Short workbench and Node execution to the same exact approved package", async () => {
    const f = await fixture({ unified: true });
    try {
      const next = composeDesktopLocalComfyProjectExecutionApproval(f.input);
      if (next.schemaVersion !== "crewon.desktop-plugin-approval.v3")
        throw new Error("expected execution data");
      const pin = {
        pluginId: "crewon.short-drama",
        packageDigest: f.input.source.packageDigest,
        contributionId: "workbench",
      };
      expect(next.projects.pluginGenerations!.publications).toEqual([
        { source: pin, target: { ...pin, action: "image.generate" } },
      ]);
      expect(next.projects.pluginQueries!.publications).toEqual([
        { source: pin, target: { ...pin, action: "image.query" } },
      ]);
      expect(next.projects.resultSelections!.identities).toEqual([
        {
          pluginId: "crewon.short-drama",
          pluginVersion: "12.0.0",
          manifestDigest: f.input.target.entry.identity.manifestDigest,
          implementationDigest:
            f.input.target.entry.identity.implementationDigest,
        },
      ]);
      expect(
        composeDesktopLocalComfyProjectExecutionApproval({
          ...f.input,
          approval: next,
        }),
      ).toEqual(next);
    } finally {
      await f.close();
    }
  });
  it("appends Short12 while retaining the original Krea pins and legacy result identity", async () => {
    const legacy = await fixture(),
      current = await fixture({ unified: true });
    try {
      const old = composeDesktopLocalComfyProjectExecutionApproval(
        legacy.input,
      );
      if (old.schemaVersion !== "crewon.desktop-plugin-approval.v3")
        throw new Error("expected legacy data");
      const next = composeDesktopLocalComfyProjectExecutionApproval({
        ...current.input,
        approval: parseDesktopPluginApproval({
          ...old,
          sources: [
            ...old.sources,
            ...current.input.approval.sources.map((entry) => ({
              ...entry,
              sourceId: "unified-source",
              directory: resolve(entry.directory, entry.version),
              packageDigest: hash("short12-package"),
            })),
          ],
          publications: [
            ...old.publications,
            ...current.input.approval.publications.map((entry) => ({
              ...entry,
              packageDigest: hash("short12-package"),
            })),
          ],
        }),
        source: {
          ...current.input.source,
          packageDigest: hash("short12-package"),
        },
        target: {
          ...current.input.target,
          entry: {
            ...current.input.target.entry,
            identity: {
              ...current.input.target.entry.identity,
              packageDigest: hash("short12-package"),
            },
          },
        },
      });
      if (next.schemaVersion !== "crewon.desktop-plugin-approval.v3")
        throw new Error("expected execution data");
      expect(next.projects.pluginGenerations!.publications[0]).toEqual(
        old.projects.pluginGenerations!.publications[0],
      );
      expect(next.projects.pluginQueries!.publications[0]).toEqual(
        old.projects.pluginQueries!.publications[0],
      );
      expect(next.projects.resultSelections!.identities[0]).toEqual(
        old.projects.resultSelections!.identities[0],
      );
      expect(next.projects.resultSelections!.identities[1]!.pluginId).toBe(
        "crewon.short-drama",
      );
    } finally {
      await legacy.close();
      await current.close();
    }
  });
  it.each([
    "source-version",
    "publisher",
    "different-package",
    "different-module",
  ])(
    "rejects a unified execution substituted from another source: %s",
    async (kind) => {
      const f = await fixture({ unified: true });
      try {
        const input = structuredClone(f.input) as Mutable<typeof f.input>;
        if (kind === "source-version")
          input.source.descriptor.version = "11.0.0";
        if (kind === "publisher")
          input.source.descriptor.publisherId = "foreign.publisher";
        if (kind === "different-package")
          input.source.packageDigest = hash("foreign");
        if (kind === "different-module") input.source.contributionId = "studio";
        expect(() =>
          composeDesktopLocalComfyProjectExecutionApproval(input),
        ).toThrow();
      } finally {
        await f.close();
      }
    },
  );
  it("preserves approved source/publications and scopes all actions to the pinned target", async () => {
    const f = await fixture();
    try {
      const next = composeDesktopLocalComfyProjectExecutionApproval(f.input);
      expect(next.sources).toEqual(f.input.approval.sources);
      expect(next.publications).toEqual(f.input.approval.publications);
      expect(next.schemaVersion).toBe("crewon.desktop-plugin-approval.v3");
      if (next.schemaVersion !== "crewon.desktop-plugin-approval.v3")
        throw new Error("expected execution data");
      expect(next.projects.pluginGenerations!.publications[0]!.target).toEqual({
        pluginId: f.input.target.descriptor.pluginId,
        packageDigest: f.input.target.entry.identity.packageDigest,
        contributionId: "studio",
        action: "image.generate",
      });
      expect(next.projects.resultSelections!.identities).toEqual([
        {
          pluginVersion: f.input.target.descriptor.version,
          manifestDigest: f.input.target.entry.identity.manifestDigest,
          implementationDigest:
            f.input.target.entry.identity.implementationDigest,
        },
      ]);
      expect(
        composeDesktopLocalComfyProjectExecutionApproval({
          ...f.input,
          approval: next,
        }),
      ).toEqual(next);
    } finally {
      await f.close();
    }
  });
  it.each([
    "source-digest",
    "target-digest",
    "contribution",
    "unpublished-ui",
    "identity",
    "missing-service",
  ])("rejects ambiguous or unapproved binding: %s", async (kind) => {
    const f = await fixture();
    try {
      const input = structuredClone(f.input) as Mutable<typeof f.input>;
      if (kind === "source-digest")
        input.source.packageDigest = hash("foreign");
      if (kind === "target-digest")
        input.target.entry.identity.packageDigest = hash("foreign");
      if (kind === "contribution") input.source.contributionId = "foreign";
      if (kind === "unpublished-ui")
        input.approval.publications[1]!.publicAssets = [];
      if (kind === "identity")
        input.target.entry.identity.implementationDigest = hash("foreign");
      if (kind === "missing-service")
        input.source.descriptor.requires =
          input.source.descriptor.requires.filter(
            (item) => item.service !== "crewon.project-generations",
          );
      expect(() =>
        composeDesktopLocalComfyProjectExecutionApproval(input),
      ).toThrow();
    } finally {
      await f.close();
    }
  });
});
