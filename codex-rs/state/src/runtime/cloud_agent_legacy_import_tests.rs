use pretty_assertions::assert_eq;

use super::StateRuntime;
use crate::CloudAgentLegacyImportCommit;
use crate::CloudAgentLegacyImportCommitOutcome;
use crate::CloudAgentLegacyImportStart;
use crate::CloudAgentLegacyImportStartOutcome;
use crate::CloudAgentLegacyImportStatus;
use crate::CloudAgentTurnOrigin;
use crate::CloudAgentTurnRecord;
use crate::CloudAgentTurnStatus;
use crate::CloudExecutionArtifactRefRecord;
use crate::runtime::cloud_agent_turn_tests::initialized;
use crate::runtime::cloud_agent_turn_tests::runtime_bundle;
use crate::runtime::cloud_agent_turn_tests::seed_authority;
use crate::runtime::cloud_agent_turn_tests::seed_prompt_artifact;
use crate::runtime::test_support::unique_temp_dir;

const SOURCE_DIGEST: &str =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PAYLOAD_DIGEST: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[tokio::test]
async fn legacy_import_is_restart_durable_and_idempotent() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let (context, binding) = seed_authority(&runtime).await;
    seed_prompt_artifact(&runtime).await;
    seed_artifact_aliases(&runtime).await;
    let start = start_request(&context);
    let turns = imported_turns(&context, &binding);

    let started = runtime
        .start_cloud_agent_legacy_import(&start)
        .await
        .expect("start legacy import");
    let CloudAgentLegacyImportStartOutcome::Started(pending) = started else {
        panic!("expected new legacy import");
    };
    assert_eq!(pending.status, CloudAgentLegacyImportStatus::Pending);
    assert_eq!(
        runtime
            .start_cloud_agent_legacy_import(&start)
            .await
            .expect("resume pending import"),
        CloudAgentLegacyImportStartOutcome::ExistingPending(pending.clone())
    );

    let commit = CloudAgentLegacyImportCommit {
        journal_id: start.journal_id.clone(),
        source_digest: start.source_digest.clone(),
        turns: turns.clone(),
    };
    assert_eq!(
        runtime
            .commit_cloud_agent_legacy_import(&commit)
            .await
            .expect("commit legacy import"),
        CloudAgentLegacyImportCommitOutcome::Committed
    );
    assert_eq!(
        runtime
            .commit_cloud_agent_legacy_import(&commit)
            .await
            .expect("repeat legacy import commit"),
        CloudAgentLegacyImportCommitOutcome::ExistingSame
    );
    for turn in &turns {
        assert_eq!(
            runtime
                .get_cloud_agent_turn_record(&turn.turn_id)
                .await
                .expect("read imported Turn"),
            Some(turn.clone())
        );
    }
    let completed = runtime
        .get_cloud_agent_legacy_import(&start.journal_id)
        .await
        .expect("read import journal")
        .expect("journal exists");
    assert_eq!(completed.status, CloudAgentLegacyImportStatus::Completed);

    runtime.close().await;
    let reopened = initialized(&codex_home).await;
    assert_eq!(
        reopened
            .commit_cloud_agent_legacy_import(&commit)
            .await
            .expect("resume completed import after restart"),
        CloudAgentLegacyImportCommitOutcome::ExistingSame
    );
    assert_eq!(
        reopened
            .start_cloud_agent_legacy_import(&start)
            .await
            .expect("resume completed journal"),
        CloudAgentLegacyImportStartOutcome::ExistingCompleted(completed)
    );
    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn late_batch_failure_keeps_pending_journal_and_retries_atomically() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let (context, binding) = seed_authority(&runtime).await;
    seed_prompt_artifact(&runtime).await;
    seed_artifact_aliases(&runtime).await;
    let start = start_request(&context);
    let turns = imported_turns(&context, &binding);
    runtime
        .start_cloud_agent_legacy_import(&start)
        .await
        .expect("start legacy import");
    sqlx::query(
        r#"
CREATE TRIGGER fail_second_legacy_import_mapping
BEFORE INSERT ON cloud_agent_legacy_import_turns
WHEN NEW.ordinal = 1
BEGIN
    SELECT RAISE(ABORT, 'injected legacy import mapping failure');
END
        "#,
    )
    .execute(runtime.pool.as_ref())
    .await
    .expect("install failure injection");
    let commit = CloudAgentLegacyImportCommit {
        journal_id: start.journal_id.clone(),
        source_digest: start.source_digest.clone(),
        turns: turns.clone(),
    };

    runtime
        .commit_cloud_agent_legacy_import(&commit)
        .await
        .expect_err("late batch failure must roll back");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM cloud_agent_turns")
            .fetch_one(runtime.pool.as_ref())
            .await
            .expect("count rolled back Turns"),
        0
    );
    assert_eq!(
        runtime
            .get_cloud_agent_legacy_import(&start.journal_id)
            .await
            .expect("read pending journal")
            .expect("pending journal exists")
            .status,
        CloudAgentLegacyImportStatus::Pending
    );
    sqlx::query("DROP TRIGGER fail_second_legacy_import_mapping")
        .execute(runtime.pool.as_ref())
        .await
        .expect("remove failure injection");
    assert_eq!(
        runtime
            .commit_cloud_agent_legacy_import(&commit)
            .await
            .expect("retry atomic import"),
        CloudAgentLegacyImportCommitOutcome::Committed
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

fn start_request(context: &crate::ThreadExecutionContextRecord) -> CloudAgentLegacyImportStart {
    CloudAgentLegacyImportStart {
        journal_id: "legacy-journal:deployment-a:file-a".to_string(),
        source_key: "legacy-source:deployment-a:file-a".to_string(),
        source_digest: SOURCE_DIGEST.to_string(),
        source_bytes: 512,
        thread_id: context.thread_id.clone(),
        execution_binding: context
            .execution_binding
            .clone()
            .expect("execution binding"),
        expected_turn_count: 2,
        imported_at: 200,
    }
}

fn imported_turns(
    context: &crate::ThreadExecutionContextRecord,
    binding: &crate::ProviderResourceBindingRecord,
) -> Vec<CloudAgentTurnRecord> {
    (0..2)
        .map(|ordinal| {
            let mut turn = runtime_bundle(context, binding).turn;
            turn.turn_id = format!("legacy-turn:deployment-a:file-a:{ordinal:04}");
            turn.client_user_message_id =
                format!("legacy-message:deployment-a:file-a:{ordinal:04}");
            turn.origin = CloudAgentTurnOrigin::LegacyImport {
                import_id: format!("legacy-import:deployment-a:file-a:{ordinal:04}"),
            };
            turn.prompt_artifact = artifact(&format!("legacy-prompt-{ordinal}"));
            turn.status = CloudAgentTurnStatus::Completed;
            turn.primary_output_artifact = Some(artifact(&format!("legacy-output-{ordinal}")));
            turn.error_code = None;
            turn.trace_id = Some("legacy-import-trace".to_string());
            turn.creation_digest = SOURCE_DIGEST.to_string();
            turn.created_at = 200;
            turn.updated_at = 200;
            turn.completed_at = Some(200);
            turn.record_hash = turn.canonical_hash();
            turn.validate().expect("valid imported Turn");
            turn
        })
        .collect()
}

fn artifact(artifact_id: &str) -> CloudExecutionArtifactRefRecord {
    CloudExecutionArtifactRefRecord {
        artifact_id: artifact_id.to_string(),
        revision: 1,
    }
}

async fn seed_artifact_aliases(runtime: &StateRuntime) {
    for artifact_id in [
        "legacy-prompt-0",
        "legacy-output-0",
        "legacy-prompt-1",
        "legacy-output-1",
    ] {
        let payload_id = format!("payload-{artifact_id}");
        sqlx::query(
            r#"
INSERT INTO artifact_payloads (
    payload_id, sha256, byte_len, media_type, sensitivity, retention_kind,
    expires_at, status, content, created_at
) VALUES (?, ?, 1, 'text/plain', 'workspace_sensitive',
          'user_managed', NULL, 'available', X'78', 200)
            "#,
        )
        .bind(&payload_id)
        .bind(PAYLOAD_DIGEST)
        .execute(runtime.pool.as_ref())
        .await
        .expect("seed legacy Artifact payload");
        sqlx::query(
            r#"
INSERT INTO artifact_manifests (
    artifact_id, revision, idempotency_key, commit_hash,
    payload_id, manifest_json, created_at
) VALUES (?, 1, ?, ?, ?, '{}', 200)
            "#,
        )
        .bind(artifact_id)
        .bind(format!("idempotency-{artifact_id}"))
        .bind(format!("hash-{artifact_id}"))
        .bind(payload_id)
        .execute(runtime.pool.as_ref())
        .await
        .expect("seed legacy Artifact manifest");
    }
}
