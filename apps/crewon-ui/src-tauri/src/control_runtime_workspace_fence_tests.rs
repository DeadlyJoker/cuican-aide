use std::time::Duration;

use pretty_assertions::assert_eq;
use rusqlite::Connection;

use super::WorkspaceSwitchFence;
use super::WorkspaceSwitchFenceError;

#[test]
fn rejects_active_run_workspace_operation_and_delivery_attempt_authority() {
    for setup in [
        "INSERT INTO run_snapshots
         (tenant_id, space_id, run_id, revision, last_sequence, state_json, updated_at)
         VALUES ('tenant', 'space', 'run', 1, 1, json_object('status', 'queued'), 'time')",
        "INSERT INTO workspace_operations (tenant_id, execution_id, status)
         VALUES ('tenant', 'execution', 'prepared')",
        "INSERT INTO workspace_operations (tenant_id, execution_id, status)
         VALUES ('tenant', 'execution', 'unknownOutcome')",
        "INSERT INTO workspace_delivery_attempts
         (tenant_id, execution_id, attempt_number, status)
         VALUES ('tenant', 'execution', 1, 'pending')",
        "INSERT INTO workspace_delivery_attempts
         (tenant_id, execution_id, attempt_number, status)
         VALUES ('tenant', 'execution', 1, 'leased')",
        "INSERT INTO workspace_operations (tenant_id, execution_id, status)
         VALUES ('tenant', 'execution', 'futureStatus')",
        "INSERT INTO workspace_delivery_attempts
         (tenant_id, execution_id, attempt_number, status)
         VALUES ('tenant', 'execution', 1, 'futureStatus')",
        "INSERT INTO workspace_operations (tenant_id, execution_id, status)
         VALUES ('tenant', 'execution', NULL)",
        "INSERT INTO workspace_delivery_attempts
         (tenant_id, execution_id, attempt_number, status)
         VALUES ('tenant', 'execution', 1, NULL)",
        "INSERT INTO work_items (work_item_id, tenant_id, run_id, kind, work_item_json,
          created_at, status, available_at_ms, lease_epoch, attempt_count)
         VALUES ('work', 'tenant', 'run', 'run.execute', '{}', 'time', 'pending', 0, 0, 0)",
        "INSERT INTO work_items (work_item_id, tenant_id, run_id, kind, work_item_json,
          created_at, status, available_at_ms, lease_epoch, attempt_count)
         VALUES ('work', 'tenant', 'run', 'run.execute', '{}', 'time', 'leased', 0, 0, 0)",
        "INSERT INTO work_items (work_item_id, tenant_id, run_id, kind, work_item_json,
          created_at, status, available_at_ms, lease_epoch, attempt_count)
         VALUES ('work', 'tenant', 'run', 'run.execute', '{}', 'time', 'futureStatus', 0, 0, 0)",
        "INSERT INTO work_items (work_item_id, tenant_id, run_id, kind, work_item_json,
          created_at, status, available_at_ms, lease_epoch, attempt_count)
         VALUES ('work', 'tenant', 'run', 'run.execute', '{}', 'time', NULL, 0, 0, 0)",
    ] {
        let fixture = fixture();
        if setup.contains("INSERT INTO work_items") {
            fixture
                .database
                .execute(
                    "INSERT INTO run_snapshots
                     (tenant_id, space_id, run_id, revision, last_sequence, state_json, updated_at)
                     VALUES ('tenant', 'space', 'run', 1, 1,
                             json_object('status', 'completed'), 'time')",
                    [],
                )
                .unwrap();
        }
        fixture.database.execute(setup, []).unwrap();
        assert_eq!(
            WorkspaceSwitchFence::begin(&fixture.path).unwrap_err(),
            WorkspaceSwitchFenceError::ActiveAuthority
        );
    }
}

#[test]
fn accepts_only_terminal_authority_and_holds_begin_immediate_until_commit() {
    let fixture = fixture();
    fixture
        .database
        .execute(
            "INSERT INTO run_snapshots
             (tenant_id, space_id, run_id, revision, last_sequence, state_json, updated_at)
             VALUES ('tenant', 'space', 'run', 1, 1,
                     json_object('status', 'completed'), 'time')",
            [],
        )
        .unwrap();
    fixture
        .database
        .execute(
            "INSERT INTO work_items
             (work_item_id, tenant_id, run_id, kind, work_item_json, created_at,
              status, available_at_ms, lease_epoch, attempt_count)
             VALUES ('work', 'tenant', 'run', 'run.execute', '{}', 'time',
                     'completed', 0, 0, 0)",
            [],
        )
        .unwrap();
    fixture
        .database
        .execute(
            "INSERT INTO workspace_operations (tenant_id, execution_id, status)
             VALUES ('tenant', 'execution', 'completed')",
            [],
        )
        .unwrap();
    fixture
        .database
        .execute(
            "INSERT INTO workspace_delivery_attempts
             (tenant_id, execution_id, attempt_number, status)
             VALUES ('tenant', 'execution', 1, 'settled')",
            [],
        )
        .unwrap();
    let fence = WorkspaceSwitchFence::begin(&fixture.path).unwrap();
    let writer = Connection::open(&fixture.path).unwrap();
    writer.busy_timeout(Duration::ZERO).unwrap();
    assert!(writer
        .execute(
            "INSERT INTO run_snapshots
             (tenant_id, space_id, run_id, revision, last_sequence, state_json, updated_at)
             VALUES ('tenant-2', 'space', 'run-2', 1, 1, '{}', 'time')",
            [],
        )
        .is_err());
    fence.commit().unwrap();
    assert_eq!(
        writer.execute(
            "INSERT INTO run_snapshots
             (tenant_id, space_id, run_id, revision, last_sequence, state_json, updated_at)
             VALUES ('tenant-2', 'space', 'run-2', 1, 1, '{}', 'time')",
            [],
        ),
        Ok(1)
    );
}

#[test]
fn absent_workspace_tables_are_safe_but_partial_or_corrupt_authority_fails_closed() {
    let root = tempfile::tempdir().unwrap();
    let absent = root.path().join("absent.sqlite");
    install_run_work_schema(&Connection::open(&absent).unwrap());
    WorkspaceSwitchFence::begin(&absent)
        .unwrap()
        .commit()
        .unwrap();

    let partial = root.path().join("partial.sqlite");
    Connection::open(&partial)
        .unwrap()
        .execute("CREATE TABLE workspace_operations (status TEXT)", [])
        .unwrap();
    assert_eq!(
        WorkspaceSwitchFence::begin(&partial).unwrap_err(),
        WorkspaceSwitchFenceError::Unavailable
    );

    let corrupt = root.path().join("corrupt.sqlite");
    let database = Connection::open(&corrupt).unwrap();
    database
        .execute(
            "CREATE TABLE workspace_operations (wrong TEXT NOT NULL)",
            [],
        )
        .unwrap();
    database
        .execute("CREATE TABLE workspace_delivery_attempts (status TEXT)", [])
        .unwrap();
    assert_eq!(
        WorkspaceSwitchFence::begin(&corrupt).unwrap_err(),
        WorkspaceSwitchFenceError::Unavailable
    );

    let future = root.path().join("future.sqlite");
    let database = Connection::open(&future).unwrap();
    database.pragma_update(None, "user_version", 24).unwrap();
    install_run_work_schema(&database);
    assert_eq!(
        WorkspaceSwitchFence::begin(&future).unwrap_err(),
        WorkspaceSwitchFenceError::Unavailable
    );
}

#[test]
fn missing_run_or_work_authority_fails_closed() {
    for present_table in ["run_snapshots", "work_items"] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(format!("missing-{present_table}.sqlite"));
        let database = Connection::open(&path).unwrap();
        match present_table {
            "run_snapshots" => database
                .execute("CREATE TABLE run_snapshots (state_json TEXT)", [])
                .unwrap(),
            "work_items" => database
                .execute("CREATE TABLE work_items (status TEXT)", [])
                .unwrap(),
            _ => unreachable!(),
        };
        assert_eq!(
            WorkspaceSwitchFence::begin(&path).unwrap_err(),
            WorkspaceSwitchFenceError::Unavailable
        );
    }
}

#[test]
fn complete_table_names_with_wrong_columns_or_claim_index_fail_closed() {
    for corruption in ["columns", "index"] {
        let fixture = fixture();
        match corruption {
            "columns" => {
                fixture
                    .database
                    .execute_batch(
                        "DROP TABLE workspace_operation_receipts;
                         CREATE TABLE workspace_operation_receipts (wrong TEXT)",
                    )
                    .unwrap();
            }
            "index" => {
                fixture
                    .database
                    .execute_batch(
                        "DROP INDEX workspace_delivery_attempts_claim_idx;
                         CREATE INDEX workspace_delivery_attempts_claim_idx
                           ON workspace_delivery_attempts(status)",
                    )
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert_eq!(
            WorkspaceSwitchFence::begin(&fixture.path).unwrap_err(),
            WorkspaceSwitchFenceError::Unavailable
        );
    }
}

struct Fixture {
    _root: tempfile::TempDir,
    path: std::path::PathBuf,
    database: Connection,
}

fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("control.sqlite");
    let database = Connection::open(&path).unwrap();
    install_run_work_schema(&database);
    database.pragma_update(None, "user_version", 23).unwrap();
    database
        .execute(
            "CREATE TABLE workspace_operations (
                tenant_id TEXT, space_id TEXT, thread_id TEXT, execution_id TEXT,
                base_revision INTEGER, revision INTEGER, status TEXT,
                action_digest TEXT, command_digest TEXT, operation_json TEXT,
                PRIMARY KEY (tenant_id, execution_id)
             ) STRICT",
            [],
        )
        .unwrap();
    database
        .execute(
            "CREATE TABLE workspace_operation_revisions (
                tenant_id TEXT, execution_id TEXT, revision INTEGER,
                result_digest TEXT, operation_json TEXT,
                PRIMARY KEY (tenant_id, execution_id, revision),
                UNIQUE (tenant_id, execution_id, revision, result_digest)
             ) STRICT",
            [],
        )
        .unwrap();
    database
        .execute(
            "CREATE TABLE workspace_delivery_attempts (
                tenant_id TEXT, space_id TEXT, thread_id TEXT, execution_id TEXT,
                attempt_number INTEGER, operation_revision INTEGER, phase TEXT, status TEXT,
                action_digest TEXT, command_digest TEXT, created_at TEXT,
                lease_owner_id TEXT, lease_id TEXT, lease_epoch INTEGER,
                leased_at TEXT, expires_at TEXT, settlement_kind TEXT,
                resolution_status TEXT, settled_at TEXT,
                result_revision INTEGER, result_digest TEXT, attempt_json TEXT,
                PRIMARY KEY (tenant_id, execution_id, attempt_number)
             ) STRICT",
            [],
        )
        .unwrap();
    database
        .execute(
            "CREATE TABLE workspace_operation_receipts (
                tenant_id TEXT, space_id TEXT, phase TEXT, scope TEXT, idempotency_key TEXT,
                thread_id TEXT, execution_id TEXT, action_digest TEXT, command_digest TEXT,
                fingerprint TEXT, attempt_number INTEGER, attempt_identity TEXT,
                seed_result_revision INTEGER, seed_result_digest TEXT,
                PRIMARY KEY (tenant_id, space_id, phase, scope, idempotency_key)
             ) STRICT",
            [],
        )
        .unwrap();
    database
        .execute(
            "CREATE INDEX workspace_operations_thread_idx
             ON workspace_operations (tenant_id, space_id, thread_id, execution_id)",
            [],
        )
        .unwrap();
    database
        .execute(
            "CREATE INDEX workspace_delivery_attempts_claim_idx
             ON workspace_delivery_attempts
             (tenant_id, space_id, status, execution_id, attempt_number)",
            [],
        )
        .unwrap();
    Fixture {
        _root: root,
        path,
        database,
    }
}

fn install_run_work_schema(database: &Connection) {
    database
        .execute_batch(
            "CREATE TABLE run_snapshots (
               tenant_id TEXT NOT NULL,
               space_id TEXT NOT NULL,
               run_id TEXT PRIMARY KEY,
               revision INTEGER NOT NULL,
               last_sequence INTEGER NOT NULL,
               state_json TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               UNIQUE (tenant_id, run_id)
             );
             CREATE TABLE work_items (
               work_item_order INTEGER PRIMARY KEY AUTOINCREMENT,
               work_item_id TEXT NOT NULL UNIQUE,
               tenant_id TEXT NOT NULL,
               run_id TEXT NOT NULL,
               kind TEXT NOT NULL,
               work_item_json TEXT NOT NULL,
               created_at TEXT NOT NULL,
               status TEXT,
               available_at_ms INTEGER NOT NULL,
               lease_owner_id TEXT,
               lease_id TEXT,
               lease_epoch INTEGER NOT NULL,
               lease_expires_at_ms INTEGER,
               attempt_count INTEGER NOT NULL,
               completed_at_ms INTEGER,
               last_error_code TEXT,
               FOREIGN KEY (tenant_id, run_id)
                 REFERENCES run_snapshots(tenant_id, run_id)
             );
             CREATE INDEX work_items_claim_idx
               ON work_items(status, available_at_ms, lease_expires_at_ms, work_item_order);",
        )
        .unwrap();
}
