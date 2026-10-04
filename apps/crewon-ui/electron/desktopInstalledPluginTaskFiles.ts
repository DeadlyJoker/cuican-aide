import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_MAX_BYTES,
  parseDesktopInstalledPluginTaskConfiguration,
} from "@crewon/contracts/plugins";
import { extensionCanonicalJson } from "@crewon/domain";
import {
  assertDesktopInstalledPluginActivationFilesIssued,
  type DesktopInstalledPluginActivationFiles,
} from "./desktopInstalledPluginActivationFiles.ts";
import {
  assertDesktopInstalledPluginRuntimeConfiguration,
  captureDesktopInstalledPluginRuntimeDocument,
  desktopInstalledPluginAbsolutePath,
  desktopInstalledPluginInvalid as invalid,
  desktopInstalledPluginTaskExecutionSettings,
  type EnabledDesktopInstalledPluginRuntimeConfiguration,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";
import {
  assertDesktopPluginBootstrapIssued,
  type DesktopPluginBootstrap,
} from "./desktopPluginBootstrap.ts";

export type DesktopInstalledPluginTaskFiles = Readonly<{
  path: string;
  assertCurrent(): void;
  withdraw(): void;
  /** The parent has physically joined every consuming Control before calling close. */
  close(): void;
}>;
type DirectoryPin = Readonly<{ path: string; metadata: Stats }>;

/** Independent task publication from genuine Native config/bootstrap/activation file owners. */
export function createDesktopInstalledPluginTaskFiles(
  input: Readonly<{
    dataDirectory: string;
    configuration: EnabledDesktopInstalledPluginRuntimeConfiguration;
    bootstrap: DesktopPluginBootstrap;
    activationFiles: DesktopInstalledPluginActivationFiles;
  }>,
): DesktopInstalledPluginTaskFiles {
  const dataDirectory = desktopInstalledPluginAbsolutePath(input.dataDirectory);
  const configuration = input.configuration;
  const bootstrap = input.bootstrap;
  const activationFiles = input.activationFiles;
  assertDesktopInstalledPluginRuntimeConfiguration(
    configuration,
    dataDirectory,
  );
  const settings = desktopInstalledPluginTaskExecutionSettings(configuration);
  if (settings === null) invalid("task_unissued");
  const manifest = assertDesktopPluginBootstrapIssued(bootstrap);
  const activation = assertDesktopInstalledPluginActivationFilesIssued(
    activationFiles,
    dataDirectory,
  );
  if (
    manifest.installRoot !== join(dataDirectory, "plugins") ||
    !isDeepStrictEqual(activation.actor, manifest.actor) ||
    !isDeepStrictEqual(activation.scope, manifest.scope) ||
    activation.installRoot !== manifest.installRoot ||
    settings.uiPublications.some(
      (grant) =>
        !manifest.sources.some(
          (source) =>
            source.pluginId === grant.pluginId &&
            source.packageDigest === grant.packageDigest,
        ) ||
        !manifest.publications.some(
          (publication) =>
            publication.pluginId === grant.pluginId &&
            publication.packageDigest === grant.packageDigest,
        ),
    ) ||
    activation.entries.some(
      ({ identity }) =>
        !manifest.sources.some(
          (source) =>
            source.pluginId === identity.pluginId &&
            source.publisherId === identity.publisherId &&
            source.version === identity.version &&
            source.packageDigest === identity.packageDigest,
        ),
    )
  )
    invalid("task_publication");
  // UI-only source packages need not be Worker entries; the receiving Main owns target admission.
  const publication = parseDesktopInstalledPluginTaskConfiguration({
    schemaVersion: "crewon.desktop-installed-plugin-tasks.v1",
    actor: manifest.actor,
    scope: manifest.scope,
    authorityEpoch: manifest.authorityEpoch,
    installRoot: manifest.installRoot,
    activationDigest: `sha256:${createHash("sha256")
      .update(extensionCanonicalJson(activation))
      .digest("hex")}`,
    ...settings,
  });
  const pins = directoryPins(dataDirectory);
  const parent = pins[0]!.metadata;
  assertPrivateDirectory(parent);
  const directory = mkdtempSync(
    join(dataDirectory, ".installed-plugin-tasks-"),
  );
  chmodSync(directory, 0o700);
  const identity = lstatSync(directory);
  const path = join(directory, "tasks.json");
  let file: ReturnType<
    typeof captureDesktopInstalledPluginRuntimeDocument
  > | null = null;
  let withdrawn = false;
  let closed = false;
  const assertDirectory = () => {
    assertDirectoryPins(pins);
    const actual = lstatSync(directory);
    assertPrivateDirectory(actual);
    if (
      actual.dev !== identity.dev ||
      actual.ino !== identity.ino ||
      actual.mode !== identity.mode ||
      actual.uid !== identity.uid
    )
      invalid("task_directory_changed");
  };
  const close = () => {
    withdrawn = true;
    if (closed) return;
    assertDirectory();
    const children = readdirSync(directory);
    if (file === null) {
      if (children.length !== 0) invalid("task_directory_contents_changed");
    } else {
      if (children.length !== 1 || children[0] !== "tasks.json")
        invalid("task_directory_contents_changed");
      file.assertCurrent();
      assertDirectory();
      unlinkSync(path);
    }
    assertDirectory();
    rmdirSync(directory);
    closed = true;
  };
  try {
    const bytes = JSON.stringify(publication);
    if (
      Buffer.byteLength(bytes) >
      DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_MAX_BYTES
    )
      invalid("task_limit");
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    file = captureDesktopInstalledPluginRuntimeDocument(
      path,
      DESKTOP_INSTALLED_PLUGIN_TASK_CONFIGURATION_MAX_BYTES,
    );
    const assertCurrent = () => {
      if (withdrawn || closed) invalid("withdrawn");
      assertDesktopInstalledPluginRuntimeConfiguration(
        configuration,
        dataDirectory,
      );
      if (
        desktopInstalledPluginTaskExecutionSettings(configuration) !==
          settings ||
        assertDesktopPluginBootstrapIssued(bootstrap) !== manifest ||
        assertDesktopInstalledPluginActivationFilesIssued(
          activationFiles,
          dataDirectory,
        ) !== activation
      )
        invalid("task_owner_changed");
      assertDirectory();
      file!.assertCurrent();
    };
    assertCurrent();
    return Object.freeze({
      path,
      assertCurrent,
      withdraw() {
        withdrawn = true;
      },
      close,
    });
  } catch (error) {
    try {
      close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "desktop_installed_plugin_task_creation_cleanup_failed",
      );
    }
    throw error;
  }
}

function assertPrivateDirectory(metadata: Stats): void {
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o777) !== 0o700
  )
    invalid("task_directory");
}
function directoryPins(path: string): readonly DirectoryPin[] {
  const pins: DirectoryPin[] = [];
  for (let current = path; ; current = dirname(current)) {
    const metadata = lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      invalid("task_directory");
    pins.push({ path: current, metadata });
    if (dirname(current) === current) return pins;
  }
}
function assertDirectoryPins(pins: readonly DirectoryPin[]): void {
  for (const pin of pins) {
    const current = lstatSync(pin.path);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== pin.metadata.dev ||
      current.ino !== pin.metadata.ino ||
      current.mode !== pin.metadata.mode ||
      current.uid !== pin.metadata.uid
    )
      invalid("task_directory_changed");
  }
}
