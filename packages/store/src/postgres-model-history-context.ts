import { createHash, randomUUID } from "node:crypto";
import { type Pool, type PoolClient } from "pg";
import {
  RunStoreError,
  type ModelHistoryContextCheckpoint,
  type ModelHistoryContextProgress,
  type ModelHistoryContextState,
  type ModelHistoryContextStore,
  type ThreadLocator,
} from "@crewon/application";
import {
  isModelHistoryInstructionBoundary,
  validateModelHistoryItem,
  type ModelHistoryItem,
} from "@crewon/domain";
import {
  decodePostgresModelHistoryItem,
  safeInteger,
  type PostgresModelHistoryRow,
} from "./postgres-thread-codec.ts";
import {
  normalizePostgresError,
  rollbackPostgres,
} from "./postgres-store-support.ts";
import {
  stableJson,
  validateModelHistoryPage,
  validateThreadLocator,
} from "./store-invariants.ts";

type State = {
  algorithm_version: number;
  through_sequence: number;
  fingerprint: string;
  last_item_digest: string | null;
  latest_rollback_sequence: number | null;
  latest_rollback_digest: string | null;
};
type StateRow = Omit<State, "through_sequence" | "latest_rollback_sequence"> & {
  through_sequence: string | number;
  latest_rollback_sequence: string | number | null;
};
type ReferenceRow = PostgresModelHistoryRow & {
  reference_sequence: string | number;
  reference_id: string;
  reference_type: string;
  item_digest: string;
};
type ContentItem = Exclude<
  ModelHistoryItem,
  { type: "compaction" | "rollback" }
>;
const PAGE_SIZE = 100;
const READ_TRANSACTION = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

/** Every page uses a short coherent snapshot; backfill shares the canonical writer's Thread lock. */
export class PostgresModelHistoryContextStore
  implements ModelHistoryContextStore
{
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #assertOpen: () => void;

  constructor(pool: Pool, quotedSchema: string, assertOpen: () => void) {
    this.#pool = pool;
    this.#schema = quotedSchema;
    this.#assertOpen = assertOpen;
  }

  async prepare(locator: ThreadLocator): Promise<ModelHistoryContextProgress> {
    this.#assertOpen();
    validateThreadLocator(locator);
    const ready = await transaction(
      this.#pool,
      READ_TRANSACTION,
      async (client) => {
        const state = await loadState(client, this.#schema, locator);
        if (
          state === undefined ||
          state.through_sequence !==
            (await loadHead(client, this.#schema, locator))
        )
          return null;
        return {
          processedThroughSequence: state.through_sequence,
          targetSequence: state.through_sequence,
          context: await loadContext(client, this.#schema, locator, state),
        };
      },
    );
    if (ready !== null) return ready;
    return transaction(this.#pool, "BEGIN", async (client) => {
      await lockPostgresHistoryThread(client, this.#schema, locator);
      const state =
        (await loadState(client, this.#schema, locator)) ??
        (await createState(client, this.#schema, locator));
      const targetSequence = await loadHead(client, this.#schema, locator);
      if (state.through_sequence > targetSequence) invalid();
      const result = await client.query<PostgresModelHistoryRow>(
        `SELECT * FROM ${this.#schema}.model_history_items
        WHERE tenant_id=$1 AND thread_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4`,
        [locator.tenantId, locator.threadId, state.through_sequence, PAGE_SIZE],
      );
      const next = await advance(
        client,
        this.#schema,
        locator,
        state,
        result.rows.map((row) => decodePostgresModelHistoryItem(row, locator)),
      );
      if (
        result.rows.length < PAGE_SIZE &&
        next.through_sequence !== targetSequence
      )
        invalid();
      return {
        processedThroughSequence: next.through_sequence,
        targetSequence,
        context:
          next.through_sequence === targetSequence
            ? await loadContext(client, this.#schema, locator, next)
            : null,
      };
    });
  }

  async listItems(
    locator: ThreadLocator,
    checkpoint: ModelHistoryContextCheckpoint,
    afterSequence: number,
    limit: number,
  ): Promise<readonly ContentItem[]> {
    this.#assertOpen();
    validateModelHistoryPage(locator, afterSequence, limit);
    if (limit > PAGE_SIZE)
      throw new RunStoreError("model_history_context_page_limit_invalid");
    return transaction(this.#pool, READ_TRANSACTION, async (client) => {
      const state = await loadState(client, this.#schema, locator);
      if (
        state === undefined ||
        state.through_sequence !== checkpoint.throughHistorySequence ||
        state.fingerprint !== checkpoint.fingerprint ||
        (await loadHead(client, this.#schema, locator)) !==
          checkpoint.throughHistorySequence
      ) {
        throw new RunStoreError("model_history_context_changed");
      }
      const compaction = await loadCompaction(client, this.#schema, locator);
      const result = await client.query<ReferenceRow>(
        `${referenceSelect(this.#schema)}
        WHERE refs.tenant_id=$1 AND refs.thread_id=$2 AND refs.item_type<>'compaction'
          AND refs.sequence>$3 ORDER BY refs.sequence LIMIT $4`,
        [
          locator.tenantId,
          locator.threadId,
          Math.max(afterSequence, compaction?.replacesThroughSequence ?? 0),
          limit,
        ],
      );
      return result.rows.map((row) => {
        const item = decodeReference(row, locator);
        if (
          item.type === "compaction" ||
          item.type === "rollback" ||
          item.sequence > checkpoint.throughHistorySequence
        )
          invalid();
        return item as ContentItem;
      });
    });
  }
}

/** Acquired before canonical INSERTs and before derived state; preserves one lock order. */
export async function lockPostgresHistoryThread(
  client: PoolClient,
  schema: string,
  locator: ThreadLocator,
): Promise<void> {
  const locked = await client.query(
    `SELECT 1 FROM ${schema}.threads WHERE tenant_id=$1 AND thread_id=$2 FOR UPDATE`,
    [locator.tenantId, locator.threadId],
  );
  if (locked.rowCount !== 1) throw new RunStoreError("model_history_not_found");
}

/** Caller owns the Thread lock and canonical write transaction. Never backfills old bodies. */
export async function appendPostgresModelHistoryContext(
  client: PoolClient,
  schema: string,
  items: readonly ModelHistoryItem[],
): Promise<void> {
  const first = items[0];
  if (first === undefined) return;
  let state = await loadState(client, schema, first);
  if (state === undefined && first.sequence === 1)
    state = await createState(client, schema, first);
  if (state === undefined || state.through_sequence !== first.sequence - 1)
    return;
  await advance(client, schema, first, state, items);
}

async function advance(
  client: PoolClient,
  schema: string,
  locator: ThreadLocator,
  state: State,
  items: readonly ModelHistoryItem[],
): Promise<State> {
  if (items.length === 0) return state;
  const next = { ...state };
  const references: {
    sequence: number;
    itemId: string;
    type: string;
    boundary: string;
    digest: string;
  }[] = [];
  const flush = async () => {
    if (references.length === 0) return;
    await client.query(
      `INSERT INTO ${schema}.model_history_context_refs
      (tenant_id, thread_id, sequence, item_id, item_type, boundary_kind, item_digest)
      SELECT $1, $2, * FROM unnest($3::bigint[], $4::text[], $5::text[], $6::text[], $7::text[])`,
      [
        locator.tenantId,
        locator.threadId,
        references.map((ref) => ref.sequence),
        references.map((ref) => ref.itemId),
        references.map((ref) => ref.type),
        references.map((ref) => ref.boundary),
        references.map((ref) => ref.digest),
      ],
    );
    references.length = 0;
  };
  for (const item of items) {
    validateModelHistoryItem(item);
    if (
      item.tenantId !== locator.tenantId ||
      item.threadId !== locator.threadId ||
      item.sequence !== next.through_sequence + 1
    )
      invalid();
    const digest = hash(stableJson(item));
    if (item.type === "rollback") {
      await flush();
      await applyRollback(client, schema, locator, item);
      next.latest_rollback_sequence = item.sequence;
      next.latest_rollback_digest = digest;
    } else {
      references.push({
        sequence: item.sequence,
        itemId: item.itemId,
        type: item.type,
        digest,
        boundary: isModelHistoryInstructionBoundary(item)
          ? "instruction"
          : item.type === "message" &&
              item.role === "user" &&
              (item.source === "goal_continuation" ||
                item.source === "goal_steering")
            ? "contextual"
            : "other",
      });
    }
    next.through_sequence = item.sequence;
    next.fingerprint = hash(`${next.fingerprint}\n${item.sequence}\n${digest}`);
    next.last_item_digest = digest;
  }
  await flush();
  await client.query(
    `UPDATE ${schema}.model_history_context_state SET through_sequence=$1, fingerprint=$2,
    last_item_digest=$3, latest_rollback_sequence=$4, latest_rollback_digest=$5 WHERE tenant_id=$6 AND thread_id=$7`,
    [
      next.through_sequence,
      next.fingerprint,
      next.last_item_digest,
      next.latest_rollback_sequence,
      next.latest_rollback_digest,
      locator.tenantId,
      locator.threadId,
    ],
  );
  return next;
}

async function applyRollback(
  client: PoolClient,
  schema: string,
  locator: ThreadLocator,
  marker: Extract<ModelHistoryItem, { type: "rollback" }>,
): Promise<void> {
  const result = await client.query<{ removed: string; cut: string | null }>(
    `SELECT COUNT(*) AS removed, MIN(sequence) AS cut FROM
    (SELECT sequence FROM ${schema}.model_history_context_refs WHERE tenant_id=$1 AND thread_id=$2
      AND boundary_kind='instruction' ORDER BY sequence DESC LIMIT $3) AS turns`,
    [locator.tenantId, locator.threadId, marker.requestedTurns],
  );
  const boundary = result.rows[0]!;
  let cut = boundary.cut === null ? null : safeInteger(boundary.cut);
  if (cut !== null) {
    const first = await client.query<{ value: string }>(
      `SELECT MIN(sequence) AS value FROM ${schema}.model_history_context_refs
      WHERE tenant_id=$1 AND thread_id=$2 AND boundary_kind='instruction'`,
      [locator.tenantId, locator.threadId],
    );
    if (cut !== safeInteger(first.rows[0]!.value)) {
      const previous = await client.query<{ sequence: string }>(
        `SELECT sequence FROM ${schema}.model_history_context_refs
        WHERE tenant_id=$1 AND thread_id=$2 AND sequence<$3 AND boundary_kind<>'contextual' ORDER BY sequence DESC LIMIT 1`,
        [locator.tenantId, locator.threadId, cut],
      );
      if (previous.rows[0] === undefined) invalid();
      const leading = await client.query<{ value: string }>(
        `SELECT MIN(sequence) AS value FROM ${schema}.model_history_context_refs
        WHERE tenant_id=$1 AND thread_id=$2 AND sequence>$3 AND sequence<=$4`,
        [locator.tenantId, locator.threadId, previous.rows[0].sequence, cut],
      );
      cut = safeInteger(leading.rows[0]!.value);
    }
  }
  if (
    marker.removedTurns !== safeInteger(boundary.removed) ||
    marker.historyFromSequence !== cut ||
    marker.historyThroughSequence !== marker.sequence - 1
  ) {
    throw new RunStoreError("model_history_rollback_boundary_mismatch");
  }
  if (cut !== null)
    await client.query(
      `DELETE FROM ${schema}.model_history_context_refs WHERE tenant_id=$1 AND thread_id=$2 AND sequence>=$3`,
      [locator.tenantId, locator.threadId, cut],
    );
}

async function loadContext(
  client: PoolClient,
  schema: string,
  locator: ThreadLocator,
  state: State,
): Promise<ModelHistoryContextState> {
  const lastItem =
    state.through_sequence === 0
      ? null
      : await loadItem(
          client,
          schema,
          locator,
          state.through_sequence,
          state.last_item_digest,
        );
  const latestRollback =
    state.latest_rollback_sequence === null
      ? null
      : await loadItem(
          client,
          schema,
          locator,
          state.latest_rollback_sequence,
          state.latest_rollback_digest,
        );
  if (latestRollback !== null && latestRollback.type !== "rollback") invalid();
  return {
    checkpoint: {
      throughHistorySequence: state.through_sequence,
      fingerprint: state.fingerprint,
    },
    lastItem,
    lastCompaction: await loadCompaction(client, schema, locator),
    latestRollback:
      latestRollback as ModelHistoryContextState["latestRollback"],
  };
}

async function loadCompaction(
  client: PoolClient,
  schema: string,
  locator: ThreadLocator,
): Promise<ModelHistoryContextState["lastCompaction"]> {
  const result = await client.query<ReferenceRow>(
    `${referenceSelect(schema)} WHERE refs.tenant_id=$1 AND refs.thread_id=$2
    AND refs.item_type='compaction' ORDER BY refs.sequence DESC LIMIT 1`,
    [locator.tenantId, locator.threadId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const item = decodeReference(row, locator);
  if (item.type !== "compaction") invalid();
  return item as ModelHistoryContextState["lastCompaction"];
}

async function loadItem(
  client: PoolClient,
  schema: string,
  locator: ThreadLocator,
  sequence: number,
  digest: string | null,
): Promise<ModelHistoryItem> {
  const result = await client.query<PostgresModelHistoryRow>(
    `SELECT * FROM ${schema}.model_history_items WHERE tenant_id=$1 AND thread_id=$2 AND sequence=$3`,
    [locator.tenantId, locator.threadId, sequence],
  );
  if (result.rows[0] === undefined) invalid();
  const item = decodePostgresModelHistoryItem(result.rows[0], locator);
  if (hash(stableJson(item)) !== digest) invalid();
  return item;
}

function decodeReference(
  row: ReferenceRow,
  locator: ThreadLocator,
): ModelHistoryItem {
  const item = decodePostgresModelHistoryItem(row, locator);
  if (
    item.sequence !== safeInteger(row.reference_sequence) ||
    item.itemId !== row.reference_id ||
    item.type !== row.reference_type ||
    hash(stableJson(item)) !== row.item_digest
  )
    invalid();
  return item;
}

function referenceSelect(schema: string): string {
  return `SELECT refs.sequence AS reference_sequence, refs.item_id AS reference_id, refs.item_type AS reference_type,
    refs.item_digest, history.* FROM ${schema}.model_history_context_refs AS refs LEFT JOIN ${schema}.model_history_items AS history
      ON history.tenant_id=refs.tenant_id AND history.thread_id=refs.thread_id AND history.sequence=refs.sequence`;
}

async function loadState(
  client: PoolClient,
  schema: string,
  locator: ThreadLocator,
): Promise<State | undefined> {
  const result = await client.query<StateRow>(
    `SELECT * FROM ${schema}.model_history_context_state WHERE tenant_id=$1 AND thread_id=$2`,
    [locator.tenantId, locator.threadId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  if (
    row.algorithm_version !== 1 ||
    typeof row.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.fingerprint)
  )
    invalid();
  return {
    ...row,
    through_sequence: safeInteger(row.through_sequence),
    latest_rollback_sequence:
      row.latest_rollback_sequence === null
        ? null
        : safeInteger(row.latest_rollback_sequence),
  };
}

async function createState(
  client: PoolClient,
  schema: string,
  locator: ThreadLocator,
): Promise<State> {
  const fingerprint = hash(
    stableJson([
      "crewon.context-index.v1",
      { tenantId: locator.tenantId, threadId: locator.threadId },
      randomUUID(),
    ]),
  );
  await client.query(
    `INSERT INTO ${schema}.model_history_context_state
    (tenant_id, thread_id, algorithm_version, through_sequence, fingerprint) VALUES ($1, $2, 1, 0, $3)`,
    [locator.tenantId, locator.threadId, fingerprint],
  );
  return (await loadState(client, schema, locator))!;
}

async function loadHead(
  client: PoolClient,
  schema: string,
  locator: ThreadLocator,
): Promise<number> {
  const result = await client.query<{ value: string }>(
    `SELECT COALESCE(MAX(sequence), 0) AS value FROM ${schema}.model_history_items WHERE tenant_id=$1 AND thread_id=$2`,
    [locator.tenantId, locator.threadId],
  );
  return safeInteger(result.rows[0]!.value);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function invalid(): never {
  throw new RunStoreError("model_history_context_invalid");
}

async function transaction<T>(
  pool: Pool,
  begin: typeof READ_TRANSACTION | "BEGIN",
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(begin);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollbackPostgres(client);
    throw normalizePostgresError(error);
  } finally {
    client.release();
  }
}
