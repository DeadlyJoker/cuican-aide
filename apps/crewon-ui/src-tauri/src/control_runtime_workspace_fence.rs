use std::path::Path;

use rusqlite::Connection;
use rusqlite::OpenFlags;
use rusqlite::OptionalExtension;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum WorkspaceSwitchFenceError {
    ActiveAuthority,
    Unavailable,
}

pub(super) struct WorkspaceSwitchFence {
    database: Option<Connection>,
}

impl std::fmt::Debug for WorkspaceSwitchFence {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("WorkspaceSwitchFence([REDACTED])")
    }
}

impl WorkspaceSwitchFence {
    pub(super) fn begin(path: &Path) -> Result<Self, WorkspaceSwitchFenceError> {
        let database = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?;
        database
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?;
        let fence = Self {
            database: Some(database),
        };
        fence.validate()?;
        Ok(fence)
    }

    fn validate(&self) -> Result<(), WorkspaceSwitchFenceError> {
        let database = self
            .database
            .as_ref()
            .ok_or(WorkspaceSwitchFenceError::Unavailable)?;
        let user_version = database
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?;
        if user_version > 23 {
            return Err(WorkspaceSwitchFenceError::Unavailable);
        }
        if !table_exists(database, "run_snapshots")?
            || !table_exists(database, "work_items")?
            || validate_run_work_schema(database).is_err()
        {
            return Err(WorkspaceSwitchFenceError::Unavailable);
        }
        if database
            .query_row(
                "SELECT 1 FROM run_snapshots
                     WHERE json_extract(state_json, '$.status') IS NULL
                        OR json_extract(state_json, '$.status')
                           NOT IN ('completed', 'failed', 'canceled')
                     LIMIT 1",
                [],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?
            .is_some()
        {
            return Err(WorkspaceSwitchFenceError::ActiveAuthority);
        }
        if database
            .query_row(
                "SELECT 1 FROM work_items
                 WHERE status IS NULL OR status <> 'completed' LIMIT 1",
                [],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?
            .is_some()
        {
            return Err(WorkspaceSwitchFenceError::ActiveAuthority);
        }
        let workspace_tables = [
            "workspace_operations",
            "workspace_operation_revisions",
            "workspace_delivery_attempts",
            "workspace_operation_receipts",
        ]
        .map(|table| table_exists(database, table))
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
        let present = workspace_tables.iter().filter(|present| **present).count();
        if present != 0 && present != workspace_tables.len() {
            return Err(WorkspaceSwitchFenceError::Unavailable);
        }
        if present == 0 {
            return if user_version < 23 {
                Ok(())
            } else {
                Err(WorkspaceSwitchFenceError::Unavailable)
            };
        }
        if user_version != 23 {
            return Err(WorkspaceSwitchFenceError::Unavailable);
        }
        validate_workspace_schema(database)?;
        let active_operation = database
            .query_row(
                "SELECT 1 FROM workspace_operations
                 WHERE status IS NULL
                    OR status NOT IN ('completed', 'failed', 'canceled')
                 LIMIT 1",
                [],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?
            .is_some();
        let active_attempt = database
            .query_row(
                "SELECT 1 FROM workspace_delivery_attempts
                 WHERE status IS NULL OR status <> 'settled' LIMIT 1",
                [],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?
            .is_some();
        if active_operation || active_attempt {
            return Err(WorkspaceSwitchFenceError::ActiveAuthority);
        }
        Ok(())
    }

    pub(super) fn commit(mut self) -> Result<(), Self> {
        let committed = self
            .database
            .as_ref()
            .is_some_and(|database| database.execute_batch("COMMIT").is_ok());
        if committed {
            self.database.take();
            Ok(())
        } else {
            Err(self)
        }
    }

    pub(super) fn into_connection(mut self) -> Result<Connection, WorkspaceSwitchFenceError> {
        self.database
            .take()
            .ok_or(WorkspaceSwitchFenceError::Unavailable)
    }
}

fn validate_workspace_schema(database: &Connection) -> Result<(), WorkspaceSwitchFenceError> {
    for query in [
        "SELECT tenant_id, space_id, thread_id, execution_id, base_revision, revision,
                status, action_digest, command_digest, operation_json
         FROM workspace_operations LIMIT 0",
        "SELECT tenant_id, execution_id, revision, result_digest, operation_json
         FROM workspace_operation_revisions LIMIT 0",
        "SELECT tenant_id, space_id, thread_id, execution_id, attempt_number,
                operation_revision, phase, status, action_digest, command_digest, created_at,
                lease_owner_id, lease_id, lease_epoch, leased_at, expires_at, settlement_kind,
                resolution_status, settled_at, result_revision, result_digest, attempt_json
         FROM workspace_delivery_attempts LIMIT 0",
        "SELECT tenant_id, space_id, phase, scope, idempotency_key, thread_id,
                execution_id, action_digest, command_digest, fingerprint, attempt_number,
                attempt_identity, seed_result_revision, seed_result_digest
         FROM workspace_operation_receipts LIMIT 0",
    ] {
        database
            .prepare(query)
            .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?;
    }
    if [
        "workspace_operations",
        "workspace_operation_revisions",
        "workspace_delivery_attempts",
        "workspace_operation_receipts",
    ]
    .into_iter()
    .any(|table| !table_is_strict(database, table).unwrap_or(false))
        || primary_key_columns(database, "workspace_operations")? != ["tenant_id", "execution_id"]
        || primary_key_columns(database, "workspace_operation_revisions")?
            != ["tenant_id", "execution_id", "revision"]
        || primary_key_columns(database, "workspace_delivery_attempts")?
            != ["tenant_id", "execution_id", "attempt_number"]
        || primary_key_columns(database, "workspace_operation_receipts")?
            != ["tenant_id", "space_id", "phase", "scope", "idempotency_key"]
        || !has_unique_index(
            database,
            "workspace_operation_revisions",
            &["tenant_id", "execution_id", "revision", "result_digest"],
        )?
        || index_columns(database, "workspace_operations_thread_idx")?
            != ["tenant_id", "space_id", "thread_id", "execution_id"]
        || index_columns(database, "workspace_delivery_attempts_claim_idx")?
            != [
                "tenant_id",
                "space_id",
                "status",
                "execution_id",
                "attempt_number",
            ]
    {
        return Err(WorkspaceSwitchFenceError::Unavailable);
    }
    Ok(())
}

fn table_is_strict(database: &Connection, table: &str) -> Result<bool, WorkspaceSwitchFenceError> {
    database
        .query_row(
            "SELECT strict FROM pragma_table_list WHERE name = ?1 AND type = 'table'",
            [table],
            |row| row.get::<_, i64>(0),
        )
        .map(|strict| strict == 1)
        .map_err(|_| WorkspaceSwitchFenceError::Unavailable)
}

fn validate_run_work_schema(database: &Connection) -> Result<(), WorkspaceSwitchFenceError> {
    for query in [
        "SELECT tenant_id, space_id, run_id, revision, last_sequence, state_json, updated_at
         FROM run_snapshots LIMIT 0",
        "SELECT work_item_order, work_item_id, tenant_id, run_id, kind, work_item_json,
                created_at, status, available_at_ms, lease_owner_id, lease_id, lease_epoch,
                lease_expires_at_ms, attempt_count, completed_at_ms, last_error_code
         FROM work_items LIMIT 0",
    ] {
        database
            .prepare(query)
            .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?;
    }
    if primary_key_columns(database, "run_snapshots")? != ["run_id"]
        || primary_key_columns(database, "work_items")? != ["work_item_order"]
        || !has_unique_index(database, "run_snapshots", &["tenant_id", "run_id"])?
        || !has_unique_index(database, "work_items", &["work_item_id"])?
        || !has_run_work_foreign_key(database)?
        || index_columns(database, "work_items_claim_idx")?
            != [
                "status",
                "available_at_ms",
                "lease_expires_at_ms",
                "work_item_order",
            ]
    {
        return Err(WorkspaceSwitchFenceError::Unavailable);
    }
    Ok(())
}

fn has_run_work_foreign_key(database: &Connection) -> Result<bool, WorkspaceSwitchFenceError> {
    let mut statement = database
        .prepare("PRAGMA foreign_key_list(work_items)")
        .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?;
    Ok(rows.iter().any(|(id, _, table, from, to)| {
        table == "run_snapshots"
            && from == "tenant_id"
            && to == "tenant_id"
            && rows
                .iter()
                .any(|(other_id, _, other_table, other_from, other_to)| {
                    other_id == id
                        && other_table == "run_snapshots"
                        && other_from == "run_id"
                        && other_to == "run_id"
                })
    }))
}

fn primary_key_columns(
    database: &Connection,
    table: &str,
) -> Result<Vec<String>, WorkspaceSwitchFenceError> {
    let mut statement = database
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?;
    let mut columns = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(5)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?;
    columns.retain(|(position, _)| *position > 0);
    columns.sort_by_key(|(position, _)| *position);
    Ok(columns.into_iter().map(|(_, name)| name).collect())
}

fn has_unique_index(
    database: &Connection,
    table: &str,
    expected: &[&str],
) -> Result<bool, WorkspaceSwitchFenceError> {
    let mut statement = database
        .prepare(&format!("PRAGMA index_list({table})"))
        .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?;
    let indexes = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
        })
        .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?;
    for (name, unique) in indexes {
        if unique == 1 && index_columns(database, &name)? == expected {
            return Ok(true);
        }
    }
    Ok(false)
}

fn index_columns(
    database: &Connection,
    index: &str,
) -> Result<Vec<String>, WorkspaceSwitchFenceError> {
    let mut statement = database
        .prepare(&format!("PRAGMA index_info({index})"))
        .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(2))
        .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?;
    Ok(columns)
}

impl Drop for WorkspaceSwitchFence {
    fn drop(&mut self) {
        if let Some(database) = self.database.take() {
            let _ = database.execute_batch("ROLLBACK");
        }
    }
}

fn table_exists(database: &Connection, table: &str) -> Result<bool, WorkspaceSwitchFenceError> {
    Ok(database
        .query_row(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1",
            [table],
            |_| Ok(()),
        )
        .optional()
        .map_err(|_| WorkspaceSwitchFenceError::Unavailable)?
        .is_some())
}

#[cfg(test)]
#[path = "control_runtime_workspace_fence_tests.rs"]
mod tests;
