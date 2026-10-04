import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { extensionCanonicalJson } from "@crewon/domain";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import {
  assertDesktopInstalledPluginActivationFilesIssued,
  createDesktopInstalledPluginRuntimeActivationFiles,
  type DesktopInstalledPluginActivationFiles,
} from "./desktopInstalledPluginActivationFiles.ts";
import {
  withFixture,
  type Fixture,
} from "./desktopAutomaticInstalledPluginRuntime.test-support.ts";
import {
  DESKTOP_TASK_ENABLED_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
  loadDesktopInstalledPluginRuntimeConfiguration,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";
import {
  assertDesktopPluginBootstrapIssued,
  prepareDesktopPluginBootstrap,
  type DesktopPluginBootstrap,
} from "./desktopPluginBootstrap.ts";
import { createDesktopInstalledPluginTaskFiles } from "./desktopInstalledPluginTaskFiles.ts";

const authority = (role: string) => ({
  url: `https://native-task-owner.example/${role}`,
  serviceTokenEnvironmentVariable: `NATIVE_TASK_${role.toUpperCase()}_TOKEN`,
});
function settings(f: Fixture) {
  return {
    taskPolicyAuthority: authority("policy"),
    uiPolicyAuthority: authority("ui"),
    packageAuthority: authority("package"),
    quoteAuthority: authority("quote"),
    uiPublications: [
      {
        pluginId: f.source.pluginId,
        packageDigest: f.source.packageDigest,
        contributionId: "short-drama.studio",
      },
    ],
    timeoutMs: 2_000,
    maximumPackages: 8,
  };
}
function configuration(f: Fixture, taskExecution = settings(f)) {
  f.write({
    ...f.value,
    schemaVersion: DESKTOP_TASK_ENABLED_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
    activationAuthority: authority("activation"),
    taskExecution,
  });
  const result = loadDesktopInstalledPluginRuntimeConfiguration(
    f.dataDirectory,
  );
  if (!result.enabled) throw new Error("fixture issued v4 required");
  return result;
}
function activation(
  f: Fixture,
  bootstrap: DesktopPluginBootstrap = f.bootstrap,
) {
  return createDesktopInstalledPluginRuntimeActivationFiles({
    dataDirectory: f.dataDirectory,
    bootstrap,
    origin: "http://127.0.0.1:43001",
    authority: authority("activation"),
    timeoutMs: 2_000,
    entries: f.release.entries.map((entry) => ({
      identity: {
        ...entry.packageIdentity,
        manifestDigest: entry.configuration.manifestDigest,
        implementationDigest: entry.configuration.implementationDigest,
      },
      configuration: entry.configuration,
      configuredTarget: {
        ...entry.target,
        executionAuthority: "crewonKernel" as const,
      },
    })),
  });
}

it("issues a private task document from actual config/bootstrap/activation owners and pins its canonical activation digest without credentials", async () => {
  await withFixture(async (f) => {
    const config = configuration(f);
    const actual = activation(f);
    const owner = createDesktopInstalledPluginTaskFiles({
      dataDirectory: f.dataDirectory,
      configuration: config,
      bootstrap: f.bootstrap,
      activationFiles: actual,
    });
    try {
      const manifest = assertDesktopPluginBootstrapIssued(f.bootstrap);
      const publication = assertDesktopInstalledPluginActivationFilesIssued(
        actual,
        f.dataDirectory,
      );
      const bytes = readFileSync(owner.path, "utf8");
      expect(JSON.parse(bytes)).toEqual({
        schemaVersion: "crewon.desktop-installed-plugin-tasks.v1",
        actor: manifest.actor,
        scope: manifest.scope,
        authorityEpoch: manifest.authorityEpoch,
        installRoot: manifest.installRoot,
        activationDigest: `sha256:${createHash("sha256").update(extensionCanonicalJson(publication)).digest("hex")}`,
        ...settings(f),
      });
      expect(dirname(dirname(owner.path))).toBe(f.dataDirectory);
      expect(lstatSync(dirname(owner.path)).mode & 0o777).toBe(0o700);
      expect(lstatSync(owner.path).mode & 0o777).toBe(0o600);
      expect(lstatSync(owner.path).nlink).toBe(1);
      expect(bytes).not.toContain(f.provider.apiKey);
      expect(bytes).not.toContain(
        f.input.sharedEnvironment.CREWON_CONTROL_SESSION_TOKEN,
      );
      mkdirSync(join(f.dataDirectory, "unrelated-sibling"), { mode: 0o700 });
      owner.assertCurrent();
      owner.withdraw();
      expect(() => owner.assertCurrent()).toThrow(/withdrawn/);
      // Logical withdrawal of the consumed owners must not prevent retiring our exact file.
      actual.withdraw();
      owner.close();
      expect(existsSync(dirname(owner.path))).toBe(false);
      owner.close();
    } finally {
      owner.close();
      actual.close();
    }
  });
});

it("rejects activation/config/bootstrap clones and unapproved issued activation entries before allocating task files", async () => {
  await withFixture(async (f) => {
    const config = configuration(f);
    const actual = activation(f);
    try {
      const input = {
        dataDirectory: f.dataDirectory,
        configuration: config,
        bootstrap: f.bootstrap,
        activationFiles: actual,
      };
      expect(() =>
        assertDesktopInstalledPluginActivationFilesIssued(
          { ...actual },
          f.dataDirectory,
        ),
      ).toThrow(/unissued/);
      expect(() =>
        assertDesktopInstalledPluginActivationFilesIssued(actual, f.directory),
      ).toThrow(/unissued/);
      for (const change of [
        { configuration: { ...config } },
        { bootstrap: { ...f.bootstrap } },
        { activationFiles: { ...actual } },
      ])
        expect(() =>
          createDesktopInstalledPluginTaskFiles({ ...input, ...change }),
        ).toThrow();
      const foreign = createDesktopInstalledPluginRuntimeActivationFiles({
        dataDirectory: f.dataDirectory,
        bootstrap: f.bootstrap,
        origin: "http://127.0.0.1:43002",
        authority: authority("activation"),
        timeoutMs: 2_000,
        entries: [
          {
            ...f.release.entries[0]!,
            identity: {
              ...f.release.entries[0]!.packageIdentity,
              pluginId: "example.unapproved",
              manifestDigest:
                f.release.entries[0]!.configuration.manifestDigest,
              implementationDigest:
                f.release.entries[0]!.configuration.implementationDigest,
            },
            configuration: {},
            configuredTarget: {
              ...f.release.entries[0]!.target,
              executionAuthority: "crewonKernel" as const,
            },
          },
        ],
      });
      try {
        expect(() =>
          createDesktopInstalledPluginTaskFiles({
            ...input,
            activationFiles: foreign,
          }),
        ).toThrow(/task_publication/);
      } finally {
        foreign.close();
      }
      expect(
        readdirSync(f.dataDirectory).filter((name) =>
          name.startsWith(".installed-plugin-tasks-"),
        ),
      ).toEqual([]);
    } finally {
      actual.close();
    }
  });
});

it("permits an independently approved UI-only tuple that is not a Worker catalog entry", async () => {
  await withFixture(async (f) => {
    await f.bootstrap.cleanup();
    const uiSource = {
      ...f.source,
      sourceId: "approved-ui-only",
      pluginId: "example.ui-only",
      packageDigest: `sha256:${"b".repeat(64)}`,
      directory: join(f.directory, "ui-only-source"),
    };
    f.writeApproval({
      ...f.approval,
      sources: [...f.approval.sources, uiSource],
      publications: [
        ...f.approval.publications,
        {
          ...f.publication,
          pluginId: uiSource.pluginId,
          packageDigest: uiSource.packageDigest,
        },
      ],
    });
    const bootstrap = (await prepareDesktopPluginBootstrap({
      dataDirectory: f.dataDirectory,
      actor: DESKTOP_RUNTIME_OWNER,
      sessionEntropy: "native-ui-only-independent-publication-0000000000000000",
    }))!;
    let actual: DesktopInstalledPluginActivationFiles | undefined;
    try {
      const taskExecution = {
        ...settings(f),
        uiPublications: [
          {
            pluginId: uiSource.pluginId,
            packageDigest: uiSource.packageDigest,
            contributionId: "drama.studio",
          },
        ],
      };
      const config = configuration(f, taskExecution);
      actual = activation(f, bootstrap);
      expect(
        assertDesktopInstalledPluginActivationFilesIssued(
          actual,
          f.dataDirectory,
        ).entries.some(
          ({ identity }) => identity.pluginId === uiSource.pluginId,
        ),
      ).toBe(false);
      const files = createDesktopInstalledPluginTaskFiles({
        dataDirectory: f.dataDirectory,
        configuration: config,
        bootstrap,
        activationFiles: actual,
      });
      try {
        expect(
          JSON.parse(readFileSync(files.path, "utf8")).uiPublications,
        ).toEqual(taskExecution.uiPublications);
      } finally {
        files.close();
      }
    } finally {
      actual?.close();
      await bootstrap.cleanup();
    }
  });
});

it.each([
  "leaf",
  "directory",
  "leaf-mode",
  "parent-mode",
  "hard-link",
] as const)(
  "rejects real task %s drift without deleting or adopting a replacement",
  async (change) => {
    await withFixture(async (f) => {
      const config = configuration(f),
        actual = activation(f);
      const files = createDesktopInstalledPluginTaskFiles({
        dataDirectory: f.dataDirectory,
        configuration: config,
        bootstrap: f.bootstrap,
        activationFiles: actual,
      });
      const original = readFileSync(files.path);
      try {
        if (change === "leaf") {
          renameSync(files.path, join(dirname(files.path), "original.json"));
          writeFileSync(files.path, original, { mode: 0o600 });
        } else if (change === "directory") {
          const saved = dirname(files.path) + "-original";
          renameSync(dirname(files.path), saved);
          symlinkSync(saved, dirname(files.path));
        } else if (change === "leaf-mode") chmodSync(files.path, 0o644);
        else if (change === "parent-mode")
          chmodSync(dirname(files.path), 0o755);
        else
          linkSync(
            files.path,
            join(dirname(files.path), "unexpected-link.json"),
          );
        expect(() => files.assertCurrent()).toThrow();
        expect(() => files.close()).toThrow();
        expect(existsSync(files.path)).toBe(true);
        expect(readFileSync(files.path)).toEqual(original);
      } finally {
        actual.close();
      }
    });
  },
);

it("cleanup rejects an unexpected sibling, stays permanently withdrawn and can retire the unchanged owned file after the sibling is removed", async () => {
  await withFixture(async (f) => {
    const config = configuration(f),
      actual = activation(f);
    const files = createDesktopInstalledPluginTaskFiles({
      dataDirectory: f.dataDirectory,
      configuration: config,
      bootstrap: f.bootstrap,
      activationFiles: actual,
    });
    const unexpected = join(dirname(files.path), "unexpected.json");
    try {
      writeFileSync(unexpected, "foreign child", { mode: 0o600 });
      expect(() => files.close()).toThrow(/contents_changed/);
      expect(existsSync(files.path)).toBe(true);
      expect(() => files.assertCurrent()).toThrow(/withdrawn/);
      unlinkSync(unexpected);
      // Cleanup does not depend on the source config remaining current after withdrawal.
      f.write({
        schemaVersion: DESKTOP_TASK_ENABLED_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
        enabled: false,
      });
      actual.withdraw();
      files.close();
      expect(existsSync(dirname(files.path))).toBe(false);
    } finally {
      actual.close();
    }
  });
});
