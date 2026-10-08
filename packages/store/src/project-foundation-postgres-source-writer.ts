import type { PoolClient } from "pg";
import { projectSourceScalarLength } from "@crewon/domain";
import {
  foundationFailure,
  foundationJson,
  type FoundationPrepared,
} from "./project-foundation-store-support.ts";

/** Source insertion borrows its caller's already-open original project transaction. */
export class ProjectFoundationPostgresSourceWriter {
  readonly #prefix: string;
  readonly #assertOpen: () => void;
  constructor(input: { prefix: string; assertOpen(): void }) {
    this.#prefix = input.prefix;
    this.#assertOpen = input.assertOpen;
  }

  async insertSource(
    client: PoolClient,
    prepared: Exclude<FoundationPrepared, { kind: "save-proposal" }>,
  ) {
    const source = prepared.source;
    if (source === null)
      foundationFailure("project_foundation_source_required");
    await this.#query(
      client,
      `INSERT INTO ${this.#prefix}project_sources
      (tenant_id,space_id,project_id,source_revision,content_digest,file_digest,character_length,record_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        source.tenantId,
        source.spaceId,
        source.projectId,
        source.revision,
        source.digest,
        source.fileDigest,
        source.characterLength,
        foundationJson(source, 8_192),
      ],
    );
    await this.#insertRows(
      client,
      "project_source_chunks",
      "tenant_id,space_id,project_id,source_revision,chunk_index,start_offset,character_length,content,content_digest",
      prepared.chunks.map((chunk) => [
        chunk.tenantId,
        chunk.spaceId,
        chunk.projectId,
        chunk.sourceRevision,
        chunk.index,
        chunk.startOffset,
        projectSourceScalarLength(chunk.content),
        chunk.content,
        chunk.digest,
      ]),
    );
    await this.#insertRows(
      client,
      "project_source_chapters",
      "tenant_id,space_id,project_id,source_revision,chapter_id,start_offset,end_offset,record_json",
      prepared.chapters.map((chapter) => [
        chapter.tenantId,
        chapter.spaceId,
        chapter.projectId,
        chapter.sourceRevision,
        chapter.chapterId,
        chapter.startOffset,
        chapter.endOffset,
        foundationJson(chapter, 4_096),
      ]),
    );
  }

  async #insertRows(
    client: PoolClient,
    table: "project_source_chunks" | "project_source_chapters",
    columns: string,
    rows: readonly unknown[][],
  ) {
    const width = columns.split(",").length;
    for (let offset = 0; offset < rows.length; offset += 128) {
      const batch = rows.slice(offset, offset + 128);
      const tuples = batch
        .map(
          (_, i) =>
            `(${Array.from({ length: width }, (_, j) => `$${i * width + j + 1}`).join(",")})`,
        )
        .join(",");
      await this.#query(
        client,
        `INSERT INTO ${this.#prefix}${table} (${columns}) VALUES ${tuples}`,
        batch.flat(),
      );
    }
  }

  async #query(client: PoolClient, sql: string, values: unknown[] = []) {
    this.#assertOpen();
    const result = await client.query(sql, values);
    this.#assertOpen();
    return result;
  }
}
