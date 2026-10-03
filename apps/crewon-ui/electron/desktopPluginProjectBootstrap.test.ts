import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
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
  DESKTOP_PLUGIN_BOOTSTRAP_SCHEMA,
  DESKTOP_PLUGIN_BOOTSTRAP_SCHEMA_V2,
  prepareDesktopPluginBootstrap,
} from "./desktopPluginBootstrap.ts";
import { desktopPluginBootstrapFixture } from "./desktopPluginBootstrap.test-support.ts";

type Fixture = ReturnType<typeof desktopPluginBootstrapFixture>;
const directories: string[] = [];
function fixture() {
  const result = desktopPluginBootstrapFixture();
  directories.push(result.directory);
  return result;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function projectApproval(f: Fixture) {
  const publication = {
    pluginId: f.source.pluginId,
    packageDigest: f.source.packageDigest,
    contributionId: "workbench",
  };
  // These identify an offline approval-parser fixture, not a funded provider deployment.
  const offlineSelectionIdentity = {
    pluginVersion: "1.0.0",
    manifestDigest: `sha256:${"b".repeat(64)}`,
    implementationDigest: `sha256:${"c".repeat(64)}`,
  };
  return {
    version: "crewon.desktop-project-history.v1",
    pluginUi: { publications: [publication] },
    generationReads: { version: "crewon.project-generation-read.v1" },
    generationReadUi: { publications: [publication] },
    resultSelections: {
      version: "crewon.project-concept-selection.v1",
      adapter: "comfyui-krea2",
      identities: [offlineSelectionIdentity],
    },
    selectionUi: { publications: [publication] },
    uiRecovery: {
      version: "crewon.plugin-ui-recovery.v1",
      publications: [
        {
          ...publication,
          actions: [
            "crewon.project-generation-selections.v1.selectConceptImage",
          ],
        },
      ],
    },
  };
}
function v2Approval(f: Fixture, projects: unknown = projectApproval(f)) {
  return {
    ...f.approval,
    schemaVersion: DESKTOP_PLUGIN_APPROVAL_SCHEMA_V2,
    projects,
  };
}
function expectNoAllocation(f: Fixture) {
  expect(readdirSync(f.dataDirectory)).toEqual(["plugin-approvals.json"]);
}
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

describe("Native v2 project history approval bootstrap", () => {
  it("keeps the v1 issued manifest exact and refuses projects in a v1 approval", async () => {
    const original = fixture();
    original.writeApproval();
    const result = await prepareDesktopPluginBootstrap(original.input);
    expect(result).not.toBeNull();
    const manifest = assertDesktopPluginBootstrapIssued(result!);
    expect(manifest.schemaVersion).toBe(DESKTOP_PLUGIN_BOOTSTRAP_SCHEMA);
    expect(Object.hasOwn(manifest, "projects")).toBe(false);
    expect(original.read(result!.bootstrapPath)).toEqual(manifest);
    await result!.cleanup();

    const altered = fixture();
    altered.writeApproval({
      ...altered.approval,
      projects: projectApproval(altered),
    });
    await expect(
      prepareDesktopPluginBootstrap(altered.input),
    ).rejects.toThrow();
    expectNoAllocation(altered);
  });

  it("issues the actual private v2 DTO with separately approved frozen project grants and only the environment path", async () => {
    const f = fixture();
    const projects = projectApproval(f);
    f.writeApproval(v2Approval(f, projects));
    const result = await prepareDesktopPluginBootstrap(f.input);
    expect(result).not.toBeNull();
    const manifest = assertDesktopPluginBootstrapIssued(result!);
    expect(manifest.schemaVersion).toBe(DESKTOP_PLUGIN_BOOTSTRAP_SCHEMA_V2);
    if (manifest.schemaVersion !== DESKTOP_PLUGIN_BOOTSTRAP_SCHEMA_V2)
      throw new Error("Expected issued v2 bootstrap");
    expect(f.read(result!.bootstrapPath)).toEqual({
      schemaVersion: DESKTOP_PLUGIN_BOOTSTRAP_SCHEMA_V2,
      actor: f.input.actor,
      scope: result!.scope,
      authorityEpoch: result!.authorityEpoch,
      installRoot: join(f.dataDirectory, "plugins"),
      sources: [f.source],
      publications: [f.publication],
      projects,
    });
    expect(result!.environment).toEqual({
      CREWON_DESKTOP_PLUGIN_BOOTSTRAP_PATH: result!.bootstrapPath,
    });
    expect(Object.isFrozen(manifest.projects)).toBe(true);
    expect(Object.isFrozen(manifest.projects.pluginUi!.publications[0])).toBe(
      true,
    );
    expect(
      Object.isFrozen(manifest.projects.resultSelections!.identities[0]),
    ).toBe(true);
    expect(
      Object.isFrozen(manifest.projects.uiRecovery!.publications[0]!.actions),
    ).toBe(true);
    projects.selectionUi.publications[0]!.contributionId = "changed-workbench";
    expect(manifest.projects.selectionUi!.publications[0]!.contributionId).toBe(
      "workbench",
    );
    expect(lstatSync(result!.bootstrapPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(result!.bootstrapPath).nlink).toBe(1);
    expect(lstatSync(join(f.dataDirectory, "plugins")).mode & 0o777).toBe(
      0o700,
    );
    expect(readFileSync(result!.bootstrapPath, "utf8")).not.toContain(
      f.input.sessionEntropy,
    );
    expect(() => assertDesktopPluginBootstrapIssued({ ...result! })).toThrow();
    await result!.cleanup();
    expect(() => assertDesktopPluginBootstrapIssued(result!)).toThrow();
    expect(readdirSync(f.dataDirectory).sort()).toEqual([
      "plugin-approvals.json",
      "plugin-profile.json",
      "plugins",
    ]);
  });

  it("changes authority on v1 to v2 without changing the original persistent Native profile", async () => {
    const f = fixture();
    f.writeApproval();
    const first = await prepareDesktopPluginBootstrap(f.input);
    const profilePath = join(f.dataDirectory, "plugin-profile.json");
    const originalProfile = readFileSync(profilePath);
    await first!.cleanup();
    f.writeApproval(v2Approval(f));
    const second = await prepareDesktopPluginBootstrap({
      ...f.input,
      sessionEntropy: `${f.input.sessionEntropy}:v2`,
    });
    expect(second!.scope).toEqual(first!.scope);
    expect(readFileSync(profilePath)).toEqual(originalProfile);
    expect(second!.authorityEpoch).not.toBe(first!.authorityEpoch);
    await second!.cleanup();
  });

  it("pins exact project approval bytes into the existing epoch and rejects drift or overwriting an issued bootstrap", async () => {
    const f = fixture();
    f.writeApproval(v2Approval(f));
    const first = await prepareDesktopPluginBootstrap(f.input);
    const originalBootstrap = readFileSync(first!.bootstrapPath);
    expect(first!.authorityEpoch).toBe(
      hash(
        JSON.stringify({
          schemaVersion: "crewon.desktop-plugin-epoch.v1",
          approvalDigest: hash(readFileSync(f.approvalPath)),
          sessionEntropy: f.input.sessionEntropy,
        }),
      ),
    );
    const projects = projectApproval(f);
    projects.resultSelections.identities[0]!.implementationDigest = `sha256:${"d".repeat(64)}`;
    f.writeApproval(v2Approval(f, projects));
    expect(() => first!.assertCurrent!()).toThrow();
    expect(() => assertDesktopPluginBootstrapIssued(first!)).toThrow();
    await expect(prepareDesktopPluginBootstrap(f.input)).rejects.toThrow();
    expect(readFileSync(first!.bootstrapPath)).toEqual(originalBootstrap);
    const next = await prepareDesktopPluginBootstrap({
      ...f.input,
      sessionEntropy: `${f.input.sessionEntropy}:next`,
    });
    expect(next!.scope).toEqual(first!.scope);
    expect(next!.authorityEpoch).not.toBe(first!.authorityEpoch);
    await first!.cleanup();
    await next!.cleanup();
  });

  it("captures metadata-only approval without implicitly adding read, selection or recovery grants", async () => {
    const f = fixture();
    const projects = {
      version: "crewon.desktop-project-history.v1",
      pluginUi: projectApproval(f).pluginUi,
    };
    f.writeApproval(v2Approval(f, projects));
    const result = await prepareDesktopPluginBootstrap(f.input);
    const manifest = assertDesktopPluginBootstrapIssued(result!);
    expect(manifest.schemaVersion).toBe(DESKTOP_PLUGIN_BOOTSTRAP_SCHEMA_V2);
    if (manifest.schemaVersion !== DESKTOP_PLUGIN_BOOTSTRAP_SCHEMA_V2)
      throw new Error("Expected issued v2 bootstrap");
    expect(manifest.projects).toEqual(projects);
    expect(Object.keys(manifest.projects)).toEqual(["version", "pluginUi"]);
    await result!.cleanup();
  });

  it.each([
    ["missing projects", undefined],
    ["null projects", null],
    ["empty grants", { version: "crewon.desktop-project-history.v1" }],
    ["future schema", { version: "crewon.desktop-project-history.v2" }],
  ])(
    "refuses v2 %s before allocating any profile or plugin root",
    async (_, projects) => {
      const f = fixture();
      const approval = v2Approval(f, projects);
      if (projects === undefined) Reflect.deleteProperty(approval, "projects");
      f.writeApproval(approval);
      await expect(prepareDesktopPluginBootstrap(f.input)).rejects.toThrow();
      expectNoAllocation(f);
    },
  );

  const deniedProjects: readonly [
    string,
    (approved: ReturnType<typeof projectApproval>) => unknown,
  ][] = [
    [
      "metadata plus selection UI without business selection grant",
      (approved) => ({
        version: approved.version,
        pluginUi: approved.pluginUi,
        selectionUi: approved.selectionUi,
      }),
    ],
    [
      "metadata plus recovery without selection UI grant",
      (approved) => ({
        version: approved.version,
        pluginUi: approved.pluginUi,
        uiRecovery: approved.uiRecovery,
      }),
    ],
    [
      "selection without independently enabled history reads",
      ({ generationReads: _, ...approved }) => approved,
    ],
    [
      "publication from an unapproved plugin",
      (approved) => ({
        ...approved,
        generationReadUi: {
          publications: [
            {
              ...approved.generationReadUi.publications[0],
              pluginId: "example.unapproved",
            },
          ],
        },
      }),
    ],
    [
      "publication for an unapproved package digest",
      (approved) => ({
        ...approved,
        selectionUi: {
          publications: [
            {
              ...approved.selectionUi.publications[0],
              packageDigest: `sha256:${"e".repeat(64)}`,
            },
          ],
        },
      }),
    ],
    [
      "recovery contribution not granted by selection UI",
      (approved) => ({
        ...approved,
        uiRecovery: {
          ...approved.uiRecovery,
          publications: [
            {
              ...approved.uiRecovery.publications[0],
              contributionId: "unapproved-workbench",
            },
          ],
        },
      }),
    ],
    [
      "recovery generation action",
      (approved) => ({
        ...approved,
        uiRecovery: {
          ...approved.uiRecovery,
          publications: [
            {
              ...approved.uiRecovery.publications[0],
              actions: ["crewon.project-generations.v1.generateConceptImage"],
            },
          ],
        },
      }),
    ],
  ];
  it.each(deniedProjects)(
    "refuses %s at the approval boundary",
    async (_, alter) => {
      const f = fixture();
      f.writeApproval(v2Approval(f, alter(projectApproval(f))));
      await expect(prepareDesktopPluginBootstrap(f.input)).rejects.toThrow();
      expectNoAllocation(f);
    },
  );

  it.each(["generation", "query", "url", "price", "actor"])(
    "refuses unknown execution/configuration field %s instead of capturing it",
    async (field) => {
      const f = fixture();
      f.writeApproval(v2Approval(f, { ...projectApproval(f), [field]: {} }));
      await expect(prepareDesktopPluginBootstrap(f.input)).rejects.toThrow();
      expectNoAllocation(f);
    },
  );

  it("keeps v2 approvals private and refuses cleanup of a replaced bootstrap without deleting the replacement", async () => {
    const linked = fixture();
    linked.writeApproval(v2Approval(linked));
    const aliasPath = join(linked.directory, "approval-alias.json");
    linkSync(linked.approvalPath, aliasPath);
    await expect(prepareDesktopPluginBootstrap(linked.input)).rejects.toThrow();
    expectNoAllocation(linked);

    const f = fixture();
    f.writeApproval(v2Approval(f));
    const result = await prepareDesktopPluginBootstrap(f.input);
    renameSync(result!.bootstrapPath, `${result!.bootstrapPath}.original`);
    const replacement = Buffer.from('{"replacement":true}');
    writeFileSync(result!.bootstrapPath, replacement, { mode: 0o600 });
    chmodSync(result!.bootstrapPath, 0o600);
    expect(() => result!.assertCurrent!()).toThrow();
    await expect(result!.cleanup()).rejects.toThrow();
    expect(readFileSync(result!.bootstrapPath)).toEqual(replacement);
    expect(f.read(join(f.dataDirectory, "plugin-profile.json")).scope).toEqual(
      result!.scope,
    );
  });
});
