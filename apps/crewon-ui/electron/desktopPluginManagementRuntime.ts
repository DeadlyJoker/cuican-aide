import { createHash } from "node:crypto";
import { join } from "node:path";
import { DESKTOP_RUNTIME_OWNER } from "./desktopExtensionRuntime.ts";
import {
  prepareDesktopPluginBootstrap,
  type DesktopPluginBootstrap,
} from "./desktopPluginBootstrap.ts";

/** Only Native-owned bootstrap inputs may reach a Control process. */
export function clearDesktopPluginEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    if (
      name.startsWith("CREWON_PLUGIN_UI_") ||
      name.startsWith("CREWON_PLUGIN_INSTALLATION_") ||
      name.startsWith("CREWON_DESKTOP_PLUGIN_") ||
      name === "CREWON_INSTALLED_PLUGIN_EXECUTION_CONFIG_PATH"
    )
      delete result[name];
  }
  return result;
}

/** Tracks even a preparation interrupted before its first await resumes. */
export class DesktopPluginBootstrapOwner {
  readonly #preparation: Promise<DesktopPluginBootstrap | null>;
  #bootstrap: DesktopPluginBootstrap | null = null;
  #prepared = false;
  #withdrawn = false;
  #closing: Promise<void> | null = null;

  constructor(input: Parameters<typeof prepareDesktopPluginBootstrap>[0]) {
    this.#preparation = prepareDesktopPluginBootstrap(input).then((value) => {
      this.#bootstrap = value;
      this.#prepared = true;
      return value;
    });
    void this.#preparation.catch(() => {});
  }

  async prepared(): Promise<DesktopPluginBootstrap | null> {
    const result = await this.#preparation;
    this.#available();
    return result;
  }

  get enabled(): boolean {
    return !this.#withdrawn && this.#prepared && this.#bootstrap !== null;
  }

  controlEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    this.#available();
    if (!this.#prepared)
      throw new Error("desktop_plugin_bootstrap_owner_not_prepared");
    return {
      ...clearDesktopPluginEnvironment(environment),
      ...this.#bootstrap?.environment,
    };
  }

  withdraw(): void {
    this.#withdrawn = true;
  }

  /** Caller first joins every Control child which could still read the file. */
  close(): Promise<void> {
    this.withdraw();
    if (this.#closing !== null) return this.#closing;
    const closing = (async () => {
      // A rejected preparation has published no owner; successful late preparation still needs cleanup.
      await this.#preparation.catch(() => null);
      await this.#bootstrap?.cleanup();
      this.#bootstrap = null;
    })();
    this.#closing = closing;
    void closing.catch(() => {
      if (this.#closing === closing) this.#closing = null;
    });
    return closing;
  }

  #available(): void {
    if (this.#withdrawn)
      throw new Error("desktop_plugin_bootstrap_owner_closed");
  }
}

export type DesktopLocalManagementAccess = Readonly<{
  schemaVersion: "crewon.desktop-local-management-access.v1";
  generation: number;
}>;

/** Native invalidation is synchronous; notifications carry no session or account credentials. */
export class DesktopLocalManagementAccessEvents {
  readonly #listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* A destroyed window must not interrupt physical runtime cleanup. */
      }
    }
  }
}

/** An authenticated management server without releasing an Agent or spawning a Worker. */
export function desktopPluginManagementEnvironment(
  input: Readonly<{
    ambient: NodeJS.ProcessEnv;
    dataDirectory: string;
    controlPort: number;
    origin: string;
    csrfToken: string;
    sessionToken: string;
  }>,
): NodeJS.ProcessEnv {
  const ambient = { ...input.ambient };
  // There is no configured model, worker, remote policy or production authority in this mode.
  for (const name of Object.keys(ambient)) {
    if (name.startsWith("CREWON_")) delete ambient[name];
  }
  return {
    ...ambient,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    CREWON_ACTOR_ID: DESKTOP_RUNTIME_OWNER.actorId,
    CREWON_AGENT_VERSION_ID: `desktop-plugin-management-unavailable-${createHash("sha256").update(input.sessionToken).digest("hex")}`,
    CREWON_ARTIFACT_DB_PATH: join(
      input.dataDirectory,
      "artifact-metadata.sqlite",
    ),
    CREWON_ARTIFACT_ENCRYPTION_KEY_ID: "desktop-artifact-key-v1",
    CREWON_ARTIFACT_ENCRYPTION_KEY_PATH: join(
      input.dataDirectory,
      "artifact-encryption.key",
    ),
    CREWON_ARTIFACT_ROOT: join(input.dataDirectory, "artifacts"),
    CREWON_AUTHORITY_ID: "standalone-authority",
    CREWON_CONTROL_ALLOWED_ORIGINS: input.origin,
    CREWON_CONTROL_CSRF_TOKEN: input.csrfToken,
    CREWON_CONTROL_DB_PATH: join(input.dataDirectory, "control.sqlite"),
    CREWON_CONTROL_ORIGIN: input.origin,
    CREWON_CONTROL_PORT: String(input.controlPort),
    CREWON_CONTROL_SECURITY_MODE: "standalone",
    CREWON_CONTROL_SESSION_TOKEN: input.sessionToken,
    CREWON_CONTROL_TARGET: `http://127.0.0.1:${input.controlPort}`,
    CREWON_NATIVE_WORKSPACE_READ_ENABLED: "0",
    CREWON_POLICY_SNAPSHOT_ID: "standalone-policy-v0",
    CREWON_PRINCIPAL_ID: DESKTOP_RUNTIME_OWNER.principalId,
    CREWON_SPACE_ID: DESKTOP_RUNTIME_OWNER.spaceId,
    CREWON_TENANT_ID: DESKTOP_RUNTIME_OWNER.tenantId,
  };
}
