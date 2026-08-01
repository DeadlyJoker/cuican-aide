use pretty_assertions::assert_eq;

use super::StateRuntime;
use crate::DurableWorkspaceRootRecord;
use crate::DurableWorkspaceRootResolveOutcome;
use crate::OfficeLegacyWriteStatus;
use crate::OfficeMigrationAdvanceSource;
use crate::OfficeMigrationBeginImport;
use crate::OfficeMigrationCommit;
use crate::OfficeMigrationMutationOutcome;
use crate::OfficeMigrationPhase;
use crate::OfficeMigrationStart;
use crate::OfficeMigrationStartOutcome;
use crate::office_migration_snapshot_digest;
use crate::runtime::test_support::unique_temp_dir;

const WORKSPACE_KEY: &str = "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d60001";
const SOURCE_DIGEST: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[tokio::test]
async fn migration_fence_and_import_survive_restart() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    seed_workspace(&runtime).await;
    let start = start_request();
    let started = match runtime
        .start_office_migration(&start)
        .await
        .expect("start migration")
    {
        OfficeMigrationStartOutcome::Started(record) => record,
        other => panic!("unexpected start outcome: {other:?}"),
    };
    assert_eq!(
        runtime
            .office_legacy_write_status(&start.record_id)
            .await
            .expect("read fence"),
        OfficeLegacyWriteStatus::Fenced {
            phase: OfficeMigrationPhase::Quiescing,
            journal_revision: 1,
        }
    );
    runtime.close().await;

    let reopened = initialized(&codex_home).await;
    assert_eq!(
        reopened
            .get_office_migration_journal(&start.record_id)
            .await
            .expect("read restarted journal"),
        Some(started)
    );
    let importing = match reopened
        .begin_office_migration_import(&OfficeMigrationBeginImport {
            record_id: start.record_id.clone(),
            source_digest: start.source_digest.clone(),
            expected_journal_revision: 1,
            updated_at: 101,
        })
        .await
        .expect("begin import")
    {
        OfficeMigrationMutationOutcome::Updated(record) => record,
        other => panic!("unexpected begin outcome: {other:?}"),
    };
    assert_eq!(importing.phase, OfficeMigrationPhase::Importing);

    let snapshot_json = r#"{"workspace":{"recordId":"office-record-1"}}"#.to_string();
    let commit = OfficeMigrationCommit {
        record_id: start.record_id.clone(),
        source_digest: start.source_digest.clone(),
        expected_journal_revision: 2,
        snapshot_digest: office_migration_snapshot_digest(&snapshot_json),
        snapshot_json,
        imported_at: 102,
    };
    let imported = match reopened
        .commit_office_migration(&commit)
        .await
        .expect("commit import")
    {
        OfficeMigrationMutationOutcome::Updated(record) => record,
        other => panic!("unexpected commit outcome: {other:?}"),
    };
    assert_eq!(imported.phase, OfficeMigrationPhase::Imported);
    assert_eq!(
        reopened
            .commit_office_migration(&commit)
            .await
            .expect("replay commit"),
        OfficeMigrationMutationOutcome::Existing(imported)
    );

    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn duplicate_start_is_idempotent_and_source_drift_conflicts() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    seed_workspace(&runtime).await;
    let start = start_request();
    let (first, second) = tokio::join!(
        runtime.start_office_migration(&start),
        runtime.start_office_migration(&start)
    );
    let outcomes = (first.expect("first start"), second.expect("second start"));
    assert!(matches!(
        outcomes,
        (
            OfficeMigrationStartOutcome::Started(_),
            OfficeMigrationStartOutcome::Existing(_)
        ) | (
            OfficeMigrationStartOutcome::Existing(_),
            OfficeMigrationStartOutcome::Started(_)
        )
    ));
    assert!(matches!(
        runtime
            .start_office_migration(&OfficeMigrationStart {
                started_at: start.started_at + 100,
                ..start.clone()
            })
            .await
            .expect("replay start with a later observation time"),
        OfficeMigrationStartOutcome::Existing(record)
            if record.started_at == start.started_at
    ));

    let mut drifted = start.clone();
    drifted.source_revision = "revision-2".to_string();
    assert_eq!(
        runtime
            .start_office_migration(&drifted)
            .await
            .expect("reject source drift"),
        OfficeMigrationStartOutcome::Conflict
    );
    assert_eq!(
        runtime
            .begin_office_migration_import(&OfficeMigrationBeginImport {
                record_id: start.record_id,
                source_digest: format!("sha256:{}", "b".repeat(64)),
                expected_journal_revision: 1,
                updated_at: 101,
            })
            .await
            .expect("reject digest drift"),
        OfficeMigrationMutationOutcome::Conflict
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn workspace_dependency_and_persisted_hash_fail_closed() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let start = start_request();
    assert_eq!(
        runtime
            .start_office_migration(&start)
            .await
            .expect("missing workspace outcome"),
        OfficeMigrationStartOutcome::WorkspaceNotFound
    );
    seed_workspace(&runtime).await;
    runtime
        .start_office_migration(&start)
        .await
        .expect("start migration after workspace");
    sqlx::query(
        "UPDATE office_migration_journals SET source_revision = 'tampered' WHERE record_id = ?",
    )
    .bind(&start.record_id)
    .execute(runtime.pool.as_ref())
    .await
    .expect("tamper journal");
    let error = runtime
        .get_office_migration_journal(&start.record_id)
        .await
        .expect_err("tampered journal must fail closed");
    assert!(error.to_string().contains("hash mismatch"));

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn snapshot_bounds_drift_and_debug_output_fail_closed() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    seed_workspace(&runtime).await;
    let start = start_request();
    runtime
        .start_office_migration(&start)
        .await
        .expect("start migration");
    runtime
        .begin_office_migration_import(&OfficeMigrationBeginImport {
            record_id: start.record_id.clone(),
            source_digest: start.source_digest.clone(),
            expected_journal_revision: 1,
            updated_at: 101,
        })
        .await
        .expect("begin import");

    let invalid = OfficeMigrationCommit {
        record_id: start.record_id.clone(),
        source_digest: start.source_digest.clone(),
        expected_journal_revision: 2,
        snapshot_digest: office_migration_snapshot_digest("[]"),
        snapshot_json: "[]".to_string(),
        imported_at: 102,
    };
    runtime
        .commit_office_migration(&invalid)
        .await
        .expect_err("non-object snapshot must be rejected");

    let snapshot_json = r#"{"secretMarker":"must-not-appear"}"#.to_string();
    let commit = OfficeMigrationCommit {
        record_id: start.record_id.clone(),
        source_digest: start.source_digest.clone(),
        expected_journal_revision: 2,
        snapshot_digest: office_migration_snapshot_digest(&snapshot_json),
        snapshot_json,
        imported_at: 102,
    };
    let rendered = format!("{commit:?}");
    assert!(!rendered.contains("must-not-appear"));
    runtime
        .commit_office_migration(&commit)
        .await
        .expect("commit valid snapshot");

    let changed_json = r#"{"secretMarker":"changed"}"#.to_string();
    let changed = OfficeMigrationCommit {
        snapshot_digest: office_migration_snapshot_digest(&changed_json),
        snapshot_json: changed_json,
        ..commit
    };
    assert_eq!(
        runtime
            .commit_office_migration(&changed)
            .await
            .expect("reject changed snapshot replay"),
        OfficeMigrationMutationOutcome::Conflict
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn quiescing_source_can_advance_with_cas_before_import() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    seed_workspace(&runtime).await;
    let start = start_request();
    let started = match runtime
        .start_office_migration(&start)
        .await
        .expect("start migration")
    {
        OfficeMigrationStartOutcome::Started(record) => record,
        other => panic!("unexpected start outcome: {other:?}"),
    };
    let request = OfficeMigrationAdvanceSource {
        record_id: start.record_id.clone(),
        expected_source_digest: start.source_digest.clone(),
        expected_journal_revision: started.journal_revision,
        source_revision: "revision-after-quiesce".to_string(),
        source_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            .to_string(),
        source_bytes: 2048,
        updated_at: start.started_at + 1,
    };
    let advanced = match runtime
        .advance_office_migration_source(&request)
        .await
        .expect("advance source")
    {
        OfficeMigrationMutationOutcome::Updated(record) => record,
        other => panic!("unexpected source advance outcome: {other:?}"),
    };
    assert_eq!(
        runtime
            .advance_office_migration_source(&request)
            .await
            .expect("replay source advance"),
        OfficeMigrationMutationOutcome::Existing(advanced.clone())
    );
    assert_eq!(
        runtime
            .advance_office_migration_source(&OfficeMigrationAdvanceSource {
                source_digest:
                    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                        .to_string(),
                ..request.clone()
            })
            .await
            .expect("reject stale source advance"),
        OfficeMigrationMutationOutcome::Conflict
    );
    runtime.close().await;

    let reopened = initialized(&codex_home).await;
    assert_eq!(
        reopened
            .get_office_migration_journal(&start.record_id)
            .await
            .expect("read advanced journal"),
        Some(advanced.clone())
    );
    let importing = reopened
        .begin_office_migration_import(&OfficeMigrationBeginImport {
            record_id: start.record_id,
            source_digest: advanced.source_digest.clone(),
            expected_journal_revision: advanced.journal_revision,
            updated_at: advanced.updated_at + 1,
        })
        .await
        .expect("begin import after quiesce");
    assert!(matches!(
        importing,
        OfficeMigrationMutationOutcome::Updated(record)
            if record.phase == OfficeMigrationPhase::Importing
    ));

    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

fn start_request() -> OfficeMigrationStart {
    OfficeMigrationStart {
        record_id: "office-record-1".to_string(),
        workspace_key: WORKSPACE_KEY.to_string(),
        source_revision: "revision-1".to_string(),
        source_digest: SOURCE_DIGEST.to_string(),
        source_bytes: 512,
        started_at: 100,
    }
}

async fn seed_workspace(runtime: &StateRuntime) {
    let mut record = DurableWorkspaceRootRecord {
        workspace_key: WORKSPACE_KEY.to_string(),
        node_id: "node-1".to_string(),
        environment_id: "environment-1".to_string(),
        root_fingerprint: format!("sha256:{}", "c".repeat(64)),
        record_hash: String::new(),
        created_at: 1,
    };
    record.record_hash = record.canonical_hash();
    assert!(matches!(
        runtime
            .resolve_durable_workspace_root_record(&record)
            .await
            .expect("seed durable workspace"),
        DurableWorkspaceRootResolveOutcome::Created(_)
            | DurableWorkspaceRootResolveOutcome::Existing(_)
    ));
}

async fn initialized(codex_home: &std::path::Path) -> std::sync::Arc<StateRuntime> {
    StateRuntime::init(codex_home.to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize state runtime")
}
