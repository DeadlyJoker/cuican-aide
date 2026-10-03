import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import {
  DESKTOP_PLUGIN_APPROVAL_FILE,
  DESKTOP_PLUGIN_APPROVAL_SCHEMA,
} from "./desktopPluginBootstrap.ts";

export function desktopPluginBootstrapFixture() {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "crewon-native-plugin-bootstrap-")),
  );
  chmodSync(directory, 0o700);
  const dataDirectory = join(directory, "data");
  mkdirSync(dataDirectory, { mode: 0o700 });
  const sourceDirectory = join(directory, "approved-source");
  mkdirSync(sourceDirectory, { mode: 0o700 });
  const source = {
    sourceId: "approved-short-drama-v1",
    directory: sourceDirectory,
    pluginId: "example.short-drama",
    publisherId: "example.publisher",
    version: "1.0.0",
    packageDigest: `sha256:${"a".repeat(64)}`,
  };
  const publication = {
    pluginId: source.pluginId,
    publisherId: source.publisherId,
    packageDigest: source.packageDigest,
    publicAssets: ["ui/entry.mjs", "assets/cover.png"],
  };
  const approval = {
    schemaVersion: DESKTOP_PLUGIN_APPROVAL_SCHEMA,
    sources: [source],
    publications: [publication],
  };
  const approvalPath = join(dataDirectory, DESKTOP_PLUGIN_APPROVAL_FILE);
  function writeApproval(value: unknown = approval) {
    writeFileSync(approvalPath, JSON.stringify(value), { mode: 0o600 });
    chmodSync(approvalPath, 0o600);
  }
  return {
    directory,
    dataDirectory,
    source,
    publication,
    approval,
    approvalPath,
    writeApproval,
    input: {
      dataDirectory,
      actor: DESKTOP_RUNTIME_OWNER,
      sessionEntropy: `${"session-canary-not-persisted-".repeat(2)}:7`,
    },
    read(path: string) {
      return JSON.parse(readFileSync(path, "utf8"));
    },
  };
}
