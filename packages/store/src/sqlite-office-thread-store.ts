import type { DatabaseSync } from "node:sqlite";
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
  validateOfficeThreadAdoption,
  validateOfficeThreadLocator,
} from "./office-thread-binding.ts";

/** Creation helpers run inside commitThread's transaction. Adoption owns a separate transaction. */
export class SqliteOfficeThreadStore {
  private readonly database: DatabaseSync;
  private readonly loadThread: (
    locator: ThreadScopedLocator,
  ) => ThreadState | null;
  constructor(
    database: DatabaseSync,
    loadThread: (locator: ThreadScopedLocator) => ThreadState | null,
  ) {
    this.database = database;
    this.loadThread = loadThread;
  }

  load(locator: OfficeThreadLocator): OfficeThreadBinding | null {
    validateOfficeThreadLocator(locator);
    const row = this.database
      .prepare(
        `SELECT * FROM office_thread_bindings WHERE tenant_id = ? AND space_id = ? AND office_id = ?`,
      )
      .get(locator.tenantId, locator.spaceId, locator.officeId);
    return decodeOfficeThreadRow(row, locator);
  }

  assertOffice(binding: OfficeThreadBinding): void {
    const row = this.database
      .prepare(
        `SELECT definition_json FROM office_definitions WHERE tenant_id = ? AND space_id = ? AND office_version_id = ?`,
      )
      .get(binding.tenantId, binding.spaceId, binding.officeVersionId);
    assertOfficeThreadDefinition(binding, row?.definition_json);
  }

  assertAvailable(binding: OfficeThreadBinding): void {
    if (this.load(binding) !== null)
      throw new RunStoreError("office_thread_already_bound");
    if (
      this.database
        .prepare(
          `SELECT 1 FROM office_thread_bindings WHERE tenant_id = ? AND space_id = ? AND thread_id = ?`,
        )
        .get(binding.tenantId, binding.spaceId, binding.threadId)
    )
      throw new RunStoreError("office_thread_already_claimed");
  }

  insert(binding: OfficeThreadBinding): void {
    this.database
      .prepare(
        `INSERT INTO office_thread_bindings (tenant_id, space_id, office_id, office_version_id, thread_id, bound_by_actor_id, bound_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        binding.tenantId,
        binding.spaceId,
        binding.officeId,
        binding.officeVersionId,
        binding.threadId,
        binding.boundByActorId,
        binding.boundAt,
      );
  }

  bind(input: BindOfficeThreadInput): BindOfficeThreadResult {
    validateOfficeThreadAdoption(input);
    const { binding } = input;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.assertOffice(binding);
      const prior = this.load(binding);
      if (prior !== null) {
        if (prior.threadId !== binding.threadId)
          throw new RunStoreError("office_thread_already_bound");
        this.database.exec("COMMIT");
        return { disposition: "existing", binding: prior };
      }
      this.assertAvailable(binding);
      assertOfficeThreadAdoption(input, this.loadThread(binding));
      this.insert(binding);
      this.database.exec("COMMIT");
      return { disposition: "bound", binding: structuredClone(binding) };
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        /* SQLite may already have rolled back. */
      }
      throw error;
    }
  }
}
