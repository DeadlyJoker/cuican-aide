import type { DatabaseSync } from "node:sqlite";
import {
  assertSqliteAssetOwnedSchema,
  migrateSqliteAssetOwnedSchema,
  type AssetOwnedSchema,
} from "./project-asset-owned-schema.ts";
const table = "project_media_image_review_jobs",
  marker = "project_media_image_review_job_schema_version";
const definition: AssetOwnedSchema = {
  tables: [table, marker],
  marker,
  functions: [],
  error: "project_media_image_review_job_schema_invalid",
  sql(pg) {
    if (pg)
      throw new Error("project_media_image_review_job_native_sqlite_only");
    return (
      `CREATE TABLE ${table}(tenant_id TEXT NOT NULL,space_id TEXT NOT NULL,run_id TEXT NOT NULL,thread_id TEXT NOT NULL,content_digest TEXT NOT NULL,record_json TEXT NOT NULL CHECK(json_valid(record_json) AND json_type(record_json)='object' AND length(CAST(record_json AS BLOB))<=8192),PRIMARY KEY(tenant_id,run_id),FOREIGN KEY(tenant_id,run_id) REFERENCES run_snapshots(tenant_id,run_id) ON DELETE RESTRICT,FOREIGN KEY(tenant_id,thread_id) REFERENCES threads(tenant_id,thread_id) ON DELETE RESTRICT) STRICT;
    CREATE TABLE ${marker}(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,migration_digest TEXT NOT NULL,schema_digest TEXT NOT NULL) STRICT;` +
      [table, marker]
        .map(
          (t) =>
            `CREATE TRIGGER ${t}_immutable BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'project_media_image_review_job_immutable'); END; CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'project_media_image_review_job_immutable'); END;`,
        )
        .join("")
    );
  },
};
export const assertSqliteMediaImageReviewJobSchema = (
  db: DatabaseSync,
  optional = false,
) => assertSqliteAssetOwnedSchema(db, definition, optional);
export const migrateSqliteMediaImageReviewJobs = (db: DatabaseSync) =>
  migrateSqliteAssetOwnedSchema(db, definition);
