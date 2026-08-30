use std::path::Path;
use std::time::Duration;

use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::create_final_assistant_message_sse_response;
use app_test_support::to_response;
use app_test_support::write_mock_responses_config_toml_with_chatgpt_base_url;
use core_test_support::responses;
use crewon_app_server_protocol::JSONRPCError;
use crewon_app_server_protocol::JSONRPCMessage;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::OfficeCreateResponse;
use crewon_app_server_protocol::OfficeManagerEnsureResponse;
use crewon_app_server_protocol::OfficeManagerEnsureStatus;
use crewon_app_server_protocol::OfficeReadResponse;
use crewon_app_server_protocol::OfficeRunResponse;
use crewon_app_server_protocol::OfficeSaveResponse;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::ThreadLoadedListResponse;
use crewon_app_server_protocol::ThreadReadResponse;
use crewon_app_server_protocol::ThreadSource;
use crewon_app_server_protocol::ThreadStartParams;
use crewon_app_server_protocol::ThreadStartResponse;
use crewon_app_server_protocol::TurnStartResponse;
use serde_json::json;
use tempfile::TempDir;
use tokio::time::timeout;
use uuid::Uuid;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

enum ManagerEnsureOutcome {
    Response(OfficeManagerEnsureResponse),
    Error(JSONRPCError),
}

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

async fn request_manager_ensure_outcome(
    mcp: &mut TestAppServer,
    params: serde_json::Value,
) -> Result<ManagerEnsureOutcome> {
    let request_id = mcp
        .send_raw_request("office/manager/ensure", Some(params))
        .await?;
    let message = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_response_or_error_message(RequestId::Integer(request_id)),
    )
    .await??;
    match message {
        JSONRPCMessage::Response(response) => {
            Ok(ManagerEnsureOutcome::Response(to_response(response)?))
        }
        JSONRPCMessage::Error(error) => Ok(ManagerEnsureOutcome::Error(error)),
        JSONRPCMessage::Request(request) => {
            anyhow::bail!("unexpected request while awaiting manager ensure: {request:?}")
        }
        JSONRPCMessage::Notification(notification) => {
            anyhow::bail!("unexpected notification while awaiting manager ensure: {notification:?}")
        }
    }
}

fn count_rollout_files(path: &Path) -> Result<usize> {
    if !path.exists() {
        return Ok(0);
    }
    let mut count = 0;
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            count += count_rollout_files(&entry.path())?;
        } else if entry
            .path()
            .extension()
            .and_then(|extension| extension.to_str())
            == Some("jsonl")
        {
            count += 1;
        }
    }
    Ok(count)
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

async fn create_server_owned_manager(
    mcp: &mut TestAppServer,
    workspace: &TempDir,
    title: &str,
    goal: &str,
) -> Result<(
    OfficeManagerEnsureResponse,
    crewon_app_server_protocol::Thread,
)> {
    let created: OfficeCreateResponse = request(
        mcp,
        "office/create",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "title": title,
            "subtitle": null,
            "threadId": null,
            "goal": goal
        }),
    )
    .await?;
    let ensured: OfficeManagerEnsureResponse = request(
        mcp,
        "office/manager/ensure",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "officeRecordId": created.config["workspace"]["recordId"],
            "expectedRecordRevision": created.config["workspace"]["recordRevision"]
        }),
    )
    .await?;
    let read: ThreadReadResponse = request(
        mcp,
        "thread/read",
        json!({
            "threadId": ensured.thread_id,
            "includeTurns": false
        }),
    )
    .await?;
    Ok((ensured, read.thread))
}

async fn assert_manager_mutation_rejected(
    mcp: &mut TestAppServer,
    method: &str,
    params: serde_json::Value,
) -> Result<()> {
    let request_id = mcp.send_raw_request(method, Some(params)).await?;
    let error: JSONRPCError = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(request_id)),
    )
    .await??;
    assert!(
        error.error.message.contains("Office-scoped runtime"),
        "{method}: {}",
        error.error.message
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manager_ensure_provisions_and_reuses_server_owned_runtime() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let mut mcp = initialized_app_server(&codex_home).await?;
    let (created, thread) = create_server_owned_manager(
        &mut mcp,
        &workspace,
        "Server-owned Manager Office",
        "Provision the manager on the server",
    )
    .await?;
    assert_eq!(created.status, OfficeManagerEnsureStatus::Created);
    assert_eq!(created.thread_id, thread.id);
    assert_eq!(
        thread.thread_source,
        Some(ThreadSource::Feature(
            "office_manager_runtime_v1".to_string()
        ))
    );

    let reused: OfficeManagerEnsureResponse = request(
        &mut mcp,
        "office/manager/ensure",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "officeRecordId": created.config["workspace"]["recordId"],
            "expectedRecordRevision": created.config["workspace"]["recordRevision"]
        }),
    )
    .await?;
    assert_eq!(reused.status, OfficeManagerEnsureStatus::ReusedServerOwned);
    assert_eq!(reused.thread_id, created.thread_id);
    assert_eq!(reused.config, created.config);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_manager_ensure_keeps_one_canonical_runtime_and_discards_the_loser() -> Result<()>
{
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let mut first = initialized_app_server(&codex_home).await?;
    let mut second = initialized_app_server(&codex_home).await?;
    let created: OfficeCreateResponse = request(
        &mut first,
        "office/create",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "title": "Concurrent Manager Office",
            "subtitle": null,
            "threadId": null,
            "goal": "Keep exactly one manager runtime"
        }),
    )
    .await?;
    let params = json!({
        "cwd": workspace.path().to_string_lossy(),
        "officeRecordId": created.config["workspace"]["recordId"],
        "expectedRecordRevision": created.config["workspace"]["recordRevision"]
    });
    let rollout_count_before = count_rollout_files(codex_home.path())?;

    let (first_outcome, second_outcome) = tokio::join!(
        request_manager_ensure_outcome(&mut first, params.clone()),
        request_manager_ensure_outcome(&mut second, params),
    );
    let mut responses = Vec::new();
    let mut errors = Vec::new();
    for outcome in [first_outcome?, second_outcome?] {
        match outcome {
            ManagerEnsureOutcome::Response(response) => responses.push(response),
            ManagerEnsureOutcome::Error(error) => errors.push(error),
        }
    }
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0].status, OfficeManagerEnsureStatus::Created);
    assert_eq!(errors.len(), 1);
    assert!(errors[0].error.message.contains("stale"));

    let canonical: OfficeReadResponse = request(
        &mut first,
        "office/read",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "threadId": responses[0].thread_id,
            "title": null
        }),
    )
    .await?;
    let canonical = canonical.record.expect("canonical Office record");
    assert_eq!(
        canonical.config["workspace"]["threadId"],
        responses[0].thread_id
    );
    assert_eq!(
        count_rollout_files(codex_home.path())?,
        rollout_count_before + 1
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stale_manager_ensure_revision_creates_no_runtime() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let mut mcp = initialized_app_server(&codex_home).await?;
    let created: OfficeCreateResponse = request(
        &mut mcp,
        "office/create",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "title": "Stale Manager Office",
            "subtitle": null,
            "threadId": null,
            "goal": "Reject stale manager provisioning"
        }),
    )
    .await?;
    let mut updated_config = created.config.clone();
    updated_config["workspace"]["goal"] = json!("Advance the canonical revision");
    let updated: OfficeSaveResponse = request(
        &mut mcp,
        "office/save",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": updated_config
        }),
    )
    .await?;
    let rollout_count_before = count_rollout_files(codex_home.path())?;

    let outcome = request_manager_ensure_outcome(
        &mut mcp,
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "officeRecordId": created.config["workspace"]["recordId"],
            "expectedRecordRevision": created.config["workspace"]["recordRevision"]
        }),
    )
    .await?;
    let ManagerEnsureOutcome::Error(error) = outcome else {
        anyhow::bail!("stale manager ensure unexpectedly succeeded");
    };
    assert!(error.error.message.contains("stale"));
    assert_eq!(
        count_rollout_files(codex_home.path())?,
        rollout_count_before
    );

    let ensured: OfficeManagerEnsureResponse = request(
        &mut mcp,
        "office/manager/ensure",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "officeRecordId": updated.config["workspace"]["recordId"],
            "expectedRecordRevision": updated.config["workspace"]["recordRevision"]
        }),
    )
    .await?;
    assert_eq!(ensured.status, OfficeManagerEnsureStatus::Created);
    assert_eq!(
        count_rollout_files(codex_home.path())?,
        rollout_count_before + 1
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn generic_thread_start_rejects_reserved_office_runtime_source() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let mut mcp = initialized_app_server(&codex_home).await?;
    let request_id = mcp
        .send_thread_start_request(ThreadStartParams {
            cwd: Some(workspace.path().to_string_lossy().into_owned()),
            thread_source: Some(ThreadSource::Feature(
                "office_manager_runtime_v1".to_string(),
            )),
            ..Default::default()
        })
        .await?;
    let error: JSONRPCError = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(request_id)),
    )
    .await??;
    assert!(error.error.message.contains("server-owned Office runtimes"));
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn legacy_office_create_can_adopt_a_pristine_workspace_thread() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let mut mcp = initialized_app_server(&codex_home).await?;
    let ordinary = start_workspace_thread(&mut mcp, &workspace).await?.thread;

    let created: OfficeCreateResponse = request(
        &mut mcp,
        "office/create",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "title": "Legacy Compatible Office",
            "subtitle": null,
            "threadId": ordinary.id,
            "goal": "Preserve the stable create flow without importing chat history"
        }),
    )
    .await?;

    assert_eq!(created.config["workspace"]["threadId"], ordinary.id);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_same_workspace_thread_cannot_be_bound_or_rebound_as_manager() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let mut mcp = initialized_app_server(&codex_home).await?;
    let ordinary = start_workspace_thread(&mut mcp, &workspace).await?.thread;
    let _: serde_json::Value = request(
        &mut mcp,
        "thread/inject_items",
        json!({
            "threadId": ordinary.id,
            "items": [{
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "private single-chat history"}]
            }]
        }),
    )
    .await?;
    let request_id = mcp
        .send_raw_request(
            "office/create",
            Some(json!({
                "cwd": workspace.path().to_string_lossy(),
                "title": "Unsafe Office",
                "subtitle": null,
                "threadId": ordinary.id,
                "goal": "Must not inherit single-chat history"
            })),
        )
        .await?;
    let error: JSONRPCError = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(request_id)),
    )
    .await??;
    assert!(error.error.message.contains("threadId"));

    let request_id = mcp
        .send_raw_request(
            "office/create",
            Some(json!({
                "cwd": workspace.path().to_string_lossy(),
                "title": "Invalid Manager Id Office",
                "subtitle": null,
                "threadId": "not-a-runtime-thread-id",
                "goal": "Reject non-runtime manager identities"
            })),
        )
        .await?;
    let error: JSONRPCError = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(request_id)),
    )
    .await??;
    assert!(error.error.message.contains("threadId"));

    let (ensured, _) = create_server_owned_manager(
        &mut mcp,
        &workspace,
        "Safe Office",
        "Keep single-chat and group-chat context separate",
    )
    .await?;
    let mut rebound = ensured.config;
    rebound["workspace"]["threadId"] = json!(ordinary.id);
    let request_id = mcp
        .send_raw_request(
            "office/save",
            Some(json!({
                "cwd": workspace.path().to_string_lossy(),
                "config": rebound
            })),
        )
        .await?;
    let error: JSONRPCError = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(request_id)),
    )
    .await??;
    assert!(error.error.message.contains("office/manager/ensure"));
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_manager_thread_rejects_generic_mutations_when_loaded_and_cold() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let mut mcp = initialized_app_server(&codex_home).await?;
    let (ensured, manager) = create_server_owned_manager(
        &mut mcp,
        &workspace,
        "Protected Manager Office",
        "Keep manager execution on the Office capability path",
    )
    .await?;
    assert_eq!(ensured.status, OfficeManagerEnsureStatus::Created);
    let manager_path = manager
        .path
        .clone()
        .expect("persistent manager thread must have a rollout path");
    let ordinary = start_workspace_thread(&mut mcp, &workspace).await?.thread;
    let mut active_config = ensured.config;
    active_config["workspace"]["activity"]["runs"] = json!([{
        "id": "active-manager-run",
        "status": "running",
        "threadId": manager.id,
        "turnId": "active-manager-turn"
    }]);
    let saved: OfficeSaveResponse = request(
        &mut mcp,
        "office/save",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": active_config
        }),
    )
    .await?;
    assert_eq!(saved.config["workspace"]["threadId"], manager.id);

    let _: serde_json::Value = request(
        &mut mcp,
        "thread/increment_elicitation",
        json!({"threadId": manager.id}),
    )
    .await?;
    let _: serde_json::Value = request(
        &mut mcp,
        "thread/decrement_elicitation",
        json!({"threadId": manager.id}),
    )
    .await?;

    for (method, params) in [
        (
            "turn/start",
            json!({
                "threadId": manager.id,
                "input": [{"type": "text", "text": "bypass", "textElements": []}]
            }),
        ),
        (
            "turn/steer",
            json!({
                "threadId": manager.id,
                "expectedTurnId": "not-active",
                "input": [{"type": "text", "text": "bypass", "textElements": []}]
            }),
        ),
        (
            "turn/interrupt",
            json!({"threadId": manager.id, "turnId": "active-manager-turn"}),
        ),
        (
            "thread/inject_items",
            json!({"threadId": manager.id, "items": []}),
        ),
        (
            "thread/settings/update",
            json!({"threadId": manager.id, "model": "mock-model"}),
        ),
        (
            "review/start",
            json!({
                "threadId": manager.id,
                "delivery": "inline",
                "target": {"type": "custom", "instructions": "bypass"}
            }),
        ),
        ("thread/fork", json!({"threadId": manager.id})),
        (
            "mcpServer/tool/call",
            json!({
                "threadId": manager.id,
                "server": "filesystem",
                "tool": "write_file",
                "arguments": {"path": "/tmp/manager-bypass", "contents": "blocked"}
            }),
        ),
    ] {
        assert_manager_mutation_rejected(&mut mcp, method, params).await?;
    }

    let _: serde_json::Value = request(
        &mut mcp,
        "thread/resume",
        json!({"threadId": manager.id, "excludeTurns": true}),
    )
    .await?;
    assert_manager_mutation_rejected(
        &mut mcp,
        "thread/resume",
        json!({
            "threadId": manager.id,
            "excludeTurns": true,
            "sandbox": "workspace-write"
        }),
    )
    .await?;

    let _: serde_json::Value = request(
        &mut mcp,
        "thread/settings/update",
        json!({"threadId": ordinary.id, "model": "mock-model"}),
    )
    .await?;

    drop(mcp);
    let mut cold = initialized_app_server(&codex_home).await?;
    let loaded: ThreadLoadedListResponse =
        request(&mut cold, "thread/loaded/list", json!({})).await?;
    assert!(!loaded.data.iter().any(|thread_id| thread_id == &manager.id));

    for (method, params) in [
        (
            "turn/start",
            json!({
                "threadId": manager.id,
                "input": [{"type": "text", "text": "cold bypass", "textElements": []}]
            }),
        ),
        (
            "thread/fork",
            json!({
                "threadId": Uuid::nil().to_string(),
                "path": manager_path
            }),
        ),
        (
            "mcpServer/tool/call",
            json!({
                "threadId": manager.id,
                "server": "filesystem",
                "tool": "write_file",
                "arguments": {"path": "/tmp/cold-manager-bypass", "contents": "blocked"}
            }),
        ),
        ("thread/delete", json!({"threadId": manager.id})),
    ] {
        assert_manager_mutation_rejected(&mut cold, method, params).await?;
    }

    assert_manager_mutation_rejected(
        &mut cold,
        "thread/resume",
        json!({
            "threadId": Uuid::nil().to_string(),
            "path": manager_path,
            "excludeTurns": true
        }),
    )
    .await?;
    assert_manager_mutation_rejected(
        &mut cold,
        "thread/resume",
        json!({
            "threadId": manager.id,
            "excludeTurns": true,
            "developerInstructions": "unsafe override"
        }),
    )
    .await?;

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_office_manager_rejects_generic_conversation_turns() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let mut mcp = initialized_app_server(&codex_home).await?;
    let (_, manager) = create_server_owned_manager(
        &mut mcp,
        &workspace,
        "Idle Protected Manager Office",
        "Keep all manager conversation on the Office group-chat path",
    )
    .await?;

    assert_manager_mutation_rejected(
        &mut mcp,
        "turn/start",
        json!({
            "threadId": manager.id,
            "input": [{
                "type": "text",
                "text": "bypass the Office group chat",
                "textElements": []
            }]
        }),
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn legacy_office_manager_without_sidecar_is_backfilled_and_protected() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let mut mcp = initialized_app_server(&codex_home).await?;
    let manager = start_workspace_thread(&mut mcp, &workspace).await?.thread;
    let _: serde_json::Value = request(
        &mut mcp,
        "thread/inject_items",
        json!({
            "threadId": manager.id,
            "items": [{
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "Legacy manager bootstrap"}]
            }]
        }),
    )
    .await?;
    let office_directory = workspace.path().join(".crewon").join("offices");
    std::fs::create_dir_all(&office_directory)?;
    std::fs::write(
        office_directory.join("legacy-manager.json"),
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "kind": "office",
            "savedAt": "2026-07-14T00:00:00.000Z",
            "config": {
                "title": "Legacy Protected Office",
                "workspace": {
                    "threadId": manager.id,
                    "members": [],
                    "messages": [],
                    "tasks": [],
                    "activity": {"runs": []}
                }
            }
        }))?,
    )?;

    let legacy: OfficeReadResponse = request(
        &mut mcp,
        "office/read",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "threadId": manager.id,
            "title": null
        }),
    )
    .await?;
    let legacy = legacy.record.expect("legacy Office record");
    let saved: OfficeSaveResponse = request(
        &mut mcp,
        "office/save",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": legacy.config
        }),
    )
    .await?;
    assert_eq!(saved.config["workspace"]["threadId"], manager.id);
    let reused: OfficeManagerEnsureResponse = request(
        &mut mcp,
        "office/manager/ensure",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "officeRecordId": saved.config["workspace"]["recordId"],
            "expectedRecordRevision": saved.config["workspace"]["recordRevision"]
        }),
    )
    .await?;
    assert_eq!(reused.status, OfficeManagerEnsureStatus::ReusedLegacy);
    assert_eq!(reused.thread_id, manager.id);

    assert_manager_mutation_rejected(
        &mut mcp,
        "thread/settings/update",
        json!({"threadId": manager.id, "model": "mock-model"}),
    )
    .await?;

    let sidecar_directory = office_directory.join(".workspace-identities");
    let sidecars = std::fs::read_dir(sidecar_directory)?.collect::<Result<Vec<_>, _>>()?;
    assert_eq!(sidecars.len(), 1);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_binding_canonicalizes_uuid_and_rejects_cross_workspace() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let other_workspace = TempDir::new()?;
    let mut mcp = initialized_app_server(&codex_home).await?;
    let (ensured, manager) = create_server_owned_manager(
        &mut mcp,
        &workspace,
        "Canonical Manager Office",
        "Canonicalize the manager identity",
    )
    .await?;
    let mut canonical_config = ensured.config;
    canonical_config["workspace"]["threadId"] = json!(manager.id.to_ascii_uppercase());
    let saved: OfficeSaveResponse = request(
        &mut mcp,
        "office/save",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": canonical_config
        }),
    )
    .await?;
    assert_eq!(saved.config["workspace"]["threadId"], manager.id);
    assert_manager_mutation_rejected(
        &mut mcp,
        "thread/settings/update",
        json!({"threadId": manager.id, "model": "mock-model"}),
    )
    .await?;

    let request_id = mcp
        .send_raw_request(
            "office/save",
            Some(json!({
                "cwd": other_workspace.path().to_string_lossy(),
                "config": {
                    "title": "Cross Workspace Office",
                    "workspace": {
                        "threadId": manager.id,
                        "members": [],
                        "messages": [],
                        "tasks": []
                    }
                }
            })),
        )
        .await?;
    let error: JSONRPCError = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(request_id)),
    )
    .await??;
    assert!(error.error.message.contains("different workspace"));
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn generic_history_resume_rejects_office_scoped_context() -> Result<()> {
    let codex_home = TempDir::new()?;
    let mut mcp = initialized_app_server(&codex_home).await?;
    for content_type in ["input_text", "output_text"] {
        let request_id = mcp
            .send_raw_request(
                "thread/resume",
                Some(json!({
                    "threadId": Uuid::nil().to_string(),
                    "history": [{
                        "type": "message",
                        "role": "user",
                        "content": [{
                            "type": content_type,
                            "text": "<external_scope__office__office_manager_context_0>protected</external_scope__office__office_manager_context_0>"
                        }]
                    }],
                    "excludeTurns": true
                })),
            )
            .await?;
        let error: JSONRPCError = timeout(
            DEFAULT_TIMEOUT,
            mcp.read_stream_until_error_message(RequestId::Integer(request_id)),
        )
        .await??;
        assert!(
            error
                .error
                .message
                .contains("Office manager history cannot be resumed"),
            "caller-provided {content_type} must not import Office-scoped context"
        );
    }

    let request_id = mcp
        .send_raw_request(
            "thread/resume",
            Some(json!({
                "threadId": Uuid::nil().to_string(),
                "history": [{
                    "type": "message",
                    "role": "developer",
                    "content": [{
                        "type": "input_text",
                        "text": "<external_application_context key_bytes=39>scope__office_contract__manager_task_0\nprotected</external_application_context>"
                    }]
                }],
                "excludeTurns": true
            })),
        )
        .await?;
    let error: JSONRPCError = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(request_id)),
    )
    .await??;
    assert!(
        error
            .error
            .message
            .contains("Office manager history cannot be resumed")
    );

    let _: serde_json::Value = request(
        &mut mcp,
        "thread/resume",
        json!({
            "threadId": Uuid::nil().to_string(),
            "history": [{
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "ordinary imported history"}]
            }],
            "excludeTurns": true
        }),
    )
    .await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_generic_turn_and_office_run_admit_only_one_manager_turn() -> Result<()> {
    let server = responses::start_mock_server().await;
    let delayed_response = responses::sse_response(create_final_assistant_message_sse_response(
        "The admitted manager turn completes later",
    )?)
    .set_delay(Duration::from_secs(/*secs*/ 3));
    let response_mock = responses::mount_response_sequence(&server, vec![delayed_response]).await;
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut app = initialized_app_server(&codex_home).await?;
    let (ensured, manager) = create_server_owned_manager(
        &mut app,
        &workspace,
        "Capability Admission Office",
        "Serialize ordinary and Office manager admissions",
    )
    .await?;
    let saved = OfficeSaveResponse {
        file_path: ensured.file_path,
        config: ensured.config,
    };

    let generic_request_id = app
        .send_raw_request(
            "turn/start",
            Some(json!({
                "threadId": manager.id,
                "input": [{
                    "type": "text",
                    "text": "Start an ordinary manager conversation",
                    "textElements": []
                }]
            })),
        )
        .await?;
    let office_request_id = app
        .send_raw_request(
            "office/run",
            Some(json!({
                "cwd": workspace.path().to_string_lossy(),
                "config": saved.config,
                "message": {
                    "author": "User",
                    "glyph": "@",
                    "accent": "slate",
                    "time": "now",
                    "text": "Start the Office manager run",
                    "kind": "message"
                },
                "text": "Start the Office manager run",
                "locale": "en",
                "threadId": manager.id,
                "clientUserMessageId": "capability-admission-office-run"
            })),
        )
        .await?;

    let generic_request_id = RequestId::Integer(generic_request_id);
    let office_request_id = RequestId::Integer(office_request_id);
    let mut generic_outcome = None;
    let mut office_outcome = None;
    while generic_outcome.is_none() || office_outcome.is_none() {
        match timeout(DEFAULT_TIMEOUT, app.read_next_message()).await?? {
            JSONRPCMessage::Response(response) if response.id == generic_request_id => {
                generic_outcome = Some(Ok(response));
            }
            JSONRPCMessage::Error(error) if error.id == generic_request_id => {
                generic_outcome = Some(Err(error));
            }
            JSONRPCMessage::Response(response) if response.id == office_request_id => {
                office_outcome = Some(Ok(response));
            }
            JSONRPCMessage::Error(error) if error.id == office_request_id => {
                office_outcome = Some(Err(error));
            }
            _ => {}
        }
    }

    let generic_turn = match generic_outcome.expect("generic turn outcome") {
        Ok(response) => Some(to_response::<TurnStartResponse>(response)?),
        Err(error) => {
            assert!(error.error.message.contains("Office-scoped runtime"));
            None
        }
    };
    let office_run = match office_outcome.expect("Office run outcome") {
        Ok(response) => Some(to_response::<OfficeRunResponse>(response)?),
        Err(error) => {
            assert!(
                error.error.message.contains("turn")
                    || error.error.message.contains("active")
                    || error.error.message.contains("running"),
                "unexpected Office admission failure: {}",
                error.error.message
            );
            None
        }
    };
    assert_eq!(generic_turn.is_some() as u8 + office_run.is_some() as u8, 1);

    let canonical: OfficeReadResponse = request(
        &mut app,
        "office/read",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "threadId": manager.id,
            "title": null
        }),
    )
    .await?;
    let config = canonical.record.expect("canonical Office record").config;
    let nonterminal_runs = config["workspace"]["activity"]["runs"]
        .as_array()
        .expect("Office runs")
        .iter()
        .filter(|run| {
            !matches!(
                run.get("status").and_then(serde_json::Value::as_str),
                Some("completed" | "failed" | "interrupted")
            )
        })
        .collect::<Vec<_>>();
    match office_run {
        Some(office_run) => {
            assert!(nonterminal_runs.iter().all(|run| {
                run.get("id").and_then(serde_json::Value::as_str)
                    == Some(office_run.run_id.as_str())
                    && run.get("turnId").and_then(serde_json::Value::as_str)
                        == Some(office_run.turn.id.as_str())
            }));
        }
        None => assert!(nonterminal_runs.is_empty()),
    }

    for _ in 0..40 {
        if response_mock.requests().len() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(response_mock.requests().len(), 1);
    Ok(())
}
