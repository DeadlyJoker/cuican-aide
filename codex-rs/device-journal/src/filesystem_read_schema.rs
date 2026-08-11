use sqlx::Row as _;
use sqlx::SqlitePool;

use crate::DeviceJournalError;
use crate::authority;

pub(super) async fn assert_authority(pool: &SqlitePool) -> Result<(), DeviceJournalError> {
    assert_columns(
        pool,
        "filesystem_read_executions",
        &[
            ("execution_id", "TEXT", 1),
            ("command_fingerprint", "TEXT", 0),
            ("command_json", "TEXT", 0),
            ("device_id", "TEXT", 0),
            ("lease_id", "TEXT", 0),
            ("lease_epoch", "INTEGER", 0),
            ("workspace_binding_id", "TEXT", 0),
            ("incarnation_id", "TEXT", 0),
            ("command_digest", "TEXT", 0),
            ("acknowledged_through", "INTEGER", 0),
            ("created_at", "TEXT", 0),
        ],
    )
    .await?;
    assert_columns(
        pool,
        "filesystem_read_events",
        &[
            ("execution_id", "TEXT", 1),
            ("sequence", "INTEGER", 2),
            ("event_type", "TEXT", 0),
            ("event_fingerprint", "TEXT", 0),
            ("event_json", "TEXT", 0),
            ("receipt_id", "TEXT", 0),
            ("connection_epoch", "INTEGER", 0),
            ("observed_at", "TEXT", 0),
        ],
    )
    .await?;
    assert_columns(
        pool,
        "filesystem_read_acks",
        &[
            ("execution_id", "TEXT", 1),
            ("through_sequence", "INTEGER", 2),
            ("ack_fingerprint", "TEXT", 0),
            ("ack_json", "TEXT", 0),
            ("acknowledged_at", "TEXT", 0),
        ],
    )
    .await?;
    assert_sql(
        pool,
        "filesystem_read_executions",
        &[
            "strict",
            "json_valid(command_json)",
            "length(command_fingerprint) = 71",
            "length(command_digest) = 71",
            "check (lease_epoch >= 1)",
            "check (acknowledged_through between 0 and 2)",
        ],
    )
    .await?;
    assert_sql(
        pool,
        "filesystem_read_events",
        &[
            "strict",
            "primary key (execution_id, sequence)",
            "references filesystem_read_executions(execution_id) on delete restrict",
            "length(event_fingerprint) = 71",
            "json_valid(event_json)",
            "workspace_read.accepted",
            "workspace_read.completed",
            "workspace_read.unknown_outcome",
        ],
    )
    .await?;
    assert_sql(
        pool,
        "filesystem_read_acks",
        &[
            "strict",
            "primary key (execution_id, through_sequence)",
            "references filesystem_read_events(execution_id, sequence) on delete restrict",
            "length(ack_fingerprint) = 71",
            "json_valid(ack_json)",
        ],
    )
    .await?;
    assert_foreign_key(
        pool,
        "filesystem_read_events",
        "filesystem_read_executions",
        &[("execution_id", "execution_id")],
    )
    .await?;
    assert_foreign_key(
        pool,
        "filesystem_read_acks",
        "filesystem_read_events",
        &[
            ("execution_id", "execution_id"),
            ("through_sequence", "sequence"),
        ],
    )
    .await?;
    assert_index(
        pool,
        "filesystem_read_executions_unacknowledged_idx",
        "filesystem_read_executions",
        &["(execution_id, acknowledged_through)"],
    )
    .await?;
    assert_index(
        pool,
        "filesystem_read_events_accepted_receipt_idx",
        "filesystem_read_events",
        &["unique index", "(receipt_id)", "where sequence = 1"],
    )
    .await
}

async fn assert_columns(
    pool: &SqlitePool,
    table: &str,
    expected: &[(&str, &str, i64)],
) -> Result<(), DeviceJournalError> {
    let rows = match table {
        "filesystem_read_executions" => {
            sqlx::query("PRAGMA table_info(filesystem_read_executions)")
        }
        "filesystem_read_events" => sqlx::query("PRAGMA table_info(filesystem_read_events)"),
        "filesystem_read_acks" => sqlx::query("PRAGMA table_info(filesystem_read_acks)"),
        _ => return Err(authority("device_journal_schema_corrupt")),
    }
    .fetch_all(pool)
    .await?;
    if rows.len() != expected.len()
        || rows.iter().zip(expected).any(|(row, (name, kind, pk))| {
            row.try_get::<String, _>("name").ok().as_deref() != Some(*name)
                || row.try_get::<String, _>("type").ok().as_deref() != Some(*kind)
                || row.try_get::<i64, _>("notnull").ok() != Some(1)
                || row.try_get::<i64, _>("pk").ok() != Some(*pk)
        })
    {
        return Err(authority("device_journal_schema_corrupt"));
    }
    Ok(())
}

async fn assert_sql(
    pool: &SqlitePool,
    name: &str,
    required: &[&str],
) -> Result<(), DeviceJournalError> {
    let sql: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
            .bind(name)
            .fetch_one(pool)
            .await?;
    let normalized = sql
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if required.iter().any(|part| !normalized.contains(part)) {
        return Err(authority("device_journal_schema_corrupt"));
    }
    Ok(())
}

async fn assert_foreign_key(
    pool: &SqlitePool,
    table: &str,
    target: &str,
    expected: &[(&str, &str)],
) -> Result<(), DeviceJournalError> {
    let rows = match table {
        "filesystem_read_events" => sqlx::query("PRAGMA foreign_key_list(filesystem_read_events)"),
        "filesystem_read_acks" => sqlx::query("PRAGMA foreign_key_list(filesystem_read_acks)"),
        _ => return Err(authority("device_journal_schema_corrupt")),
    }
    .fetch_all(pool)
    .await?;
    if rows.len() != expected.len()
        || rows.iter().zip(expected).any(|(row, (from, to))| {
            row.try_get::<String, _>("table").ok().as_deref() != Some(target)
                || row.try_get::<String, _>("on_delete").ok().as_deref() != Some("RESTRICT")
                || row.try_get::<String, _>("from").ok().as_deref() != Some(*from)
                || row.try_get::<String, _>("to").ok().as_deref() != Some(*to)
        })
    {
        return Err(authority("device_journal_schema_corrupt"));
    }
    Ok(())
}

async fn assert_index(
    pool: &SqlitePool,
    name: &str,
    table: &str,
    required: &[&str],
) -> Result<(), DeviceJournalError> {
    let row =
        sqlx::query("SELECT tbl_name, sql FROM sqlite_schema WHERE type = 'index' AND name = ?")
            .bind(name)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| authority("device_journal_schema_corrupt"))?;
    let sql: String = row.try_get("sql")?;
    let normalized = sql
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if row.try_get::<String, _>("tbl_name")? != table
        || required.iter().any(|part| !normalized.contains(part))
    {
        return Err(authority("device_journal_schema_corrupt"));
    }
    Ok(())
}
