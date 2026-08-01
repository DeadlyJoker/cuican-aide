use crewon_app_server_protocol::OfficeCreateParams;
use crewon_app_server_protocol::OfficeDeleteParams;
use crewon_app_server_protocol::OfficeRunParams;
use crewon_app_server_protocol::OfficeSaveParams;
use crewon_state::DurableWorkspaceRootRecord;
use crewon_state::OfficeMigrationStart;
use crewon_state::OfficeMigrationStartOutcome;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;
use tokio::time::Duration;
use tokio::time::timeout;

use super::super::CrewonDomainRequestProcessor;
use super::OfficeLegacyRecordMutator;

const WORKSPACE_KEY: &str = "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d60019";
const SOURCE_DIGEST: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[tokio::test]
async fn fenced_rpc_record_rejects_save_and_delete_without_changing_the_file() {
    let state_home = TempDir::new().expect("create state home");
    let workspace = TempDir::new().expect("create workspace");
    let state = crewon_state::StateRuntime::init(
        state_home.path().to_path_buf(),
        "office-fence-test".to_string(),
    )
    .await
    .expect("initialize state");
    seed_workspace(&state).await;
    let processor = CrewonDomainRequestProcessor::with_migration_state(state.clone());
    let cwd = workspace.path().to_string_lossy().into_owned();
    let created = processor
        .office_create(OfficeCreateParams {
            cwd: cwd.clone(),
            title: "Fenced Office".to_string(),
            subtitle: None,
            thread_id: Some("thread-fenced-office".to_string()),
            goal: Some("Preserve migration authority".to_string()),
        })
        .await
        .expect("create Office before migration");
    let record_id = created.config["workspace"]["recordId"]
        .as_str()
        .expect("record id")
        .to_string();
    let source_revision = created.config["workspace"]["recordRevision"]
        .as_str()
        .expect("record revision")
        .to_string();
    start_migration(&state, &record_id, &source_revision).await;
    let original = tokio::fs::read(&created.file_path)
        .await
        .expect("read original Office record");

    let mut changed = created.config.clone();
    changed["title"] = json!("Changed after migration");
    let save_error = processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: changed,
        })
        .await
        .expect_err("fenced save must fail");
    assert_fenced_error(&save_error);

    let delete_error = processor
        .office_delete(OfficeDeleteParams {
            cwd,
            file_path: created.file_path.clone(),
        })
        .await
        .expect_err("fenced delete must fail");
    assert_fenced_error(&delete_error);
    assert_eq!(
        tokio::fs::read(&created.file_path)
            .await
            .expect("read unchanged Office record"),
        original
    );
}

#[tokio::test]
async fn fenced_create_and_legacy_identity_fallback_cannot_bypass_the_journal() {
    let state_home = TempDir::new().expect("create state home");
    let workspace = TempDir::new().expect("create workspace");
    let state = crewon_state::StateRuntime::init(
        state_home.path().to_path_buf(),
        "office-fence-test".to_string(),
    )
    .await
    .expect("initialize state");
    seed_workspace(&state).await;
    let cwd = workspace.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Reserved Office",
        "workspace": {
            "recordId": "office-reserved-for-migration",
            "recordRevision": "revision-reserved-for-migration",
            "threadId": "thread-reserved",
            "members": [],
            "messages": [],
            "tasks": [],
            "activity": {"approvals": [], "artifacts": []}
        }
    });
    start_migration(
        &state,
        "office-reserved-for-migration",
        "revision-reserved-for-migration",
    )
    .await;
    let mutator = OfficeLegacyRecordMutator::with_migration_state(state);
    let error = mutator
        .create(&cwd, config)
        .await
        .expect_err("fenced create must fail");
    assert_fenced_error(&error);
    assert!(
        !workspace
            .path()
            .join(".crewon/offices/reserved-office-thread-r.json")
            .exists()
    );
}

#[tokio::test]
async fn id_less_legacy_save_without_thread_id_resolves_the_existing_fenced_file() {
    let state_home = TempDir::new().expect("create state home");
    let workspace = TempDir::new().expect("create workspace");
    let state = crewon_state::StateRuntime::init(
        state_home.path().to_path_buf(),
        "office-fence-test".to_string(),
    )
    .await
    .expect("initialize state");
    seed_workspace(&state).await;
    let cwd = workspace.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Legacy Office Without Thread",
        "workspace": {
            "goal": "Preserve the original legacy file",
            "members": [],
            "messages": [],
            "tasks": [],
            "activity": {"approvals": [], "artifacts": []}
        }
    });
    let initial = CrewonDomainRequestProcessor::new()
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: config.clone(),
        })
        .await
        .expect("save id-less legacy Office");
    let file_name = std::path::Path::new(&initial.file_path)
        .file_name()
        .and_then(|value| value.to_str())
        .expect("legacy file name");
    let record_id = super::super::office_record_identity::legacy_record_id(file_name);
    start_migration(&state, &record_id, "legacy-revision").await;

    let mut changed = config.clone();
    changed["workspace"]["goal"] = json!("Forbidden legacy update");
    let error = CrewonDomainRequestProcessor::with_migration_state(state.clone())
        .office_save(OfficeSaveParams {
            cwd,
            config: changed,
        })
        .await
        .expect_err("id-less legacy save must resolve the fenced record");
    assert_fenced_error(&error);

    let mut identity_changed = config;
    identity_changed["title"] = json!("Renamed Legacy Office");
    identity_changed["workspace"]["threadId"] = json!("new-legacy-thread");
    let identity_error = CrewonDomainRequestProcessor::with_migration_state(state)
        .office_save(OfficeSaveParams {
            cwd: workspace.path().to_string_lossy().into_owned(),
            config: identity_changed,
        })
        .await
        .expect_err("id-less legacy identity drift must not create a new Office record");
    assert!(
        identity_error
            .message
            .contains("legacy Office identity cannot be resolved")
    );
    let office_files = std::fs::read_dir(workspace.path().join(".crewon/offices"))
        .expect("read Office directory")
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
        .count();
    assert_eq!(office_files, 1);
}

#[tokio::test]
async fn fenced_run_turn_cannot_enqueue_an_auto_dispatch_sidecar_intent() {
    let state_home = TempDir::new().expect("create state home");
    let workspace = TempDir::new().expect("create workspace");
    let state = crewon_state::StateRuntime::init(
        state_home.path().to_path_buf(),
        "office-fence-test".to_string(),
    )
    .await
    .expect("initialize state");
    seed_workspace(&state).await;
    let processor = CrewonDomainRequestProcessor::with_migration_state(state.clone());
    let cwd = workspace.path().to_string_lossy().into_owned();
    let created = processor
        .office_create(OfficeCreateParams {
            cwd: cwd.clone(),
            title: "Fenced Auto Dispatch Office".to_string(),
            subtitle: None,
            thread_id: Some("thread-fenced-auto-dispatch".to_string()),
            goal: Some("Do not enqueue after migration".to_string()),
        })
        .await
        .expect("create Office before migration");
    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: created.config,
            message: json!({
                "author": "User",
                "glyph": "@",
                "accent": "slate",
                "time": "now",
                "kind": "message",
                "text": "Prepare one run"
            }),
            text: "Prepare one run".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: Some("fenced-auto-dispatch-message".to_string()),
        })
        .await
        .expect("prepare Office run before migration");
    let (file_path, started_config) = processor
        .office_run_mark_started(
            &cwd,
            prepared.config,
            &prepared.run_id,
            "turn-fenced-auto-dispatch",
        )
        .await
        .expect("mark Office run started before migration");
    let record_id = started_config["workspace"]["recordId"]
        .as_str()
        .expect("record id");
    let source_revision = started_config["workspace"]["recordRevision"]
        .as_str()
        .expect("record revision");
    let intent = processor
        .office_auto_dispatch_intent_queue(
            &cwd,
            "thread-fenced-auto-dispatch",
            "turn-fenced-auto-dispatch",
            "beforeFence",
        )
        .await
        .expect("queue auto dispatch intent before migration");
    let scheduler_path = workspace.path().join(".crewon/office-runs/scheduler.json");
    let scheduler_before = tokio::fs::read(&scheduler_path)
        .await
        .expect("read scheduler before migration");
    start_migration(&state, record_id, source_revision).await;

    let queue_error = processor
        .office_auto_dispatch_intent_queue(
            &cwd,
            "thread-fenced-auto-dispatch",
            "turn-fenced-auto-dispatch",
            "testFence",
        )
        .await
        .expect_err("fenced source turn must not enqueue an auto dispatch intent");
    assert_fenced_error(&queue_error);
    let claim_error = processor
        .office_auto_dispatch_intent_claim(
            &cwd,
            &intent.intent_id,
            "thread-fenced-auto-dispatch",
            "turn-fenced-auto-dispatch",
            "lease-after-fence",
        )
        .await
        .expect_err("fenced source turn must not claim an existing intent");
    assert_fenced_error(&claim_error);
    assert_eq!(
        tokio::fs::read(&scheduler_path)
            .await
            .expect("read scheduler after rejected mutations"),
        scheduler_before
    );

    processor
        .office_run_mark_failed(
            &cwd,
            started_config,
            &prepared.run_id,
            "drained after migration fence",
        )
        .await
        .expect("quiescing must allow an admitted run to reach a terminal state");
    let persisted: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(file_path)
            .await
            .expect("read drained Office record"),
    )
    .expect("parse drained Office record");
    assert_eq!(
        persisted["config"]["workspace"]["activity"]["runs"][0]["status"],
        json!("failed")
    );
    assert_eq!(
        tokio::fs::read(scheduler_path)
            .await
            .expect("read scheduler after terminal drain"),
        scheduler_before
    );
}

#[tokio::test]
async fn dispatch_permit_holds_authority_until_failed_terminal_write_consumes_it() {
    let state_home = TempDir::new().expect("create state home");
    let workspace = TempDir::new().expect("create workspace");
    let state = crewon_state::StateRuntime::init(
        state_home.path().to_path_buf(),
        "office-permit-test".to_string(),
    )
    .await
    .expect("initialize state");
    seed_workspace(&state).await;
    let processor = CrewonDomainRequestProcessor::with_migration_state(state.clone());
    let cwd = workspace.path().to_string_lossy().into_owned();
    let created = processor
        .office_create(OfficeCreateParams {
            cwd: cwd.clone(),
            title: "Permitted Office".to_string(),
            subtitle: None,
            thread_id: Some("thread-permitted-office".to_string()),
            goal: Some("Keep authority through external dispatch".to_string()),
        })
        .await
        .expect("create Office before dispatch");
    let permitted = processor
        .office_run_prepare_permitted(OfficeRunParams {
            cwd: cwd.clone(),
            config: created.config,
            message: json!({
                "author": "User",
                "glyph": "@",
                "accent": "slate",
                "time": "now",
                "kind": "message",
                "text": "Prepare one permitted run"
            }),
            text: "Prepare one permitted run".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: Some("permitted-run-message".to_string()),
        })
        .await
        .expect("prepare permitted Office run");
    let run_id = permitted.prepared().run_id.clone();

    let mutator = OfficeLegacyRecordMutator::with_migration_state(state);
    let cwd_for_waiter = cwd.clone();
    let mut authority_waiter = tokio::spawn(async move {
        mutator
            .lock_authority(&cwd_for_waiter)
            .await
            .expect("acquire authority after permit is consumed")
    });
    assert!(
        timeout(Duration::from_millis(200), &mut authority_waiter)
            .await
            .is_err(),
        "dispatch permit must retain the Office authority lock"
    );

    processor
        .office_run_mark_failed_permitted(permitted, "simulated external dispatch failure")
        .await
        .expect("consume permit with a terminal failed write");
    let acquired_authority = timeout(Duration::from_secs(2), authority_waiter)
        .await
        .expect("authority waiter must unblock after permit consumption")
        .expect("authority waiter task must complete");
    drop(acquired_authority);

    let persisted: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(created.file_path)
            .await
            .expect("read terminal Office record"),
    )
    .expect("parse terminal Office record");
    let run = persisted["config"]["workspace"]["activity"]["runs"]
        .as_array()
        .expect("persisted runs")
        .iter()
        .find(|run| run["id"] == run_id)
        .expect("persisted permitted run");
    assert_eq!(run["status"], json!("failed"));
}

#[tokio::test]
async fn fenced_prepare_does_not_create_a_run_or_run_index() {
    let state_home = TempDir::new().expect("create state home");
    let workspace = TempDir::new().expect("create workspace");
    let state = crewon_state::StateRuntime::init(
        state_home.path().to_path_buf(),
        "office-permit-test".to_string(),
    )
    .await
    .expect("initialize state");
    seed_workspace(&state).await;
    let processor = CrewonDomainRequestProcessor::with_migration_state(state.clone());
    let cwd = workspace.path().to_string_lossy().into_owned();
    let created = processor
        .office_create(OfficeCreateParams {
            cwd: cwd.clone(),
            title: "Fenced Before Prepare Office".to_string(),
            subtitle: None,
            thread_id: Some("thread-fenced-before-prepare".to_string()),
            goal: Some("Reject before dispatch preparation".to_string()),
        })
        .await
        .expect("create Office before migration");
    let record_id = created.config["workspace"]["recordId"]
        .as_str()
        .expect("record id");
    let source_revision = created.config["workspace"]["recordRevision"]
        .as_str()
        .expect("record revision");
    let original = tokio::fs::read(&created.file_path)
        .await
        .expect("read Office before migration");
    start_migration(&state, record_id, source_revision).await;

    let error = match processor
        .office_run_prepare_permitted(OfficeRunParams {
            cwd: cwd.clone(),
            config: created.config,
            message: json!({
                "author": "User",
                "glyph": "@",
                "accent": "slate",
                "time": "now",
                "kind": "message",
                "text": "Must be fenced before prepare"
            }),
            text: "Must be fenced before prepare".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: Some("fenced-before-prepare-message".to_string()),
        })
        .await
    {
        Ok(_) => panic!("migration fence must reject before dispatch preparation"),
        Err(error) => error,
    };
    assert_fenced_error(&error);
    assert_eq!(
        tokio::fs::read(&created.file_path)
            .await
            .expect("read unchanged fenced Office"),
        original
    );
    assert!(
        !workspace
            .path()
            .join(".crewon/office-runs/index.json")
            .exists(),
        "fenced preparation must not create a run index"
    );
}

async fn seed_workspace(state: &crewon_state::StateRuntime) {
    let mut root = DurableWorkspaceRootRecord {
        workspace_key: WORKSPACE_KEY.to_string(),
        node_id: "office-fence-node".to_string(),
        environment_id: "office-fence-environment".to_string(),
        root_fingerprint: format!("sha256:{}", "b".repeat(64)),
        record_hash: String::new(),
        created_at: 1,
    };
    root.record_hash = root.canonical_hash();
    state
        .resolve_durable_workspace_root_record(&root)
        .await
        .expect("seed durable workspace");
}

async fn start_migration(
    state: &crewon_state::StateRuntime,
    record_id: &str,
    source_revision: &str,
) {
    assert!(matches!(
        state
            .start_office_migration(&OfficeMigrationStart {
                record_id: record_id.to_string(),
                workspace_key: WORKSPACE_KEY.to_string(),
                source_revision: source_revision.to_string(),
                source_digest: SOURCE_DIGEST.to_string(),
                source_bytes: 1,
                started_at: 2,
            })
            .await
            .expect("start Office migration"),
        OfficeMigrationStartOutcome::Started(_)
    ));
}

fn assert_fenced_error(error: &crewon_app_server_protocol::JSONRPCErrorError) {
    assert_eq!(
        error.data,
        Some(json!({
            "type": "officeMigrationFenced",
            "phase": "quiescing",
            "journalRevision": 1,
        }))
    );
}
