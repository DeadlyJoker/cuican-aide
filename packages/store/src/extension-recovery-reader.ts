import { lstatSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentVersionAsset,
  AgentVersionDeployment,
  AgentVersionReleaseBundle,
} from "@crewon/application";
import {
  validateAgentVersionAsset,
  validateAgentVersionDeployment,
  validateAgentVersionReleaseBundle,
} from "./agent-version-store-invariants.ts";

const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

/** Read-only Native recovery port. It never migrates, activates or publishes. */
export function readSqliteExtensionRecoveryRelease(
  input: Readonly<{
    databasePath: string;
    tenantId: string;
    releaseId: string;
    agentVersionIds: readonly string[];
  }>,
): Readonly<{
  assets: readonly AgentVersionAsset[];
  deployments: readonly AgentVersionDeployment[];
  bundle: AgentVersionReleaseBundle;
}> {
  const databasePath = input.databasePath;
  const tenantId = identifier(input.tenantId);
  const releaseId = identifier(input.releaseId);
  const ids = [...input.agentVersionIds].map(identifier);
  if (
    typeof databasePath !== "string" ||
    !isAbsolute(databasePath) ||
    resolve(databasePath) !== databasePath ||
    Buffer.byteLength(databasePath) > 4096 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(databasePath) ||
    ids.length < 1 ||
    ids.length > 256 ||
    new Set(ids).size !== ids.length
  )
    unavailable();
  let database: DatabaseSync | null = null;
  try {
    const identity = databaseIdentity(databasePath);
    database = new DatabaseSync(databasePath, {
      readOnly: true,
      allowExtension: false,
    });
    assertSameDatabase(databasePath, identity);
    database.exec(
      "PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN",
    );
    let total = 0;
    const json = (value: unknown): unknown => {
      if (typeof value !== "string") unavailable();
      total += Buffer.byteLength(value);
      if (total > MAX_TOTAL_BYTES) unavailable();
      return JSON.parse(value);
    };
    const bundleRow = database
      .prepare(
        `SELECT tenant_id,release_id,manifest_digest,default_agent_version_id,
      CASE WHEN length(CAST(bundle_json AS BLOB))<=262144 THEN bundle_json ELSE NULL END AS json
      FROM agent_version_release_bundles WHERE tenant_id=? AND release_id=?`,
      )
      .get(tenantId, releaseId);
    if (!bundleRow) unavailable();
    const bundle = json(bundleRow.json) as AgentVersionReleaseBundle;
    validateAgentVersionReleaseBundle(bundle);
    if (
      bundle.deployments.length !== ids.length ||
      bundle.deployments.some(
        (deployment) => !ids.includes(deployment.agentVersionId),
      )
    )
      unavailable();
    if (
      bundle.tenantId !== bundleRow.tenant_id ||
      bundle.releaseId !== bundleRow.release_id ||
      bundle.manifestDigest !== bundleRow.manifest_digest ||
      bundle.defaultAgentVersionId !== bundleRow.default_agent_version_id
    )
      unavailable();
    const assetStatement =
      database.prepare(`SELECT tenant_id,agent_version_id,content_digest,created_at,
      CASE WHEN length(CAST(asset_json AS BLOB))<=1048576 THEN asset_json ELSE NULL END AS json
      FROM agent_versions WHERE tenant_id=? AND agent_version_id=?`);
    const deploymentStatement =
      database.prepare(`SELECT tenant_id,agent_version_id,content_digest,materialization_digest,deployed_at,
      CASE WHEN length(CAST(deployment_json AS BLOB))<=32768 THEN deployment_json ELSE NULL END AS json
      FROM agent_version_deployments WHERE tenant_id=? AND agent_version_id=?`);
    const assets: AgentVersionAsset[] = [],
      deployments: AgentVersionDeployment[] = [];
    for (const id of ids) {
      const assetRow = assetStatement.get(tenantId, id),
        deploymentRow = deploymentStatement.get(tenantId, id);
      if (!assetRow || !deploymentRow) unavailable();
      const asset = json(assetRow.json) as AgentVersionAsset;
      validateAgentVersionAsset(asset);
      if (
        asset.tenantId !== assetRow.tenant_id ||
        asset.agentVersionId !== assetRow.agent_version_id ||
        asset.contentDigest !== assetRow.content_digest ||
        asset.createdAt !== assetRow.created_at
      )
        unavailable();
      const deployment = json(deploymentRow.json) as AgentVersionDeployment;
      validateAgentVersionDeployment(deployment);
      if (
        deployment.tenantId !== deploymentRow.tenant_id ||
        deployment.agentVersionId !== deploymentRow.agent_version_id ||
        deployment.contentDigest !== deploymentRow.content_digest ||
        deployment.materializationDigest !==
          deploymentRow.materialization_digest ||
        deployment.deployedAt !== deploymentRow.deployed_at
      )
        unavailable();
      assets.push(asset);
      deployments.push(deployment);
    }
    assertSameDatabase(databasePath, identity);
    database.exec("ROLLBACK");
    return Object.freeze({
      assets: Object.freeze(assets),
      deployments: Object.freeze(deployments),
      bundle,
    });
  } catch {
    return unavailable();
  } finally {
    database?.close();
  }
}

function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value) > 512 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
  )
    unavailable();
  return value;
}
function databaseIdentity(
  path: string,
): Readonly<{ dev: bigint; ino: bigint }> {
  let parent = dirname(path);
  while (true) {
    const directory = lstatSync(parent);
    if (!directory.isDirectory() || directory.isSymbolicLink()) unavailable();
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const file = lstatSync(path, { bigint: true });
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1n)
    unavailable();
  return Object.freeze({ dev: file.dev, ino: file.ino });
}
function assertSameDatabase(
  path: string,
  expected: Readonly<{ dev: bigint; ino: bigint }>,
): void {
  const current = databaseIdentity(path);
  if (current.dev !== expected.dev || current.ino !== expected.ino)
    unavailable();
}
function unavailable(): never {
  throw new Error("extension_recovery_database_unavailable");
}
