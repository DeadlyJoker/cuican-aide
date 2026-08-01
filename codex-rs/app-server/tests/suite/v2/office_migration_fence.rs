use std::time::Duration;

use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::to_response;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::OfficeCreateResponse;
use crewon_app_server_protocol::RequestId;
use crewon_state::DurableWorkspaceRootRecord;
use crewon_state::OfficeMigrationStart;
use crewon_state::OfficeMigrationStartOutcome;
use crewon_state::StateRuntime;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;
use tokio::time::timeout;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const WORKSPACE_KEY: &str = "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d60029";
const SOURCE_DIGEST: &str =
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_office_mutation_and_run_fail_closed_after_migration_journal_starts() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let cwd = workspace.path().to_string_lossy().into_owned();
    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_TIMEOUT, mcp.initialize()).await??;

    let created: OfficeCreateResponse = request(
        &mut mcp,
        "office/create",
        json!({
            "cwd": cwd,
            "title": "Migration Fence Office",
            "subtitle": null,
            "threadId": "thread-migration-fence",
            "goal": "Keep the legacy authority immutable"
        }),
    )
    .await?;
    let record_id = created.config["workspace"]["recordId"]
        .as_str()
        .expect("created record id");
    let source_revision = created.config["workspace"]["recordRevision"]
        .as_str()
        .expect("created record revision");
    let original = tokio::fs::read(&created.file_path).await?;

    let state = StateRuntime::init(codex_home.path().to_path_buf(), "mock_provider".into()).await?;
    seed_workspace(&state).await?;
    assert!(matches!(
        state
            .start_office_migration(&OfficeMigrationStart {
                record_id: record_id.to_string(),
                workspace_key: WORKSPACE_KEY.to_string(),
                source_revision: source_revision.to_string(),
                source_digest: SOURCE_DIGEST.to_string(),
                source_bytes: original.len() as u64,
                started_at: 1,
            })
            .await?,
        OfficeMigrationStartOutcome::Started(_)
    ));

    let mut changed = created.config.clone();
    changed["title"] = json!("Forbidden update");
    let save_id = mcp
        .send_raw_request(
            "office/save",
            Some(json!({
                "cwd": workspace.path().to_string_lossy(),
                "config": changed
            })),
        )
        .await?;
    let save_error = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(save_id)),
    )
    .await??;
    assert_fenced_error(&save_error.error);

    let run_id = mcp
        .send_raw_request(
            "office/run",
            Some(json!({
                "cwd": workspace.path().to_string_lossy(),
                "config": created.config,
                "message": {
                    "author": "User",
                    "glyph": "@",
                    "accent": "slate",
                    "time": "now",
                    "text": "Do not start this fenced run",
                    "kind": "message"
                },
                "text": "Do not start this fenced run",
                "locale": "en",
                "threadId": null,
                "clientUserMessageId": "office-fenced-run"
            })),
        )
        .await?;
    let run_error = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(run_id)),
    )
    .await??;
    assert_fenced_error(&run_error.error);

    let delete_id = mcp
        .send_raw_request(
            "office/delete",
            Some(json!({
                "cwd": workspace.path().to_string_lossy(),
                "filePath": created.file_path
            })),
        )
        .await?;
    let delete_error = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(delete_id)),
    )
    .await??;
    assert_fenced_error(&delete_error.error);
    assert_eq!(tokio::fs::read(&created.file_path).await?, original);
    Ok(())
}

async fn request<T: serde::de::DeserializeOwned>(
    mcp: &mut TestAppServer,
    method: &str,
    params: serde_json::Value,
) -> Result<T> {
    let request_id = mcp.send_raw_request(method, Some(params)).await?;
    let response: JSONRPCResponse = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    to_response(response)
}

async fn seed_workspace(state: &StateRuntime) -> Result<()> {
    let mut root = DurableWorkspaceRootRecord {
        workspace_key: WORKSPACE_KEY.to_string(),
        node_id: "office-fence-node".to_string(),
        environment_id: "office-fence-environment".to_string(),
        root_fingerprint: format!("sha256:{}", "c".repeat(64)),
        record_hash: String::new(),
        created_at: 1,
    };
    root.record_hash = root.canonical_hash();
    state.resolve_durable_workspace_root_record(&root).await?;
    Ok(())
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
