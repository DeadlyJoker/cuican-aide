import { readSqliteTranscriptRuns } from "./thread-transcript-run-snapshot.ts";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type {
  MessageRecord,
  ThreadMessageWindow,
  ThreadMessageWindowQuery,
  ThreadMessageWindowStore,
  ThreadScopedLocator,
} from "@crewon/application";
import type { ThreadState } from "@crewon/domain";
import { readSqliteMessageRunBindings } from "./sqlite-message-run-evidence.ts";
import {
  assertMessageWindowThread,
  selectMessageWindowSequences,
  validateMessageWindowQuery,
} from "./thread-message-window.ts";

type Row = Record<string, SQLOutputValue>;
const VISIBLE = `NOT EXISTS (SELECT 1 FROM message_invalidations i WHERE i.tenant_id=m.tenant_id AND i.thread_id=m.thread_id AND i.message_sequence=m.sequence)`;

type Dependencies = {
  assertOpen(): void;
  loadThread(locator: ThreadScopedLocator): ThreadState | null;
  decodeMessage(row: Row, locator: ThreadScopedLocator): MessageRecord;
};

export class SqliteThreadMessageWindowStore
  implements ThreadMessageWindowStore
{
  readonly #database: DatabaseSync;
  readonly #dependencies: Dependencies;
  constructor(database: DatabaseSync, dependencies: Dependencies) {
    this.#database = database;
    this.#dependencies = dependencies;
  }

  async readWindow(
    query: ThreadMessageWindowQuery,
  ): Promise<ThreadMessageWindow> {
    this.#dependencies.assertOpen();
    validateMessageWindowQuery(query);
    this.#database.exec("BEGIN");
    try {
      const thread = this.#dependencies.loadThread(query);
      assertMessageWindowThread(thread, query);
      const older = query.position?.direction !== "newer";
      const position = query.position;
      const rows = this.#database
        .prepare(
          `SELECT m.sequence,
        length(CAST(m.content AS BLOB)) + length(CAST(m.message_json AS BLOB)) AS stored_bytes
        FROM messages m WHERE m.tenant_id=? AND m.thread_id=?
        ${position === null ? "" : `AND m.sequence ${older ? "<" : ">"} ?`}
        AND ${VISIBLE} ORDER BY m.sequence ${older ? "DESC" : "ASC"} LIMIT ?`,
        )
        .all(
          query.tenantId,
          query.threadId,
          ...(position === null ? [] : [position.messageSequence]),
          query.limit,
        );
      const sequences = selectMessageWindowSequences(
        rows.map((row) => ({
          sequence: Number(row.sequence),
          storedBytes: Number(row.stored_bytes),
        })),
      );
      const messages =
        sequences.length === 0
          ? []
          : this.#database
              .prepare(
                `SELECT m.* FROM messages m
        WHERE m.tenant_id=? AND m.thread_id=? AND m.sequence IN (${sequences.map(() => "?").join(",")}) ORDER BY m.sequence ASC`,
              )
              .all(query.tenantId, query.threadId, ...sequences)
              .map((row) => this.#dependencies.decodeMessage(row, query));
      const first = messages[0];
      const last = messages.at(-1);
      const exists = (sequence: number, direction: "<" | ">") =>
        this.#database
          .prepare(
            `SELECT 1 FROM messages m
        WHERE m.tenant_id=? AND m.thread_id=? AND m.sequence ${direction} ? AND ${VISIBLE} ORDER BY m.sequence ${direction === "<" ? "DESC" : "ASC"} LIMIT 1`,
          )
          .get(query.tenantId, query.threadId, sequence) !== undefined;
      const runBindings =
        query.view === "transcript" || query.view === "transcriptSnapshot"
          ? readSqliteMessageRunBindings(this.#database, query, messages)
          : undefined;
      const result = {
        thread,
        messages,
        hasOlder: first !== undefined && exists(first.sequence, "<"),
        hasNewer: last !== undefined && exists(last.sequence, ">"),
        ...(runBindings === undefined ? {} : { runBindings }),
        ...(query.view === "transcriptSnapshot"
          ? {
              runSnapshot: readSqliteTranscriptRuns(
                this.#database,
                query,
                runBindings!,
              ),
            }
          : {}),
      };
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
