import { extensionOpaqueId, parsePluginProfileScope } from "@crewon/domain";
import {
  captureDesktopInstalledPluginRuntimeDocument,
  desktopInstalledPluginAbsolutePath,
  desktopInstalledPluginExactKeys,
  desktopInstalledPluginRecord,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";

export const DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV =
  "CREWON_PLUGIN_CREDIT_SETTLEMENT_CONFIG_PATH";
const SCHEMA = "crewon.plugin-credit-settlement-worker.v1";
const LIMIT = 64 * 1024;
type Role = Readonly<{ role: "shared" | "worker" }>;
export type DesktopPluginCreditSettlementEnvironment = Readonly<{
  project(environment: NodeJS.ProcessEnv, target: Role): NodeJS.ProcessEnv;
  assertCurrent(): void;
  close(): void;
}>;

function invalid(reason = "invalid"): never {
  throw new Error(`desktop_plugin_credit_settlement_environment_${reason}`);
}
function copyEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const fields = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).length !== Object.keys(fields).length ||
    Object.values(fields).some(
      (field) =>
        !field.enumerable ||
        !Object.hasOwn(field, "value") ||
        (field.value !== undefined && typeof field.value !== "string"),
    )
  )
    invalid();
  return Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [name, field.value]),
  );
}
function integer(value: unknown, maximum: number): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  )
    invalid();
}
/** Native isolation constraint, in addition to the unchanged Worker's v1 parser. */
function reservedTokenName(name: string): boolean {
  return (
    (name.startsWith("CREWON_") && !name.startsWith("CREWON_FINANCIAL_")) ||
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
      "TERM",
      "TERMINFO",
      "TERMINFO_DIRS",
      "PWD",
      "OLDPWD",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "CODEX_HOME",
      "SYSTEMROOT",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "PROGRAMDATA",
      "SYSTEMDRIVE",
      "HOMEDRIVE",
      "HOMEPATH",
      "PROCESSOR_ARCHITECTURE",
      "USERNAME",
      "PROGRAMFILES",
    ].includes(name)
  );
}
function endpointReference(input: unknown): string {
  const value = desktopInstalledPluginRecord(input);
  desktopInstalledPluginExactKeys(value, [
    "url",
    "serviceTokenEnvironmentVariable",
  ]);
  const name = value.serviceTokenEnvironmentVariable;
  if (
    typeof name !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,127}$/u.test(name) ||
    typeof value.url !== "string" ||
    Buffer.byteLength(value.url) > 2048 ||
    /[\s?#\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.url)
  )
    invalid();
  if (reservedTokenName(name)) invalid("reserved_token_name");
  const url = new URL(value.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    invalid();
  return name;
}

/** Captures the original v1 file and immutable own credential values, not a live ambient-env watcher. */
export function captureDesktopPluginCreditSettlementEnvironment(
  ambient: NodeJS.ProcessEnv,
): DesktopPluginCreditSettlementEnvironment {
  const original = copyEnvironment(ambient);
  const declaredPath = original[DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV];
  let snapshot:
    | ReturnType<typeof captureDesktopInstalledPluginRuntimeDocument>
    | undefined;
  let path: string | undefined;
  const tokens: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  if (declaredPath !== undefined) {
    try {
      path = desktopInstalledPluginAbsolutePath(declaredPath);
      snapshot = captureDesktopInstalledPluginRuntimeDocument(path, LIMIT);
      const document = desktopInstalledPluginRecord(snapshot.value);
      desktopInstalledPluginExactKeys(document, [
        "schemaVersion",
        "scope",
        "authorityId",
        "authorityRevision",
        "authorizationAuthority",
        "decisionAuthority",
        "timeoutMs",
        "maxAuthorizationAgeMs",
        "batchSize",
        "intervalMs",
        "maxRoundMs",
        "migrate",
      ]);
      if (
        document.schemaVersion !== SCHEMA ||
        typeof document.migrate !== "boolean"
      )
        invalid();
      parsePluginProfileScope(document.scope);
      extensionOpaqueId(document.authorityId);
      extensionOpaqueId(document.authorityRevision);
      integer(document.timeoutMs, 30_000);
      integer(document.maxAuthorizationAgeMs, 30_000);
      integer(document.batchSize, 16);
      integer(document.intervalMs, 3_600_000);
      integer(document.maxRoundMs, 30_000);
      for (const endpoint of [
        document.authorizationAuthority,
        document.decisionAuthority,
      ]) {
        const name = endpointReference(endpoint);
        const token = original[name];
        if (typeof token !== "string" || !/^[\x21-\x7e]{32,8192}$/u.test(token))
          invalid();
        tokens[name] = token;
      }
    } catch (error) {
      for (const name of Object.keys(tokens)) delete tokens[name];
      if (
        error instanceof Error &&
        error.message ===
          "desktop_plugin_credit_settlement_environment_reserved_token_name"
      )
        throw error;
      invalid();
    }
  }
  let closed = false,
    withdrawn = false;
  const withdraw = (reason: string): never => {
    withdrawn = true;
    for (const name of Object.keys(tokens)) delete tokens[name];
    invalid(reason);
  };
  const assertCurrent = () => {
    if (closed) invalid("closed");
    if (withdrawn) invalid("withdrawn");
    if (snapshot !== undefined) {
      try {
        snapshot.assertCurrent();
      } catch {
        withdraw("file_changed");
      }
    }
  };
  return Object.freeze({
    assertCurrent,
    project(environment: NodeJS.ProcessEnv, target: Role): NodeJS.ProcessEnv {
      assertCurrent();
      const fields = desktopInstalledPluginRecord(target);
      desktopInstalledPluginExactKeys(fields, ["role"]);
      if (fields.role !== "shared" && fields.role !== "worker") invalid();
      const result = copyEnvironment(environment);
      if (path === undefined) {
        if (result[DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV] !== undefined)
          withdraw("overlay_conflict");
        return result;
      }
      for (const [name, value] of [
        [DESKTOP_PLUGIN_CREDIT_SETTLEMENT_CONFIG_ENV, path],
        ...Object.entries(tokens),
      ]) {
        if (result[name] !== undefined && result[name] !== value)
          withdraw("overlay_conflict");
        delete result[name];
        if (fields.role === "worker") result[name] = value;
      }
      return result;
    },
    close() {
      closed = true;
      for (const name of Object.keys(tokens)) delete tokens[name];
      snapshot = undefined;
      path = undefined;
    },
  });
}

/** For one-shot Native management/catalogue launches; no opt-in performs no file I/O. */
export function desktopPluginCreditSettlementSharedEnvironment(
  ambient: NodeJS.ProcessEnv,
  options: Readonly<{ launchEnvironment?: NodeJS.ProcessEnv }> = {},
): NodeJS.ProcessEnv {
  const captured = captureDesktopPluginCreditSettlementEnvironment(ambient);
  try {
    const fields = desktopInstalledPluginRecord(options);
    desktopInstalledPluginExactKeys(
      fields,
      Object.hasOwn(fields, "launchEnvironment") ? ["launchEnvironment"] : [],
    );
    return captured.project(
      (fields.launchEnvironment as NodeJS.ProcessEnv | undefined) ?? ambient,
      { role: "shared" },
    );
  } finally {
    captured.close();
  }
}
