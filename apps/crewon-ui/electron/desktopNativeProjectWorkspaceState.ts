import { lstatSync, type Stats } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readSqliteNativeProjectWorkspaceState } from "@crewon/store/host-project-workspaces";
import { parsePluginProjectWorkspaceOwner } from "@crewon/domain";
import type { DesktopNativePluginPackageIdentity } from "@crewon/contracts/plugins";
import { captureDesktopNativePluginAuthorityOwner } from "./desktopNativePluginAuthority.ts";
import { exactRecord } from "./localWorkspaceProjectAllocationJournal.ts";

export type DesktopNativeProjectWorkspaceState = Readonly<{
  version: "crewon.desktop-native-project-workspace-state.v1";
}>;
type Source = Readonly<{
  nativeAuthority: unknown;
  owner: ReturnType<typeof parsePluginProjectWorkspaceOwner>;
  packageIdentity: DesktopNativePluginPackageIdentity;
  assertCurrent(): void;
}>;
const sources = new WeakMap<object, Source>();

/** Main-only persistent qualification. The actual Control UI/write qualification remains independently required. */
export function captureDesktopNativeProjectWorkspaceState(
  input: Readonly<{
    nativeAuthority: unknown;
    projectId: string;
    packageIdentity: DesktopNativePluginPackageIdentity;
  }>,
): DesktopNativeProjectWorkspaceState {
  const fields = exactRecord(input, [
    "nativeAuthority",
    "projectId",
    "packageIdentity",
  ]);
  const nativeAuthority = fields.nativeAuthority;
  const pin = captureDesktopNativePluginAuthorityOwner(nativeAuthority);
  const identity = exactRecord(fields.packageIdentity, [
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
  ]);
  const pkg = pin.packages.find((pkg) =>
    (["pluginId", "publisherId", "version", "packageDigest"] as const).every(
      (key) => pkg[key] === identity[key],
    ),
  );
  if (!pkg || pkg.approvalRequirement !== "none") invalid();
  const packageIdentity = Object.freeze({
    pluginId: pkg.pluginId,
    publisherId: pkg.publisherId,
    version: pkg.version,
    packageDigest: pkg.packageDigest,
  });
  const owner = parsePluginProjectWorkspaceOwner({
    ...pin.authority.actor,
    profileId: pin.authority.scope.profileId,
    pluginId: pkg.pluginId,
    publisherId: pkg.publisherId,
    projectId: fields.projectId,
  });
  const path = pin.authority.controlDatabasePath;
  const stat = databaseIdentity(path);
  const read = () => {
    pin.assertCurrent();
    databaseIdentity(path, stat);
    const db = new DatabaseSync(path, {
      readOnly: true,
      allowExtension: false,
    });
    try {
      db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN",
      );
      databaseIdentity(path, stat);
      const result = readSqliteNativeProjectWorkspaceState({
        database: db,
        owner,
        packageIdentity,
      });
      databaseIdentity(path, stat);
      pin.assertCurrent();
      db.exec("ROLLBACK");
      return result;
    } finally {
      db.close();
    }
  };
  const snapshot = read(),
    expiresAt = Date.now() + 5000;
  const assertCurrent = () => {
    if (
      Date.now() >= expiresAt ||
      captureDesktopNativePluginAuthorityOwner(nativeAuthority) !== pin
    )
      invalid();
    if (
      read().selectionRevision !== snapshot.selectionRevision ||
      Date.now() >= expiresAt
    )
      invalid();
  };
  const reference = Object.freeze({
    version: "crewon.desktop-native-project-workspace-state.v1" as const,
  });
  sources.set(
    reference,
    Object.freeze({ nativeAuthority, owner, packageIdentity, assertCurrent }),
  );
  return reference;
}
export function qualifyDesktopNativeProjectWorkspaceState(
  reference: DesktopNativeProjectWorkspaceState,
) {
  const source =
    reference !== null && typeof reference === "object"
      ? sources.get(reference)
      : undefined;
  if (!source) invalid();
  source.assertCurrent();
  return source;
}
function databaseIdentity(path: string, expected?: Stats): Stats {
  const actual = lstatSync(path);
  if (
    !actual.isFile() ||
    actual.isSymbolicLink() ||
    actual.nlink !== 1 ||
    actual.uid !== process.getuid?.() ||
    (expected &&
      ["dev", "ino", "mode", "uid"].some(
        (key) => actual[key as keyof Stats] !== expected[key as keyof Stats],
      ))
  )
    invalid();
  return actual;
}
function invalid(): never {
  throw new Error("desktop_native_project_workspace_state_unavailable");
}
