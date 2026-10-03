import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseExtensionRecoveryProviderBinding } from "@crewon/agent-version/extension-recovery";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import {
  assertDesktopPluginBootstrapIssued,
  type DesktopPluginBootstrap,
} from "./desktopPluginBootstrap.ts";
import { createDesktopInstalledPluginPreparationFiles } from "./desktopInstalledPluginPreparationFiles.ts";

export const DESKTOP_INSTALLED_PLUGIN_RUNTIME_FILE =
  "desktop-installed-plugin-runtime.json";
export const DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA =
  "crewon.desktop-installed-plugin-runtime.v1";
export const DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA =
  "crewon.desktop-installed-plugin-runtime.v2";
const MAX_BYTES = 128 * 1024;
export const DESKTOP_INSTALLED_PLUGIN_AUTHORITY_NAMES = [
  "actorAuthority",
  "policyAuthority",
  "profileAuthority",
  "packageAuthority",
  "networkAuthority",
] as const;
export type DesktopInstalledPluginAuthorityEndpoint = Readonly<{
  url: string;
  serviceTokenEnvironmentVariable: string;
}>;
export type DesktopInstalledPluginWorkerAuthorities = Readonly<{
  actorAuthority: DesktopInstalledPluginAuthorityEndpoint;
  policyAuthority: DesktopInstalledPluginAuthorityEndpoint;
  profileAuthority: DesktopInstalledPluginAuthorityEndpoint;
  packageAuthority: DesktopInstalledPluginAuthorityEndpoint;
  networkAuthority: DesktopInstalledPluginAuthorityEndpoint | null;
  timeoutMs: number;
}>;
export type DesktopInstalledPluginPreparationSelection = Readonly<{
  pluginId: string;
  approvalRequirement: "none" | "perAction";
}>;

export type DesktopInstalledPluginProviderBinding = Readonly<{
  providerId: string;
  endpoint: string;
  responsesEndpoint: string;
  modelId: string;
  credentialRequired: boolean;
}>;
export type DesktopOperatorInstalledPluginRuntimeConfiguration =
  | Readonly<{
      schemaVersion: typeof DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA;
      enabled: false;
    }>
  | Readonly<{
      schemaVersion: typeof DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA;
      enabled: true;
      workerConfigurationPath: string;
      providerBinding: DesktopInstalledPluginProviderBinding;
    }>;
export type DesktopAutomaticInstalledPluginRuntimeConfiguration =
  | Readonly<{
      schemaVersion: typeof DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA;
      enabled: false;
    }>
  | Readonly<{
      schemaVersion: typeof DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA;
      enabled: true;
      providerBinding: DesktopInstalledPluginProviderBinding;
      plugins: readonly DesktopInstalledPluginPreparationSelection[];
      workerAuthorities: DesktopInstalledPluginWorkerAuthorities;
    }>;
export type DesktopInstalledPluginRuntimeConfiguration =
  | DesktopOperatorInstalledPluginRuntimeConfiguration
  | DesktopAutomaticInstalledPluginRuntimeConfiguration;
export type EnabledDesktopInstalledPluginRuntimeConfiguration = Extract<
  DesktopInstalledPluginRuntimeConfiguration,
  { enabled: true }
>;
export type EnabledDesktopAutomaticInstalledPluginRuntimeConfiguration =
  Extract<
    DesktopAutomaticInstalledPluginRuntimeConfiguration,
    { enabled: true }
  >;

type DirectoryPin = Readonly<{ path: string; metadata: Stats }>;
type FileSnapshot = Readonly<{
  bytes: Buffer;
  metadata: Stats;
  ancestors: readonly DirectoryPin[];
}>;
const issued = new WeakMap<
  EnabledDesktopInstalledPluginRuntimeConfiguration,
  Readonly<{ dataDirectory: string; assertCurrent(): void }>
>();

/** A fixed Native opt-in. An absent file does not inspect other paths or create anything. */
export function loadDesktopInstalledPluginRuntimeConfiguration(
  dataDirectory: string,
): DesktopInstalledPluginRuntimeConfiguration {
  const directory = desktopInstalledPluginAbsolutePath(dataDirectory);
  const path = join(directory, DESKTOP_INSTALLED_PLUGIN_RUNTIME_FILE);
  try {
    lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return Object.freeze({
        schemaVersion: DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
        enabled: false,
      });
    throw error;
  }
  const directoryMetadata = lstatSync(directory);
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    directoryMetadata.uid !== process.getuid?.() ||
    (directoryMetadata.mode & 0o777) !== 0o700
  )
    desktopInstalledPluginInvalid("data_directory");
  const file = captureDesktopInstalledPluginRuntimeDocument(path, MAX_BYTES);
  const configuration = parseDesktopInstalledPluginRuntimeConfiguration(
    file.value,
  );
  if (configuration.enabled)
    issued.set(configuration, {
      dataDirectory: directory,
      assertCurrent: file.assertCurrent,
    });
  return configuration;
}

/** Parsing alone cannot issue the Native file ownership proof used by the runtime. */
export function parseDesktopInstalledPluginRuntimeConfiguration(
  input: unknown,
): DesktopInstalledPluginRuntimeConfiguration {
  const value = desktopInstalledPluginRecord(input);
  const automatic =
    value.schemaVersion === DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA;
  desktopInstalledPluginExactKeys(
    value,
    value.enabled === false
      ? ["schemaVersion", "enabled"]
      : automatic
        ? [
            "schemaVersion",
            "enabled",
            "providerBinding",
            "plugins",
            "workerAuthorities",
          ]
        : [
            "schemaVersion",
            "enabled",
            "workerConfigurationPath",
            "providerBinding",
          ],
  );
  if (
    value.schemaVersion !== DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA &&
    !automatic
  )
    desktopInstalledPluginInvalid("configuration");
  if (value.enabled === false)
    return Object.freeze({
      schemaVersion: automatic
        ? DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA
        : DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
      enabled: false,
    });
  if (value.enabled !== true) desktopInstalledPluginInvalid("configuration");
  const provider = desktopInstalledPluginRecord(value.providerBinding);
  desktopInstalledPluginExactKeys(provider, [
    "providerId",
    "endpoint",
    "responsesEndpoint",
    "modelId",
    "credentialRequired",
  ]);
  const binding = parseExtensionRecoveryProviderBinding({
    providerId: provider.providerId,
    endpoint: provider.endpoint,
    responsesEndpoint: provider.responsesEndpoint,
    credentialRequired: provider.credentialRequired,
  });
  const modelId = desktopInstalledPluginText(provider.modelId, 256);
  const providerBinding = Object.freeze({ ...binding, modelId });
  if (automatic) {
    const plugins = ownDenseArray(value.plugins, 1, 32).map((input) => {
      const plugin = desktopInstalledPluginRecord(input);
      desktopInstalledPluginExactKeys(plugin, [
        "pluginId",
        "approvalRequirement",
      ]);
      const pluginId = desktopInstalledPluginText(plugin.pluginId, 48);
      if (
        !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u.test(pluginId) ||
        (plugin.approvalRequirement !== "none" &&
          plugin.approvalRequirement !== "perAction")
      )
        desktopInstalledPluginInvalid("plugin_selection");
      return Object.freeze({
        pluginId,
        approvalRequirement: plugin.approvalRequirement,
      });
    });
    if (
      new Set(plugins.map((plugin) => plugin.pluginId)).size !== plugins.length
    )
      desktopInstalledPluginInvalid("plugin_selection_duplicate");
    return Object.freeze({
      schemaVersion: DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
      enabled: true,
      providerBinding,
      plugins: Object.freeze(plugins),
      workerAuthorities: parseDesktopInstalledPluginWorkerAuthorities(
        value.workerAuthorities,
      ),
    });
  }
  return Object.freeze({
    schemaVersion: DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
    enabled: true,
    workerConfigurationPath: desktopInstalledPluginAbsolutePath(
      value.workerConfigurationPath,
    ),
    providerBinding,
  });
}

export function assertDesktopInstalledPluginRuntimeConfiguration(
  configuration: EnabledDesktopInstalledPluginRuntimeConfiguration,
  dataDirectory: string,
): void {
  const source = issued.get(configuration);
  if (!source || source.dataDirectory !== dataDirectory)
    desktopInstalledPluginInvalid("configuration_unissued");
  source.assertCurrent();
}

/** Only real v2/config+bootstrap owners can create this fixed, privately owned v1 preparation. */
export function createAutomaticDesktopInstalledPluginRuntimeFiles(
  input: Readonly<{
    configuration: EnabledDesktopAutomaticInstalledPluginRuntimeConfiguration;
    dataDirectory: string;
    bootstrap: DesktopPluginBootstrap;
  }>,
) {
  const { configuration, bootstrap } = input;
  const dataDirectory = desktopInstalledPluginAbsolutePath(input.dataDirectory);
  const assertCurrent = () => {
    assertDesktopInstalledPluginRuntimeConfiguration(
      configuration,
      dataDirectory,
    );
    const manifest = assertDesktopPluginBootstrapIssued(bootstrap);
    if (
      !isDeepStrictEqual(manifest.actor, DESKTOP_RUNTIME_OWNER) ||
      manifest.installRoot !== join(dataDirectory, "plugins")
    )
      desktopInstalledPluginInvalid("bootstrap");
    return manifest;
  };
  const manifest = assertCurrent();
  if (
    configuration.schemaVersion !==
    DESKTOP_AUTOMATIC_INSTALLED_PLUGIN_RUNTIME_SCHEMA
  )
    desktopInstalledPluginInvalid("configuration_mode");
  const approvedPackages = [
    ...new Map(
      manifest.sources.map(
        ({ pluginId, publisherId, version, packageDigest }) => {
          const identity = Object.freeze({
            pluginId,
            publisherId,
            version,
            packageDigest,
          });
          return [JSON.stringify(identity), identity] as const;
        },
      ),
    ).values(),
  ];
  if (
    approvedPackages.length === 0 ||
    configuration.plugins.some(
      (plugin) =>
        !approvedPackages.some(
          (identity) => identity.pluginId === plugin.pluginId,
        ),
    )
  )
    desktopInstalledPluginInvalid("package_unapproved");
  for (const plugin of configuration.plugins) {
    if (
      new Set(
        approvedPackages
          .filter((identity) => identity.pluginId === plugin.pluginId)
          .map((identity) => identity.publisherId),
      ).size !== 1
    )
      desktopInstalledPluginInvalid("package_publisher_ambiguous");
  }
  const files = createDesktopInstalledPluginPreparationFiles({
    dataDirectory,
    buildDocuments: ({ workerPath, releasePath }) => ({
      preparation: {
        schemaVersion: "crewon.installed-plugin-native-preparation.v1",
        actor: manifest.actor,
        scope: manifest.scope,
        approvedPackages,
        plugins: configuration.plugins,
        workerConfigurationPath: workerPath,
      },
      worker: {
        schemaVersion: "crewon.installed-plugin-worker.v1",
        installRoot: manifest.installRoot,
        releaseDocumentPath: releasePath,
        ...configuration.workerAuthorities,
        historicalScope: null,
      },
    }),
  });
  const derived = Object.freeze({
    schemaVersion: DESKTOP_INSTALLED_PLUGIN_RUNTIME_SCHEMA,
    enabled: true as const,
    workerConfigurationPath: files.workerPath,
    providerBinding: configuration.providerBinding,
  });
  issued.set(derived, {
    dataDirectory,
    assertCurrent() {
      assertCurrent();
      files.assertCurrent();
    },
  });
  try {
    assertCurrent();
    files.assertCurrent();
  } catch (error) {
    files.close();
    throw error;
  }
  return Object.freeze({ ...files, configuration: derived });
}

export function parseDesktopInstalledPluginWorkerAuthorities(
  input: unknown,
): DesktopInstalledPluginWorkerAuthorities {
  const value = desktopInstalledPluginRecord(input);
  desktopInstalledPluginExactKeys(value, [
    ...DESKTOP_INSTALLED_PLUGIN_AUTHORITY_NAMES,
    "timeoutMs",
  ]);
  if (
    !Number.isSafeInteger(value.timeoutMs) ||
    Number(value.timeoutMs) < 1 ||
    Number(value.timeoutMs) > 30_000
  )
    desktopInstalledPluginInvalid("worker_configuration");
  const endpoints = Object.fromEntries(
    DESKTOP_INSTALLED_PLUGIN_AUTHORITY_NAMES.map((name) => {
      if (name === "networkAuthority" && value[name] === null)
        return [name, null];
      const endpoint = desktopInstalledPluginRecord(value[name]);
      desktopInstalledPluginExactKeys(endpoint, [
        "url",
        "serviceTokenEnvironmentVariable",
      ]);
      const raw = desktopInstalledPluginText(endpoint.url, 2048);
      if (/[\s?#]/u.test(raw))
        desktopInstalledPluginInvalid("authority_endpoint");
      const url = new URL(raw);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        desktopInstalledPluginInvalid("authority_endpoint");
      const environmentVariable = desktopInstalledPluginText(
        endpoint.serviceTokenEnvironmentVariable,
        128,
      );
      if (
        !/^[A-Z][A-Z0-9_]{0,127}$/u.test(environmentVariable) ||
        reservedEnvironment(environmentVariable)
      )
        desktopInstalledPluginInvalid("authority_reference");
      return [
        name,
        Object.freeze({
          url: url.href,
          serviceTokenEnvironmentVariable: environmentVariable,
        }),
      ];
    }),
  );
  return Object.freeze({
    ...endpoints,
    timeoutMs: Number(value.timeoutMs),
  }) as DesktopInstalledPluginWorkerAuthorities;
}
export function desktopInstalledPluginAuthorityEndpoints(
  input: DesktopInstalledPluginWorkerAuthorities,
): readonly Readonly<{ url: string; environmentVariable: string }>[] {
  return Object.freeze(
    DESKTOP_INSTALLED_PLUGIN_AUTHORITY_NAMES.flatMap((name) => {
      const endpoint = input[name];
      return endpoint === null
        ? []
        : [
            Object.freeze({
              url: endpoint.url,
              environmentVariable: endpoint.serviceTokenEnvironmentVariable,
            }),
          ];
    }),
  );
}
function ownDenseArray(
  input: unknown,
  minimum: number,
  maximum: number,
): unknown[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length < minimum ||
    input.length > maximum ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    desktopInstalledPluginInvalid("array");
  const fields = Object.getOwnPropertyDescriptors(input);
  return Array.from({ length: input.length }, (_, index) => {
    const field = fields[String(index)];
    if (!field?.enumerable || !("value" in field))
      desktopInstalledPluginInvalid("array");
    return field.value;
  });
}
function reservedEnvironment(name: string): boolean {
  return (
    (name.startsWith("CREWON_") &&
      !name.startsWith("CREWON_INSTALLED_PLUGIN_AUTHORITY_")) ||
    /^(?:NODE_|ELECTRON_|DYLD_|LD_|XDG_|LC_|PNPM_|NPM_|VITE_)/u.test(name) ||
    [
      "PATH",
      "HOME",
      "SHELL",
      "USER",
      "LOGNAME",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "TZ",
      "PWD",
      "OLDPWD",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "CODEX_HOME",
    ].includes(name)
  );
}

/** Internal Main file capture; no worker implementation or plugin module is imported. */
export function captureDesktopInstalledPluginRuntimeDocument(
  input: string,
  maximum: number,
  privacy: "private" | "package" = "private",
): Readonly<{ value: unknown; assertCurrent(): void }> {
  const path = desktopInstalledPluginAbsolutePath(input);
  const snapshot = readFileSnapshot(path, maximum, privacy);
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes),
    );
  } catch {
    desktopInstalledPluginInvalid("json");
  }
  deepFreeze(value);
  return Object.freeze({
    value,
    assertCurrent() {
      assertDirectoryPins(snapshot.ancestors);
      const actual = readFileSnapshot(path, maximum, privacy);
      if (
        !sameStat(actual.metadata, snapshot.metadata) ||
        !actual.bytes.equals(snapshot.bytes)
      )
        desktopInstalledPluginInvalid("file_changed");
    },
  });
}

export function captureDesktopInstalledPluginRuntimeDirectory(
  input: string,
): Readonly<{ assertCurrent(): void }> {
  const pins = directoryPins(desktopInstalledPluginAbsolutePath(input));
  return Object.freeze({ assertCurrent: () => assertDirectoryPins(pins) });
}

/** Pins a declared package artifact without loading or executing its implementation. */
export function captureDesktopInstalledPluginRuntimeArtifact(
  input: string,
  expectedBytes: number,
): Readonly<{ assertCurrent(): void }> {
  const path = desktopInstalledPluginAbsolutePath(input);
  const ancestors = directoryPins(dirname(path));
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o022) !== 0 ||
    metadata.size !== expectedBytes
  )
    desktopInstalledPluginInvalid("package_file");
  return Object.freeze({
    assertCurrent() {
      assertDirectoryPins(ancestors);
      if (!sameStat(metadata, lstatSync(path)))
        desktopInstalledPluginInvalid("package_changed");
    },
  });
}

function readFileSnapshot(
  path: string,
  maximum: number,
  privacy: "private" | "package",
): FileSnapshot {
  const ancestors = directoryPins(dirname(path));
  const before = lstatSync(path);
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.uid !== uid ||
    (privacy === "private"
      ? (before.mode & 0o777) !== 0o600
      : (before.mode & 0o022) !== 0) ||
    before.size < 1 ||
    before.size > maximum
  )
    desktopInstalledPluginInvalid("file");
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = fstatSync(fd);
    if (!sameStat(before, opened))
      desktopInstalledPluginInvalid("file_changed");
    const bytes = Buffer.allocUnsafe(maximum + 1);
    let count = 0;
    while (count < bytes.byteLength) {
      const read = readSync(fd, bytes, count, bytes.byteLength - count, null);
      if (read === 0) break;
      count += read;
    }
    if (
      count !== before.size ||
      count > maximum ||
      !sameStat(opened, fstatSync(fd)) ||
      !sameStat(before, lstatSync(path))
    )
      desktopInstalledPluginInvalid("file_changed");
    assertDirectoryPins(ancestors);
    return { bytes: bytes.subarray(0, count), metadata: before, ancestors };
  } finally {
    closeSync(fd);
  }
}

function directoryPins(path: string): readonly DirectoryPin[] {
  const pins: DirectoryPin[] = [];
  for (let current = path; ; current = dirname(current)) {
    const metadata = lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      desktopInstalledPluginInvalid("directory");
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
      current.ino !== pin.metadata.ino
    )
      desktopInstalledPluginInvalid("directory_changed");
  }
}
function sameStat(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.uid === b.uid &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
function deepFreeze(value: unknown): void {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
}
export function desktopInstalledPluginRecord(
  input: unknown,
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    desktopInstalledPluginInvalid("shape");
  const fields = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).length !== Object.keys(fields).length ||
    Object.values(fields).some(
      (field) => !field.enumerable || !("value" in field),
    )
  )
    desktopInstalledPluginInvalid("shape");
  return Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, field.value]),
  );
}
export function desktopInstalledPluginExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    desktopInstalledPluginInvalid("shape");
}
export function desktopInstalledPluginAbsolutePath(input: unknown): string {
  if (
    typeof input !== "string" ||
    !isAbsolute(input) ||
    resolve(input) !== input ||
    input.trim() !== input ||
    Buffer.byteLength(input) > 4096 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(input)
  )
    desktopInstalledPluginInvalid("path");
  return input;
}
export function desktopInstalledPluginText(
  input: unknown,
  maximum: number,
): string {
  if (
    typeof input !== "string" ||
    !input ||
    input.trim() !== input ||
    Buffer.byteLength(input) > maximum ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(input)
  )
    desktopInstalledPluginInvalid("text");
  return input;
}
export function desktopInstalledPluginInvalid(reason: string): never {
  throw new Error(`desktop_installed_plugin_runtime_${reason}_invalid`);
}
