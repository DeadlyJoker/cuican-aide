import type {
  ActivateAgentVersionReleaseResult,
  ActorContext,
  ApplicationClock,
  AuthorizationPort,
} from "@crewon/application";
import { AgentVersionReleaseApplicationService } from "@crewon/application";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";

import {
  activateRuntimeAgentVersionRelease,
  compileRuntimeAgentVersionRelease,
  type RuntimeAgentVersionReleaseConfig,
  type RuntimeAgentVersionReleasePlan,
} from "./agent-version-release.ts";
import { NodeSha256ContentDigester } from "./standalone-adapters.ts";

type ReleaseAuthority = Readonly<{
  actor: ActorContext;
  authorization: AuthorizationPort;
  clock: ApplicationClock;
  activationId: string;
}>;

export type RuntimeAgentVersionReleaseActivationResult = Readonly<{
  plan: RuntimeAgentVersionReleasePlan;
  activation: ActivateAgentVersionReleaseResult;
}>;

export type StandaloneRuntimeAgentVersionReleaseConfig =
  RuntimeAgentVersionReleaseConfig &
    ReleaseAuthority &
    Readonly<{ databasePath: string }>;

export type PostgresRuntimeAgentVersionReleaseConfig =
  RuntimeAgentVersionReleaseConfig &
    ReleaseAuthority &
    Readonly<{
      connectionString: string;
      schema?: string;
      maxPoolSize?: number;
      statementTimeoutMs?: number;
    }>;

export type StandaloneRuntimeAgentVersionRollbackConfig = ReleaseAuthority &
  Readonly<{
    databasePath: string;
    releaseId: string;
  }>;

export type PostgresRuntimeAgentVersionRollbackConfig = ReleaseAuthority &
  Readonly<{
    connectionString: string;
    schema?: string;
    maxPoolSize?: number;
    statementTimeoutMs?: number;
    releaseId: string;
  }>;

/** Compiles and activates a release without constructing a Runtime Worker. */
export async function activateStandaloneRuntimeAgentVersionRelease(
  config: StandaloneRuntimeAgentVersionReleaseConfig,
): Promise<RuntimeAgentVersionReleaseActivationResult> {
  const plan = compileRuntimeAgentVersionRelease(config);
  const store = new SqliteRunStore(config.databasePath);
  try {
    const activation = await activateRuntimeAgentVersionRelease({
      actor: config.actor,
      store,
      authorization: config.authorization,
      clock: config.clock,
      plan,
      activationId: config.activationId,
    });
    return { plan, activation };
  } finally {
    await store.close();
  }
}

/** PostgreSQL release authority equivalent of the standalone compiler. */
export async function activatePostgresRuntimeAgentVersionRelease(
  config: PostgresRuntimeAgentVersionReleaseConfig,
): Promise<RuntimeAgentVersionReleaseActivationResult> {
  const plan = compileRuntimeAgentVersionRelease(config);
  const store = await PostgresDomainStore.open({
    connectionString: config.connectionString,
    schema: config.schema,
    maxPoolSize: config.maxPoolSize,
    statementTimeoutMs: config.statementTimeoutMs,
  });
  try {
    const activation = await activateRuntimeAgentVersionRelease({
      actor: config.actor,
      store,
      authorization: config.authorization,
      clock: config.clock,
      plan,
      activationId: config.activationId,
    });
    return { plan, activation };
  } finally {
    await store.close();
  }
}

/** Moves the standalone active pointer to an existing immutable bundle. */
export async function rollbackStandaloneRuntimeAgentVersionRelease(
  config: StandaloneRuntimeAgentVersionRollbackConfig,
): Promise<ActivateAgentVersionReleaseResult> {
  const store = new SqliteRunStore(config.databasePath);
  try {
    return await releaseService(store, config).activateExisting(
      config.actor,
      config.releaseId,
      config.activationId,
    );
  } finally {
    await store.close();
  }
}

/** Moves the PostgreSQL active pointer to an existing immutable bundle. */
export async function rollbackPostgresRuntimeAgentVersionRelease(
  config: PostgresRuntimeAgentVersionRollbackConfig,
): Promise<ActivateAgentVersionReleaseResult> {
  const store = await PostgresDomainStore.open({
    connectionString: config.connectionString,
    schema: config.schema,
    maxPoolSize: config.maxPoolSize,
    statementTimeoutMs: config.statementTimeoutMs,
  });
  try {
    return await releaseService(store, config).activateExisting(
      config.actor,
      config.releaseId,
      config.activationId,
    );
  } finally {
    await store.close();
  }
}

function releaseService(
  store: SqliteRunStore | PostgresDomainStore,
  authority: ReleaseAuthority,
): AgentVersionReleaseApplicationService {
  return new AgentVersionReleaseApplicationService({
    store,
    authorization: authority.authorization,
    clock: authority.clock,
    digester: new NodeSha256ContentDigester(),
  });
}
