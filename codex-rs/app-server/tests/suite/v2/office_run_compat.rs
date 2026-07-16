use std::time::Duration;

use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::create_final_assistant_message_sse_response;
use app_test_support::create_mock_responses_server_sequence_unchecked;
use app_test_support::to_response;
use app_test_support::write_mock_responses_config_toml_with_chatgpt_base_url;
use crewon_app_server_protocol::ItemStartedNotification;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::OfficeCreateResponse;
use crewon_app_server_protocol::OfficeManagerEnsureResponse;
use crewon_app_server_protocol::OfficeRunResponse;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::ThreadItem;
use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;
use tempfile::TempDir;
use tokio::time::timeout;

const TIMEOUT: Duration = Duration::from_secs(30);

async fn request<T: serde::de::DeserializeOwned>(
    app: &mut TestAppServer,
    method: &str,
    params: JsonValue,
) -> Result<T> {
    let request_id = app.send_raw_request(method, Some(params)).await?;
    let response: JSONRPCResponse = timeout(
        TIMEOUT,
        app.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    to_response(response)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stable_office_run_preserves_legacy_payload_sizes_and_message_text() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(vec![
        create_final_assistant_message_sse_response("Legacy-compatible Office run completed.")?,
    ])
    .await;
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut app = TestAppServer::new(codex_home.path()).await?;
    timeout(TIMEOUT, app.initialize()).await??;

    let created: OfficeCreateResponse = request(
        &mut app,
        "office/create",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "title": "Stable Office Run Compatibility",
            "subtitle": null,
            "threadId": null,
            "goal": "Keep the stable office/run contract compatible"
        }),
    )
    .await?;
    let ensured: OfficeManagerEnsureResponse = request(
        &mut app,
        "office/manager/ensure",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "officeRecordId": created.config["workspace"]["recordId"],
            "expectedRecordRevision": created.config["workspace"]["recordRevision"]
        }),
    )
    .await?;

    let text = format!("Execute the stable Office request. {}", "x".repeat(1_024));
    let client_user_message_id = format!("legacy-client-{}", "i".repeat(300));
    let message = json!({
        "author": "Legacy client",
        "glyph": "L",
        "accent": "blue",
        "time": "now",
        "text": "Keep this caller-owned display text",
        "kind": "message",
        "metadata": "m".repeat(8 * 1024)
    });
    let run: OfficeRunResponse = request(
        &mut app,
        "office/run",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": ensured.config,
            "message": message,
            "text": text,
            "locale": "en",
            "threadId": null,
            "clientUserMessageId": client_user_message_id
        }),
    )
    .await?;

    assert_eq!(run.config["workspace"]["messages"][0], message);
    assert_eq!(
        run.config["workspace"]["activity"]["runs"][0]["requestText"],
        text
    );
    assert_eq!(
        run.config["workspace"]["activity"]["runs"][0]["clientUserMessageId"],
        client_user_message_id
    );
    let user_message = timeout(TIMEOUT, async {
        loop {
            let notification = app
                .read_stream_until_notification_message("item/started")
                .await?;
            let started: ItemStartedNotification =
                serde_json::from_value(notification.params.expect("item/started params"))?;
            if let ThreadItem::UserMessage { .. } = started.item {
                return Ok::<ThreadItem, anyhow::Error>(started.item);
            }
        }
    })
    .await??;
    let ThreadItem::UserMessage { client_id, .. } = user_message else {
        unreachable!("filtered to a user message")
    };
    assert_eq!(client_id, Some(client_user_message_id));
    timeout(
        TIMEOUT,
        app.read_stream_until_notification_message("turn/completed"),
    )
    .await??;
    assert_eq!(
        server.received_requests().await.unwrap_or_default().len(),
        1
    );
    Ok(())
}
