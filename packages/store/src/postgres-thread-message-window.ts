import type { Pool } from "pg";
import { readPostgresMessageRunBindings } from "./postgres-message-run-evidence.ts";
import type {
  ThreadMessageWindow,
  ThreadMessageWindowQuery,
  ThreadMessageWindowStore,
} from "@crewon/application";
import {
  decodePostgresMessage,
  decodePostgresThreadState,
  safeInteger,
  type PostgresMessageRow,
  type PostgresThreadRow,
} from "./postgres-thread-codec.ts";
import {
  assertMessageWindowThread,
  selectMessageWindowSequences,
  validateMessageWindowQuery,
} from "./thread-message-window.ts";

export class PostgresThreadMessageWindowStore
  implements ThreadMessageWindowStore
{
  readonly #pool: Pool;
  readonly #schemaSql: string;
  readonly #assertOpen: () => void;
  constructor(pool: Pool, schemaSql: string, assertOpen: () => void) {
    this.#pool = pool;
    this.#schemaSql = schemaSql;
    this.#assertOpen = assertOpen;
  }

  async readWindow(
    query: ThreadMessageWindowQuery,
  ): Promise<ThreadMessageWindow> {
    this.#assertOpen();
    validateMessageWindowQuery(query);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const state = await client.query<PostgresThreadRow>(
        `SELECT * FROM ${this.#schemaSql}.threads WHERE tenant_id=$1 AND space_id=$2 AND thread_id=$3`,
        [query.tenantId, query.spaceId, query.threadId],
      );
      const thread =
        state.rows[0] === undefined
          ? null
          : decodePostgresThreadState(state.rows[0], query);
      assertMessageWindowThread(thread, query);
      const visible = `NOT EXISTS (SELECT 1 FROM ${this.#schemaSql}.message_invalidations i WHERE i.tenant_id=m.tenant_id AND i.thread_id=m.thread_id AND i.message_sequence=m.sequence)`;
      const older = query.position?.direction !== "newer";
      const position = query.position;
      const metadata = await client.query<{
        sequence: string | number;
        stored_bytes: string | number;
      }>(
        `SELECT m.sequence,
        octet_length(m.content)::bigint + octet_length(m.message_json::text)::bigint AS stored_bytes
        FROM ${this.#schemaSql}.messages m WHERE m.tenant_id=$1 AND m.thread_id=$2
        ${position === null ? "" : `AND m.sequence ${older ? "<" : ">"} $4`}
        AND ${visible} ORDER BY m.sequence ${older ? "DESC" : "ASC"} LIMIT $3`,
        [
          query.tenantId,
          query.threadId,
          query.limit,
          ...(position === null ? [] : [position.messageSequence]),
        ],
      );
      const sequences = selectMessageWindowSequences(
        metadata.rows.map((row) => ({
          sequence: safeInteger(row.sequence),
          storedBytes: safeInteger(row.stored_bytes),
        })),
      );
      const rows =
        sequences.length === 0
          ? []
          : (
              await client.query<PostgresMessageRow>(
                `SELECT m.* FROM ${this.#schemaSql}.messages m
        WHERE m.tenant_id=$1 AND m.thread_id=$2 AND m.sequence=ANY($3::bigint[]) ORDER BY m.sequence ASC`,
                [query.tenantId, query.threadId, sequences],
              )
            ).rows;
      const messages = rows.map((row) => decodePostgresMessage(row, query));
      const first = messages[0];
      const last = messages.at(-1);
      const exists = async (sequence: number, direction: "<" | ">") =>
        (
          await client.query(
            `SELECT 1 FROM ${this.#schemaSql}.messages m
        WHERE m.tenant_id=$1 AND m.thread_id=$2 AND m.sequence ${direction} $3 AND ${visible} ORDER BY m.sequence ${direction === "<" ? "DESC" : "ASC"} LIMIT 1`,
            [query.tenantId, query.threadId, sequence],
          )
        ).rows.length > 0;
      const hasOlder =
        first !== undefined && (await exists(first.sequence, "<"));
      const hasNewer = last !== undefined && (await exists(last.sequence, ">"));
      const bindings =
        query.view === "transcript"
          ? {
              runBindings: await readPostgresMessageRunBindings(
                client,
                this.#schemaSql,
                query,
                messages,
              ),
            }
          : {};
      await client.query("COMMIT");
      return { thread, messages, hasOlder, hasNewer, ...bindings };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
