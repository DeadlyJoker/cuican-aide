import {
  chmodSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertDesktopPluginBootstrapIssued,
  DESKTOP_PLUGIN_APPROVAL_SCHEMA_V2,
  DESKTOP_PLUGIN_APPROVAL_SCHEMA_V3,
  DESKTOP_PLUGIN_BOOTSTRAP_SCHEMA_V3,
  prepareDesktopPluginBootstrap,
} from "./desktopPluginBootstrap.ts";
import { desktopPluginBootstrapFixture } from "./desktopPluginBootstrap.test-support.ts";

const roots: string[] = [];
const fixture = () => {
  const f = desktopPluginBootstrapFixture();
  roots.push(f.directory);
  return f;
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function execution(f: ReturnType<typeof fixture>) {
  const source = {
    pluginId: f.source.pluginId,
    packageDigest: f.source.packageDigest,
    contributionId: "workbench",
  };
  // These are private schema fixtures only: no Node, supplier or funded execution is prepared.
  const target = { ...source, contributionId: "studio" };
  return {
    version: "crewon.desktop-project-execution.v1",
    pluginUi: { publications: [source] },
    generationReads: { version: "crewon.project-generation-read.v1" },
    pluginGenerations: {
      publications: [
        { source, target: { ...target, action: "image.generate" } },
      ],
    },
    pluginQueries: {
      publications: [{ source, target: { ...target, action: "image.query" } }],
    },
    uiRecovery: {
      version: "crewon.plugin-ui-recovery.v1",
      publications: [
        {
          ...source,
          actions: [
            "crewon.project-generations.v1.generateConcept",
            "crewon.project-generation-queries.v1.queryConceptGeneration",
          ],
        },
      ],
    },
  };
}
const approval = (f: ReturnType<typeof fixture>) => ({
  ...f.approval,
  schemaVersion: DESKTOP_PLUGIN_APPROVAL_SCHEMA_V3,
  projects: execution(f),
});

describe("Native v3 explicit project execution bootstrap data", () => {
  it("issues an actual frozen private v3 file with data mappings and no task/activation authority", async () => {
    const f = fixture();
    f.writeApproval(approval(f));
    const owner = await prepareDesktopPluginBootstrap(f.input);
    expect(owner).not.toBeNull();
    const manifest = assertDesktopPluginBootstrapIssued(owner!);
    expect(manifest.schemaVersion).toBe(DESKTOP_PLUGIN_BOOTSTRAP_SCHEMA_V3);
    expect(f.read(owner!.bootstrapPath)).toEqual(manifest);
    expect(manifest).toHaveProperty("projects", execution(f));
    expect(Object.isFrozen(manifest)).toBe(true);
    if (manifest.schemaVersion !== DESKTOP_PLUGIN_BOOTSTRAP_SCHEMA_V3)
      throw new Error("test_v3_manifest_missing");
    expect(
      Object.isFrozen(manifest.projects.pluginQueries!.publications[0]!.target),
    ).toBe(true);
    expect(manifest).not.toHaveProperty("taskExecution");
    expect(manifest).not.toHaveProperty("activation");
    expect(readFileSync(owner!.bootstrapPath, "utf8")).not.toContain(
      f.input.sessionEntropy,
    );
    expect(() => assertDesktopPluginBootstrapIssued({ ...owner! })).toThrow();
    await owner!.cleanup();
    expect(() => assertDesktopPluginBootstrapIssued(owner!)).toThrow();
  });

  it("preserves actual profile across sessions and binds epoch to exact approval changes", async () => {
    const f = fixture();
    f.writeApproval(approval(f));
    const first = (await prepareDesktopPluginBootstrap(f.input))!;
    const original = assertDesktopPluginBootstrapIssued(first);
    const changed = approval(f);
    changed.projects.pluginGenerations.publications[0]!.target.action =
      "other.generate";
    f.writeApproval(changed);
    expect(() => first.assertCurrent!()).toThrow();
    const second = (await prepareDesktopPluginBootstrap({
      ...f.input,
      sessionEntropy: `${f.input.sessionEntropy}:next`,
    }))!;
    expect(second.scope).toEqual(original.scope);
    expect(second.authorityEpoch).not.toBe(first.authorityEpoch);
    expect(assertDesktopPluginBootstrapIssued(second)).toHaveProperty(
      "projects",
      changed.projects,
    );
    await first.cleanup();
    await second.cleanup();
  });

  it("does not broaden v1/v2 approval shapes to accept new execution data", async () => {
    for (const schemaVersion of [
      "crewon.desktop-plugin-approval.v1",
      DESKTOP_PLUGIN_APPROVAL_SCHEMA_V2,
    ]) {
      const f = fixture();
      f.writeApproval({ ...approval(f), schemaVersion });
      await expect(prepareDesktopPluginBootstrap(f.input)).rejects.toThrow();
      expect(readdirSync(f.dataDirectory)).toEqual(["plugin-approvals.json"]);
    }
  });

  it("refuses unapproved source/digest or recovery without its own lane before profile allocation", async () => {
    for (const alter of [
      (value: ReturnType<typeof approval>) => {
        value.projects.pluginGenerations.publications[0]!.source.contributionId =
          "other";
      },
      (value: ReturnType<typeof approval>) => {
        value.projects.pluginQueries.publications[0]!.source.packageDigest = `sha256:${"f".repeat(64)}`;
      },
      (value: ReturnType<typeof approval>) => {
        value.projects.uiRecovery.publications[0]!.actions = [
          "crewon.project-generation-selections.v1.selectConceptImage",
        ];
      },
    ]) {
      const f = fixture();
      const value = approval(f);
      // Detach shared source references so this drift affects only the requested lane.
      const input = structuredClone(value);
      input.projects.pluginGenerations.publications[0]!.source = {
        ...input.projects.pluginGenerations.publications[0]!.source,
      };
      input.projects.pluginQueries.publications[0]!.source = {
        ...input.projects.pluginQueries.publications[0]!.source,
      };
      alter(input);
      f.writeApproval(input);
      await expect(prepareDesktopPluginBootstrap(f.input)).rejects.toThrow();
      expect(readdirSync(f.dataDirectory)).toEqual(["plugin-approvals.json"]);
    }
  });

  it("withdraws current provenance for leaf replacement, mode drift and profile replacement", async () => {
    for (const change of ["leaf", "mode", "profile"] as const) {
      const f = fixture();
      f.writeApproval(approval(f));
      const owner = (await prepareDesktopPluginBootstrap(f.input))!;
      if (change === "mode") chmodSync(owner.bootstrapPath, 0o640);
      else {
        const path =
          change === "leaf"
            ? owner.bootstrapPath
            : join(f.dataDirectory, "plugin-profile.json");
        const bytes = readFileSync(path);
        renameSync(path, `${path}.old`);
        writeFileSync(path, bytes, { mode: 0o600 });
      }
      expect(() => assertDesktopPluginBootstrapIssued(owner)).toThrow();
    }
  });
});
