import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DESKTOP_INSTALLED_PLUGIN_ACTIVATION_MAX_BYTES,
  parseDesktopInstalledPluginActivationConfiguration,
} from "@crewon/contracts/plugins";
import {
  captureDesktopInstalledPluginRuntimeDirectory,
  captureDesktopInstalledPluginRuntimeDocument,
  desktopInstalledPluginAbsolutePath,
  desktopInstalledPluginInvalid as invalid,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";

const MAX_BYTES = DESKTOP_INSTALLED_PLUGIN_ACTIVATION_MAX_BYTES;

/** Storage owned by Main. The caller must have joined all consumers before close. */
export function createDesktopInstalledPluginActivationFiles(
  input: Readonly<{
    dataDirectory: string;
    configuration: unknown;
  }>,
) {
  const configuration = parseDesktopInstalledPluginActivationConfiguration(
    input.configuration,
  );
  const dataDirectory = desktopInstalledPluginAbsolutePath(input.dataDirectory);
  const ancestors =
    captureDesktopInstalledPluginRuntimeDirectory(dataDirectory);
  const parent = lstatSync(dataDirectory);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o777) !== 0o700
  )
    invalid("data_directory");
  const directory = mkdtempSync(
    join(dataDirectory, ".installed-plugin-activation-"),
  );
  chmodSync(directory, 0o700);
  const identity = lstatSync(directory);
  const path = join(directory, "activation.json");
  let file: ReturnType<
    typeof captureDesktopInstalledPluginRuntimeDocument
  > | null = null;
  let withdrawn = false;
  let closed = false;
  const assertDirectory = () => {
    ancestors.assertCurrent();
    const actualParent = lstatSync(dataDirectory);
    const actual = lstatSync(directory);
    if (
      actualParent.uid !== parent.uid ||
      (actualParent.mode & 0o777) !== 0o700 ||
      !actual.isDirectory() ||
      actual.isSymbolicLink() ||
      actual.dev !== identity.dev ||
      actual.ino !== identity.ino ||
      actual.uid !== identity.uid ||
      (actual.mode & 0o777) !== 0o700
    )
      invalid("activation_directory_changed");
  };
  const close = () => {
    withdrawn = true;
    if (closed) return;
    assertDirectory();
    const children = readdirSync(directory);
    if (file === null) {
      // An interrupted creation may only retire a still-empty directory.
      if (children.length !== 0)
        invalid("activation_directory_contents_changed");
    } else {
      if (children.length !== 1 || children[0] !== "activation.json")
        invalid("activation_directory_contents_changed");
      // The file snapshot remains usable after logical withdrawal. Never adopt a replacement.
      file.assertCurrent();
      assertDirectory();
      unlinkSync(path);
    }
    assertDirectory();
    rmdirSync(directory);
    closed = true;
  };
  try {
    const bytes = JSON.stringify(configuration);
    if (Buffer.byteLength(bytes) > MAX_BYTES) invalid("activation_limit");
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    file = captureDesktopInstalledPluginRuntimeDocument(path, MAX_BYTES);
    const assertCurrent = () => {
      if (withdrawn || closed) invalid("withdrawn");
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
        "desktop_installed_plugin_activation_creation_cleanup_failed",
      );
    }
    throw error;
  }
}
