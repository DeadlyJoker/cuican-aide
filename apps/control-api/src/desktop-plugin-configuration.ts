import { checkNativeOwnershipFile } from "./desktop-native-ownership-check.ts";
import {
  captureProjectFoundationStartupConfiguration,
  type ProjectFoundationStartupConfiguration,
} from "./project-foundation-composition.ts";
import { assertCreativeProjectPluginPublications } from "./creative-project-plugin-ui-composition.ts";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { BigIntStats } from "node:fs";
import type { ActorContext } from "@crewon/application";
import {
  parsePluginSourceView,
  parsePluginControlAssetPath,
  parseDesktopProjectHistoryConfiguration,
  type DesktopProjectHistoryConfiguration,
} from "@crewon/contracts";
import {
  parseDesktopProjectExecutionConfiguration,
  type DesktopProjectExecutionConfiguration,
} from "@crewon/contracts/plugins";
import {
  parsePluginProfileScope,
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
  type PluginProfileScope,
} from "@crewon/domain";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";

export type DesktopPluginSource = Readonly<{
  sourceId: string;
  directory: string;
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
}>;
export type DesktopPluginPublication = Readonly<{
  pluginId: string;
  publisherId: string;
  packageDigest: string;
  publicAssets: readonly string[];
}>;
/** Native-owned local-device authority, never a cloud account or a renderer profile selector. */
type DesktopPluginConfigurationBase = Readonly<{
  actor: ActorContext;
  scope: PluginProfileScope;
  authorityEpoch: string;
  installRoot: string;
  sources: readonly DesktopPluginSource[];
  publications: readonly DesktopPluginPublication[];
}>;
export type DesktopPluginConfiguration = DesktopPluginConfigurationBase &
  (
    | Readonly<{ schemaVersion: "crewon.desktop-plugin-bootstrap.v1" }>
    | Readonly<{
        schemaVersion: "crewon.desktop-plugin-bootstrap.v2";
        projects: DesktopProjectHistoryConfiguration;
      }>
    | Readonly<{
        schemaVersion: "crewon.desktop-plugin-bootstrap.v3";
        projects: DesktopProjectExecutionConfiguration;
        /** Explicit new host capability; legacy project/history DTOs retain their exact shape. */
        projectFoundation?: ProjectFoundationStartupConfiguration;
      }>
  );
const parsed = new WeakSet<object>();
const fileIssued = new WeakMap<
  DesktopPluginConfiguration,
  Readonly<{
    filename: string;
    leaf: BigIntStats;
    bytes: Buffer;
    directories: readonly Readonly<{ path: string; stat: BigIntStats }>[];
  }>
>();
const MAX_BYTES = 256 * 1024;

export function parseDesktopPluginConfiguration(
  input: unknown,
): DesktopPluginConfiguration {
  if (input !== null && typeof input === "object" && parsed.has(input))
    return input as DesktopPluginConfiguration;
  try {
    const schema =
      input !== null && typeof input === "object"
        ? Object.getOwnPropertyDescriptor(input, "schemaVersion")
        : undefined;
    if (!schema?.enumerable || !Object.hasOwn(schema, "value")) invalid();
    const v2 = schema.value === "crewon.desktop-plugin-bootstrap.v2";
    const v3 = schema.value === "crewon.desktop-plugin-bootstrap.v3";
    const hasFoundation =
      v3 && Object.hasOwn(input as object, "projectFoundation");
    const value = pluginSecurityRecord(input, [
      "schemaVersion",
      "actor",
      "scope",
      "authorityEpoch",
      "installRoot",
      "sources",
      "publications",
      ...(v2 || v3 ? ["projects"] : []),
      ...(hasFoundation ? ["projectFoundation"] : []),
    ]);
    if (
      (!v2 &&
        !v3 &&
        value.schemaVersion !== "crewon.desktop-plugin-bootstrap.v1") ||
      typeof value.authorityEpoch !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/u.test(value.authorityEpoch)
    )
      invalid();
    const actor = pluginSecurityActor(value.actor);
    const scope = parsePluginProfileScope(value.scope);
    if (scope.tenantId !== actor.tenantId || scope.spaceId !== actor.spaceId)
      invalid();
    const sources = dense(value.sources, 32).map((item) => {
      const source = pluginSecurityRecord(item, [
        "sourceId",
        "directory",
        "pluginId",
        "publisherId",
        "version",
        "packageDigest",
      ]);
      const view = parsePluginSourceView({
        sourceId: source.sourceId,
        pluginId: source.pluginId,
        publisherId: source.publisherId,
        version: source.version,
        packageDigest: source.packageDigest,
        title: "Approved source",
        description: "Native approved local package",
      });
      return Object.freeze({
        sourceId: view.sourceId,
        directory: desktopPluginPrivatePath(source.directory),
        pluginId: view.pluginId,
        publisherId: view.publisherId,
        version: view.version,
        packageDigest: view.packageDigest,
      });
    });
    const ids = new Set<string>();
    const directories = new Set<string>();
    const digests = new Set<string>();
    const versions = new Set<string>();
    const publishers = new Map<string, string>();
    for (const source of sources) {
      const version = JSON.stringify([source.pluginId, source.version]);
      if (
        ids.has(source.sourceId) ||
        directories.has(source.directory) ||
        digests.has(source.packageDigest) ||
        versions.has(version) ||
        (publishers.has(source.pluginId) &&
          publishers.get(source.pluginId) !== source.publisherId)
      )
        invalid();
      ids.add(source.sourceId);
      directories.add(source.directory);
      digests.add(source.packageDigest);
      versions.add(version);
      publishers.set(source.pluginId, source.publisherId);
    }
    const publications = dense(value.publications, 32).map((item) => {
      const publication = pluginSecurityRecord(item, [
        "pluginId",
        "publisherId",
        "packageDigest",
        "publicAssets",
      ]);
      const publicAssets = dense(publication.publicAssets, 256).map(
        parsePluginControlAssetPath,
      );
      if (
        publicAssets.length === 0 ||
        new Set(publicAssets).size !== publicAssets.length
      )
        invalid();
      const result = Object.freeze({
        pluginId: pluginInstallationNamespaceId(publication.pluginId),
        publisherId: pluginInstallationNamespaceId(publication.publisherId),
        packageDigest: pluginInstallationDigest(publication.packageDigest),
        publicAssets: Object.freeze(publicAssets),
      });
      if (
        !sources.some(
          (source) =>
            source.pluginId === result.pluginId &&
            source.publisherId === result.publisherId &&
            source.packageDigest === result.packageDigest,
        )
      )
        invalid();
      return result;
    });
    if (
      new Set(publications.map((item) => item.packageDigest)).size !==
      publications.length
    )
      invalid();
    const common = {
      actor,
      scope,
      authorityEpoch: value.authorityEpoch as string,
      installRoot: desktopPluginPrivatePath(value.installRoot),
      sources: Object.freeze(sources),
      publications: Object.freeze(publications),
    };
    const foundation = hasFoundation
      ? captureProjectFoundationStartupConfiguration(value.projectFoundation)
      : undefined;
    if (hasFoundation && foundation === undefined) invalid();
    if (foundation !== undefined) {
      assertCreativeProjectPluginPublications(
        foundation.pluginUi,
        publications,
      );
      assertCreativeProjectPluginPublications(
        foundation.uploads.pluginUi,
        publications,
      );
    }
    const configuration = Object.freeze(
      v3
        ? {
            schemaVersion: "crewon.desktop-plugin-bootstrap.v3" as const,
            ...common,
            projects: parseDesktopProjectExecutionConfiguration(
              value.projects,
              {
                publications,
              },
            ),
            ...(foundation === undefined
              ? {}
              : { projectFoundation: foundation }),
          }
        : v2
          ? {
              schemaVersion: "crewon.desktop-plugin-bootstrap.v2" as const,
              ...common,
              projects: parseDesktopProjectHistoryConfiguration(
                value.projects,
                {
                  publications,
                },
              ),
            }
          : {
              schemaVersion: "crewon.desktop-plugin-bootstrap.v1" as const,
              ...common,
            },
    );
    if (Buffer.byteLength(JSON.stringify(configuration)) > MAX_BYTES) invalid();
    parsed.add(configuration);
    return configuration;
  } catch {
    invalid();
  }
}

/** Only a native-created private bootstrap file is accepted; no ambient JSON or client path authority. */
export async function loadDesktopPluginConfiguration(
  path: string,
  input: Readonly<{ actor: ActorContext }>,
): Promise<DesktopPluginConfiguration> {
  const actor = pluginSecurityActor(input.actor);
  const filename = desktopPluginPrivatePath(path);
  const paths = await captureBootstrapPath(filename);
  const file = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.dev !== paths[0]!.stat.dev ||
      before.ino !== paths[0]!.stat.ino ||
      typeof process.getuid !== "function" ||
      before.uid !== BigInt(process.getuid()) ||
      (before.mode & 0o077n) !== 0n ||
      before.size > BigInt(MAX_BYTES)
    )
      invalid();
    const bytes = new Uint8Array(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      length !== Number(before.size) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      after.nlink !== 1n
    )
      invalid();
    const configuration = parseDesktopPluginConfiguration(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, length),
        ),
      ),
    );
    if (JSON.stringify(actor) !== JSON.stringify(configuration.actor))
      invalid();
    for (const pinned of paths) {
      const current = await lstat(pinned.path, { bigint: true });
      if (
        current.isSymbolicLink() ||
        current.dev !== pinned.stat.dev ||
        current.ino !== pinned.stat.ino ||
        current.mode !== pinned.stat.mode ||
        current.uid !== pinned.stat.uid ||
        (pinned.path === filename && current.nlink !== 1n)
      )
        invalid();
    }
    fileIssued.set(
      configuration,
      Object.freeze({
        filename,
        leaf: after,
        bytes: Buffer.from(bytes.subarray(0, length)),
        directories: Object.freeze(paths.slice(1)),
      }),
    );
    return configuration;
  } finally {
    await file.close();
  }
}

/** Only the original private-file load can authorize the new Native execution startup. */
export function assertDesktopPluginConfigurationFileCurrent(
  value: DesktopPluginConfiguration,
): void {
  checkNativeOwnershipFile(value, () => {
    try {
      const issued = fileIssued.get(value);
      if (issued === undefined) invalid();
      const directories = () => {
        for (const pin of issued.directories) {
          const current = lstatSync(pin.path, { bigint: true });
          if (
            !current.isDirectory() ||
            current.isSymbolicLink() ||
            current.dev !== pin.stat.dev ||
            current.ino !== pin.stat.ino ||
            current.mode !== pin.stat.mode ||
            current.uid !== pin.stat.uid
          )
            invalid();
        }
      };
      directories();
      const before = lstatSync(issued.filename, { bigint: true });
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        !sameLeaf(before, issued.leaf)
      )
        invalid();
      const fd = openSync(
        issued.filename,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        if (!sameLeaf(fstatSync(fd, { bigint: true }), issued.leaf)) invalid();
        const storage = Buffer.allocUnsafe(MAX_BYTES + 1);
        let length = 0;
        while (length < storage.length) {
          const count = readSync(
            fd,
            storage,
            length,
            storage.length - length,
            null,
          );
          if (count === 0) break;
          length += count;
        }
        if (
          length !== Number(issued.leaf.size) ||
          !storage.subarray(0, length).equals(issued.bytes) ||
          !sameLeaf(fstatSync(fd, { bigint: true }), issued.leaf) ||
          !sameLeaf(lstatSync(issued.filename, { bigint: true }), issued.leaf)
        )
          invalid();
        directories();
      } finally {
        closeSync(fd);
      }
    } catch {
      invalid();
    }
  });
}
function sameLeaf(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.nlink === 1n &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

/** Pin the actual leaf and ancestors before opening, then recheck after the bounded read. */
async function captureBootstrapPath(
  path: string,
): Promise<readonly Readonly<{ path: string; stat: BigIntStats }>[]> {
  const pins: { path: string; stat: BigIntStats }[] = [];
  let current = path;
  while (true) {
    const stat = await lstat(current, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      (pins.length === 0
        ? !stat.isFile() || stat.nlink !== 1n
        : !stat.isDirectory())
    )
      invalid();
    if (
      pins.length <= 1 &&
      (typeof process.getuid !== "function" ||
        stat.uid !== BigInt(process.getuid()) ||
        (stat.mode & 0o077n) !== 0n)
    )
      invalid();
    pins.push({ path: current, stat });
    const parent = dirname(current);
    if (parent === current) return pins;
    current = parent;
  }
}
export function desktopPluginPrivatePath(input: unknown): string {
  if (
    typeof input !== "string" ||
    !isAbsolute(input) ||
    resolve(input) !== input ||
    input.trim() !== input ||
    Buffer.byteLength(input) > 4096 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input)
  )
    invalid();
  for (const point of input) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) invalid();
  }
  return input;
}
function dense(input: unknown, limit: number): readonly unknown[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > limit ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    invalid();
  return Array.from({ length: input.length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(input, String(index));
    if (!item?.enumerable || !("value" in item)) invalid();
    return item.value;
  });
}
function invalid(): never {
  throw new Error("desktop_plugin_configuration_invalid");
}
