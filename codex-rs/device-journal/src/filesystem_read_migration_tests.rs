use sha2::Digest as _;
use sha2::Sha256;
use sqlx::Connection as _;
use sqlx::migrate::Migrate as _;
use sqlx::sqlite::SqliteConnectOptions;

use crate::DeviceWorkspaceJournal;
use crate::filesystem_read_tests::event_envelope_mut;
use crate::filesystem_read_tests::fixture;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[tokio::test]
async fn migrates_populated_v2_read_authority_to_v3_without_drift() {
    let directory = tempfile::tempdir().expect("temporary journal directory");
    let path = directory.path().join("device.sqlite");
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .foreign_keys(true);
    let mut connection = sqlx::SqliteConnection::connect_with(&options)
        .await
        .expect("open v2 connection");
    connection
        .ensure_migrations_table("_sqlx_migrations")
        .await
        .expect("create migration authority");
    for migration in MIGRATOR.migrations.iter().take(2) {
        connection
            .apply("_sqlx_migrations", migration)
            .await
            .expect("apply v2 migration");
    }
    let (command, mut accepted, mut terminal, ack) = fixture();
    let accepted_envelope = event_envelope_mut(&mut accepted).clone();
    let terminal_envelope = event_envelope_mut(&mut terminal).clone();
    let command_json = serde_json::to_string(&command.command).expect("encode command");
    sqlx::query("INSERT INTO filesystem_read_executions (execution_id, command_fingerprint, command_json, device_id, lease_id, lease_epoch, workspace_binding_id, incarnation_id, command_digest, acknowledged_through, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)")
        .bind(&command.command.execution_id).bind(fingerprint(&command_json)).bind(command_json)
        .bind(&command.command.device_id).bind(&command.command.lease_id).bind(i64::try_from(command.command.lease_epoch).expect("lease epoch"))
        .bind(&command.command.workspace_binding_id).bind(&command.arguments.workspace_incarnation_id)
        .bind(&accepted_envelope.command_digest).bind(&accepted_envelope.observed_at)
        .execute(&mut connection).await.expect("insert v2 execution");
    for (event, envelope, kind) in [
        (&accepted, &accepted_envelope, "workspace_read.accepted"),
        (&terminal, &terminal_envelope, "workspace_read.completed"),
    ] {
        let json = serde_json::to_string(event).expect("encode event");
        sqlx::query("INSERT INTO filesystem_read_events (execution_id, sequence, event_type, event_fingerprint, event_json, receipt_id, connection_epoch, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(&envelope.execution_id).bind(i64::try_from(envelope.sequence).expect("sequence"))
            .bind(kind).bind(fingerprint(&json)).bind(json).bind(&envelope.receipt_id)
            .bind(i64::try_from(envelope.connection_epoch).expect("epoch")).bind(&envelope.observed_at)
            .execute(&mut connection).await.expect("insert v2 event");
    }
    let ack_json = serde_json::to_string(&ack).expect("encode ACK");
    sqlx::query("INSERT INTO filesystem_read_acks (execution_id, through_sequence, ack_fingerprint, ack_json, acknowledged_at) VALUES (?, 2, ?, ?, ?)")
        .bind(&ack.execution_id).bind(fingerprint(&ack_json)).bind(ack_json).bind(&ack.acknowledged_at)
        .execute(&mut connection).await.expect("insert v2 ACK");
    connection.close().await.expect("close v2 connection");

    let journal = DeviceWorkspaceJournal::open(&path)
        .await
        .expect("migrate to v3");
    let migrated = journal
        .get_filesystem_read(&command.command.execution_id)
        .await
        .expect("read migrated authority")
        .expect("execution exists");
    assert_eq!(migrated.command, command);
    assert_eq!(migrated.accepted, accepted);
    assert_eq!(migrated.terminal, Some(terminal));
    assert_eq!(migrated.acknowledged_through, 2);
}

fn fingerprint(value: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(value.as_bytes()))
}
