import type { Client, PoolClient } from "pg";
import type {
  InstalledPluginPackage,
  PluginProfileScope,
  PluginSelection,
} from "@crewon/domain";

/** All current Store writers take this lock before their receipt/namespace locks. */
export function pluginInstallationProfileLockKey(
  schema: string,
  scope: PluginProfileScope,
): string {
  return JSON.stringify([
    "plugin-installation-profile-owner.v1",
    schema,
    scope.tenantId,
    scope.spaceId,
    scope.profileId,
  ]);
}

export async function lockPluginInstallationProfile(
  client: Pick<Client | PoolClient, "query">,
  schema: string,
  scope: PluginProfileScope,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    pluginInstallationProfileLockKey(schema, scope),
  ]);
}

/** Internal dedicated-client binding. It grants no application permission or Run admission. */
export type PluginInstallationProfileBinding = Readonly<{
  client: Client;
  scope: PluginProfileScope;
  assertOpen(): void;
  invalidate(error: unknown): void;
  run<T>(operation: () => Promise<T>): Promise<T>;
  runMutation<T>(operation: () => Promise<T>): Promise<T>;
  prepareProjection(
    selection: PluginSelection | null,
    pkg: InstalledPluginPackage | null,
  ): () => void;
}>;
