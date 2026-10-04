import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  openSync,
  fsyncSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  parseDesktopNativePluginAuthority,
  type DesktopNativePluginAuthority,
  type DesktopNativePluginNetworkGrant,
} from "@crewon/contracts/plugins";
import {
  assertDesktopPluginBootstrapIssued,
  type DesktopPluginBootstrap,
} from "./desktopPluginBootstrap.ts";
import {
  captureDesktopInstalledPluginRuntimeDocument as capture,
  captureDesktopInstalledPluginRuntimeDirectory,
  desktopInstalledPluginExactKeys,
  desktopInstalledPluginRecord,
  desktopInstalledPluginInvalid as invalid,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";

export const DESKTOP_NATIVE_PLUGIN_POLICY_FILE = "plugin-native-policy.json";
export type NativePluginPolicy = Readonly<{
  policyPath: string;
  policyDigest: string;
  packages: readonly Readonly<{
    pluginId: string;
    publisherId: string;
    version: string;
    packageDigest: string;
    approvalRequirement: "none" | "perAction";
  }>[];
  networkGrants: readonly DesktopNativePluginNetworkGrant[];
  assertCurrent(): void;
}>;
const hash = (bytes: Buffer) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
/** Only the host's explicit fixed private policy grants execution. Plugin discovery cannot supply it. */
export function captureDesktopNativePluginPolicy(
  dataDirectory: string,
  bootstrap: DesktopPluginBootstrap,
): NativePluginPolicy | null {
  const path = join(dataDirectory, DESKTOP_NATIVE_PLUGIN_POLICY_FILE);
  try {
    lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
  const snapshot = capture(path, 128 * 1024),
    value = desktopInstalledPluginRecord(snapshot.value);
  desktopInstalledPluginExactKeys(value, [
    "schemaVersion",
    "packages",
    "networkGrants",
  ]);
  if (
    value.schemaVersion !== "crewon.desktop-native-plugin-policy.v1" ||
    !Array.isArray(value.packages) ||
    value.packages.length < 1 ||
    value.packages.length > 32
  )
    invalid("native_policy");
  const packages = value.packages.map((raw) => {
    const pkg = desktopInstalledPluginRecord(raw);
    desktopInstalledPluginExactKeys(pkg, [
      "pluginId",
      "publisherId",
      "version",
      "packageDigest",
      "approvalRequirement",
    ]);
    if (
      pkg.approvalRequirement !== "none" &&
      pkg.approvalRequirement !== "perAction"
    )
      invalid("native_policy");
    return Object.freeze(pkg) as NativePluginPolicy["packages"][number];
  });
  const manifest = assertDesktopPluginBootstrapIssued(bootstrap);
  for (const pkg of packages)
    if (
      !manifest.sources.some((source) =>
        ["pluginId", "publisherId", "version", "packageDigest"].every(
          (field) =>
            source[field as keyof typeof source] ===
            pkg[field as keyof typeof pkg],
        ),
      )
    )
      invalid("native_package_unapproved");
  // Reuse the bounded public identity/network parser; a parsed policy alone issues no Native owner.
  const proof = parseDesktopNativePluginAuthority({
    schemaVersion: "crewon.desktop-native-plugin-authority.v1",
    authorityId: "policy-validation",
    actor: manifest.actor,
    scope: manifest.scope,
    installRoot: manifest.installRoot,
    controlDatabasePath: join(dataDirectory, "control.sqlite"),
    bootstrapPath: bootstrap.bootstrapPath,
    bootstrapDigest: `sha256:${"0".repeat(64)}`,
    approvalPath: join(dataDirectory, "plugin-approvals.json"),
    approvalDigest: `sha256:${"0".repeat(64)}`,
    profilePath: join(dataDirectory, "plugin-profile.json"),
    profileDigest: `sha256:${"0".repeat(64)}`,
    policyPath: path,
    policyDigest: hash(readFileSync(path)),
    packages: packages.map(({ approvalRequirement: _unused, ...pkg }) => pkg),
    networkGrants: value.networkGrants,
  });
  const assertCurrent = () => {
    snapshot.assertCurrent();
    if (assertDesktopPluginBootstrapIssued(bootstrap) !== manifest)
      invalid("bootstrap_changed");
  };
  assertCurrent();
  return Object.freeze({
    policyPath: path,
    policyDigest: hash(readFileSync(path)),
    packages: Object.freeze(packages),
    networkGrants: proof.networkGrants,
    assertCurrent,
  });
}

/** Private Main-issued authority, withdrawn before children terminate and cleaned only after their join. */
export function createDesktopNativePluginAuthority(
  input: Readonly<{
    dataDirectory: string;
    bootstrap: DesktopPluginBootstrap;
    policy: NativePluginPolicy;
  }>,
) {
  const { dataDirectory, bootstrap, policy } = input;
  const manifest = assertDesktopPluginBootstrapIssued(bootstrap);
  policy.assertCurrent();
  const parent = captureDesktopInstalledPluginRuntimeDirectory(dataDirectory);
  const stat = lstatSync(dataDirectory);
  if (
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    manifest.installRoot !== join(dataDirectory, "plugins")
  )
    invalid("data_directory");
  const pins = [
    bootstrap.bootstrapPath,
    join(dataDirectory, "plugin-approvals.json"),
    join(dataDirectory, "plugin-profile.json"),
  ].map((path) => {
    const file = capture(path, 128 * 1024);
    const digest = hash(readFileSync(path));
    file.assertCurrent();
    return { path, digest, file };
  });
  const directory = mkdtempSync(
    join(dataDirectory, ".native-plugin-authority-"),
  );
  chmodSync(directory, 0o700);
  const dirPin = captureDesktopInstalledPluginRuntimeDirectory(directory);
  const path = join(directory, "authority.json");
  const withdrawalPath = join(directory, "withdrawn.json");
  let withdrawalFile: ReturnType<typeof capture> | null = null;
  let withdrawalError: unknown;
  let withdrawn = false,
    closed = false;
  const authority = parseDesktopNativePluginAuthority({
    schemaVersion: "crewon.desktop-native-plugin-authority.v1",
    authorityId: `native-${randomBytes(32).toString("hex")}`,
    actor: manifest.actor,
    scope: manifest.scope,
    installRoot: manifest.installRoot,
    controlDatabasePath: join(dataDirectory, "control.sqlite"),
    bootstrapPath: pins[0]!.path,
    bootstrapDigest: pins[0]!.digest,
    approvalPath: pins[1]!.path,
    approvalDigest: pins[1]!.digest,
    profilePath: pins[2]!.path,
    profileDigest: pins[2]!.digest,
    policyPath: policy.policyPath,
    policyDigest: policy.policyDigest,
    packages: policy.packages.map(
      ({ approvalRequirement: _unused, ...pkg }) => pkg,
    ),
    networkGrants: policy.networkGrants,
  });
  writeFileSync(path, JSON.stringify(authority), { mode: 0o600, flag: "wx" });
  const file = capture(path, 128 * 1024);
  const assertPins = () => {
    parent.assertCurrent();
    dirPin.assertCurrent();
    file.assertCurrent();
    policy.assertCurrent();
    for (const pin of pins) pin.file.assertCurrent();
    if (assertDesktopPluginBootstrapIssued(bootstrap) !== manifest)
      invalid("bootstrap_changed");
  };
  const assertCurrent = () => {
    if (withdrawn || closed) invalid("withdrawn");
    assertPins();
    try {
      lstatSync(withdrawalPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }
    invalid("withdrawn");
  };
  const withdraw = () => {
    if (withdrawn || closed) return;
    withdrawn = true;
    // Logical revocation cannot block the supervisor from terminating children.
    try {
      parent.assertCurrent();
      dirPin.assertCurrent();
      file.assertCurrent();
      const fd = openSync(withdrawalPath, "wx", 0o600);
      try {
        writeFileSync(
          fd,
          JSON.stringify({
            schemaVersion: "crewon.desktop-native-plugin-withdrawal.v1",
            authorityId: authority.authorityId,
          }),
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      withdrawalFile = capture(withdrawalPath, 16 * 1024);
    } catch (error) {
      withdrawalError = error;
    }
  };
  assertCurrent();
  return Object.freeze({
    path,
    authority: authority as DesktopNativePluginAuthority,
    assertCurrent,
    withdraw,
    close() {
      withdraw();
      if (closed) return;
      parent.assertCurrent();
      dirPin.assertCurrent();
      file.assertCurrent();
      if (withdrawalError !== undefined) throw withdrawalError;
      withdrawalFile?.assertCurrent();
      if (
        !isDeepStrictEqual(readdirSync(directory).sort(), [
          "authority.json",
          ...(withdrawalFile === null ? [] : ["withdrawn.json"]),
        ])
      )
        invalid("native_directory_contents_changed");
      if (withdrawalFile !== null) unlinkSync(withdrawalPath);
      unlinkSync(path);
      rmdirSync(directory);
      closed = true;
    },
  });
}
