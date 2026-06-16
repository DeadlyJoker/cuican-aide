use std::time::Duration;

use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::to_response;
use crewon_app_server_protocol::AgentCreateResponse;
use crewon_app_server_protocol::AgentDeleteResponse;
use crewon_app_server_protocol::AgentListResponse;
use crewon_app_server_protocol::AgentReadResponse;
use crewon_app_server_protocol::AgentUpdateResponse;
use crewon_app_server_protocol::AutomationCreateResponse;
use crewon_app_server_protocol::AutomationDeleteResponse;
use crewon_app_server_protocol::AutomationListResponse;
use crewon_app_server_protocol::AutomationReadResponse;
use crewon_app_server_protocol::AutomationRunResponse;
use crewon_app_server_protocol::AutomationRunUpdateResponse;
use crewon_app_server_protocol::AutomationRunsListResponse;
use crewon_app_server_protocol::AutomationSaveResponse;
use crewon_app_server_protocol::AutomationUpdateResponse;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::KnowledgeListResponse;
use crewon_app_server_protocol::KnowledgeMemoryWriteResponse;
use crewon_app_server_protocol::OfficeApprovalDecideResponse;
use crewon_app_server_protocol::OfficeArtifactUpsertResponse;
use crewon_app_server_protocol::OfficeCreateResponse;
use crewon_app_server_protocol::OfficeDeleteResponse;
use crewon_app_server_protocol::OfficeListResponse;
use crewon_app_server_protocol::OfficeMemberAddResponse;
use crewon_app_server_protocol::OfficeMessageSendResponse;
use crewon_app_server_protocol::OfficeReadResponse;
use crewon_app_server_protocol::OfficeSaveResponse;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::ToolConfigKind;
use crewon_app_server_protocol::ToolDeleteResponse;
use crewon_app_server_protocol::ToolListResponse;
use crewon_app_server_protocol::ToolReadResponse;
use crewon_app_server_protocol::ToolSaveResponse;
use crewon_app_server_protocol::ToolUpdateResponse;
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

fn office_config() -> serde_json::Value {
    json!({
        "title": "Demo Office",
        "subtitle": "Customer delivery",
        "workspace": {
            "goal": "Ship the demo",
            "threadId": "thread-office-rpc",
            "members": [
                {
                    "agentId": "agent-engineer",
                    "name": "Engineer",
                    "role": "Build",
                    "glyph": "E",
                    "accent": "blue",
                    "status": "online"
                }
            ],
            "messages": [],
            "tasks": [],
            "activity": {
                "approvals": [
                    {
                        "id": "approval-1",
                        "actor": "Engineer",
                        "glyph": "E",
                        "accent": "blue",
                        "action": "Deploy",
                        "detail": "Release demo",
                        "risk": "medium",
                        "time": "now"
                    }
                ],
                "artifacts": []
            }
        }
    })
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

    let updated: AgentUpdateResponse = request(
        &mut mcp,
        "agent/update",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "filePath": created.file_path,
            "config": {
                "agentId": "agent-demo-agent",
                "name": "Demo Agent Updated",
                "threadId": "thread-agent-rpc",
                "role": "Reviewer"
            }
        }),
    )
    .await?;
    assert_eq!(updated.agent_id, "agent-demo-agent");

    let listed_after_update: AgentListResponse = request(
        &mut mcp,
        "agent/list",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "cursor": null,
            "limit": 24
        }),
    )
    .await?;
    assert_eq!(listed_after_update.data.len(), 1);
    assert_eq!(listed_after_update.data[0].file_path, updated.file_path);
    assert_eq!(
        listed_after_update.data[0].config["name"],
        "Demo Agent Updated"
    );
    assert_eq!(listed_after_update.data[0].config["role"], "Reviewer");

    let deleted: AgentDeleteResponse = request(
        &mut mcp,
        "agent/delete",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "filePath": updated.file_path
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
async fn office_config_round_trips_through_v2_rpc() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let cwd = workspace.path().to_string_lossy().into_owned();
    let mut mcp = initialized_app_server(&codex_home).await?;

    let created: OfficeCreateResponse = request(
        &mut mcp,
        "office/create",
        json!({
            "cwd": cwd,
            "title": "Created Office",
            "subtitle": "Launch desk",
            "threadId": "thread-created-office",
            "goal": "Prepare launch notes"
        }),
    )
    .await?;
    assert_eq!(
        created.config,
        json!({
            "title": "Created Office",
            "subtitle": "Launch desk",
            "workspace": {
                "goal": "Prepare launch notes",
                "threadId": "thread-created-office",
                "members": [],
                "messages": [],
                "tasks": [],
                "activity": {
                    "approvals": [],
                    "artifacts": []
                }
            }
        })
    );

    let read_created: OfficeReadResponse = request(
        &mut mcp,
        "office/read",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "threadId": "thread-created-office",
            "title": null
        }),
    )
    .await?;
    assert_eq!(
        read_created.record.as_ref().map(|record| &record.config),
        Some(&created.config)
    );

    let created_deleted: OfficeDeleteResponse = request(
        &mut mcp,
        "office/delete",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "filePath": created.file_path
        }),
    )
    .await?;
    assert!(created_deleted.deleted);

    let saved: OfficeSaveResponse = request(
        &mut mcp,
        "office/save",
        json!({
            "cwd": cwd,
            "config": office_config()
        }),
    )
    .await?;

    let listed: OfficeListResponse = request(
        &mut mcp,
        "office/list",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "cursor": null,
            "limit": 24
        }),
    )
    .await?;
    assert_eq!(listed.next_cursor, None);
    assert_eq!(listed.data.len(), 1);
    assert_eq!(listed.data[0].file_path, saved.file_path);
    assert_eq!(listed.data[0].config["title"], "Demo Office");

    let read: OfficeReadResponse = request(
        &mut mcp,
        "office/read",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "threadId": "thread-office-rpc",
            "title": null
        }),
    )
    .await?;
    assert_eq!(
        read.record.expect("office record").file_path,
        saved.file_path
    );

    let message_sent: OfficeMessageSendResponse = request(
        &mut mcp,
        "office/message/send",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": office_config(),
            "message": {
                "author": "User",
                "glyph": "@",
                "accent": "slate",
                "time": "now",
                "text": "@Engineer prepare the demo",
                "kind": "message"
            },
            "text": "@Engineer prepare the demo",
            "locale": "en",
            "workspace": null
        }),
    )
    .await?;
    assert_eq!(
        message_sent.config["workspace"]["tasks"][0]["owner"],
        "Engineer"
    );

    let member_added: OfficeMemberAddResponse = request(
        &mut mcp,
        "office/member/add",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": message_sent.config,
            "agentId": "agent-reviewer",
            "member": {
                "name": "Reviewer",
                "role": "Review",
                "glyph": "R",
                "accent": "green",
                "status": "online"
            }
        }),
    )
    .await?;
    assert_eq!(
        member_added.config["workspace"]["members"][1]["agentId"],
        "agent-reviewer"
    );

    let approval_decided: OfficeApprovalDecideResponse = request(
        &mut mcp,
        "office/approval/decide",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": member_added.config,
            "approvalId": "approval-1",
            "decision": "approved",
            "message": null
        }),
    )
    .await?;
    assert_eq!(
        approval_decided.config["workspace"]["activity"]["approvals"][0]["decision"],
        "approved"
    );

    let artifact_saved: OfficeArtifactUpsertResponse = request(
        &mut mcp,
        "office/artifact/upsert",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": approval_decided.config,
            "artifact": {
                "title": "Demo Brief",
                "kind": "doc",
                "glyph": "D",
                "accent": "blue",
                "meta": "ready"
            },
            "message": null
        }),
    )
    .await?;
    assert_eq!(
        artifact_saved.config["workspace"]["activity"]["artifacts"][0]["title"],
        "Demo Brief"
    );

    let deleted: OfficeDeleteResponse = request(
        &mut mcp,
        "office/delete",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "filePath": artifact_saved.file_path
        }),
    )
    .await?;
    assert!(deleted.deleted);

    let listed_after_delete: OfficeListResponse = request(
        &mut mcp,
        "office/list",
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
async fn automation_config_round_trips_through_v2_rpc() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let cwd = workspace.path().to_string_lossy().into_owned();
    let mut mcp = initialized_app_server(&codex_home).await?;

    let created: AutomationCreateResponse = request(
        &mut mcp,
        "automation/create",
        json!({
            "cwd": cwd,
            "title": "Demo Automation",
            "threadId": "thread-automation-rpc",
            "targetOffice": office_config(),
            "executionAgent": {
                "agentId": "agent-engineer",
                "name": "Engineer"
            },
            "prompt": "Run the demo checks",
            "enabled": true,
            "status": "enabled"
        }),
    )
    .await?;
    assert_eq!(created.config["title"], "Demo Automation");

    let saved: AutomationSaveResponse = request(
        &mut mcp,
        "automation/save",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": created.config
        }),
    )
    .await?;

    let listed: AutomationListResponse = request(
        &mut mcp,
        "automation/list",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "cursor": null,
            "limit": 24
        }),
    )
    .await?;
    assert_eq!(listed.next_cursor, None);
    assert_eq!(listed.data.len(), 1);
    assert_eq!(listed.data[0].file_path, saved.file_path);

    let read_by_thread: AutomationReadResponse = request(
        &mut mcp,
        "automation/read",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "filePath": null,
            "threadId": "thread-automation-rpc",
            "title": null
        }),
    )
    .await?;
    assert_eq!(
        read_by_thread
            .record
            .as_ref()
            .map(|record| &record.file_path),
        Some(&saved.file_path)
    );

    let mut updated_config = created.config;
    updated_config["status"] = json!("paused");
    let updated_config_response: AutomationUpdateResponse = request(
        &mut mcp,
        "automation/update",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "filePath": saved.file_path,
            "config": updated_config
        }),
    )
    .await?;
    assert_eq!(updated_config_response.file_path, saved.file_path);
    assert_eq!(updated_config_response.config["status"], "paused");

    let read_by_path: AutomationReadResponse = request(
        &mut mcp,
        "automation/read",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "filePath": saved.file_path,
            "threadId": null,
            "title": null
        }),
    )
    .await?;
    assert_eq!(
        read_by_path.record.as_ref().map(|record| &record.config),
        Some(&updated_config_response.config)
    );

    let run: AutomationRunResponse = request(
        &mut mcp,
        "automation/run",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": updated_config_response.config,
            "note": "smoke",
            "turnId": "turn-automation-rpc"
        }),
    )
    .await?;
    assert_eq!(run.run.automation_title, "Demo Automation");
    assert_eq!(run.run.status, "running");
    assert_eq!(run.run.turn_id.as_deref(), Some("turn-automation-rpc"));

    let updated: AutomationRunUpdateResponse = request(
        &mut mcp,
        "automation/run/update",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "filePath": run.file_path,
            "status": "completed",
            "completedAt": run.run.started_at + 1
        }),
    )
    .await?;
    assert_eq!(updated.run.status, "completed");

    let runs: AutomationRunsListResponse = request(
        &mut mcp,
        "automation/runs/list",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "threadId": "thread-automation-rpc",
            "cursor": null,
            "limit": 24
        }),
    )
    .await?;
    assert_eq!(runs.next_cursor, None);
    assert_eq!(runs.data.len(), 1);
    assert_eq!(runs.data[0].run.status, "completed");

    let deleted: AutomationDeleteResponse = request(
        &mut mcp,
        "automation/delete",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "filePath": saved.file_path
        }),
    )
    .await?;
    assert!(deleted.deleted);

    let listed_after_delete: AutomationListResponse = request(
        &mut mcp,
        "automation/list",
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
async fn knowledge_round_trips_through_v2_rpc() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let cwd = workspace.path().to_string_lossy().into_owned();
    let mut mcp = initialized_app_server(&codex_home).await?;

    let empty: KnowledgeListResponse = request(
        &mut mcp,
        "knowledge/list",
        json!({
            "cwd": cwd,
            "limit": 24
        }),
    )
    .await?;
    assert_eq!(empty.data.memories, Vec::new());

    let written: KnowledgeMemoryWriteResponse = request(
        &mut mcp,
        "knowledge/memory/write",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "title": "Demo Context",
            "threadId": "thread-knowledge-rpc",
            "note": "Customer prefers concise updates."
        }),
    )
    .await?;
    assert_eq!(written.data.memories.len(), 1);
    assert!(written.file_path.ends_with(".crewon/knowledge.md"));
    assert_eq!(written.data.memories[0].title, "Crewon Knowledge");
    assert!(written.data.memories[0].preview.contains("Demo Context"));
    let written_file = std::fs::read_to_string(&written.file_path)?;
    assert!(written_file.contains("Demo Context"));
    assert!(written_file.contains("thread-knowledge-rpc"));
    assert!(written_file.contains("Customer prefers concise updates."));

    let listed: KnowledgeListResponse = request(
        &mut mcp,
        "knowledge/list",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "limit": 24
        }),
    )
    .await?;
    assert_eq!(listed.data.memories, written.data.memories);
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

    let read: ToolReadResponse = request(
        &mut mcp,
        "tool/read",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "filePath": saved.file_path
        }),
    )
    .await?;
    assert_eq!(
        read.record.as_ref().map(|record| &record.file_path),
        Some(&saved.file_path)
    );
    assert_eq!(
        read.record.as_ref().map(|record| &record.config["name"]),
        Some(&json!("linear"))
    );

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

    let updated_config = json!({
        "kind": "mcp",
        "title": "Issue Tracker",
        "name": "linear-production"
    });
    let updated: ToolUpdateResponse = request(
        &mut mcp,
        "tool/update",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "filePath": saved.file_path,
            "config": updated_config.clone()
        }),
    )
    .await?;
    assert_eq!(updated.file_path, saved.file_path);
    assert_eq!(updated.config, updated_config);

    let read_after_update: ToolReadResponse = request(
        &mut mcp,
        "tool/read",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "filePath": saved.file_path
        }),
    )
    .await?;
    assert_eq!(
        read_after_update
            .record
            .as_ref()
            .map(|record| &record.config),
        Some(&updated_config)
    );

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
