import { advisoryLock, threadLockKey } from "./postgres-thread-lock.ts";
import type { Pool, PoolClient } from "pg";
import {
  RunStoreError,
  type BindOfficeThreadInput,
  type BindOfficeThreadResult,
  type OfficeThreadBinding,
  type OfficeThreadLocator,
  type ThreadScopedLocator,
} from "@crewon/application";
import type { ThreadState } from "@crewon/domain";
import {
  assertOfficeThreadAdoption,
  assertOfficeThreadDefinition,
  decodeOfficeThreadRow,
  officeThreadLockKey,
  validateOfficeThreadAdoption,
  validateOfficeThreadLocator,
} from "./office-thread-binding.ts";
import {
  rollbackPostgres,
  normalizePostgresError,
} from "./postgres-store-support.ts";

export class PostgresOfficeThreadStore {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly loadThread: (
    client: PoolClient,
    locator: ThreadScopedLocator,
  ) => Promise<ThreadState | null>;
  constructor(
    pool: Pool,
    schema: string,
    loadThread: (
      client: PoolClient,
      locator: ThreadScopedLocator,
    ) => Promise<ThreadState | null>,
  ) {
    this.pool = pool;
    this.schema = schema;
    this.loadThread = loadThread;
  }

  async load(
    client: Pool | PoolClient,
    locator: OfficeThreadLocator,
  ): Promise<OfficeThreadBinding | null> {
    validateOfficeThreadLocator(locator);
    const result = await client.query(
      `SELECT * FROM ${this.schema}.office_thread_bindings WHERE tenant_id = $1 AND space_id = $2 AND office_id = $3`,
      [locator.tenantId, locator.spaceId, locator.officeId],
    );
    return decodeOfficeThreadRow(result.rows[0], locator);
  }

  async assertOffice(
    client: PoolClient,
    binding: OfficeThreadBinding,
  ): Promise<void> {
    const result = await client.query(
      `SELECT definition_json FROM ${this.schema}.office_definitions WHERE tenant_id = $1 AND space_id = $2 AND office_version_id = $3`,
      [binding.tenantId, binding.spaceId, binding.officeVersionId],
    );
    assertOfficeThreadDefinition(binding, result.rows[0]?.definition_json);
  }

  async assertAvailable(
    client: PoolClient,
    binding: OfficeThreadBinding,
  ): Promise<void> {
    if (await this.load(client, binding))
      throw new RunStoreError("office_thread_already_bound");
    const result = await client.query(
      `SELECT 1 FROM ${this.schema}.office_thread_bindings WHERE tenant_id = $1 AND space_id = $2 AND thread_id = $3`,
      [binding.tenantId, binding.spaceId, binding.threadId],
    );
    if (result.rows.length !== 0)
      throw new RunStoreError("office_thread_already_claimed");
  }

  async insert(
    client: PoolClient,
    binding: OfficeThreadBinding,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ${this.schema}.office_thread_bindings (tenant_id, space_id, office_id, office_version_id, thread_id, bound_by_actor_id, bound_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        binding.tenantId,
        binding.spaceId,
        binding.officeId,
        binding.officeVersionId,
        binding.threadId,
        binding.boundByActorId,
        binding.boundAt,
      ],
    );
  }

  async bind(input: BindOfficeThreadInput): Promise<BindOfficeThreadResult> {
    validateOfficeThreadAdoption(input);
    const { binding } = input;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const key of [
        officeThreadLockKey(binding),
        threadLockKey(binding.tenantId, binding.threadId),
      ].sort())
        await advisoryLock(client, key);
      await this.assertOffice(client, binding);
      const prior = await this.load(client, binding);
      if (prior !== null) {
        if (prior.threadId !== binding.threadId)
          throw new RunStoreError("office_thread_already_bound");
        await client.query("COMMIT");
        return { disposition: "existing", binding: prior };
      }
      await this.assertAvailable(client, binding);
      assertOfficeThreadAdoption(input, await this.loadThread(client, binding));
      await this.insert(client, binding);
      await client.query("COMMIT");
      return { disposition: "bound", binding: structuredClone(binding) };
    } catch (error) {
      await rollbackPostgres(client);
      throw normalizePostgresError(error);
    } finally {
      client.release();
    }
  }
}
