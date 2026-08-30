use std::path::Path;
use std::time::Duration;

use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::create_fake_rollout;
use app_test_support::rollout_path;
use app_test_support::to_response;
use crewon_app_server_protocol::JSONRPCError;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::ThreadInjectItemsParams;
use crewon_app_server_protocol::ThreadInjectItemsResponse;
use crewon_app_server_protocol::ThreadResumeParams;
use crewon_app_server_protocol::ThreadResumeResponse;
use crewon_core::RolloutRecorder;
use crewon_protocol::ThreadId;
use crewon_protocol::models::ContentItem;
use crewon_protocol::models::ResponseItem;
use crewon_protocol::protocol::RolloutItem;
use pretty_assertions::assert_eq;
use tempfile::TempDir;
use tokio::time::timeout;

const DEFAULT_READ_TIMEOUT: Duration = Duration::from_secs(10);
const INVALID_REQUEST_ERROR_CODE: i64 = -32600;
const FIRST_WRITER_MARKER: &str = "writer-a-before-handoff";
const REJECTED_WRITER_MARKER: &str = "writer-b-before-handoff-must-not-persist";
const HANDOFF_WRITER_MARKER: &str = "writer-b-after-handoff";

#[tokio::test]
async fn two_app_server_processes_serialize_rollout_writer_handoff() -> Result<()> {
    let codex_home = TempDir::new()?;
    create_config_toml(codex_home.path())?;
    let thread_id = create_fake_rollout(
        codex_home.path(),
        "2025-01-05T12-00-00",
        "2025-01-05T12:00:00Z",
        "seed history",
        Some("mock_provider"),
        /*git_info*/ None,
    )?;
    let rollout_path = rollout_path(codex_home.path(), "2025-01-05T12-00-00", &thread_id);
    let (baseline_history, persisted_thread_id, parse_errors) =
        RolloutRecorder::load_rollout_items(&rollout_path).await?;
    let persisted_thread_id = persisted_thread_id
        .ok_or_else(|| anyhow::anyhow!("seed rollout did not contain a thread id"))?;
    assert_eq!(persisted_thread_id.to_string(), thread_id);
    assert_eq!(parse_errors, 0);

    let mut writer_a = initialized_app_server(codex_home.path()).await?;
    resume_thread(&mut writer_a, &thread_id).await?;
    inject_marker(&mut writer_a, &thread_id, FIRST_WRITER_MARKER).await?;

    let mut writer_b = initialized_app_server(codex_home.path()).await?;
    let competing_resume_id = writer_b
        .send_thread_resume_request(ThreadResumeParams {
            thread_id: thread_id.clone(),
            ..Default::default()
        })
        .await?;
    let competing_resume_error: JSONRPCError = timeout(
        DEFAULT_READ_TIMEOUT,
        writer_b.read_stream_until_error_message(RequestId::Integer(competing_resume_id)),
    )
    .await??;
    assert_eq!(
        competing_resume_error.error.code,
        INVALID_REQUEST_ERROR_CODE
    );
    assert!(
        competing_resume_error
            .error
            .message
            .contains("thread already has an active rollout writer"),
        "unexpected competing resume error: {}",
        competing_resume_error.error.message
    );

    let rejected_append_id = writer_b
        .send_thread_inject_items_request(ThreadInjectItemsParams {
            thread_id: thread_id.clone(),
            items: vec![serde_json::to_value(marker_item(REJECTED_WRITER_MARKER))?],
        })
        .await?;
    let rejected_append_error: JSONRPCError = timeout(
        DEFAULT_READ_TIMEOUT,
        writer_b.read_stream_until_error_message(RequestId::Integer(rejected_append_id)),
    )
    .await??;
    assert_eq!(rejected_append_error.error.code, INVALID_REQUEST_ERROR_CODE);
    assert!(
        rejected_append_error.error.message.contains("not found"),
        "failed resume must not leave a writable thread: {}",
        rejected_append_error.error.message
    );
    let writer_a_history = load_valid_history(&rollout_path, persisted_thread_id).await?;
    assert_history_prefix(writer_a_history.as_slice(), baseline_history.as_slice())?;
    assert_eq!(
        persisted_markers(writer_a_history.as_slice()),
        vec![FIRST_WRITER_MARKER.to_string()]
    );

    writer_a.shutdown().await?;

    resume_thread(&mut writer_b, &thread_id).await?;
    inject_marker(&mut writer_b, &thread_id, HANDOFF_WRITER_MARKER).await?;
    writer_b.shutdown().await?;

    let writer_b_history = load_valid_history(&rollout_path, persisted_thread_id).await?;
    assert_history_prefix(writer_b_history.as_slice(), writer_a_history.as_slice())?;
    assert_eq!(
        persisted_markers(writer_b_history.as_slice()),
        vec![
            FIRST_WRITER_MARKER.to_string(),
            HANDOFF_WRITER_MARKER.to_string(),
        ]
    );
    Ok(())
}

async fn initialized_app_server(codex_home: &Path) -> Result<TestAppServer> {
    let mut app_server = TestAppServer::new(codex_home).await?;
    timeout(DEFAULT_READ_TIMEOUT, app_server.initialize()).await??;
    Ok(app_server)
}

async fn resume_thread(app_server: &mut TestAppServer, thread_id: &str) -> Result<()> {
    let request_id = app_server
        .send_thread_resume_request(ThreadResumeParams {
            thread_id: thread_id.to_string(),
            ..Default::default()
        })
        .await?;
    let response: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        app_server.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    let _: ThreadResumeResponse = to_response(response)?;
    Ok(())
}

async fn inject_marker(
    app_server: &mut TestAppServer,
    thread_id: &str,
    marker: &str,
) -> Result<()> {
    let request_id = app_server
        .send_thread_inject_items_request(ThreadInjectItemsParams {
            thread_id: thread_id.to_string(),
            items: vec![serde_json::to_value(marker_item(marker))?],
        })
        .await?;
    let response: JSONRPCResponse = timeout(
        DEFAULT_READ_TIMEOUT,
        app_server.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    let _: ThreadInjectItemsResponse = to_response(response)?;
    Ok(())
}

fn marker_item(marker: &str) -> ResponseItem {
    ResponseItem::Message {
        id: None,
        role: "assistant".to_string(),
        content: vec![ContentItem::OutputText {
            text: marker.to_string(),
        }],
        phase: None,
    }
}

async fn load_valid_history(
    rollout_path: &Path,
    expected_thread_id: ThreadId,
) -> Result<Vec<RolloutItem>> {
    let (actual_history, actual_thread_id, parse_errors) =
        RolloutRecorder::load_rollout_items(rollout_path).await?;
    assert_eq!(actual_thread_id, Some(expected_thread_id));
    assert_eq!(parse_errors, 0);
    Ok(actual_history)
}

fn assert_history_prefix(actual: &[RolloutItem], expected_prefix: &[RolloutItem]) -> Result<()> {
    anyhow::ensure!(
        actual.len() >= expected_prefix.len(),
        "rollout history shrank from at least {} items to {}",
        expected_prefix.len(),
        actual.len()
    );
    assert_eq!(
        serde_json::to_value(&actual[..expected_prefix.len()])?,
        serde_json::to_value(expected_prefix)?
    );
    Ok(())
}

fn persisted_markers(history: &[RolloutItem]) -> Vec<String> {
    history
        .iter()
        .filter_map(|item| match item {
            RolloutItem::ResponseItem(ResponseItem::Message { content, .. }) => {
                content.iter().find_map(|content| match content {
                    ContentItem::OutputText { text }
                        if text == FIRST_WRITER_MARKER
                            || text == REJECTED_WRITER_MARKER
                            || text == HANDOFF_WRITER_MARKER =>
                    {
                        Some(text.clone())
                    }
                    _ => None,
                })
            }
            _ => None,
        })
        .collect()
}

fn create_config_toml(codex_home: &Path) -> std::io::Result<()> {
    std::fs::write(
        codex_home.join("config.toml"),
        r#"
model = "mock-model"
model_provider = "mock_provider"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.mock_provider]
name = "Unused mock provider"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
"#,
    )
}
