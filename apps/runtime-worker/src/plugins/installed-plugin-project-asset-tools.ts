import {
  ProjectAssetApplicationService,
  type CreativeProjectAuthorizationPort,
} from "@crewon/application";
import type { PluginTaskAdmission } from "@crewon/domain";
import type { SqliteRunStore, PostgresDomainStore } from "@crewon/store";
import {
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
  NodeSha256ContentDigester,
} from "../standalone-adapters.ts";
export type InstalledPluginProjectAssetToolsConfig = Readonly<{
  version: "crewon.project-asset-tools.v1";
  authorization: CreativeProjectAuthorizationPort;
  /** Explicit package-specific asset stage permission, independently from text/conversation grants. */
  authorizeService(
    admission: PluginTaskAdmission,
    signal: AbortSignal,
  ): Promise<void>;
}>;
export function captureInstalledPluginProjectAssetToolsConfig(
  input: InstalledPluginProjectAssetToolsConfig,
): InstalledPluginProjectAssetToolsConfig {
  const v = fields(input, ["version", "authorization", "authorizeService"]);
  if (
    v.version !== "crewon.project-asset-tools.v1" ||
    typeof v.authorizeService !== "function"
  )
    fail();
  const authorize = method(v.authorization, "authorize");
  const service = v.authorizeService.bind(input);
  return Object.freeze({
    version: "crewon.project-asset-tools.v1",
    authorization: Object.freeze({
      authorize: authorize as CreativeProjectAuthorizationPort["authorize"],
    }),
    authorizeService: async (admission, signal) => {
      if ((await service(admission, signal)) !== undefined) fail();
    },
  });
}
export function composeInstalledPluginProjectAssetTools(
  input: Readonly<{
    store: SqliteRunStore | PostgresDomainStore;
    config: InstalledPluginProjectAssetToolsConfig;
    admission: PluginTaskAdmission;
  }>,
) {
  const config = captureInstalledPluginProjectAssetToolsConfig(input.config);
  return Object.freeze({
    service: new ProjectAssetApplicationService({
      store: input.store.projectAssetStore(),
      projects: input.store.creativeProjectStore(),
      texts: input.store.projectTextStore(),
      authorization: config.authorization,
      clock: new SystemApplicationClock(),
      ids: new UuidV7ApplicationIdGenerator(),
      digester: new NodeSha256ContentDigester(),
    }),
    authorizeService: (signal: AbortSignal) =>
      config.authorizeService(input.admission, signal),
  });
}
export async function prepareInstalledPluginProjectAssetToolsStores(
  input: Readonly<{
    store: SqliteRunStore | PostgresDomainStore;
    config: InstalledPluginProjectAssetToolsConfig | undefined;
  }>,
) {
  if (input.config === undefined) return;
  captureInstalledPluginProjectAssetToolsConfig(input.config);
  await input.store.creativeProjectStore().migrate();
  await input.store.projectTextStore().migrate();
  await input.store.projectAssetStore().migrate();
}
function fields(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== keys.length
  )
    fail();
  const v: Record<string, unknown> = Object.create(null);
  for (const k of Reflect.ownKeys(input)) {
    const d = Object.getOwnPropertyDescriptor(input, k);
    if (
      typeof k !== "string" ||
      !keys.includes(k) ||
      !d?.enumerable ||
      !("value" in d)
    )
      fail();
    v[k] = d.value;
  }
  return v;
}
function method(input: unknown, key: string): (...args: never[]) => unknown {
  if (input === null || typeof input !== "object") fail();
  for (
    let owner: object | null = input, depth = 0;
    owner !== null && depth < 16;
    owner = Object.getPrototypeOf(owner), depth++
  ) {
    const d = Object.getOwnPropertyDescriptor(owner, key);
    if (!d) continue;
    if (!("value" in d) || typeof d.value !== "function") fail();
    return d.value.bind(input);
  }
  return fail();
}
function fail(): never {
  throw new Error("installed_plugin_project_asset_tools_configuration_invalid");
}
