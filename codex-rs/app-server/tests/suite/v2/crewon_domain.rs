use std::time::Duration;

use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::to_response;
use crewon_app_server_protocol::AgentCreateResponse;
use crewon_app_server_protocol::AgentDeleteResponse;
use crewon_app_server_protocol::AgentListResponse;
use crewon_app_server_protocol::AgentReadResponse;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::ToolConfigKind;
use crewon_app_server_protocol::ToolDeleteResponse;
use crewon_app_server_protocol::ToolListResponse;
use crewon_app_server_protocol::ToolSaveResponse;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;
use tokio::time::timeout;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

async fn initialized_app_server(codex_home: &TempDir) -> Result<TestAppServer> {
    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_TIMEOUT, mcp.initialize()).await??;
    Ok(mcp)
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_config_round_trips_through_v2_rpc() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let cwd = workspace.path().to_string_lossy().into_owned();
    let mut mcp = initialized_app_server(&codex_home).await?;

    let created: AgentCreateResponse = request(
        &mut mcp,
        "agent/create",
        json!({
            "cwd": cwd,
            "config": {
                "name": "Demo Agent",
                "threadId": "thread-agent-rpc",
                "role": "Engineer"
            }
        }),
    )
    .await?;
    assert_eq!(created.agent_id, "agent-demo-agent");

    let listed: AgentListResponse = request(
        &mut mcp,
        "agent/list",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "cursor": null,
            "limit": 24
        }),
    )
    .await?;
    assert_eq!(listed.next_cursor, None);
    assert_eq!(listed.data.len(), 1);
    assert_eq!(listed.data[0].file_path, created.file_path);
    assert_eq!(listed.data[0].config["agentId"], "agent-demo-agent");
    assert_eq!(listed.data[0].config["name"], "Demo Agent");

    let read: AgentReadResponse = request(
        &mut mcp,
        "agent/read",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "agentId": "agent-demo-agent",
            "threadId": null,
            "name": null
        }),
    )
    .await?;
    assert_eq!(
        read.record.expect("agent record").file_path,
        created.file_path
    );

    let deleted: AgentDeleteResponse = request(
        &mut mcp,
        "agent/delete",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "filePath": created.file_path
        }),
    )
    .await?;
    assert!(deleted.deleted);

    let listed_after_delete: AgentListResponse = request(
        &mut mcp,
        "agent/list",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "cursor": null,
            "limit": 24
        }),
    )
    .await?;
    assert_eq!(listed_after_delete.data, Vec::new());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_config_round_trips_through_v2_rpc() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let cwd = workspace.path().to_string_lossy().into_owned();
    let mut mcp = initialized_app_server(&codex_home).await?;

    let saved: ToolSaveResponse = request(
        &mut mcp,
        "tool/save",
        json!({
            "cwd": cwd,
            "config": {
                "kind": "mcp",
                "title": "Issue Tracker",
                "name": "linear"
            }
        }),
    )
    .await?;

    let listed: ToolListResponse = request(
        &mut mcp,
        "tool/list",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "kind": "mcp",
            "cursor": null,
            "limit": 24
        }),
    )
    .await?;
    assert_eq!(listed.next_cursor, None);
    assert_eq!(listed.data.len(), 1);
    assert_eq!(listed.data[0].file_path, saved.file_path);
    assert_eq!(listed.data[0].kind, ToolConfigKind::Mcp);
    assert_eq!(listed.data[0].config["name"], "linear");

    let deleted: ToolDeleteResponse = request(
        &mut mcp,
        "tool/delete",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "filePath": saved.file_path
        }),
    )
    .await?;
    assert!(deleted.deleted);

    let listed_after_delete: ToolListResponse = request(
        &mut mcp,
        "tool/list",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "kind": "mcp",
            "cursor": null,
            "limit": 24
        }),
    )
    .await?;
    assert_eq!(listed_after_delete.data, Vec::new());
    Ok(())
}
