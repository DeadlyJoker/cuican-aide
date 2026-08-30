use super::connection_handling_websocket::WsClient;
use super::connection_handling_websocket::connect_websocket_with_bearer;
use super::connection_handling_websocket::create_config_toml;
use super::connection_handling_websocket::read_error_for_id;
use super::connection_handling_websocket::read_notification_for_method;
use super::connection_handling_websocket::read_response_for_id;
use super::connection_handling_websocket::send_request;
use super::connection_handling_websocket::signed_bearer_token;
use super::connection_handling_websocket::spawn_websocket_server_with_args;
use anyhow::Context;
use anyhow::Result;
use app_test_support::create_final_assistant_message_sse_response;
use app_test_support::to_response;
use core_test_support::responses;
use crewon_app_server_protocol::ClientInfo;
use crewon_app_server_protocol::InitializeCapabilities;
use crewon_app_server_protocol::InitializeParams;
use crewon_app_server_protocol::OfficeCreateResponse;
use crewon_app_server_protocol::OfficeManagerEnsureResponse;
use crewon_app_server_protocol::OfficeMessageDelivery;
use crewon_app_server_protocol::OfficeMessageSubmitResponse;
use crewon_app_server_protocol::OfficeReadResponse;
use crewon_app_server_protocol::WorkspaceListParams;
use crewon_app_server_protocol::WorkspaceListResponse;
use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;
use std::io::Write;
use std::time::Duration;
use tempfile::TempDir;
use time::OffsetDateTime;

const SHARED_SECRET: &str = "0123456789abcdef0123456789abcdef";

#[tokio::test]
async fn authenticated_office_submit_is_owner_scoped_and_idempotent() -> Result<()> {
    let responses_server = responses::start_mock_server().await;
    let delayed_response = responses::sse_response(create_final_assistant_message_sse_response(
        "Office accepted exactly once",
    )?)
    .set_delay(Duration::from_secs(2));
    let response_mock =
        responses::mount_response_sequence(&responses_server, vec![delayed_response]).await;
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let shared_secret_file = codex_home.path().join("app-server-signing-secret");
    std::fs::write(&shared_secret_file, format!("{SHARED_SECRET}\n"))?;
    create_config_toml(codex_home.path(), &responses_server.uri(), "never")?;
    let workspace_root = serde_json::to_string(&workspace.path().to_string_lossy())?;
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(codex_home.path().join("config.toml"))?,
        "\n[sandbox_workspace_write]\nwritable_roots = [{workspace_root}]"
    )?;
    let auth_args = vec![
        "--ws-auth".to_string(),
        "signed-bearer-token".to_string(),
        "--ws-shared-secret-file".to_string(),
        shared_secret_file.display().to_string(),
        "--ws-issuer".to_string(),
        "crewon-enroller".to_string(),
        "--ws-audience".to_string(),
        "crewon-app-server".to_string(),
    ];
    let (mut process, bind_addr) =
        spawn_websocket_server_with_args(codex_home.path(), "ws://127.0.0.1:0", &auth_args).await?;
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let owner_token = principal_token(now, "user:owner", "owner-token")?;
    let other_token = principal_token(now, "user:other", "other-token")?;
    let mut owner = connect_websocket_with_bearer(bind_addr, Some(&owner_token)).await?;
    initialize(&mut owner, /*id*/ 1, "office_owner").await?;
    read_response_for_id(&mut owner, /*id*/ 1).await?;
    register_workspace(&mut owner, /*id*/ 2, workspace.path()).await?;

    let created: OfficeCreateResponse = request(
        &mut owner,
        /*id*/ 3,
        "office/create",
        json!({
            "cwd": workspace.path(),
            "title": "Authenticated Office",
            "subtitle": null,
            "threadId": null,
            "goal": "Submit exactly once under the owning principal"
        }),
    )
    .await?;
    let ensured: OfficeManagerEnsureResponse = request(
        &mut owner,
        /*id*/ 4,
        "office/manager/ensure",
        json!({
            "cwd": workspace.path(),
            "officeRecordId": created.config["workspace"]["recordId"],
            "expectedRecordRevision": created.config["workspace"]["recordRevision"]
        }),
    )
    .await?;
    let submit_params = json!({
        "cwd": workspace.path(),
        "config": ensured.config,
        "text": "Run this Office turn once",
        "clientUserMessageId": "authenticated-submit-1",
        "locale": "en",
        "threadId": ensured.thread_id,
        "mentions": []
    });

    let mut other = connect_websocket_with_bearer(bind_addr, Some(&other_token)).await?;
    initialize(&mut other, /*id*/ 10, "office_other").await?;
    read_response_for_id(&mut other, /*id*/ 10).await?;
    register_workspace(&mut other, /*id*/ 11, workspace.path()).await?;
    send_request(
        &mut other,
        "office/message/submit",
        /*id*/ 12,
        Some(submit_params.clone()),
    )
    .await?;
    let unauthorized = read_error_for_id(&mut other, /*id*/ 12).await?;
    assert_eq!(
        unauthorized.error.message,
        "Thread execution context request is not authorized"
    );
    let before_submit: OfficeReadResponse = request(
        &mut owner,
        /*id*/ 5,
        "office/read",
        json!({
            "cwd": workspace.path(),
            "threadId": ensured.thread_id,
            "title": null
        }),
    )
    .await?;
    assert_eq!(
        before_submit
            .record
            .expect("canonical Office record")
            .config["workspace"]["messages"],
        json!([])
    );

    send_request(
        &mut owner,
        "office/message/submit",
        /*id*/ 6,
        Some(submit_params.clone()),
    )
    .await?;
    let submitted: OfficeMessageSubmitResponse =
        to_response(read_response_for_id(&mut owner, /*id*/ 6).await?)?;
    assert!(!submitted.replayed);
    assert!(matches!(
        submitted.delivery,
        OfficeMessageDelivery::RunStarted { .. }
    ));

    let replayed: OfficeMessageSubmitResponse = request(
        &mut owner,
        /*id*/ 7,
        "office/message/submit",
        submit_params,
    )
    .await?;
    assert!(replayed.replayed);
    assert_eq!(replayed.receipt_id, submitted.receipt_id);
    assert_eq!(
        replayed.client_user_message_id,
        submitted.client_user_message_id
    );
    read_notification_for_method(&mut owner, "turn/completed").await?;
    assert_eq!(response_mock.requests().len(), 1);

    other.close(None).await?;
    owner.close(None).await?;
    process
        .kill()
        .await
        .context("failed to stop authenticated Office app-server process")?;
    Ok(())
}

fn principal_token(now: i64, subject: &str, token_id: &str) -> Result<String> {
    signed_bearer_token(
        SHARED_SECRET.as_bytes(),
        json!({
            "exp": now + 180,
            "iat": now,
            "iss": "crewon-enroller",
            "aud": "crewon-app-server",
            "sub": subject,
            "tenantId": "tenant-7",
            "spaceId": "space-9",
            "jti": token_id,
        }),
    )
}

async fn initialize(stream: &mut WsClient, id: i64, client_name: &str) -> Result<()> {
    send_request(
        stream,
        "initialize",
        id,
        Some(serde_json::to_value(InitializeParams {
            client_info: ClientInfo {
                name: client_name.to_string(),
                title: Some("Authenticated Office Test Client".to_string()),
                version: "0.1.0".to_string(),
            },
            capabilities: Some(InitializeCapabilities {
                experimental_api: true,
                ..Default::default()
            }),
        })?),
    )
    .await
}

async fn register_workspace(
    stream: &mut WsClient,
    id: i64,
    expected_root: &std::path::Path,
) -> Result<()> {
    let listed: WorkspaceListResponse = request(
        stream,
        id,
        "workspace/list",
        serde_json::to_value(WorkspaceListParams {
            cursor: None,
            limit: None,
        })?,
    )
    .await?;
    let expected_name = expected_root
        .file_name()
        .and_then(|name| name.to_str())
        .context("temporary workspace path had no UTF-8 file name")?;
    assert!(
        listed
            .data
            .iter()
            .any(|workspace| workspace.display_name == expected_name)
    );
    Ok(())
}

async fn request<T: serde::de::DeserializeOwned>(
    stream: &mut WsClient,
    id: i64,
    method: &str,
    params: JsonValue,
) -> Result<T> {
    send_request(stream, method, id, Some(params)).await?;
    to_response(read_response_for_id(stream, id).await?)
}
