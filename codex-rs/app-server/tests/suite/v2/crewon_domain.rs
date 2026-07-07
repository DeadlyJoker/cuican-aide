use std::time::Duration;

use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::create_final_assistant_message_sse_response;
use app_test_support::create_mock_responses_server_sequence_unchecked;
use app_test_support::to_response;
use app_test_support::write_mock_responses_config_toml_with_chatgpt_base_url;
use crewon_app_server_protocol::AgentCreateResponse;
use crewon_app_server_protocol::AgentDeleteResponse;
use crewon_app_server_protocol::AgentListResponse;
use crewon_app_server_protocol::AgentReadResponse;
use crewon_app_server_protocol::AgentSaveResponse;
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
use crewon_app_server_protocol::JSONRPCNotification;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::KnowledgeListResponse;
use crewon_app_server_protocol::KnowledgeMemoryWriteResponse;
use crewon_app_server_protocol::OfficeApprovalDecideResponse;
use crewon_app_server_protocol::OfficeArtifactUpsertResponse;
use crewon_app_server_protocol::OfficeCreateResponse;
use crewon_app_server_protocol::OfficeDeleteResponse;
use crewon_app_server_protocol::OfficeListResponse;
use crewon_app_server_protocol::OfficeMemberAddResponse;
use crewon_app_server_protocol::OfficeMemoryDecideResponse;
use crewon_app_server_protocol::OfficeMemoryListResponse;
use crewon_app_server_protocol::OfficeMessageSendResponse;
use crewon_app_server_protocol::OfficeReadResponse;
use crewon_app_server_protocol::OfficeRunResponse;
use crewon_app_server_protocol::OfficeRunSyncResponse;
use crewon_app_server_protocol::OfficeRunUpdatedNotification;
use crewon_app_server_protocol::OfficeSaveResponse;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::ThreadSource;
use crewon_app_server_protocol::ThreadStartParams;
use crewon_app_server_protocol::ThreadStartResponse;
use crewon_app_server_protocol::ToolConfigKind;
use crewon_app_server_protocol::ToolDeleteResponse;
use crewon_app_server_protocol::ToolListResponse;
use crewon_app_server_protocol::ToolReadResponse;
use crewon_app_server_protocol::ToolSaveResponse;
use crewon_app_server_protocol::ToolUpdateResponse;
use crewon_app_server_protocol::TurnCompletedNotification;
use crewon_app_server_protocol::TurnStartParams;
use crewon_app_server_protocol::TurnStartResponse;
use crewon_app_server_protocol::TurnStatus;
use crewon_app_server_protocol::UserInput as V2UserInput;
use pretty_assertions::assert_eq;
use serde_json::json;
use sha2::Digest as _;
use sha2::Sha256;
use tempfile::TempDir;
use tokio::time::timeout;
use uuid::Uuid;

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

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
}

fn assert_sha256_hex(value: &serde_json::Value) {
    assert!(
        value.as_str().is_some_and(|hash| {
            hash.len() == 64 && hash.chars().all(|ch| ch.is_ascii_hexdigit())
        })
    );
}

async fn start_workspace_thread(
    mcp: &mut TestAppServer,
    workspace: &TempDir,
) -> Result<ThreadStartResponse> {
    let request_id = mcp
        .send_thread_start_request(ThreadStartParams {
            model: Some("mock-model".to_string()),
            cwd: Some(workspace.path().to_string_lossy().into_owned()),
            thread_source: Some(ThreadSource::User),
            ..Default::default()
        })
        .await?;
    let response: JSONRPCResponse = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    to_response(response)
}

fn office_config() -> serde_json::Value {
    office_config_for_thread("thread-office-rpc")
}

fn office_config_for_thread(thread_id: &str) -> serde_json::Value {
    json!({
        "title": "Demo Office",
        "subtitle": "Customer delivery",
        "workspace": {
            "goal": "Ship the demo",
            "threadId": thread_id,
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
        message_sent.config["workspace"]["messages"][1]["author"],
        "Manager agent"
    );
    assert_eq!(
        message_sent.config["workspace"]["messages"][1]["kind"],
        "message"
    );
    assert!(
        message_sent.config["workspace"]["tasks"]
            .as_array()
            .expect("tasks array")
            .is_empty()
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
                "meta": "ready",
                "content": "Demo artifact body"
            },
            "message": null
        }),
    )
    .await?;
    assert_eq!(
        artifact_saved.config["workspace"]["activity"]["artifacts"][0]["title"],
        "Demo Brief"
    );
    assert_eq!(
        artifact_saved.config["workspace"]["activity"]["artifacts"][0]["contentSha256"],
        sha256_hex(b"Demo artifact body")
    );
    assert_eq!(
        artifact_saved.config["workspace"]["activity"]["artifacts"][0]["contentBytes"],
        json!("Demo artifact body".len())
    );
    assert_eq!(
        artifact_saved.config["workspace"]["activity"]["artifacts"][0]["contentSource"],
        "inline"
    );
    assert_eq!(
        artifact_saved.config["workspace"]["activity"]["artifacts"][0]["contentStatus"],
        "fingerprinted"
    );
    assert!(
        artifact_saved.config["workspace"]["activity"]["artifacts"][0]["contentObservedAt"]
            .as_str()
            .is_some_and(|observed_at| !observed_at.trim().is_empty())
    );
    assert!(
        artifact_saved.config["workspace"]["activity"]["artifacts"][0]
            .get("content")
            .is_none()
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
async fn office_run_starts_real_turn_and_auto_syncs_terminal_state() -> Result<()> {
    let assistant_message = "Office run finished with verified artifacts.";
    let responses = vec![create_final_assistant_message_sse_response(
        assistant_message,
    )?];
    let server = create_mock_responses_server_sequence_unchecked(responses).await;

    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut mcp = initialized_app_server(&codex_home).await?;

    let thread_request_id = mcp
        .send_thread_start_request(ThreadStartParams {
            model: Some("mock-model".to_string()),
            cwd: Some(workspace.path().to_string_lossy().into_owned()),
            thread_source: Some(ThreadSource::User),
            ..Default::default()
        })
        .await?;
    let thread_response: JSONRPCResponse = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(thread_request_id)),
    )
    .await??;
    let ThreadStartResponse { thread, .. } = to_response(thread_response)?;

    let office_config = office_config_for_thread(&thread.id);
    let run: OfficeRunResponse = request(
        &mut mcp,
        "office/run",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": office_config,
            "message": {
                "author": "User",
                "glyph": "@",
                "accent": "slate",
                "time": "now",
                "text": "Prepare the launch demo",
                "kind": "message"
            },
            "text": "Prepare the launch demo",
            "locale": "en",
            "threadId": null,
            "clientUserMessageId": "office-message-1"
        }),
    )
    .await?;
    assert_eq!(run.thread_id, thread.id);
    assert!(!run.run_id.is_empty());
    assert_eq!(run.turn.status, TurnStatus::InProgress);

    let started_notification: JSONRPCNotification = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_notification_message("office/run/updated"),
    )
    .await??;
    let started_update: OfficeRunUpdatedNotification = serde_json::from_value(
        started_notification
            .params
            .expect("office/run/updated params must be present"),
    )?;
    assert_eq!(started_update.reason, "started");
    assert_eq!(
        started_update.source_thread_id.as_deref(),
        Some(thread.id.as_str())
    );
    assert_eq!(
        started_update.source_turn_id.as_deref(),
        Some(run.turn.id.as_str())
    );
    assert_eq!(
        started_update.config["workspace"]["activity"]["runs"][0]["status"],
        "running"
    );

    let completed_notification: JSONRPCNotification = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_notification_message("turn/completed"),
    )
    .await??;
    let completed: TurnCompletedNotification = serde_json::from_value(
        completed_notification
            .params
            .expect("turn/completed params must be present"),
    )?;
    assert_eq!(completed.thread_id, thread.id);
    assert_eq!(completed.turn.id, run.turn.id);
    assert_eq!(completed.turn.status, TurnStatus::Completed);

    let synced_notification: JSONRPCNotification = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_notification_message("office/run/updated"),
    )
    .await??;
    let synced_update: OfficeRunUpdatedNotification = serde_json::from_value(
        synced_notification
            .params
            .expect("office/run/updated params must be present"),
    )?;
    assert_eq!(synced_update.reason, "terminalSync");
    assert_eq!(
        synced_update.source_thread_id.as_deref(),
        Some(thread.id.as_str())
    );
    assert_eq!(
        synced_update.source_turn_id.as_deref(),
        Some(run.turn.id.as_str())
    );
    assert_eq!(
        synced_update.config["workspace"]["activity"]["runs"][0]["status"],
        "completed"
    );

    let mut synced_config = None;
    for _ in 0..20 {
        let read: OfficeReadResponse = request(
            &mut mcp,
            "office/read",
            json!({
                "cwd": workspace.path().to_string_lossy(),
                "threadId": thread.id,
                "title": null
            }),
        )
        .await?;
        if let Some(record) = read.record {
            let config = record.config;
            if config["workspace"]["activity"]["runs"][0]["status"] == "completed" {
                synced_config = Some(config);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let synced_config = synced_config.expect("office run should auto-sync after turn completion");
    assert_eq!(
        synced_config["workspace"]["activity"]["runs"][0]["id"],
        run.run_id
    );
    assert_eq!(
        synced_config["workspace"]["activity"]["runs"][0]["turnId"],
        run.turn.id
    );
    assert_eq!(
        synced_config["workspace"]["activity"]["runs"][0]["resultPreview"],
        assistant_message
    );
    assert_eq!(synced_config["workspace"]["tasks"][0]["status"], "done");
    assert_eq!(
        synced_config["workspace"]["messages"][2]["text"],
        format!("Team run completed: Prepare the launch demo\n\n{assistant_message}")
    );

    let model_requests = server.received_requests().await.unwrap_or_default();
    assert_eq!(model_requests.len(), 1);
    let request_body = model_requests[0].body_json::<serde_json::Value>()?;
    let request_body_text = request_body.to_string();
    assert!(request_body_text.contains("You are the manager agent"));
    assert!(request_body_text.contains("Do not treat every chat message as a task"));
    assert!(request_body_text.contains("Prepare the launch demo"));
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_run_auto_dispatches_safe_delegation_after_terminal_sync() -> Result<()> {
    let manager_message = r#"Plan ready.
```json
{
  "officeUpdate": {
    "summary": "Plan ready with safe delegation.",
    "acceptanceCriteria": [
      {
        "criterion": "Launch demo checklist has an owner",
        "status": "passed",
        "evidence": "Manager assigned the checklist to Engineer"
      }
    ],
    "evidence": [
      {
        "summary": "Manager framed launch demo evidence",
        "status": "verified",
        "source": "manager turn"
      }
    ],
    "artifacts": [
      {
        "title": "manager-plan.md",
        "kind": "doc",
        "meta": "Manager planning artifact",
        "path": "manager-plan.md"
      }
    ],
    "delegations": [
      {
        "member": "Engineer",
        "agentId": "agent-engineer",
        "task": "Build the launch demo checklist",
        "status": "pending",
        "dispatchMode": "auto",
        "riskSeverity": "low",
        "approvalRequired": false
      }
    ]
  }
}
```"#;
    let member_message = r#"Checklist complete.
```json
{
  "officeUpdate": {
    "summary": "Checklist complete.",
    "acceptanceCriteria": [
      {
        "criterion": "Checklist is ready",
        "status": "passed",
        "evidence": "Member completed the checklist"
      }
    ],
    "evidence": [
      {
        "summary": "Member produced the checklist",
        "status": "verified",
        "source": "member turn"
      }
    ],
    "artifacts": [
      {
        "title": "member-checklist.md",
        "kind": "doc",
        "meta": "Member checklist artifact",
        "path": "member-checklist.md"
      }
    ]
  }
}
```"#;
    let responses = vec![
        create_final_assistant_message_sse_response(manager_message)?,
        create_final_assistant_message_sse_response(member_message)?,
        create_final_assistant_message_sse_response(
            "Verification evidence still needs a backend check.",
        )?,
    ];
    let server = create_mock_responses_server_sequence_unchecked(responses).await;

    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    tokio::fs::write(
        workspace.path().join("manager-plan.md"),
        b"manager plan artifact",
    )
    .await?;
    tokio::fs::write(
        workspace.path().join("member-checklist.md"),
        b"member checklist artifact",
    )
    .await?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut mcp = initialized_app_server(&codex_home).await?;

    let office_thread = start_workspace_thread(&mut mcp, &workspace).await?.thread;
    let member_thread = start_workspace_thread(&mut mcp, &workspace).await?.thread;
    let _: AgentSaveResponse = request(
        &mut mcp,
        "agent/save",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": {
                "agentId": "agent-engineer",
                "name": "Engineer",
                "threadId": member_thread.id,
                "role": "Build"
            }
        }),
    )
    .await?;

    let run: OfficeRunResponse = request(
        &mut mcp,
        "office/run",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": office_config_for_thread(&office_thread.id),
            "message": {
                "author": "User",
                "glyph": "@",
                "accent": "slate",
                "time": "now",
                "text": "Prepare the launch demo",
                "kind": "message"
            },
            "text": "Prepare the launch demo",
            "locale": "en",
            "threadId": null,
            "clientUserMessageId": "office-message-1"
        }),
    )
    .await?;
    assert_eq!(run.thread_id, office_thread.id);

    let manager_completed: TurnCompletedNotification = serde_json::from_value(
        timeout(
            DEFAULT_TIMEOUT,
            mcp.read_stream_until_notification_message("turn/completed"),
        )
        .await??
        .params
        .expect("turn/completed params must be present"),
    )?;
    assert_eq!(manager_completed.thread_id, office_thread.id);
    assert_eq!(manager_completed.turn.id, run.turn.id);

    let auto_started_notification: JSONRPCNotification = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_matching_notification(
            "office auto dispatch started",
            |notification| {
                if notification.method != "office/run/updated" {
                    return false;
                }
                notification
                    .params
                    .as_ref()
                    .and_then(|params| {
                        serde_json::from_value::<OfficeRunUpdatedNotification>(params.clone()).ok()
                    })
                    .is_some_and(|update| update.reason == "autoDispatchStarted")
            },
        ),
    )
    .await??;
    let auto_started_update: OfficeRunUpdatedNotification = serde_json::from_value(
        auto_started_notification
            .params
            .expect("office/run/updated params must be present"),
    )?;
    assert_eq!(
        auto_started_update.source_thread_id.as_deref(),
        Some(member_thread.id.as_str())
    );
    let auto_started_delegation =
        &auto_started_update.config["workspace"]["activity"]["runs"][0]["delegations"][0];
    assert_eq!(auto_started_delegation["status"], "running");
    assert_eq!(auto_started_delegation["threadId"], member_thread.id);
    assert_eq!(
        auto_started_delegation["turnId"],
        auto_started_update
            .source_turn_id
            .as_deref()
            .expect("started update should include member turn id")
    );

    let member_completed: TurnCompletedNotification = serde_json::from_value(
        timeout(
            DEFAULT_TIMEOUT,
            mcp.read_stream_until_notification_message("turn/completed"),
        )
        .await??
        .params
        .expect("turn/completed params must be present"),
    )?;
    assert_eq!(member_completed.thread_id, member_thread.id);
    assert_eq!(member_completed.turn.status, TurnStatus::Completed);

    let mut synced_config = None;
    for _ in 0..20 {
        let read: OfficeReadResponse = request(
            &mut mcp,
            "office/read",
            json!({
                "cwd": workspace.path().to_string_lossy(),
                "threadId": office_thread.id,
                "title": null
            }),
        )
        .await?;
        if let Some(record) = read.record {
            let config = record.config;
            let delegation = &config["workspace"]["activity"]["runs"][0]["delegations"][0];
            if delegation["status"] == "completed" {
                synced_config = Some(config);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let synced_config =
        synced_config.expect("member delegation should auto-sync to the office run");
    let delegation = &synced_config["workspace"]["activity"]["runs"][0]["delegations"][0];
    assert_eq!(delegation["member"], "Engineer");
    assert_eq!(delegation["agentId"], "agent-engineer");
    assert_eq!(delegation["threadId"], member_thread.id);
    assert_eq!(delegation["turnId"], member_completed.turn.id);
    assert_eq!(delegation["resultPreview"], "Checklist complete.");
    let run_record = &synced_config["workspace"]["activity"]["runs"][0];
    let acceptance = run_record["acceptanceCriteria"]
        .as_array()
        .expect("run acceptance criteria");
    let member_acceptance = acceptance
        .iter()
        .find(|item| item["criterion"] == "Checklist is ready")
        .expect("member acceptance criterion");
    assert_eq!(member_acceptance["sourceType"], "memberDelegation");
    assert_eq!(member_acceptance["sourceThreadId"], member_thread.id);
    assert_eq!(member_acceptance["sourceTurnId"], member_completed.turn.id);
    assert_eq!(member_acceptance["delegationId"], delegation["id"]);
    let evidence = run_record["evidence"].as_array().expect("run evidence");
    let manager_evidence = evidence
        .iter()
        .find(|item| item["summary"] == "Manager framed launch demo evidence")
        .expect("manager evidence");
    assert_eq!(manager_evidence["sourceType"], "managerRun");
    assert_eq!(manager_evidence["sourceThreadId"], office_thread.id);
    assert_eq!(manager_evidence["sourceTurnId"], run.turn.id);
    assert!(
        manager_evidence["observedAt"]
            .as_str()
            .is_some_and(|observed_at| !observed_at.trim().is_empty())
    );
    let member_evidence = evidence
        .iter()
        .find(|item| item["summary"] == "Member produced the checklist")
        .expect("member evidence");
    assert_eq!(member_evidence["sourceType"], "memberDelegation");
    assert_eq!(member_evidence["sourceThreadId"], member_thread.id);
    assert_eq!(member_evidence["sourceTurnId"], member_completed.turn.id);
    assert_eq!(member_evidence["delegationId"], delegation["id"]);
    assert_eq!(member_evidence["member"], "Engineer");
    assert_eq!(member_evidence["agentId"], "agent-engineer");
    let artifacts = synced_config["workspace"]["activity"]["artifacts"]
        .as_array()
        .expect("office artifacts");
    let manager_artifact = artifacts
        .iter()
        .find(|artifact| artifact["title"] == "manager-plan.md")
        .expect("manager artifact");
    assert_eq!(manager_artifact["meta"], "Manager planning artifact");
    assert_eq!(manager_artifact["sourceType"], "managerRun");
    assert_eq!(manager_artifact["sourceThreadId"], office_thread.id);
    assert_eq!(manager_artifact["sourceTurnId"], run.turn.id);
    assert_eq!(manager_artifact["path"], "manager-plan.md");
    assert_eq!(
        manager_artifact["contentSha256"],
        sha256_hex(b"manager plan artifact")
    );
    assert_eq!(
        manager_artifact["contentBytes"],
        json!("manager plan artifact".len())
    );
    assert_eq!(manager_artifact["contentSource"], "file");
    assert_eq!(manager_artifact["contentStatus"], "fingerprinted");
    assert!(
        manager_artifact["contentObservedAt"]
            .as_str()
            .is_some_and(|observed_at| !observed_at.trim().is_empty())
    );
    let member_artifact = artifacts
        .iter()
        .find(|artifact| artifact["title"] == "member-checklist.md")
        .expect("member artifact");
    assert_eq!(member_artifact["meta"], "Member checklist artifact");
    assert_eq!(member_artifact["sourceType"], "memberDelegation");
    assert_eq!(member_artifact["sourceThreadId"], member_thread.id);
    assert_eq!(member_artifact["sourceTurnId"], member_completed.turn.id);
    assert_eq!(member_artifact["delegationId"], delegation["id"]);
    assert_eq!(member_artifact["member"], "Engineer");
    assert_eq!(member_artifact["agentId"], "agent-engineer");
    assert_eq!(member_artifact["path"], "member-checklist.md");
    assert_eq!(
        member_artifact["contentSha256"],
        sha256_hex(b"member checklist artifact")
    );
    assert_eq!(
        member_artifact["contentBytes"],
        json!("member checklist artifact".len())
    );
    assert_eq!(member_artifact["contentSource"], "file");
    assert_eq!(member_artifact["contentStatus"], "fingerprinted");
    assert!(
        member_artifact["contentObservedAt"]
            .as_str()
            .is_some_and(|observed_at| !observed_at.trim().is_empty())
    );

    let model_requests = server.received_requests().await.unwrap_or_default();
    assert!(
        model_requests.len() >= 2,
        "expected at least manager and member requests, got {}",
        model_requests.len()
    );
    let manager_request = model_requests[0].body_json::<serde_json::Value>()?;
    let member_request = model_requests[1].body_json::<serde_json::Value>()?;
    assert!(
        manager_request
            .to_string()
            .contains("Prepare the launch demo")
    );
    assert!(
        member_request
            .to_string()
            .contains("Build the launch demo checklist")
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_run_auto_replans_manager_after_terminal_review() -> Result<()> {
    let first_manager_message = r#"Blocked.
```json
{
  "officeUpdate": {
    "summary": "Release readiness is blocked.",
    "acceptanceCriteria": [
      {
        "criterion": "All checks pass",
        "status": "failed",
        "evidence": "Integration test failed"
      }
    ],
    "verificationChecks": [
      {
        "check": "Run integration suite",
        "status": "failed",
        "command": "just test -p crewon-app-server",
        "evidence": "suite failed"
      }
    ],
    "evidence": [
      {
        "summary": "Integration test failed",
        "status": "blocked",
        "source": "just test"
      }
    ]
  }
}
```"#;
    let second_manager_message = r#"Repair complete.
```json
{
  "officeUpdate": {
    "summary": "Release readiness is repaired.",
    "acceptanceCriteria": [
      {
        "criterion": "All checks pass",
        "status": "passed",
        "evidence": "Integration test passed after repair"
      }
    ],
    "verificationChecks": [
      {
        "check": "Run integration suite",
        "status": "passed",
        "command": "just test -p crewon-app-server",
        "evidence": "suite passed"
      }
    ],
    "evidence": [
      {
        "summary": "Integration test passed after repair",
        "status": "verified",
        "source": "just test"
      }
    ]
  }
}
```"#;
    let responses = vec![
        create_final_assistant_message_sse_response(first_manager_message)?,
        create_final_assistant_message_sse_response(second_manager_message)?,
    ];
    let server = create_mock_responses_server_sequence_unchecked(responses).await;

    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut mcp = initialized_app_server(&codex_home).await?;
    let office_thread = start_workspace_thread(&mut mcp, &workspace).await?.thread;

    let run: OfficeRunResponse = request(
        &mut mcp,
        "office/run",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": office_config_for_thread(&office_thread.id),
            "message": {
                "author": "User",
                "glyph": "@",
                "accent": "slate",
                "time": "now",
                "text": "Check release readiness",
                "kind": "message"
            },
            "text": "Check release readiness",
            "locale": "en",
            "threadId": null,
            "clientUserMessageId": "office-message-1"
        }),
    )
    .await?;
    assert_eq!(run.thread_id, office_thread.id);

    let manager_completed: TurnCompletedNotification = serde_json::from_value(
        timeout(
            DEFAULT_TIMEOUT,
            mcp.read_stream_until_notification_message("turn/completed"),
        )
        .await??
        .params
        .expect("turn/completed params must be present"),
    )?;
    assert_eq!(manager_completed.thread_id, office_thread.id);
    assert_eq!(manager_completed.turn.id, run.turn.id);

    let auto_replan_started: OfficeRunUpdatedNotification = serde_json::from_value(
        timeout(
            DEFAULT_TIMEOUT,
            mcp.read_stream_until_matching_notification(
                "office auto replan started",
                |notification| {
                    if notification.method != "office/run/updated" {
                        return false;
                    }
                    notification
                        .params
                        .as_ref()
                        .and_then(|params| {
                            serde_json::from_value::<OfficeRunUpdatedNotification>(params.clone())
                                .ok()
                        })
                        .is_some_and(|update| update.reason == "autoReplanStarted")
                },
            ),
        )
        .await??
        .params
        .expect("office/run/updated params must be present"),
    )?;
    assert_eq!(
        auto_replan_started.source_thread_id.as_deref(),
        Some(office_thread.id.as_str())
    );
    let retry_run = &auto_replan_started.config["workspace"]["activity"]["runs"][0];
    assert_eq!(retry_run["status"], "running");
    assert_eq!(retry_run["retryOf"], run.run_id);
    assert_eq!(retry_run["loop"]["iteration"], 2);
    assert_eq!(
        retry_run["turnId"],
        auto_replan_started
            .source_turn_id
            .as_deref()
            .expect("auto replan update should include manager retry turn id")
    );

    let retry_completed: TurnCompletedNotification = serde_json::from_value(
        timeout(
            DEFAULT_TIMEOUT,
            mcp.read_stream_until_notification_message("turn/completed"),
        )
        .await??
        .params
        .expect("turn/completed params must be present"),
    )?;
    assert_eq!(retry_completed.thread_id, office_thread.id);
    assert_eq!(
        retry_completed.turn.id,
        auto_replan_started
            .source_turn_id
            .expect("auto replan update should include manager retry turn id")
    );

    let model_requests = server.received_requests().await.unwrap_or_default();
    assert_eq!(model_requests.len(), 2);
    let retry_request = model_requests[1].body_json::<serde_json::Value>()?;
    assert!(retry_request.to_string().contains("repairFailedCriteria"));
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_run_retrieves_only_explicitly_accepted_memories() -> Result<()> {
    let first_message = r#"Captured memories.
```json
{
  "officeUpdate": {
    "summary": "Captured memory candidates.",
    "memories": [
      {
        "scope": "office",
        "kind": "decision",
        "content": "accepted launch memory sentinel",
        "status": "accepted"
      },
      {
        "scope": "office",
        "kind": "decision",
        "content": "implicit pending memory sentinel"
      }
    ]
  }
}
```"#;
    let responses = vec![
        create_final_assistant_message_sse_response(first_message)?,
        create_final_assistant_message_sse_response("Second run complete.")?,
    ];
    let server = create_mock_responses_server_sequence_unchecked(responses).await;

    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut mcp = initialized_app_server(&codex_home).await?;

    let thread = start_workspace_thread(&mut mcp, &workspace).await?.thread;
    let first_run: OfficeRunResponse = request(
        &mut mcp,
        "office/run",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": office_config_for_thread(&thread.id),
            "message": {
                "author": "User",
                "glyph": "@",
                "accent": "slate",
                "time": "now",
                "text": "Record team memory sentinels",
                "kind": "message"
            },
            "text": "Record team memory sentinels",
            "locale": "en",
            "threadId": null,
            "clientUserMessageId": "office-memory-message-1"
        }),
    )
    .await?;
    timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_notification_message("turn/completed"),
    )
    .await??;
    timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_matching_notification(
            "terminal office memory sync",
            |notification| {
                if notification.method != "office/run/updated" {
                    return false;
                }
                notification
                    .params
                    .as_ref()
                    .and_then(|params| {
                        serde_json::from_value::<OfficeRunUpdatedNotification>(params.clone()).ok()
                    })
                    .is_some_and(|update| {
                        update.reason == "terminalSync"
                            && update.source_turn_id.as_deref() == Some(first_run.turn.id.as_str())
                    })
            },
        ),
    )
    .await??;

    let read: OfficeReadResponse = request(
        &mut mcp,
        "office/read",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "threadId": thread.id,
            "title": null
        }),
    )
    .await?;
    let saved_config = read.record.expect("office record").config;

    let accepted_memories: OfficeMemoryListResponse = request(
        &mut mcp,
        "office/memory/list",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": saved_config.clone(),
            "status": "accepted",
            "cursor": null,
            "limit": 10
        }),
    )
    .await?;
    assert_eq!(accepted_memories.data, Vec::new());

    let pending_memories: OfficeMemoryListResponse = request(
        &mut mcp,
        "office/memory/list",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": saved_config.clone(),
            "status": "pending",
            "cursor": null,
            "limit": 10
        }),
    )
    .await?;
    assert_eq!(pending_memories.data.len(), 2);
    let accepted_candidate = pending_memories
        .data
        .iter()
        .find(|memory| memory.content == "accepted launch memory sentinel")
        .expect("accepted model-authored memory should still require review")
        .id
        .clone();
    let pending_candidate = pending_memories
        .data
        .iter()
        .find(|memory| memory.content == "implicit pending memory sentinel")
        .expect("implicit pending memory")
        .id
        .clone();

    let accepted_memory: OfficeMemoryDecideResponse = request(
        &mut mcp,
        "office/memory/decide",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": saved_config.clone(),
            "memoryId": accepted_candidate,
            "status": "accepted"
        }),
    )
    .await?;
    assert_eq!(accepted_memory.memory.status, "accepted");
    assert_eq!(
        accepted_memory.memory.content,
        "accepted launch memory sentinel"
    );
    let accepted_update_notification: JSONRPCNotification = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_matching_notification(
            "accepted office memory decision update",
            |notification| {
                if notification.method != "office/run/updated" {
                    return false;
                }
                notification
                    .params
                    .as_ref()
                    .and_then(|params| {
                        serde_json::from_value::<OfficeRunUpdatedNotification>(params.clone()).ok()
                    })
                    .is_some_and(|update| {
                        update.reason == "memoryDecision"
                            && update.config["workspace"]["activity"]["runs"][0]["memoryRefs"]
                                .as_array()
                                .is_some_and(|memory_refs| {
                                    memory_refs.iter().any(|memory_ref| {
                                        memory_ref
                                            .get("content")
                                            .and_then(serde_json::Value::as_str)
                                            == Some("accepted launch memory sentinel")
                                            && memory_ref
                                                .get("status")
                                                .and_then(serde_json::Value::as_str)
                                                == Some("accepted")
                                    })
                                })
                    })
            },
        ),
    )
    .await??;
    let accepted_update: OfficeRunUpdatedNotification = serde_json::from_value(
        accepted_update_notification
            .params
            .expect("office/run/updated params must be present"),
    )?;
    assert_eq!(accepted_update.source_thread_id, None);
    assert_eq!(accepted_update.source_turn_id, None);

    let rejected_memory: OfficeMemoryDecideResponse = request(
        &mut mcp,
        "office/memory/decide",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": saved_config.clone(),
            "memoryId": pending_candidate,
            "status": "rejected"
        }),
    )
    .await?;
    assert_eq!(rejected_memory.memory.status, "rejected");
    assert_eq!(
        rejected_memory.memory.content,
        "implicit pending memory sentinel"
    );
    timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_matching_notification(
            "rejected office memory decision update",
            |notification| {
                if notification.method != "office/run/updated" {
                    return false;
                }
                notification
                    .params
                    .as_ref()
                    .and_then(|params| {
                        serde_json::from_value::<OfficeRunUpdatedNotification>(params.clone()).ok()
                    })
                    .is_some_and(|update| {
                        update.reason == "memoryDecision"
                            && update.config["workspace"]["activity"]["runs"][0]["memoryRefs"]
                                .as_array()
                                .is_some_and(|memory_refs| {
                                    memory_refs.iter().any(|memory_ref| {
                                        memory_ref
                                            .get("content")
                                            .and_then(serde_json::Value::as_str)
                                            == Some("implicit pending memory sentinel")
                                            && memory_ref
                                                .get("status")
                                                .and_then(serde_json::Value::as_str)
                                                == Some("rejected")
                                    })
                                })
                    })
            },
        ),
    )
    .await??;

    let second_run: OfficeRunResponse = request(
        &mut mcp,
        "office/run",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": saved_config,
            "message": {
                "author": "User",
                "glyph": "@",
                "accent": "slate",
                "time": "now",
                "text": "Use stored office memory sentinels",
                "kind": "message"
            },
            "text": "Use stored office memory sentinels",
            "locale": "en",
            "threadId": null,
            "clientUserMessageId": "office-memory-message-2"
        }),
    )
    .await?;
    timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_matching_notification(
            "second memory turn complete",
            |notification| {
                if notification.method != "turn/completed" {
                    return false;
                }
                notification
                    .params
                    .as_ref()
                    .and_then(|params| {
                        serde_json::from_value::<TurnCompletedNotification>(params.clone()).ok()
                    })
                    .is_some_and(|completed| completed.turn.id == second_run.turn.id)
            },
        ),
    )
    .await??;

    let model_requests = server.received_requests().await.unwrap_or_default();
    assert_eq!(model_requests.len(), 2);
    let request_body = model_requests[1].body_json::<serde_json::Value>()?;
    let second_prompt = request_body["input"]
        .as_array()
        .expect("input array")
        .iter()
        .rev()
        .filter(|item| item.get("role").and_then(serde_json::Value::as_str) == Some("user"))
        .filter_map(|item| item.get("content").and_then(serde_json::Value::as_array))
        .flat_map(|content| content.iter())
        .filter(|content| {
            content.get("type").and_then(serde_json::Value::as_str) == Some("input_text")
        })
        .filter_map(|content| content.get("text").and_then(serde_json::Value::as_str))
        .find(|text| text.contains("Use stored office memory sentinels"))
        .expect("second office prompt");
    assert!(second_prompt.contains("accepted launch memory sentinel"));
    assert!(!second_prompt.contains("implicit pending memory sentinel"));
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_read_recovers_terminal_run_from_persisted_thread_history() -> Result<()> {
    let responses = vec![create_final_assistant_message_sse_response(
        "Recovered result.",
    )?];
    let server = create_mock_responses_server_sequence_unchecked(responses).await;

    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut mcp = initialized_app_server(&codex_home).await?;

    let thread = start_workspace_thread(&mut mcp, &workspace).await?.thread;
    let turn_request_id = mcp
        .send_turn_start_request(TurnStartParams {
            thread_id: thread.id.clone(),
            input: vec![V2UserInput::Text {
                text: "Complete work before Office sync exists".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        })
        .await?;
    let turn_response: JSONRPCResponse = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(turn_request_id)),
    )
    .await??;
    let turn: TurnStartResponse = to_response(turn_response)?;
    let completed: TurnCompletedNotification = serde_json::from_value(
        timeout(
            DEFAULT_TIMEOUT,
            mcp.read_stream_until_notification_message("turn/completed"),
        )
        .await??
        .params
        .expect("turn/completed params must be present"),
    )?;
    assert_eq!(completed.turn.id, turn.turn.id);
    assert_eq!(completed.turn.status, TurnStatus::Completed);

    let stale_config = json!({
        "title": "Recovery Office",
        "workspace": {
            "goal": "Recover terminal Office state",
            "threadId": thread.id.clone(),
            "members": [],
            "messages": [],
            "tasks": [],
            "activity": {
                "runs": [
                    {
                        "id": "office-run-history-recovery",
                        "title": "Recover terminal turn",
                        "status": "running",
                        "threadId": thread.id.clone(),
                        "turnId": turn.turn.id.clone(),
                        "createdAt": "2026-06-19T00:00:00.000Z",
                        "updatedAt": "2026-06-19T00:00:00.000Z",
                        "requestText": "Complete work before Office sync exists"
                    }
                ],
                "artifacts": []
            }
        }
    });
    let saved: OfficeSaveResponse = request(
        &mut mcp,
        "office/save",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": stale_config
        }),
    )
    .await?;

    let recovered: OfficeReadResponse = request(
        &mut mcp,
        "office/read",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "threadId": thread.id,
            "title": null
        }),
    )
    .await?;
    let record = recovered.record.expect("recovered office record");
    assert_eq!(record.file_path, saved.file_path);
    assert_eq!(
        record.config["workspace"]["activity"]["runs"][0]["status"],
        "completed"
    );
    assert_eq!(
        record.config["workspace"]["activity"]["runs"][0]["resultPreview"],
        "Recovered result."
    );

    let update: OfficeRunUpdatedNotification = serde_json::from_value(
        timeout(
            DEFAULT_TIMEOUT,
            mcp.read_stream_until_notification_message("office/run/updated"),
        )
        .await??
        .params
        .expect("office/run/updated params must be present"),
    )?;
    assert_eq!(update.reason, "historyRecovery");
    assert_eq!(update.source_thread_id.as_deref(), Some(thread.id.as_str()));
    assert_eq!(
        update.source_turn_id.as_deref(),
        Some(turn.turn.id.as_str())
    );
    assert_eq!(
        update.config["workspace"]["activity"]["runs"][0]["status"],
        "completed"
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_run_sync_records_tool_evidence_with_provenance() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let mut mcp = initialized_app_server(&codex_home).await?;

    let thread_id = "thread-tool-evidence";
    let turn_id = "turn-tool-evidence";
    let config = json!({
        "title": "Tool Evidence Office",
        "workspace": {
            "goal": "Verify tool evidence",
            "threadId": thread_id,
            "members": [],
            "messages": [],
            "tasks": [],
            "activity": {
                "runs": [
                    {
                        "id": "office-run-tool-evidence",
                        "title": "Verify tool evidence",
                        "status": "running",
                        "threadId": thread_id,
                        "turnId": turn_id,
                        "createdAt": "2026-06-19T00:00:00.000Z",
                        "updatedAt": "2026-06-19T00:00:00.000Z",
                        "requestText": "Verify tool evidence"
                    }
                ],
                "artifacts": []
            }
        }
    });
    let response: OfficeRunSyncResponse = request(
        &mut mcp,
        "office/run/sync",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": config,
            "runId": "office-run-tool-evidence",
            "locale": "en",
            "turn": {
                "id": turn_id,
                "itemsView": "full",
                "status": "completed",
                "error": null,
                "startedAt": 1781880000,
                "completedAt": 1781880001,
                "durationMs": 1000,
                "items": [
                    {
                        "type": "commandExecution",
                        "id": "cmd-tool-evidence",
                        "command": "just test -p crewon-app-server",
                        "cwd": workspace.path().to_string_lossy(),
                        "processId": null,
                        "source": "agent",
                        "status": "completed",
                        "commandActions": [],
                        "aggregatedOutput": "test result: ok",
                        "exitCode": 0,
                        "durationMs": 1234
                    },
                    {
                        "type": "commandExecution",
                        "id": "cmd-tool-evidence-repeat",
                        "command": "just test -p crewon-app-server",
                        "cwd": workspace.path().to_string_lossy(),
                        "processId": null,
                        "source": "agent",
                        "status": "completed",
                        "commandActions": [],
                        "aggregatedOutput": "test result: ok again",
                        "exitCode": 0,
                        "durationMs": 1235
                    },
                    {
                        "type": "fileChange",
                        "id": "patch-tool-evidence",
                        "changes": [
                            {
                                "path": "src/lib.rs",
                                "kind": { "type": "update", "movePath": null },
                                "diff": "@@ -1 +1 @@"
                            }
                        ],
                        "status": "completed"
                    },
                    {
                        "type": "agentMessage",
                        "id": "msg-tool-evidence",
                        "text": "Tool evidence complete."
                    }
                ]
            }
        }),
    )
    .await?;

    let run = &response.config["workspace"]["activity"]["runs"][0];
    let evidence = run["evidence"].as_array().expect("tool evidence");
    assert_eq!(
        evidence
            .iter()
            .filter(|item| item["evidenceKind"] == "commandExecution")
            .count(),
        2
    );
    let command_evidence = evidence
        .iter()
        .find(|item| item["evidenceKind"] == "commandExecution")
        .expect("command evidence");
    assert_eq!(command_evidence["status"], "verified");
    assert_eq!(command_evidence["source"], "commandExecution");
    assert_eq!(command_evidence["sourceType"], "managerRun");
    assert_eq!(command_evidence["sourceThreadId"], thread_id);
    assert_eq!(command_evidence["sourceTurnId"], turn_id);
    assert_eq!(command_evidence["itemId"], "cmd-tool-evidence");
    assert_eq!(command_evidence["exitCode"], 0);
    assert_eq!(command_evidence["durationMs"], 1234);
    assert_eq!(command_evidence["outputPreview"], "test result: ok");
    assert_eq!(
        command_evidence["outputSha256"],
        sha256_hex(b"test result: ok")
    );

    let file_evidence = evidence
        .iter()
        .find(|item| item["evidenceKind"] == "fileChange")
        .expect("file evidence");
    assert_eq!(file_evidence["status"], "verified");
    assert_eq!(file_evidence["source"], "fileChange");
    assert_eq!(file_evidence["sourceType"], "managerRun");
    assert_eq!(file_evidence["sourceThreadId"], thread_id);
    assert_eq!(file_evidence["sourceTurnId"], turn_id);
    assert_eq!(file_evidence["itemId"], "patch-tool-evidence");
    assert_eq!(file_evidence["changeCount"], 1);
    assert_sha256_hex(&file_evidence["changesSha256"]);
    assert_eq!(file_evidence["paths"][0], "src/lib.rs");
    assert_eq!(run["loop"]["review"]["evidence"]["verified"], 3);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_run_sync_records_member_tool_evidence_with_provenance() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let mut mcp = initialized_app_server(&codex_home).await?;

    let run_id = "office-run-member-tool-evidence";
    let delegation_id = "office-delegation-member-tool-evidence";
    let manager_thread_id = "thread-manager-tool-evidence";
    let manager_turn_id = "turn-manager-tool-evidence";
    let member_thread_id = "thread-member-tool-evidence";
    let member_turn_id = "turn-member-tool-evidence";
    let config = json!({
        "title": "Member Tool Evidence Office",
        "workspace": {
            "goal": "Verify member tool evidence",
            "threadId": manager_thread_id,
            "members": [
                {
                    "agentId": "agent-engineer",
                    "name": "Engineer",
                    "threadId": member_thread_id,
                    "role": "Build"
                }
            ],
            "messages": [],
            "tasks": [],
            "activity": {
                "runs": [
                    {
                        "id": run_id,
                        "title": "Verify member tool evidence",
                        "status": "running",
                        "threadId": manager_thread_id,
                        "turnId": manager_turn_id,
                        "createdAt": "2026-06-19T00:00:00.000Z",
                        "updatedAt": "2026-06-19T00:00:00.000Z",
                        "requestText": "Verify member tool evidence",
                        "delegations": [
                            {
                                "id": delegation_id,
                                "member": "Engineer",
                                "agentId": "agent-engineer",
                                "task": "Run member verification",
                                "status": "running",
                                "threadId": member_thread_id,
                                "turnId": member_turn_id,
                                "dispatchMode": "auto",
                                "riskSeverity": "low",
                                "approvalRequired": false
                            }
                        ]
                    }
                ],
                "artifacts": []
            }
        }
    });
    let response: OfficeRunSyncResponse = request(
        &mut mcp,
        "office/run/sync",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": config,
            "runId": run_id,
            "locale": "en",
            "turn": {
                "id": member_turn_id,
                "itemsView": "full",
                "status": "completed",
                "error": null,
                "startedAt": 1781880000,
                "completedAt": 1781880001,
                "durationMs": 1000,
                "items": [
                    {
                        "type": "commandExecution",
                        "id": "cmd-member-tool-evidence",
                        "command": "just test -p crewon-app-server member_check",
                        "cwd": workspace.path().to_string_lossy(),
                        "processId": null,
                        "source": "agent",
                        "status": "failed",
                        "commandActions": [],
                        "aggregatedOutput": "member check failed",
                        "exitCode": 1,
                        "durationMs": 4321
                    },
                    {
                        "type": "fileChange",
                        "id": "patch-member-tool-evidence",
                        "changes": [
                            {
                                "path": "src/member.rs",
                                "kind": { "type": "update", "movePath": null },
                                "diff": "@@ -1 +1 @@"
                            }
                        ],
                        "status": "completed"
                    },
                    {
                        "type": "agentMessage",
                        "id": "msg-member-tool-evidence",
                        "text": "Member tool evidence complete."
                    }
                ]
            }
        }),
    )
    .await?;

    let run = &response.config["workspace"]["activity"]["runs"][0];
    let delegation = &run["delegations"][0];
    assert_eq!(delegation["status"], "completed");
    assert_eq!(
        delegation["resultPreview"],
        "Member tool evidence complete."
    );

    let evidence = run["evidence"].as_array().expect("member tool evidence");
    let command_evidence = evidence
        .iter()
        .find(|item| item["evidenceKind"] == "commandExecution")
        .expect("member command evidence");
    assert_eq!(command_evidence["status"], "blocked");
    assert_eq!(command_evidence["source"], "commandExecution");
    assert_eq!(command_evidence["sourceType"], "memberDelegation");
    assert_eq!(command_evidence["sourceThreadId"], member_thread_id);
    assert_eq!(command_evidence["sourceTurnId"], member_turn_id);
    assert_eq!(command_evidence["delegationId"], delegation_id);
    assert_eq!(command_evidence["member"], "Engineer");
    assert_eq!(command_evidence["agentId"], "agent-engineer");
    assert_eq!(command_evidence["itemId"], "cmd-member-tool-evidence");
    assert_eq!(command_evidence["exitCode"], 1);
    assert_eq!(command_evidence["durationMs"], 4321);
    assert_eq!(command_evidence["outputPreview"], "member check failed");
    assert_eq!(
        command_evidence["outputSha256"],
        sha256_hex(b"member check failed")
    );

    let file_evidence = evidence
        .iter()
        .find(|item| item["evidenceKind"] == "fileChange")
        .expect("member file evidence");
    assert_eq!(file_evidence["status"], "verified");
    assert_eq!(file_evidence["source"], "fileChange");
    assert_eq!(file_evidence["sourceType"], "memberDelegation");
    assert_eq!(file_evidence["sourceThreadId"], member_thread_id);
    assert_eq!(file_evidence["sourceTurnId"], member_turn_id);
    assert_eq!(file_evidence["delegationId"], delegation_id);
    assert_eq!(file_evidence["member"], "Engineer");
    assert_eq!(file_evidence["agentId"], "agent-engineer");
    assert_eq!(file_evidence["itemId"], "patch-member-tool-evidence");
    assert_eq!(file_evidence["changeCount"], 1);
    assert_sha256_hex(&file_evidence["changesSha256"]);
    assert_eq!(file_evidence["paths"][0], "src/member.rs");
    assert_eq!(run["loop"]["review"]["evidence"]["verified"], 1);
    assert_eq!(run["loop"]["review"]["evidence"]["blocked"], 1);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_read_recovers_auto_dispatch_for_terminal_run_with_pending_delegation() -> Result<()>
{
    let responses = vec![
        create_final_assistant_message_sse_response("Manager already completed.")?,
        create_final_assistant_message_sse_response("Recovered delegated task done.")?,
    ];
    let server = create_mock_responses_server_sequence_unchecked(responses).await;

    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut mcp = initialized_app_server(&codex_home).await?;

    let office_thread = start_workspace_thread(&mut mcp, &workspace).await?.thread;
    let member_thread = start_workspace_thread(&mut mcp, &workspace).await?.thread;
    let _: AgentSaveResponse = request(
        &mut mcp,
        "agent/save",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": {
                "agentId": "agent-engineer",
                "name": "Engineer",
                "threadId": member_thread.id,
                "role": "Build"
            }
        }),
    )
    .await?;

    let turn_request_id = mcp
        .send_turn_start_request(TurnStartParams {
            thread_id: office_thread.id.clone(),
            input: vec![V2UserInput::Text {
                text: "Complete manager work before scheduler recovery".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        })
        .await?;
    let turn_response: JSONRPCResponse = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(turn_request_id)),
    )
    .await??;
    let manager_turn: TurnStartResponse = to_response(turn_response)?;
    let completed: TurnCompletedNotification = serde_json::from_value(
        timeout(
            DEFAULT_TIMEOUT,
            mcp.read_stream_until_notification_message("turn/completed"),
        )
        .await??
        .params
        .expect("turn/completed params must be present"),
    )?;
    assert_eq!(completed.thread_id, office_thread.id);
    assert_eq!(completed.turn.id, manager_turn.turn.id);

    let stale_config = json!({
        "title": "Scheduler Recovery Office",
        "workspace": {
            "goal": "Recover pending scheduler work",
            "threadId": office_thread.id.clone(),
            "members": [
                {
                    "agentId": "agent-engineer",
                    "name": "Engineer",
                    "threadId": member_thread.id.clone(),
                    "role": "Build"
                }
            ],
            "messages": [],
            "tasks": [],
            "activity": {
                "runs": [
                    {
                        "id": "office-run-scheduler-recovery",
                        "title": "Recover scheduler turn",
                        "status": "completed",
                        "threadId": office_thread.id.clone(),
                        "turnId": manager_turn.turn.id.clone(),
                        "createdAt": "2026-06-19T00:00:00.000Z",
                        "updatedAt": "2026-06-19T00:00:00.000Z",
                        "requestText": "Complete manager work before scheduler recovery",
                        "delegationRoutes": [
                            {
                                "member": "Engineer",
                                "agentId": "agent-engineer",
                                "threadId": member_thread.id.clone(),
                                "target": member_thread.id.clone(),
                                "targetKind": "runtimeThread",
                                "tool": "followup_task",
                                "contextPolicy": "privateAndShared",
                                "memoryScope": "privateAndShared"
                            }
                        ],
                        "delegations": [
                            {
                                "id": "office-delegation-scheduler-recovery",
                                "member": "Engineer",
                                "agentId": "agent-engineer",
                                "task": "Build the recovered checklist",
                                "status": "pending",
                                "dispatchMode": "auto",
                                "riskSeverity": "low",
                                "approvalRequired": false
                            }
                        ]
                    }
                ],
                "artifacts": []
            }
        }
    });
    let _: OfficeSaveResponse = request(
        &mut mcp,
        "office/save",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": stale_config
        }),
    )
    .await?;

    let _: OfficeReadResponse = request(
        &mut mcp,
        "office/read",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "threadId": office_thread.id,
            "title": null
        }),
    )
    .await?;

    let auto_started: OfficeRunUpdatedNotification = serde_json::from_value(
        timeout(
            DEFAULT_TIMEOUT,
            mcp.read_stream_until_matching_notification(
                "recovered office auto dispatch started",
                |notification| {
                    if notification.method != "office/run/updated" {
                        return false;
                    }
                    notification
                        .params
                        .as_ref()
                        .and_then(|params| {
                            serde_json::from_value::<OfficeRunUpdatedNotification>(params.clone())
                                .ok()
                        })
                        .is_some_and(|update| update.reason == "autoDispatchStarted")
                },
            ),
        )
        .await??
        .params
        .expect("office/run/updated params must be present"),
    )?;
    assert_eq!(
        auto_started.source_thread_id.as_deref(),
        Some(member_thread.id.as_str())
    );
    let started_delegation =
        &auto_started.config["workspace"]["activity"]["runs"][0]["delegations"][0];
    assert_eq!(started_delegation["status"], "running");
    assert_eq!(started_delegation["threadId"], member_thread.id);
    let member_turn_id = auto_started
        .source_turn_id
        .as_deref()
        .expect("auto dispatch started should include member turn id")
        .to_string();
    assert_eq!(started_delegation["turnId"], member_turn_id.as_str());

    let member_completed: TurnCompletedNotification = serde_json::from_value(
        timeout(
            DEFAULT_TIMEOUT,
            mcp.read_stream_until_matching_notification(
                "recovered member turn completed",
                |notification| {
                    if notification.method != "turn/completed" {
                        return false;
                    }
                    notification
                        .params
                        .as_ref()
                        .and_then(|params| {
                            serde_json::from_value::<TurnCompletedNotification>(params.clone()).ok()
                        })
                        .is_some_and(|completed| {
                            completed.thread_id == member_thread.id
                                && completed.turn.id == member_turn_id
                        })
                },
            ),
        )
        .await??
        .params
        .expect("turn/completed params must be present"),
    )?;
    assert_eq!(member_completed.turn.status, TurnStatus::Completed);

    let mut synced_config = None;
    for _ in 0..20 {
        let read: OfficeReadResponse = request(
            &mut mcp,
            "office/read",
            json!({
                "cwd": workspace.path().to_string_lossy(),
                "threadId": office_thread.id,
                "title": null
            }),
        )
        .await?;
        if let Some(record) = read.record {
            let config = record.config;
            let delegation = &config["workspace"]["activity"]["runs"][0]["delegations"][0];
            if delegation["status"] == "completed" {
                synced_config = Some(config);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let synced_config =
        synced_config.expect("recovered member delegation should sync to the office run");
    assert_eq!(
        synced_config["workspace"]["activity"]["runs"][0]["delegations"][0]["resultPreview"],
        "Recovered delegated task done."
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_startup_recovers_auto_dispatch_for_terminal_run_with_pending_delegation()
-> Result<()> {
    let responses = vec![
        create_final_assistant_message_sse_response("Engineer runtime ready.")?,
        create_final_assistant_message_sse_response("Manager completed before restart.")?,
        create_final_assistant_message_sse_response("Startup recovered delegated task done.")?,
    ];
    let server = create_mock_responses_server_sequence_unchecked(responses).await;

    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut setup = initialized_app_server(&codex_home).await?;

    let office_thread = start_workspace_thread(&mut setup, &workspace).await?.thread;
    let member_thread = start_workspace_thread(&mut setup, &workspace).await?.thread;
    let _: AgentSaveResponse = request(
        &mut setup,
        "agent/save",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": {
                "agentId": "agent-engineer",
                "name": "Engineer",
                "threadId": member_thread.id,
                "role": "Build"
            }
        }),
    )
    .await?;

    let member_bootstrap_request_id = setup
        .send_turn_start_request(TurnStartParams {
            thread_id: member_thread.id.clone(),
            input: vec![V2UserInput::Text {
                text: "Prepare engineer runtime before restart".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        })
        .await?;
    let _: TurnStartResponse = to_response(
        timeout(
            DEFAULT_TIMEOUT,
            setup.read_stream_until_response_message(RequestId::Integer(
                member_bootstrap_request_id,
            )),
        )
        .await??,
    )?;
    let member_bootstrap_completed: TurnCompletedNotification = serde_json::from_value(
        timeout(
            DEFAULT_TIMEOUT,
            setup.read_stream_until_notification_message("turn/completed"),
        )
        .await??
        .params
        .expect("turn/completed params must be present"),
    )?;
    assert_eq!(member_bootstrap_completed.thread_id, member_thread.id);

    let turn_request_id = setup
        .send_turn_start_request(TurnStartParams {
            thread_id: office_thread.id.clone(),
            input: vec![V2UserInput::Text {
                text: "Complete manager work before restart".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        })
        .await?;
    let turn_response: JSONRPCResponse = timeout(
        DEFAULT_TIMEOUT,
        setup.read_stream_until_response_message(RequestId::Integer(turn_request_id)),
    )
    .await??;
    let manager_turn: TurnStartResponse = to_response(turn_response)?;
    let completed: TurnCompletedNotification = serde_json::from_value(
        timeout(
            DEFAULT_TIMEOUT,
            setup.read_stream_until_notification_message("turn/completed"),
        )
        .await??
        .params
        .expect("turn/completed params must be present"),
    )?;
    assert_eq!(completed.thread_id, office_thread.id);
    assert_eq!(completed.turn.id, manager_turn.turn.id);

    let stale_config = json!({
        "title": "Startup Scheduler Recovery Office",
        "workspace": {
            "goal": "Recover scheduler work after app-server restart",
            "threadId": office_thread.id.clone(),
            "members": [
                {
                    "agentId": "agent-engineer",
                    "name": "Engineer",
                    "threadId": member_thread.id.clone(),
                    "role": "Build"
                }
            ],
            "messages": [],
            "tasks": [],
            "activity": {
                "runs": [
                    {
                        "id": "office-run-startup-scheduler-recovery",
                        "title": "Recover scheduler turn after startup",
                        "status": "completed",
                        "threadId": office_thread.id.clone(),
                        "turnId": manager_turn.turn.id.clone(),
                        "createdAt": "2026-06-19T00:00:00.000Z",
                        "updatedAt": "2026-06-19T00:00:00.000Z",
                        "requestText": "Complete manager work before restart",
                        "delegationRoutes": [
                            {
                                "member": "Engineer",
                                "agentId": "agent-engineer",
                                "threadId": member_thread.id.clone(),
                                "target": member_thread.id.clone(),
                                "targetKind": "runtimeThread",
                                "tool": "followup_task",
                                "contextPolicy": "privateAndShared",
                                "memoryScope": "privateAndShared"
                            }
                        ],
                        "delegations": [
                            {
                                "id": "office-delegation-startup-scheduler-recovery",
                                "member": "Engineer",
                                "agentId": "agent-engineer",
                                "task": "Build the startup recovered checklist",
                                "status": "pending",
                                "dispatchMode": "auto",
                                "riskSeverity": "low",
                                "approvalRequired": false
                            }
                        ]
                    }
                ],
                "artifacts": []
            }
        }
    });
    let saved: OfficeSaveResponse = request(
        &mut setup,
        "office/save",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": stale_config
        }),
    )
    .await?;
    let scheduler_index_path = codex_home
        .path()
        .join("office-scheduler")
        .join("workspaces.json");
    let scheduler_index: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(&scheduler_index_path).await?)?;
    assert_eq!(
        scheduler_index["cwds"][0]["cwd"],
        workspace.path().to_string_lossy().as_ref()
    );
    tokio::fs::remove_file(&scheduler_index_path).await?;
    drop(setup);

    let _restarted = initialized_app_server(&codex_home).await?;
    let mut completed_config = None;
    let mut last_config = None;
    for _ in 0..320 {
        let bytes = tokio::fs::read(&saved.file_path).await?;
        let record: serde_json::Value = serde_json::from_slice(&bytes)?;
        let config = record["config"].clone();
        let delegation = &config["workspace"]["activity"]["runs"][0]["delegations"][0];
        if delegation["status"] == "completed" {
            completed_config = Some(config);
            break;
        }
        last_config = Some(config);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let completed_config = completed_config.unwrap_or_else(|| {
        panic!(
            "startup worker should complete recovered delegation; index={scheduler_index}; last_config={}",
            last_config.unwrap_or(serde_json::Value::Null)
        )
    });
    let delegation = &completed_config["workspace"]["activity"]["runs"][0]["delegations"][0];
    assert_eq!(delegation["threadId"], member_thread.id);
    assert_eq!(
        delegation["resultPreview"],
        "Startup recovered delegated task done."
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_startup_recovers_auto_replan_for_terminal_review() -> Result<()> {
    let replan_message = r#"Startup recovered replan done.
```json
{
  "officeUpdate": {
    "summary": "Startup recovered replan done.",
    "acceptanceCriteria": [
      {
        "criterion": "Recovered plan passes",
        "status": "passed",
        "evidence": "Startup replan completed"
      }
    ],
    "evidence": [
      {
        "summary": "Startup replan completed",
        "status": "verified",
        "source": "startup replan"
      }
    ]
  }
}
```"#;
    let responses = vec![
        create_final_assistant_message_sse_response("Manager completed before restart.")?,
        create_final_assistant_message_sse_response(replan_message)?,
    ];
    let server = create_mock_responses_server_sequence_unchecked(responses).await;

    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut setup = initialized_app_server(&codex_home).await?;

    let office_thread = start_workspace_thread(&mut setup, &workspace).await?.thread;
    let turn_request_id = setup
        .send_turn_start_request(TurnStartParams {
            thread_id: office_thread.id.clone(),
            input: vec![V2UserInput::Text {
                text: "Complete blocked manager work before restart".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        })
        .await?;
    let turn_response: JSONRPCResponse = timeout(
        DEFAULT_TIMEOUT,
        setup.read_stream_until_response_message(RequestId::Integer(turn_request_id)),
    )
    .await??;
    let manager_turn: TurnStartResponse = to_response(turn_response)?;
    let completed: TurnCompletedNotification = serde_json::from_value(
        timeout(
            DEFAULT_TIMEOUT,
            setup.read_stream_until_notification_message("turn/completed"),
        )
        .await??
        .params
        .expect("turn/completed params must be present"),
    )?;
    assert_eq!(completed.thread_id, office_thread.id);
    assert_eq!(completed.turn.id, manager_turn.turn.id);

    let source_run_id = "office-run-startup-replan";
    drop(setup);

    let stale_config = json!({
        "title": "Startup Replan Office",
        "workspace": {
            "goal": "Recover review-gated manager replan after app-server restart",
            "threadId": office_thread.id.clone(),
            "members": [],
            "messages": [],
            "tasks": [],
            "activity": {
                "runs": [
                    {
                        "id": source_run_id,
                        "title": "Recover manager replan after startup",
                        "status": "completed",
                        "threadId": office_thread.id.clone(),
                        "turnId": manager_turn.turn.id.clone(),
                        "createdAt": "2026-06-19T00:00:00.000Z",
                        "updatedAt": "2026-06-19T00:00:00.000Z",
                        "requestText": "Complete blocked manager work before restart",
                        "acceptanceCriteria": [
                            {
                                "criterion": "Recovered plan passes",
                                "status": "failed",
                                "evidence": "Initial manager run did not repair it"
                            }
                        ],
                        "evidence": [
                            {
                                "summary": "Initial manager run did not repair it",
                                "status": "blocked",
                                "source": "manager"
                            }
                        ],
                        "loop": {
                            "mode": "officeLoopEngineering",
                            "iteration": 1,
                            "maxIterations": 2,
                            "review": {
                                "status": "blocked",
                                "nextAction": "repairFailedCriteria",
                                "risks": { "openHigh": 0 }
                            }
                        }
                    }
                ],
                "artifacts": []
            }
        }
    });
    let office_dir = workspace.path().join(".crewon").join("offices");
    tokio::fs::create_dir_all(&office_dir).await?;
    let saved_file_path = office_dir.join(format!(
        "startup-replan-office-{}.json",
        office_thread.id.chars().take(8).collect::<String>()
    ));
    tokio::fs::write(
        &saved_file_path,
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "kind": "office",
            "savedAt": "2026-06-19T00:00:00.000Z",
            "config": stale_config
        }))?,
    )
    .await?;
    let scheduler_index_path = codex_home
        .path()
        .join("office-scheduler")
        .join("workspaces.json");
    tokio::fs::create_dir_all(
        scheduler_index_path
            .parent()
            .expect("scheduler index parent"),
    )
    .await?;
    tokio::fs::write(
        &scheduler_index_path,
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "cwds": [
                {
                    "cwd": workspace.path().to_string_lossy(),
                    "updatedAt": 1781864660
                }
            ]
        }))?,
    )
    .await?;

    let _restarted = initialized_app_server(&codex_home).await?;
    let mut completed_config = None;
    let mut last_config = None;
    for _ in 0..160 {
        let bytes = tokio::fs::read(&saved_file_path).await?;
        let record: serde_json::Value = serde_json::from_slice(&bytes)?;
        let config = record["config"].clone();
        let retry_completed = config["workspace"]["activity"]["runs"]
            .as_array()
            .expect("office runs")
            .iter()
            .any(|run| {
                run["retryOf"] == source_run_id
                    && run["status"] == "completed"
                    && run["resultPreview"] == "Startup recovered replan done."
            });
        if retry_completed {
            completed_config = Some(config);
            break;
        }
        last_config = Some(config);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let completed_config = completed_config.unwrap_or_else(|| {
        panic!(
            "startup worker should complete recovered manager replan; last_config={}",
            last_config.unwrap_or(serde_json::Value::Null)
        )
    });
    let retry_run = completed_config["workspace"]["activity"]["runs"]
        .as_array()
        .expect("office runs")
        .iter()
        .find(|run| run["retryOf"] == source_run_id)
        .expect("retry run");
    assert_eq!(retry_run["loop"]["iteration"], 2);
    assert_eq!(retry_run["loop"]["review"]["status"], "needsReview");
    assert_eq!(
        retry_run["loop"]["review"]["nextAction"],
        "collectVerificationEvidence"
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_startup_repairs_empty_member_runtime_thread_before_auto_dispatch() -> Result<()> {
    let responses = vec![
        create_final_assistant_message_sse_response("Manager completed before runtime repair.")?,
        create_final_assistant_message_sse_response("Runtime repair delegated task done.")?,
    ];
    let server = create_mock_responses_server_sequence_unchecked(responses).await;

    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut setup = initialized_app_server(&codex_home).await?;

    let office_thread = start_workspace_thread(&mut setup, &workspace).await?.thread;
    let stale_member_thread = start_workspace_thread(&mut setup, &workspace).await?.thread;
    let saved_agent: AgentSaveResponse = request(
        &mut setup,
        "agent/save",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": {
                "agentId": "agent-engineer",
                "name": "Engineer",
                "threadId": stale_member_thread.id,
                "role": "Build"
            }
        }),
    )
    .await?;

    let turn_request_id = setup
        .send_turn_start_request(TurnStartParams {
            thread_id: office_thread.id.clone(),
            input: vec![V2UserInput::Text {
                text: "Complete manager work before runtime repair".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        })
        .await?;
    let turn_response: JSONRPCResponse = timeout(
        DEFAULT_TIMEOUT,
        setup.read_stream_until_response_message(RequestId::Integer(turn_request_id)),
    )
    .await??;
    let manager_turn: TurnStartResponse = to_response(turn_response)?;
    let completed: TurnCompletedNotification = serde_json::from_value(
        timeout(
            DEFAULT_TIMEOUT,
            setup.read_stream_until_notification_message("turn/completed"),
        )
        .await??
        .params
        .expect("turn/completed params must be present"),
    )?;
    assert_eq!(completed.thread_id, office_thread.id);
    assert_eq!(completed.turn.id, manager_turn.turn.id);

    let stale_config = json!({
        "title": "Startup Runtime Repair Office",
        "workspace": {
            "goal": "Repair an empty member runtime thread after app-server restart",
            "threadId": office_thread.id.clone(),
            "members": [
                {
                    "agentId": "agent-engineer",
                    "name": "Engineer",
                    "threadId": stale_member_thread.id.clone(),
                    "role": "Build"
                }
            ],
            "messages": [],
            "tasks": [],
            "activity": {
                "runs": [
                    {
                        "id": "office-run-startup-runtime-repair",
                        "title": "Repair runtime route after startup",
                        "status": "completed",
                        "threadId": office_thread.id.clone(),
                        "turnId": manager_turn.turn.id.clone(),
                        "createdAt": "2026-06-19T00:00:00.000Z",
                        "updatedAt": "2026-06-19T00:00:00.000Z",
                        "requestText": "Complete manager work before runtime repair",
                        "delegationRoutes": [
                            {
                                "member": "Engineer",
                                "agentId": "agent-engineer",
                                "threadId": stale_member_thread.id.clone(),
                                "target": stale_member_thread.id.clone(),
                                "targetKind": "runtimeThread",
                                "tool": "followup_task",
                                "contextPolicy": "privateAndShared",
                                "memoryScope": "privateAndShared"
                            }
                        ],
                        "delegations": [
                            {
                                "id": "office-delegation-startup-runtime-repair",
                                "member": "Engineer",
                                "agentId": "agent-engineer",
                                "task": "Build the repaired runtime checklist",
                                "status": "pending",
                                "dispatchMode": "auto",
                                "riskSeverity": "low",
                                "approvalRequired": false
                            }
                        ]
                    }
                ],
                "artifacts": []
            }
        }
    });
    let saved: OfficeSaveResponse = request(
        &mut setup,
        "office/save",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": stale_config
        }),
    )
    .await?;
    drop(setup);

    let _restarted = initialized_app_server(&codex_home).await?;
    let mut completed_config = None;
    let mut last_config = None;
    for _ in 0..100 {
        let bytes = tokio::fs::read(&saved.file_path).await?;
        let record: serde_json::Value = serde_json::from_slice(&bytes)?;
        let config = record["config"].clone();
        let delegation = &config["workspace"]["activity"]["runs"][0]["delegations"][0];
        if delegation["status"] == "completed" {
            completed_config = Some(config);
            break;
        }
        last_config = Some(config);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let completed_config = completed_config.unwrap_or_else(|| {
        panic!(
            "startup worker should repair member runtime and complete delegation; last_config={}",
            last_config.unwrap_or(serde_json::Value::Null)
        )
    });

    let delegation = &completed_config["workspace"]["activity"]["runs"][0]["delegations"][0];
    let repaired_thread_id = delegation["threadId"]
        .as_str()
        .expect("repaired delegation thread id");
    assert_ne!(repaired_thread_id, stale_member_thread.id);
    assert_eq!(
        delegation["repairSourceThreadId"],
        stale_member_thread.id.as_str()
    );
    assert_eq!(
        delegation["resultPreview"],
        "Runtime repair delegated task done."
    );
    assert_eq!(
        completed_config["workspace"]["members"][0]["runtime"]["threadId"],
        repaired_thread_id
    );
    assert_eq!(
        completed_config["workspace"]["activity"]["runs"][0]["delegationRoutes"][0]["target"],
        repaired_thread_id
    );

    let agent_record: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(&saved_agent.file_path).await?)?;
    assert_eq!(agent_record["config"]["threadId"], repaired_thread_id);
    assert_eq!(
        agent_record["config"]["runtimeRepairSourceThreadId"],
        stale_member_thread.id
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_startup_repairs_missing_automation_runtime_thread_before_auto_verification_dispatch()
-> Result<()> {
    let responses = vec![
        create_final_assistant_message_sse_response(
            "Manager completed before automation runtime repair.",
        )?,
        create_final_assistant_message_sse_response(
            "Startup repaired automation verification passed.",
        )?,
    ];
    let server = create_mock_responses_server_sequence_unchecked(responses).await;

    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut setup = initialized_app_server(&codex_home).await?;

    let office_thread = start_workspace_thread(&mut setup, &workspace).await?.thread;
    let stale_automation_thread_id = Uuid::new_v4().to_string();
    let saved_automation: AutomationSaveResponse = request(
        &mut setup,
        "automation/save",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": {
                "automationId": "automation-nightly",
                "title": "Nightly QA",
                "threadId": stale_automation_thread_id,
                "prompt": "Run the nightly QA verification",
                "enabled": true,
                "status": "enabled"
            }
        }),
    )
    .await?;

    let turn_request_id = setup
        .send_turn_start_request(TurnStartParams {
            thread_id: office_thread.id.clone(),
            input: vec![V2UserInput::Text {
                text: "Complete manager work before automation runtime repair".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        })
        .await?;
    let turn_response: JSONRPCResponse = timeout(
        DEFAULT_TIMEOUT,
        setup.read_stream_until_response_message(RequestId::Integer(turn_request_id)),
    )
    .await??;
    let manager_turn: TurnStartResponse = to_response(turn_response)?;
    let completed: TurnCompletedNotification = serde_json::from_value(
        timeout(
            DEFAULT_TIMEOUT,
            setup.read_stream_until_notification_message("turn/completed"),
        )
        .await??
        .params
        .expect("turn/completed params must be present"),
    )?;
    assert_eq!(completed.thread_id, office_thread.id);
    assert_eq!(completed.turn.id, manager_turn.turn.id);

    let stale_config = json!({
        "title": "Startup Automation Runtime Repair Office",
        "workspace": {
            "goal": "Repair an empty automation runtime thread after app-server restart",
            "threadId": office_thread.id.clone(),
            "members": [],
            "messages": [],
            "tasks": [],
            "activity": {
                "runs": [
                    {
                        "id": "office-run-startup-automation-runtime-repair",
                        "title": "Repair automation runtime route after startup",
                        "status": "completed",
                        "threadId": office_thread.id.clone(),
                        "turnId": manager_turn.turn.id.clone(),
                        "createdAt": "2026-06-19T00:00:00.000Z",
                        "updatedAt": "2026-06-19T00:00:00.000Z",
                        "requestText": "Complete manager work before automation runtime repair",
                        "verificationChecks": [
                            {
                                "itemId": "verification-nightly",
                                "check": "Run nightly QA",
                                "status": "pending",
                                "automationId": "automation-nightly",
                                "dispatchMode": "auto",
                                "riskSeverity": "low",
                                "approvalRequired": false
                            }
                        ]
                    }
                ],
                "artifacts": []
            }
        }
    });
    let saved: OfficeSaveResponse = request(
        &mut setup,
        "office/save",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": stale_config
        }),
    )
    .await?;
    drop(setup);

    let _restarted = initialized_app_server(&codex_home).await?;
    let mut completed_config = None;
    let mut last_config = None;
    for _ in 0..200 {
        let bytes = tokio::fs::read(&saved.file_path).await?;
        let record: serde_json::Value = serde_json::from_slice(&bytes)?;
        let config = record["config"].clone();
        let check = &config["workspace"]["activity"]["runs"][0]["verificationChecks"][0];
        if check["dispatchStatus"] == "completed" {
            completed_config = Some(config);
            break;
        }
        last_config = Some(config);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let completed_config = completed_config.unwrap_or_else(|| {
        panic!(
            "startup worker should repair automation runtime and complete verification; last_config={}",
            last_config.unwrap_or(serde_json::Value::Null)
        )
    });

    let check = &completed_config["workspace"]["activity"]["runs"][0]["verificationChecks"][0];
    let repaired_thread_id = check["automationThreadId"]
        .as_str()
        .expect("repaired automation thread id");
    assert_ne!(repaired_thread_id, stale_automation_thread_id);
    assert_eq!(
        check["runtimeRepairSourceThreadId"],
        stale_automation_thread_id.as_str()
    );
    assert_eq!(check["status"], "passed");
    assert_eq!(
        check["evidence"],
        "Startup repaired automation verification passed."
    );

    let automation_record: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(&saved_automation.file_path).await?)?;
    assert_eq!(automation_record["config"]["threadId"], repaired_thread_id);
    assert_eq!(
        automation_record["config"]["runtimeRepairSourceThreadId"],
        stale_automation_thread_id
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_run_sync_persists_and_drains_auto_dispatch_intent() -> Result<()> {
    let responses = vec![
        create_final_assistant_message_sse_response("Manager sync source completed.")?,
        create_final_assistant_message_sse_response("Queued scheduler task done.")?,
    ];
    let server = create_mock_responses_server_sequence_unchecked(responses).await;

    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut mcp = initialized_app_server(&codex_home).await?;

    let office_thread = start_workspace_thread(&mut mcp, &workspace).await?.thread;
    let member_thread = start_workspace_thread(&mut mcp, &workspace).await?.thread;
    let _: AgentSaveResponse = request(
        &mut mcp,
        "agent/save",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": {
                "agentId": "agent-engineer",
                "name": "Engineer",
                "threadId": member_thread.id,
                "role": "Build"
            }
        }),
    )
    .await?;

    let turn_request_id = mcp
        .send_turn_start_request(TurnStartParams {
            thread_id: office_thread.id.clone(),
            input: vec![V2UserInput::Text {
                text: "Complete manager source before explicit office sync".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        })
        .await?;
    let turn_response: JSONRPCResponse = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(turn_request_id)),
    )
    .await??;
    let manager_turn: TurnStartResponse = to_response(turn_response)?;
    let completed: TurnCompletedNotification = serde_json::from_value(
        timeout(
            DEFAULT_TIMEOUT,
            mcp.read_stream_until_notification_message("turn/completed"),
        )
        .await??
        .params
        .expect("turn/completed params must be present"),
    )?;
    assert_eq!(completed.thread_id, office_thread.id);
    assert_eq!(completed.turn.id, manager_turn.turn.id);

    let run_id = "office-run-sync-scheduler-intent";
    let stale_config = json!({
        "title": "Scheduler Intent Office",
        "workspace": {
            "goal": "Persist scheduler intent during explicit sync",
            "threadId": office_thread.id.clone(),
            "members": [
                {
                    "agentId": "agent-engineer",
                    "name": "Engineer",
                    "threadId": member_thread.id.clone(),
                    "role": "Build"
                }
            ],
            "messages": [],
            "tasks": [],
            "activity": {
                "runs": [
                    {
                        "id": run_id,
                        "title": "Persist scheduler intent",
                        "status": "running",
                        "threadId": office_thread.id.clone(),
                        "turnId": manager_turn.turn.id.clone(),
                        "createdAt": "2026-06-19T00:00:00.000Z",
                        "updatedAt": "2026-06-19T00:00:00.000Z",
                        "requestText": "Complete manager source before explicit office sync",
                        "delegationRoutes": [
                            {
                                "member": "Engineer",
                                "agentId": "agent-engineer",
                                "threadId": member_thread.id.clone(),
                                "target": member_thread.id.clone(),
                                "targetKind": "runtimeThread",
                                "tool": "followup_task",
                                "contextPolicy": "privateAndShared",
                                "memoryScope": "privateAndShared"
                            }
                        ],
                        "delegations": [
                            {
                                "id": "office-delegation-sync-scheduler-intent",
                                "member": "Engineer",
                                "agentId": "agent-engineer",
                                "task": "Run the queued scheduler task",
                                "status": "pending",
                                "dispatchMode": "auto",
                                "riskSeverity": "low",
                                "approvalRequired": false
                            }
                        ]
                    }
                ],
                "artifacts": []
            }
        }
    });

    let sync_response: OfficeRunSyncResponse = request(
        &mut mcp,
        "office/run/sync",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": stale_config,
            "runId": run_id,
            "turn": completed.turn,
            "locale": "en"
        }),
    )
    .await?;
    assert_eq!(
        sync_response.config["workspace"]["activity"]["runs"][0]["status"],
        "completed"
    );
    let scheduler_path = workspace
        .path()
        .join(".crewon")
        .join("office-runs")
        .join("scheduler.json");
    let scheduler_json: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(&scheduler_path).await?)?;
    let dispatched_intent = scheduler_json["intents"]
        .as_array()
        .expect("scheduler intents")
        .iter()
        .find(|intent| intent["sourceTurnId"] == manager_turn.turn.id)
        .expect("dispatched scheduler intent");
    assert_eq!(dispatched_intent["status"], "dispatched");

    let auto_started: OfficeRunUpdatedNotification = serde_json::from_value(
        timeout(
            DEFAULT_TIMEOUT,
            mcp.read_stream_until_matching_notification(
                "explicit sync auto dispatch started",
                |notification| {
                    if notification.method != "office/run/updated" {
                        return false;
                    }
                    notification
                        .params
                        .as_ref()
                        .and_then(|params| {
                            serde_json::from_value::<OfficeRunUpdatedNotification>(params.clone())
                                .ok()
                        })
                        .is_some_and(|update| update.reason == "autoDispatchStarted")
                },
            ),
        )
        .await??
        .params
        .expect("office/run/updated params must be present"),
    )?;
    assert_eq!(
        auto_started.source_thread_id.as_deref(),
        Some(member_thread.id.as_str())
    );
    let started_delegation =
        &auto_started.config["workspace"]["activity"]["runs"][0]["delegations"][0];
    assert_eq!(started_delegation["status"], "running");
    let member_turn_id = started_delegation["turnId"]
        .as_str()
        .expect("member turn id")
        .to_string();

    let scheduler_json: serde_json::Value =
        serde_json::from_slice(&tokio::fs::read(&scheduler_path).await?)?;
    let dispatched_intent = scheduler_json["intents"]
        .as_array()
        .expect("scheduler intents")
        .iter()
        .find(|intent| intent["sourceTurnId"] == manager_turn.turn.id)
        .expect("dispatched scheduler intent");
    assert_eq!(dispatched_intent["status"], "dispatched");
    assert_eq!(dispatched_intent["runId"], run_id);
    assert_eq!(
        dispatched_intent["delegationId"],
        "office-delegation-sync-scheduler-intent"
    );
    assert_eq!(dispatched_intent["dispatchedThreadId"], member_thread.id);
    assert_eq!(dispatched_intent["dispatchedTurnId"], member_turn_id);

    let member_completed: TurnCompletedNotification = serde_json::from_value(
        timeout(
            DEFAULT_TIMEOUT,
            mcp.read_stream_until_matching_notification(
                "scheduler intent member turn completed",
                |notification| {
                    if notification.method != "turn/completed" {
                        return false;
                    }
                    notification
                        .params
                        .as_ref()
                        .and_then(|params| {
                            serde_json::from_value::<TurnCompletedNotification>(params.clone()).ok()
                        })
                        .is_some_and(|completed| {
                            completed.thread_id == member_thread.id
                                && completed.turn.id == member_turn_id
                        })
                },
            ),
        )
        .await??
        .params
        .expect("turn/completed params must be present"),
    )?;
    assert_eq!(member_completed.turn.status, TurnStatus::Completed);
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
