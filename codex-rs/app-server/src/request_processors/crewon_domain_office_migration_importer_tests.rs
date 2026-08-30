use std::sync::Arc;

use crewon_state::DurableWorkspaceRootRecord;
use crewon_state::DurableWorkspaceRootResolveOutcome;
use crewon_state::OfficeMigrationPhase;
use crewon_state::StateRuntime;
use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;
use tempfile::TempDir;

use super::OfficeLegacyImportError;
use super::OfficeLegacyImportOutcome;
use super::OfficeLegacyImportRequest;
use super::OfficeLegacyImporter;
use super::OfficeMigrationFailureInjection;
use super::OfficeQuiescedSourceOutcome;

const WORKSPACE_KEY: &str = "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d60009";

#[tokio::test]
async fn idle_import_is_restart_safe_and_does_not_rewrite_source() {
    let fixture = Fixture::new(idle_config()).await;
    let source_before = tokio::fs::read(&fixture.file_path)
        .await
        .expect("read source before import");
    assert!(matches!(
        fixture
            .import(100, OfficeMigrationFailureInjection::Disabled)
            .await,
        Ok(OfficeLegacyImportOutcome::Imported {
            journal_revision: 3
        })
    ));
    assert_eq!(
        tokio::fs::read(&fixture.file_path)
            .await
            .expect("read source after import"),
        source_before
    );
    fixture.state.close().await;

    let reopened = state(fixture.state_home.path()).await;
    let importer = OfficeLegacyImporter::new(reopened.clone());
    assert!(matches!(
        importer
            .import(fixture.request(200, OfficeMigrationFailureInjection::Disabled))
            .await,
        Ok(OfficeLegacyImportOutcome::Existing {
            phase: OfficeMigrationPhase::Imported,
            journal_revision: 3
        })
    ));
    reopened.close().await;
}

#[tokio::test]
async fn crashes_after_each_journal_boundary_resume_forward() {
    let after_journal = Fixture::new(idle_config()).await;
    assert_eq!(
        after_journal
            .import(100, OfficeMigrationFailureInjection::AfterJournal)
            .await,
        Err(OfficeLegacyImportError::SimulatedCrash)
    );
    assert!(matches!(
        after_journal
            .import(200, OfficeMigrationFailureInjection::Disabled)
            .await,
        Ok(OfficeLegacyImportOutcome::Imported {
            journal_revision: 3
        })
    ));
    after_journal.state.close().await;

    let after_begin = Fixture::new(idle_config()).await;
    assert_eq!(
        after_begin
            .import(100, OfficeMigrationFailureInjection::AfterBeginImport)
            .await,
        Err(OfficeLegacyImportError::SimulatedCrash)
    );
    let journal = after_begin
        .state
        .get_office_migration_journal("office-import")
        .await
        .expect("read journal")
        .expect("journal exists");
    assert_eq!(journal.phase, OfficeMigrationPhase::Importing);
    assert!(matches!(
        after_begin
            .import(200, OfficeMigrationFailureInjection::Disabled)
            .await,
        Ok(OfficeLegacyImportOutcome::Imported {
            journal_revision: 3
        })
    ));
    after_begin.state.close().await;
}

#[tokio::test]
async fn active_run_requires_explicit_terminal_source_advance() {
    let fixture = Fixture::new(running_config()).await;
    assert!(matches!(
        fixture.import(100, OfficeMigrationFailureInjection::Disabled).await,
        Ok(OfficeLegacyImportOutcome::Quiescing(blocking))
            if blocking.run_id == "run-active" && blocking.manager_is_steerable
    ));
    assert!(matches!(
        fixture.advance(101).await,
        Ok(OfficeQuiescedSourceOutcome::Blocked(blocking))
            if blocking.run_id == "run-active"
    ));

    fixture.write(completed_config()).await;
    assert_eq!(
        fixture
            .import(102, OfficeMigrationFailureInjection::Disabled)
            .await,
        Err(OfficeLegacyImportError::Conflict)
    );
    assert!(matches!(
        fixture.advance(103).await,
        Ok(OfficeQuiescedSourceOutcome::Advanced {
            journal_revision: 2
        })
    ));
    assert!(matches!(
        fixture
            .import(104, OfficeMigrationFailureInjection::Disabled)
            .await,
        Ok(OfficeLegacyImportOutcome::Imported {
            journal_revision: 4
        })
    ));
    fixture.state.close().await;
}

#[tokio::test]
async fn strict_reader_rejects_corrupt_outside_and_symlink_sources() {
    let fixture = Fixture::new(idle_config()).await;
    let outside = fixture.workspace.path().join("outside.json");
    tokio::fs::write(&outside, b"{}")
        .await
        .expect("write outside file");
    let importer = OfficeLegacyImporter::new(fixture.state.clone());
    assert_eq!(
        importer
            .import(OfficeLegacyImportRequest {
                file_path: outside.to_str().expect("outside path"),
                ..fixture.request(100, OfficeMigrationFailureInjection::Disabled)
            })
            .await,
        Err(OfficeLegacyImportError::InvalidRequest)
    );
    fixture.write_raw(b"not-json").await;
    assert_eq!(
        fixture
            .import(100, OfficeMigrationFailureInjection::Disabled)
            .await,
        Err(OfficeLegacyImportError::InvalidSource)
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;

        let target = fixture.workspace.path().join("target.json");
        tokio::fs::write(&target, persisted(idle_config()))
            .await
            .expect("write symlink target");
        tokio::fs::remove_file(&fixture.file_path)
            .await
            .expect("remove original source");
        symlink(&target, &fixture.file_path).expect("create source symlink");
        assert_eq!(
            fixture
                .import(100, OfficeMigrationFailureInjection::Disabled)
                .await,
            Err(OfficeLegacyImportError::InvalidSource)
        );
    }
    fixture.state.close().await;
}

struct Fixture {
    workspace: TempDir,
    state_home: TempDir,
    state: Arc<StateRuntime>,
    file_path: std::path::PathBuf,
}

impl Fixture {
    async fn new(config: JsonValue) -> Self {
        let workspace = TempDir::new().expect("create workspace");
        let state_home = TempDir::new().expect("create state home");
        let office_directory = workspace.path().join(".crewon").join("offices");
        tokio::fs::create_dir_all(&office_directory)
            .await
            .expect("create office directory");
        let file_path = office_directory.join("office.json");
        tokio::fs::write(&file_path, persisted(config))
            .await
            .expect("write office source");
        let state = state(state_home.path()).await;
        seed_workspace(&state).await;
        Self {
            workspace,
            state_home,
            state,
            file_path,
        }
    }

    fn request(
        &self,
        now: i64,
        failure_injection: OfficeMigrationFailureInjection,
    ) -> OfficeLegacyImportRequest<'_> {
        OfficeLegacyImportRequest {
            cwd: self.workspace.path().to_str().expect("workspace path"),
            file_path: self.file_path.to_str().expect("office path"),
            workspace_key: WORKSPACE_KEY,
            now,
            failure_injection,
        }
    }

    async fn import(
        &self,
        now: i64,
        failure_injection: OfficeMigrationFailureInjection,
    ) -> Result<OfficeLegacyImportOutcome, OfficeLegacyImportError> {
        OfficeLegacyImporter::new(self.state.clone())
            .import(self.request(now, failure_injection))
            .await
    }

    async fn advance(
        &self,
        now: i64,
    ) -> Result<OfficeQuiescedSourceOutcome, OfficeLegacyImportError> {
        OfficeLegacyImporter::new(self.state.clone())
            .advance_quiesced_source(self.request(now, OfficeMigrationFailureInjection::Disabled))
            .await
    }

    async fn write(&self, config: JsonValue) {
        self.write_raw(&persisted(config)).await;
    }

    async fn write_raw(&self, bytes: &[u8]) {
        tokio::fs::write(&self.file_path, bytes)
            .await
            .expect("rewrite office source");
    }
}

fn persisted(config: JsonValue) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "version": 1,
        "kind": "office",
        "savedAt": "2026-06-28T12:00:00.000Z",
        "config": config,
    }))
    .expect("serialize office source")
}

fn idle_config() -> JsonValue {
    office_config(json!({"runs": []}), "revision-1")
}

fn running_config() -> JsonValue {
    office_config(
        json!({
            "runs": [{
                "id": "run-active",
                "status": "running",
                "threadId": "thread-manager",
                "turnId": "turn-1"
            }]
        }),
        "revision-1",
    )
}

fn completed_config() -> JsonValue {
    office_config(
        json!({
            "runs": [{
                "id": "run-active",
                "status": "completed",
                "threadId": "thread-manager",
                "turnId": "turn-1"
            }]
        }),
        "revision-2",
    )
}

fn office_config(activity: JsonValue, revision: &str) -> JsonValue {
    json!({
        "title": "Import Office",
        "workspace": {
            "recordId": "office-import",
            "recordRevision": revision,
            "threadId": "thread-manager",
            "members": [{"memberId": "manager", "role": "leader"}],
            "activity": activity,
            "messages": []
        }
    })
}

async fn seed_workspace(state: &StateRuntime) {
    let mut record = DurableWorkspaceRootRecord {
        workspace_key: WORKSPACE_KEY.to_string(),
        node_id: "node-test".to_string(),
        environment_id: "local".to_string(),
        root_fingerprint: format!("sha256:{}", "d".repeat(64)),
        record_hash: String::new(),
        created_at: 1,
    };
    record.record_hash = record.canonical_hash();
    assert!(matches!(
        state
            .resolve_durable_workspace_root_record(&record)
            .await
            .expect("seed workspace"),
        DurableWorkspaceRootResolveOutcome::Created(_)
            | DurableWorkspaceRootResolveOutcome::Existing(_)
    ));
}

async fn state(path: &std::path::Path) -> Arc<StateRuntime> {
    StateRuntime::init(path.to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize state")
}
