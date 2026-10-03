import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  captureDesktopInstalledPluginRuntimeDirectory,
  captureDesktopInstalledPluginRuntimeDocument,
  desktopInstalledPluginAbsolutePath,
  desktopInstalledPluginInvalid as invalid,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";

const PREFIX = ".installed-plugin-preparation-";
const MAX_BYTES = 128 * 1024;

/** Storage only: creation cannot issue a configuration, approve a package or grant execution. */
export function createDesktopInstalledPluginPreparationFiles(
  input: Readonly<{
    dataDirectory: string;
    buildDocuments(
      paths: Readonly<{ workerPath: string; releasePath: string }>,
    ): Readonly<{ preparation: unknown; worker: unknown }>;
  }>,
) {
  const dataDirectory = desktopInstalledPluginAbsolutePath(input.dataDirectory);
  const ancestors =
    captureDesktopInstalledPluginRuntimeDirectory(dataDirectory);
  const parent = lstatSync(dataDirectory);
  if (parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700)
    invalid("data_directory");
  const directory = mkdtempSync(join(dataDirectory, PREFIX));
  chmodSync(directory, 0o700);
  const identity = lstatSync(directory);
  let withdrawn = false;
  let closed = false;
  const assertDirectory = () => {
    ancestors.assertCurrent();
    const actualParent = lstatSync(dataDirectory);
    if (
      actualParent.uid !== parent.uid ||
      (actualParent.mode & 0o777) !== 0o700
    )
      invalid("data_directory");
    const actual = lstatSync(directory);
    if (
      !actual.isDirectory() ||
      actual.isSymbolicLink() ||
      actual.dev !== identity.dev ||
      actual.ino !== identity.ino ||
      actual.uid !== identity.uid ||
      (actual.mode & 0o777) !== 0o700
    )
      invalid("preparation_directory_changed");
  };
  const close = () => {
    withdrawn = true;
    if (closed) return;
    assertDirectory();
    rmSync(directory, { recursive: true });
    closed = true;
  };
  try {
    const preparationPath = join(directory, "preparation.json");
    const workerPath = join(directory, "worker.json");
    const releasePath = join(directory, "release.json");
    const resultPath = join(directory, "preparation-result.json");
    const documents = input.buildDocuments({ workerPath, releasePath });
    for (const [path, value] of [
      [preparationPath, documents.preparation],
      [workerPath, documents.worker],
    ] as const) {
      const bytes = JSON.stringify(value);
      if (Buffer.byteLength(bytes) > MAX_BYTES) invalid("preparation_limit");
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    }
    const preparation = captureDesktopInstalledPluginRuntimeDocument(
      preparationPath,
      MAX_BYTES,
    );
    const worker = captureDesktopInstalledPluginRuntimeDocument(
      workerPath,
      MAX_BYTES,
    );
    const assertCurrent = () => {
      if (withdrawn || closed) invalid("withdrawn");
      assertDirectory();
      preparation.assertCurrent();
      worker.assertCurrent();
    };
    assertCurrent();
    return Object.freeze({
      directory,
      preparationPath,
      workerPath,
      releasePath,
      resultPath,
      assertReleaseAbsent() {
        assertCurrent();
        try {
          lstatSync(releasePath);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return;
          throw error;
        }
        invalid("preparation_unexpected_release");
      },
      assertCurrent,
      withdraw() {
        withdrawn = true;
      },
      close,
    });
  } catch (error) {
    close();
    throw error;
  }
}
