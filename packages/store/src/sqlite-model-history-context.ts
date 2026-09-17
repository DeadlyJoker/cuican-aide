import { createHash, randomUUID } from "node:crypto";
import { decodeSqliteModelHistoryItem } from "./sqlite-canonical-tool-output-codec.ts";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
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
  stableJson,
  validateModelHistoryPage,
  validateThreadLocator,
} from "./store-invariants.ts";

type Row = Record<string, SQLOutputValue>;
type ContentItem = Exclude<
  ModelHistoryItem,
  { type: "compaction" | "rollback" }
>;
const PAGE_SIZE = 100;
const RAW_COLUMNS =
  "tenant_id, thread_id, sequence, item_id, item_type, run_id, segment_id, created_at, item_json";

/** Short transactions only: never holds a read snapshot while the Worker samples. */
export class SqliteModelHistoryContextStore
  implements ModelHistoryContextStore
{
  readonly #database: DatabaseSync;
  readonly #assertOpen: () => void;
  constructor(database: DatabaseSync, assertOpen: () => void) {
    this.#database = database;
    this.#assertOpen = assertOpen;
  }

  async prepare(locator: ThreadLocator): Promise<ModelHistoryContextProgress> {
    this.#assertOpen();
    validateThreadLocator(locator);
    const ready = transaction(this.#database, "BEGIN", () => {
      const state = loadState(this.#database, locator);
      if (
        state === undefined ||
        state.through_sequence !== loadHead(this.#database, locator)
      )
        return null;
      return {
        processedThroughSequence: Number(state.through_sequence),
        targetSequence: Number(state.through_sequence),
        context: loadContext(this.#database, locator, state),
      };
    });
    if (ready !== null) return ready;
    return transaction(this.#database, "BEGIN IMMEDIATE", () => {
      if (
        this.#database
          .prepare("SELECT 1 FROM threads WHERE tenant_id=? AND thread_id=?")
          .get(locator.tenantId, locator.threadId) === undefined
      ) {
        throw new RunStoreError("model_history_not_found");
      }
      const state =
        loadState(this.#database, locator) ??
        createState(this.#database, locator);
      const targetSequence = loadHead(this.#database, locator);
      if (Number(state.through_sequence) > targetSequence) invalid();
      const rows = this.#database
        .prepare(
          `SELECT ${RAW_COLUMNS} FROM model_history_items
        WHERE tenant_id=? AND thread_id=? AND sequence>? ORDER BY sequence LIMIT ?`,
        )
        .all(
          locator.tenantId,
          locator.threadId,
          state.through_sequence!,
          PAGE_SIZE,
        );
      const next = advance(
        this.#database,
        locator,
        state,
        rows.map((row) => decode(row, locator)),
      );
      if (
        rows.length < PAGE_SIZE &&
        Number(next.through_sequence) !== targetSequence
      )
        invalid();
      return {
        processedThroughSequence: Number(next.through_sequence),
        targetSequence,
        context:
          Number(next.through_sequence) === targetSequence
            ? loadContext(this.#database, locator, next)
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
    return transaction(this.#database, "BEGIN", () => {
      const state = loadState(this.#database, locator);
      if (
        state === undefined ||
        state.through_sequence !== checkpoint.throughHistorySequence ||
        state.fingerprint !== checkpoint.fingerprint ||
        loadHead(this.#database, locator) !== checkpoint.throughHistorySequence
      ) {
        throw new RunStoreError("model_history_context_changed");
      }
      const compaction = loadCompaction(this.#database, locator);
      const rows = this.#database
        .prepare(
          `SELECT refs.sequence AS reference_sequence,
        refs.item_id AS reference_id, refs.item_type AS reference_type, refs.item_digest,
        history.* FROM model_history_context_refs AS refs
        LEFT JOIN model_history_items AS history ON history.tenant_id=refs.tenant_id
          AND history.thread_id=refs.thread_id AND history.sequence=refs.sequence
        WHERE refs.tenant_id=? AND refs.thread_id=? AND refs.item_type<>'compaction'
          AND refs.sequence>? ORDER BY refs.sequence LIMIT ?`,
        )
        .all(
          locator.tenantId,
          locator.threadId,
          Math.max(afterSequence, compaction?.replacesThroughSequence ?? 0),
          limit,
        );
      return rows.map((row) => {
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

/** Called after canonical INSERTs, inside their existing write transaction. */
export function appendSqliteModelHistoryContext(
  database: DatabaseSync,
  items: readonly ModelHistoryItem[],
): void {
  const first = items[0];
  if (first === undefined) return;
  let state = loadState(database, first);
  if (state === undefined && first.sequence === 1)
    state = createState(database, first);
  // Old Threads resume their bounded backfill on reads; writes never scan old bodies.
  if (state === undefined || state.through_sequence !== first.sequence - 1)
    return;
  advance(database, first, state, items);
}

function advance(
  database: DatabaseSync,
  locator: ThreadLocator,
  state: Row,
  items: readonly ModelHistoryItem[],
): Row {
  if (items.length === 0) return state;
  const next = { ...state };
  const insert = database.prepare(`INSERT INTO model_history_context_refs
    (tenant_id, thread_id, sequence, item_id, item_type, boundary_kind, item_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const item of items) {
    validateModelHistoryItem(item);
    if (
      item.tenantId !== locator.tenantId ||
      item.threadId !== locator.threadId ||
      item.sequence !== Number(next.through_sequence) + 1
    )
      invalid();
    const digest = hash(stableJson(item));
    if (item.type === "rollback") {
      applyRollback(database, locator, item);
      next.latest_rollback_sequence = item.sequence;
      next.latest_rollback_digest = digest;
    } else {
      insert.run(
        locator.tenantId,
        locator.threadId,
        item.sequence,
        item.itemId,
        item.type,
        isModelHistoryInstructionBoundary(item)
          ? "instruction"
          : item.type === "message" &&
              item.role === "user" &&
              (item.source === "goal_continuation" ||
                item.source === "goal_steering")
            ? "contextual"
            : "other",
        digest,
      );
    }
    next.through_sequence = item.sequence;
    next.fingerprint = hash(`${next.fingerprint}\n${item.sequence}\n${digest}`);
    next.last_item_digest = digest;
  }
  database
    .prepare(
      `UPDATE model_history_context_state SET through_sequence=?, fingerprint=?,
    last_item_digest=?, latest_rollback_sequence=?, latest_rollback_digest=? WHERE tenant_id=? AND thread_id=?`,
    )
    .run(
      next.through_sequence!,
      next.fingerprint!,
      next.last_item_digest!,
      next.latest_rollback_sequence!,
      next.latest_rollback_digest!,
      locator.tenantId,
      locator.threadId,
    );
  return next;
}

/** Same turn boundary as Domain's replay, using indexed metadata instead of old bodies. */
function applyRollback(
  database: DatabaseSync,
  locator: ThreadLocator,
  marker: Extract<ModelHistoryItem, { type: "rollback" }>,
): void {
  const boundary = database
    .prepare(
      `SELECT COUNT(*) AS removed, MIN(sequence) AS cut FROM
    (SELECT sequence FROM model_history_context_refs WHERE tenant_id=? AND thread_id=?
      AND boundary_kind='instruction' ORDER BY sequence DESC LIMIT ?)`,
    )
    .get(locator.tenantId, locator.threadId, marker.requestedTurns)!;
  let cut = boundary.cut === null ? null : Number(boundary.cut);
  if (cut !== null) {
    const first = database
      .prepare(
        `SELECT MIN(sequence) AS value FROM model_history_context_refs
      WHERE tenant_id=? AND thread_id=? AND boundary_kind='instruction'`,
      )
      .get(locator.tenantId, locator.threadId)!.value;
    if (cut !== first) {
      const previous = database
        .prepare(
          `SELECT sequence FROM model_history_context_refs
        WHERE tenant_id=? AND thread_id=? AND sequence<? AND boundary_kind<>'contextual'
        ORDER BY sequence DESC LIMIT 1`,
        )
        .get(locator.tenantId, locator.threadId, cut);
      if (previous === undefined) invalid();
      cut = Number(
        database
          .prepare(
            `SELECT MIN(sequence) AS value FROM model_history_context_refs
        WHERE tenant_id=? AND thread_id=? AND sequence>? AND sequence<=?`,
          )
          .get(locator.tenantId, locator.threadId, previous.sequence!, cut)!
          .value,
      );
    }
  }
  if (
    marker.removedTurns !== boundary.removed ||
    marker.historyFromSequence !== cut ||
    marker.historyThroughSequence !== marker.sequence - 1
  ) {
    throw new RunStoreError("model_history_rollback_boundary_mismatch");
  }
  if (cut !== null)
    database
      .prepare(
        `DELETE FROM model_history_context_refs
    WHERE tenant_id=? AND thread_id=? AND sequence>=?`,
      )
      .run(locator.tenantId, locator.threadId, cut);
}

function loadContext(
  database: DatabaseSync,
  locator: ThreadLocator,
  state: Row,
): ModelHistoryContextState {
  const lastItem =
    Number(state.through_sequence) === 0
      ? null
      : loadItem(
          database,
          locator,
          Number(state.through_sequence),
          String(state.last_item_digest),
        );
  const latestRollback =
    state.latest_rollback_sequence === null
      ? null
      : loadItem(
          database,
          locator,
          Number(state.latest_rollback_sequence),
          String(state.latest_rollback_digest),
        );
  if (latestRollback !== null && latestRollback.type !== "rollback") invalid();
  return {
    checkpoint: {
      throughHistorySequence: Number(state.through_sequence),
      fingerprint: String(state.fingerprint),
    },
    lastItem,
    lastCompaction: loadCompaction(database, locator),
    latestRollback:
      latestRollback as ModelHistoryContextState["latestRollback"],
  };
}

function loadCompaction(
  database: DatabaseSync,
  locator: ThreadLocator,
): ModelHistoryContextState["lastCompaction"] {
  const row = database
    .prepare(
      `SELECT refs.sequence AS reference_sequence,
    refs.item_id AS reference_id, refs.item_type AS reference_type, refs.item_digest,
    history.* FROM model_history_context_refs AS refs
    LEFT JOIN model_history_items AS history ON history.tenant_id=refs.tenant_id
      AND history.thread_id=refs.thread_id AND history.sequence=refs.sequence
    WHERE refs.tenant_id=? AND refs.thread_id=? AND refs.item_type='compaction'
    ORDER BY refs.sequence DESC LIMIT 1`,
    )
    .get(locator.tenantId, locator.threadId);
  if (row === undefined) return null;
  const item = decodeReference(row, locator);
  if (item.type !== "compaction") invalid();
  return item as ModelHistoryContextState["lastCompaction"];
}

function loadItem(
  database: DatabaseSync,
  locator: ThreadLocator,
  sequence: number,
  digest: string,
): ModelHistoryItem {
  const row = database
    .prepare(
      `SELECT ${RAW_COLUMNS} FROM model_history_items
    WHERE tenant_id=? AND thread_id=? AND sequence=?`,
    )
    .get(locator.tenantId, locator.threadId, sequence);
  if (row === undefined) invalid();
  const item = decode(row, locator);
  if (hash(stableJson(item)) !== digest) invalid();
  return item;
}

function decodeReference(row: Row, locator: ThreadLocator): ModelHistoryItem {
  const item = decode(row, locator);
  if (
    item.sequence !== row.reference_sequence ||
    item.itemId !== row.reference_id ||
    item.type !== row.reference_type ||
    hash(stableJson(item)) !== row.item_digest
  )
    invalid();
  return item;
}

function decode(row: Row, locator: ThreadLocator): ModelHistoryItem {
  if (typeof row.item_json !== "string") invalid();
  const item = decodeSqliteModelHistoryItem(row.item_json);
  validateModelHistoryItem(item);
  if (
    item.tenantId !== locator.tenantId ||
    item.threadId !== locator.threadId ||
    item.tenantId !== row.tenant_id ||
    item.threadId !== row.thread_id ||
    item.sequence !== row.sequence ||
    item.itemId !== row.item_id ||
    item.type !== row.item_type ||
    item.runId !== row.run_id ||
    item.segmentId !== row.segment_id ||
    item.createdAt !== row.created_at
  )
    invalid();
  return item;
}

function loadState(
  database: DatabaseSync,
  locator: ThreadLocator,
): Row | undefined {
  const state = database
    .prepare(
      `SELECT * FROM model_history_context_state WHERE tenant_id=? AND thread_id=?`,
    )
    .get(locator.tenantId, locator.threadId);
  if (
    state !== undefined &&
    (state.algorithm_version !== 1 ||
      !Number.isSafeInteger(state.through_sequence) ||
      Number(state.through_sequence) < 0 ||
      typeof state.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(state.fingerprint))
  )
    invalid();
  return state;
}

function createState(database: DatabaseSync, locator: ThreadLocator): Row {
  // A new seed also fences readers after invalidation/rebuild at the same raw head.
  database
    .prepare(
      `INSERT INTO model_history_context_state
    (tenant_id, thread_id, algorithm_version, through_sequence, fingerprint) VALUES (?, ?, 1, 0, ?)`,
    )
    .run(
      locator.tenantId,
      locator.threadId,
      hash(
        stableJson([
          "crewon.context-index.v1",
          { tenantId: locator.tenantId, threadId: locator.threadId },
          randomUUID(),
        ]),
      ),
    );
  return loadState(database, locator)!;
}

function loadHead(database: DatabaseSync, locator: ThreadLocator): number {
  return Number(
    database
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS value FROM model_history_items
    WHERE tenant_id=? AND thread_id=?`,
      )
      .get(locator.tenantId, locator.threadId)!.value,
  );
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalid(): never {
  throw new RunStoreError("model_history_context_invalid");
}

function transaction<T>(
  database: DatabaseSync,
  begin: "BEGIN" | "BEGIN IMMEDIATE",
  work: () => T,
): T {
  database.exec(begin);
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
