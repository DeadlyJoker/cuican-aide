use std::path::Path;
use std::time::Duration;

use sqlx::ConnectOptions as _;
use sqlx::Row as _;
use sqlx::SqlitePool;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::sqlite::SqliteJournalMode;
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::sqlite::SqliteSynchronous;

use crate::DeviceJournalError;
use crate::authority;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub(crate) async fn open_pool(path: &Path) -> Result<SqlitePool, DeviceJournalError> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5))
        .disable_statement_logging();
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?;
    if let Err(error) = MIGRATOR.run(&pool).await {
        pool.close().await;
        return Err(error.into());
    }
    if let Err(error) = assert_authority(&pool).await {
        pool.close().await;
        return Err(error);
    }
    Ok(pool)
}

async fn assert_authority(pool: &SqlitePool) -> Result<(), DeviceJournalError> {
    assert_runtime_pragmas(pool).await?;
    let rows = sqlx::query("SELECT singleton, version FROM device_journal_schema")
        .fetch_all(pool)
        .await?;
    if rows.len() != 1
        || rows[0].try_get::<i64, _>("singleton")? != 1
        || rows[0].try_get::<i64, _>("version")? != 1
    {
        return Err(authority("device_journal_schema_unsupported"));
    }
    assert_columns(
        pool,
        "device_journal_schema",
        &[("singleton", 1), ("version", 0)],
    )
    .await?;
    assert_columns(
        pool,
        "workspace_executions",
        &[
            ("execution_id", 1),
            ("execution_kind", 0),
            ("command_fingerprint", 0),
            ("command_json", 0),
            ("device_id", 0),
            ("lease_id", 0),
            ("lease_epoch", 0),
            ("expires_at", 0),
            ("workspace_binding_id", 0),
            ("incarnation_id", 0),
            ("device_binding_id", 0),
            ("runtime_binding_id", 0),
            ("policy_snapshot_id", 0),
            ("action_digest", 0),
            ("command_digest", 0),
            ("idempotency_key", 0),
            ("acknowledged_through", 0),
            ("created_at", 0),
        ],
    )
    .await?;
    assert_columns(
        pool,
        "workspace_events",
        &[
            ("execution_id", 1),
            ("sequence", 2),
            ("event_type", 0),
            ("event_fingerprint", 0),
            ("event_json", 0),
            ("device_id", 0),
            ("receipt_id", 0),
            ("connection_epoch", 0),
            ("workspace_binding_id", 0),
            ("incarnation_id", 0),
            ("device_binding_id", 0),
            ("runtime_binding_id", 0),
            ("action_digest", 0),
            ("command_digest", 0),
            ("observed_at", 0),
        ],
    )
    .await?;
    assert_columns(
        pool,
        "workspace_acks",
        &[
            ("execution_id", 1),
            ("through_sequence", 2),
            ("ack_fingerprint", 0),
            ("ack_json", 0),
            ("device_id", 0),
            ("receipt_id", 0),
            ("connection_epoch", 0),
            ("workspace_binding_id", 0),
            ("incarnation_id", 0),
            ("device_binding_id", 0),
            ("runtime_binding_id", 0),
            ("action_digest", 0),
            ("command_digest", 0),
            ("acknowledged_at", 0),
        ],
    )
    .await?;
    assert_table_sql(
        pool,
        "device_journal_schema",
        &["strict", "check (singleton = 1)", "check (version >= 1)"],
    )
    .await?;
    assert_table_sql(
        pool,
        "workspace_executions",
        &[
            "strict",
            "check (execution_kind = 'workspacelist')",
            "json_valid(command_json)",
            "length(command_fingerprint) = 71",
            "substr(command_fingerprint, 1, 7) = 'sha256:'",
            "substr(command_fingerprint, 8) not glob '*[^0-9a-f]*'",
            "check (lease_epoch >= 1)",
            "check (acknowledged_through between 0 and 2)",
        ],
    )
    .await?;
    assert_table_sql(
        pool,
        "workspace_events",
        &[
            "strict",
            "primary key (execution_id, sequence)",
            "references workspace_executions(execution_id) on delete restrict",
            "length(event_fingerprint) = 71",
            "substr(event_fingerprint, 1, 7) = 'sha256:'",
            "substr(event_fingerprint, 8) not glob '*[^0-9a-f]*'",
            "json_valid(event_json)",
            "check (sequence in (1, 2))",
            "sequence = 1 and event_type = 'workspace_list.accepted'",
            "sequence = 2 and event_type in",
            "check (connection_epoch >= 1)",
        ],
    )
    .await?;
    assert_table_sql(
        pool,
        "workspace_acks",
        &[
            "strict",
            "primary key (execution_id, through_sequence)",
            "references workspace_events(execution_id, sequence) on delete restrict",
            "length(ack_fingerprint) = 71",
            "substr(ack_fingerprint, 1, 7) = 'sha256:'",
            "substr(ack_fingerprint, 8) not glob '*[^0-9a-f]*'",
            "json_valid(ack_json)",
            "check (through_sequence in (1, 2))",
            "check (connection_epoch >= 1)",
        ],
    )
    .await?;
    assert_foreign_key(
        pool,
        "workspace_events",
        "workspace_executions",
        &[("execution_id", "execution_id")],
    )
    .await?;
    assert_foreign_key(
        pool,
        "workspace_acks",
        "workspace_events",
        &[
            ("execution_id", "execution_id"),
            ("through_sequence", "sequence"),
        ],
    )
    .await?;
    let index_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index' AND name IN (?, ?) AND tbl_name IN (?, ?)",
    )
    .bind("workspace_executions_unacknowledged_idx")
    .bind("workspace_events_accepted_receipt_idx")
    .bind("workspace_executions")
    .bind("workspace_events")
    .fetch_one(pool)
    .await?;
    if index_count != 2 {
        return Err(authority("device_journal_schema_corrupt"));
    }
    let unacknowledged_index_sql: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?")
            .bind("workspace_executions_unacknowledged_idx")
            .fetch_one(pool)
            .await?;
    let unacknowledged_index_sql = unacknowledged_index_sql
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if !unacknowledged_index_sql
        .contains("on workspace_executions (execution_id, acknowledged_through)")
    {
        return Err(authority("device_journal_schema_corrupt"));
    }
    let receipt_index_sql: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?")
            .bind("workspace_events_accepted_receipt_idx")
            .fetch_one(pool)
            .await?;
    let receipt_index_sql = receipt_index_sql
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if !receipt_index_sql.contains("unique index")
        || !receipt_index_sql.contains("(receipt_id)")
        || !receipt_index_sql.contains("where sequence = 1")
    {
        return Err(authority("device_journal_schema_corrupt"));
    }
    let foreign_key_errors = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(pool)
        .await?;
    let quick_check: String = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_one(pool)
        .await?;
    if !foreign_key_errors.is_empty() || quick_check != "ok" {
        return Err(authority("device_journal_authority_corrupt"));
    }
    Ok(())
}

async fn assert_runtime_pragmas(pool: &SqlitePool) -> Result<(), DeviceJournalError> {
    let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(pool)
        .await?;
    let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
        .fetch_one(pool)
        .await?;
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(pool)
        .await?;
    let busy_timeout: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
        .fetch_one(pool)
        .await?;
    if journal_mode != "wal" || synchronous != 2 || foreign_keys != 1 || busy_timeout < 5_000 {
        return Err(authority("device_journal_runtime_unsafe"));
    }
    Ok(())
}

async fn assert_columns(
    pool: &SqlitePool,
    table: &str,
    expected: &[(&str, i64)],
) -> Result<(), DeviceJournalError> {
    let rows = match table {
        "device_journal_schema" => sqlx::query("PRAGMA table_info(device_journal_schema)"),
        "workspace_executions" => sqlx::query("PRAGMA table_info(workspace_executions)"),
        "workspace_events" => sqlx::query("PRAGMA table_info(workspace_events)"),
        "workspace_acks" => sqlx::query("PRAGMA table_info(workspace_acks)"),
        _ => return Err(authority("device_journal_schema_corrupt")),
    }
    .fetch_all(pool)
    .await?;
    if rows.len() != expected.len()
        || rows.iter().zip(expected).any(|(row, (name, primary_key))| {
            row.try_get::<String, _>("name").ok().as_deref() != Some(*name)
                || row.try_get::<String, _>("type").ok().as_deref()
                    != Some(expected_column_type(table, name))
                || row.try_get::<i64, _>("notnull").ok() != Some(1)
                || row.try_get::<i64, _>("pk").ok() != Some(*primary_key)
        })
    {
        return Err(authority("device_journal_schema_corrupt"));
    }
    Ok(())
}

fn expected_column_type(table: &str, column: &str) -> &'static str {
    if matches!(
        (table, column),
        ("device_journal_schema", "singleton" | "version")
            | (
                "workspace_executions",
                "lease_epoch" | "acknowledged_through"
            )
            | ("workspace_events", "sequence" | "connection_epoch")
            | ("workspace_acks", "through_sequence" | "connection_epoch")
    ) {
        "INTEGER"
    } else {
        "TEXT"
    }
}

async fn assert_table_sql(
    pool: &SqlitePool,
    table: &str,
    required: &[&str],
) -> Result<(), DeviceJournalError> {
    let sql: String =
        sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
            .bind(table)
            .fetch_one(pool)
            .await?;
    let normalized = sql
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if required
        .iter()
        .any(|fragment| !normalized.contains(fragment))
    {
        return Err(authority("device_journal_schema_corrupt"));
    }
    Ok(())
}

async fn assert_foreign_key(
    pool: &SqlitePool,
    table: &str,
    target: &str,
    expected_columns: &[(&str, &str)],
) -> Result<(), DeviceJournalError> {
    let rows = match table {
        "workspace_events" => sqlx::query("PRAGMA foreign_key_list(workspace_events)"),
        "workspace_acks" => sqlx::query("PRAGMA foreign_key_list(workspace_acks)"),
        _ => return Err(authority("device_journal_schema_corrupt")),
    }
    .fetch_all(pool)
    .await?;
    if rows.len() != expected_columns.len()
        || rows.iter().zip(expected_columns).any(|(row, (from, to))| {
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
