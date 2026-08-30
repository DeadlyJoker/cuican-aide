use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use anyhow::Context;
use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::create_final_assistant_message_sse_response;
use app_test_support::create_mock_responses_server_sequence_unchecked;
use app_test_support::to_response;
use app_test_support::write_mock_responses_config_toml;
use crewon_app_server_protocol::AgentSaveResponse;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::OfficeCreateResponse;
use crewon_app_server_protocol::OfficeMemberAddResponse;
use crewon_app_server_protocol::OfficeReadResponse;
use crewon_app_server_protocol::OfficeRunResponse;
use crewon_app_server_protocol::OfficeRunUpdatedNotification;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::ThreadItem;
use crewon_app_server_protocol::ThreadSource;
use crewon_app_server_protocol::ThreadStartParams;
use crewon_app_server_protocol::ThreadStartResponse;
use crewon_app_server_protocol::ThreadTurnsListResponse;
use crewon_app_server_protocol::TurnCompletedNotification;
use crewon_features::Feature;
use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;
use tempfile::TempDir;
use tokio::time::timeout;

const TIMEOUT: Duration = Duration::from_secs(30);
const EXACT_TASK: &str = "Resume the v2 admission-only execution sentinel";

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

async fn start_workspace_thread(
    app: &mut TestAppServer,
    workspace: &TempDir,
) -> Result<ThreadStartResponse> {
    let request_id = app
        .send_thread_start_request(ThreadStartParams {
            model: Some("mock-model".to_string()),
            cwd: Some(workspace.path().to_string_lossy().into_owned()),
            thread_source: Some(ThreadSource::User),
            ..Default::default()
        })
        .await?;
    let response: JSONRPCResponse = timeout(
        TIMEOUT,
        app.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    to_response(response)
}

fn v2_admission_only_rollout(rollout: &[u8], client_id: &str) -> Result<(Vec<u8>, JsonValue)> {
    let mut session_meta = None;
    let mut admission = None;
    for line in String::from_utf8_lossy(rollout).lines() {
        let item: JsonValue = serde_json::from_str(line)?;
        match item["type"].as_str() {
            Some("session_meta") if session_meta.is_none() => session_meta = Some(line.to_string()),
            Some("user_input_once_marker")
                if item["payload"]["clientId"] == client_id
                    && item["payload"].get("phase").is_none()
                    && admission.is_none() =>
            {
                admission = Some((line.to_string(), item));
            }
            _ => {}
        }
    }
    let session_meta = session_meta.context("member session meta")?;
    let (admission_line, admission) = admission.context("v2 member admission marker")?;
    assert_eq!(admission["payload"]["version"], 2);
    Ok((
        format!("{session_meta}\n{admission_line}\n").into_bytes(),
        admission,
    ))
}

fn exact_task_request_count(requests: &[wiremock::Request]) -> usize {
    requests
        .iter()
        .filter(|request| {
            request
                .body_json::<JsonValue>()
                .is_ok_and(|body| body.to_string().contains(EXACT_TASK))
        })
        .count()
}

fn matching_client_turns(turns: &ThreadTurnsListResponse, client_id: &str) -> Vec<String> {
    turns
        .data
        .iter()
        .filter(|turn| {
            turn.items.iter().any(|item| {
                matches!(
                    item,
                    ThreadItem::UserMessage {
                        client_id: Some(item_client_id),
                        ..
                    } if item_client_id == client_id
                )
            })
        })
        .map(|turn| turn.id.clone())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v2_admission_without_execution_fence_resumes_original_turn_exactly_once() -> Result<()> {
    let manager_message = format!(
        r#"Plan ready.
```json
{{
  "officeUpdate": {{
    "summary": "Prepared one v2 admission-only recovery delegation.",
    "delegations": [{{
      "member": "Engineer",
      "agentId": "agent-engineer",
      "task": "{EXACT_TASK}",
      "status": "pending",
      "dispatchMode": "auto",
      "riskSeverity": "low",
      "approvalRequired": false
    }}]
  }}
}}
```"#
    );
    let seed_server = create_mock_responses_server_sequence_unchecked(vec![
        create_final_assistant_message_sse_response(&manager_message)?,
        create_final_assistant_message_sse_response("Seed v2 admission dispatch complete.")?,
    ])
    .await;
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let enabled_features = BTreeMap::from([
        (Feature::UserInputOnce, true),
        (Feature::OfficeAutoDelegationDurableAdmission, true),
    ]);
    write_mock_responses_config_toml(
        codex_home.path(),
        &seed_server.uri(),
        &enabled_features,
        /*auto_compact_limit*/ 200_000,
        /*requires_openai_auth*/ None,
        "mock_provider",
        "compact prompt",
    )?;
    let mut app = TestAppServer::new(codex_home.path()).await?;
    timeout(TIMEOUT, app.initialize()).await??;

    let office_thread = start_workspace_thread(&mut app, &workspace).await?.thread;
    let member_thread = start_workspace_thread(&mut app, &workspace).await?.thread;
    let member_rollout_path = member_thread.path.clone().context("member rollout path")?;
    let _: AgentSaveResponse = request(
        &mut app,
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
    let created: OfficeCreateResponse = request(
        &mut app,
        "office/create",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "title": "V2 Admission Recovery Office",
            "subtitle": null,
            "threadId": office_thread.id,
            "goal": "Resume an admitted but provably unstarted durable dispatch"
        }),
    )
    .await?;
    let member_added: OfficeMemberAddResponse = request(
        &mut app,
        "office/member/add",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": created.config,
            "agentId": "agent-engineer",
            "member": {
                "name": "Engineer",
                "role": "Build",
                "glyph": "E",
                "accent": "blue",
                "status": "online"
            }
        }),
    )
    .await?;
    let run: OfficeRunResponse = request(
        &mut app,
        "office/run",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": member_added.config,
            "message": {
                "author": "User",
                "glyph": "@",
                "accent": "slate",
                "time": "now",
                "text": "Prepare the v2 admission-only sentinel",
                "kind": "message"
            },
            "text": "Prepare the v2 admission-only sentinel",
            "locale": "en",
            "threadId": null,
            "clientUserMessageId": "v2-admission-recovery-manager-message"
        }),
    )
    .await?;

    let admitted: OfficeRunUpdatedNotification = serde_json::from_value(
        timeout(
            TIMEOUT,
            app.read_stream_until_matching_notification("durable admission", |notification| {
                notification.method == "office/run/updated"
                    && notification.params.as_ref().is_some_and(|params| {
                        serde_json::from_value::<OfficeRunUpdatedNotification>(params.clone())
                            .is_ok_and(|update| update.reason == "autoDispatchAdmitted")
                    })
            }),
        )
        .await??
        .params
        .context("durable admission params")?,
    )?;
    let seeded = &admitted.config["workspace"]["activity"]["runs"][0]["delegations"][0];
    let delegation_id = seeded["id"]
        .as_str()
        .context("durable delegation id")?
        .to_string();
    let original_turn_id = seeded["turnId"]
        .as_str()
        .context("durable turn id")?
        .to_string();
    let seeded_receipt = seeded["dispatchReceipt"].clone();
    let client_id = seeded_receipt["clientUserMessageId"]
        .as_str()
        .context("receipt client id")?
        .to_string();
    let intent_id = seeded_receipt["intentId"]
        .as_str()
        .context("receipt intent id")?
        .to_string();
    timeout(
        TIMEOUT,
        app.read_stream_until_matching_notification("seed member completion", |notification| {
            notification.method == "turn/completed"
                && notification.params.as_ref().is_some_and(|params| {
                    serde_json::from_value::<TurnCompletedNotification>(params.clone()).is_ok_and(
                        |completed| {
                            completed.thread_id == member_thread.id
                                && completed.turn.id == original_turn_id
                        },
                    )
                })
        }),
    )
    .await??;
    assert_eq!(
        exact_task_request_count(&seed_server.received_requests().await.unwrap_or_default()),
        1
    );
    app.shutdown().await?;

    let (admission_only, admission) =
        v2_admission_only_rollout(&tokio::fs::read(&member_rollout_path).await?, &client_id)?;
    assert_eq!(admission["payload"]["turnId"], original_turn_id);
    tokio::fs::write(&member_rollout_path, &admission_only).await?;

    let office_path = Path::new(&admitted.file_path);
    let mut office: JsonValue = serde_json::from_slice(&tokio::fs::read(office_path).await?)?;
    let delegation = office["config"]["workspace"]["activity"]["runs"][0]["delegations"][0]
        .as_object_mut()
        .context("persisted delegation")?;
    for field in ["turnId", "dispatchMethod", "completedAt", "resultPreview"] {
        delegation.remove(field);
    }
    delegation.insert("status".to_string(), json!("queued"));
    delegation.insert("dispatchLeaseId".to_string(), json!("expired-v2-child"));
    delegation.insert(
        "dispatchLeaseStartedAt".to_string(),
        json!("2000-01-01T00:00:00Z"),
    );
    delegation.insert(
        "dispatchLeaseExpiresAt".to_string(),
        json!("2000-01-01T00:00:01Z"),
    );
    let receipt = delegation
        .get_mut("dispatchReceipt")
        .context("persisted dispatch receipt")?;
    *receipt = seeded_receipt;
    receipt["status"] = json!("starting");
    receipt["admissionState"] = JsonValue::Null;
    receipt["turnId"] = JsonValue::Null;
    receipt["lastError"] = JsonValue::Null;
    tokio::fs::write(office_path, serde_json::to_vec_pretty(&office)?).await?;

    let scheduler_path = workspace
        .path()
        .join(".crewon")
        .join("office-runs")
        .join("scheduler.json");
    let mut scheduler: JsonValue =
        serde_json::from_slice(&tokio::fs::read(&scheduler_path).await?)?;
    let intent = scheduler["intents"]
        .as_array_mut()
        .and_then(|intents| {
            intents
                .iter_mut()
                .find(|intent| intent["intentId"] == intent_id)
        })
        .context("persisted scheduler intent")?;
    intent["status"] = json!("dispatching");
    intent["leaseId"] = json!("expired-v2-scheduler");
    intent["leaseStartedAt"] = json!("2000-01-01T00:00:00Z");
    intent["leaseExpiresAt"] = json!("2000-01-01T00:00:01Z");
    intent["updatedAt"] = json!("2000-01-01T00:00:00Z");
    intent["lastError"] = JsonValue::Null;
    for field in [
        "runId",
        "dispatchKind",
        "delegationId",
        "verificationCheckId",
        "filePath",
        "dispatchedThreadId",
        "dispatchedTurnId",
    ] {
        intent[field] = JsonValue::Null;
    }
    let mut scheduler_bytes = serde_json::to_vec_pretty(&scheduler)?;
    scheduler_bytes.push(b'\n');
    tokio::fs::write(&scheduler_path, scheduler_bytes).await?;

    let recovery_server = create_mock_responses_server_sequence_unchecked(vec![
        create_final_assistant_message_sse_response("Recovered v2 admission exactly once.")?,
        create_final_assistant_message_sse_response("Unexpected second v2 recovery replay.")?,
    ])
    .await;
    write_mock_responses_config_toml(
        codex_home.path(),
        &recovery_server.uri(),
        &enabled_features,
        /*auto_compact_limit*/ 200_000,
        /*requires_openai_auth*/ None,
        "mock_provider",
        "compact prompt",
    )?;
    let mut restarted = TestAppServer::new(codex_home.path()).await?;
    timeout(TIMEOUT, restarted.initialize()).await??;
    timeout(
        TIMEOUT,
        restarted.read_stream_until_matching_notification(
            "recovered member completion",
            |notification| {
                notification.method == "turn/completed"
                    && notification.params.as_ref().is_some_and(|params| {
                        serde_json::from_value::<TurnCompletedNotification>(params.clone())
                            .is_ok_and(|completed| {
                                completed.thread_id == member_thread.id
                                    && completed.turn.id == original_turn_id
                            })
                    })
            },
        ),
    )
    .await??;
    let completed: OfficeRunUpdatedNotification = serde_json::from_value(
        timeout(
            TIMEOUT,
            restarted.read_stream_until_matching_notification(
                "recovered Office completion",
                |notification| {
                    notification.method == "office/run/updated"
                        && notification.params.as_ref().is_some_and(|params| {
                            serde_json::from_value::<OfficeRunUpdatedNotification>(params.clone())
                                .is_ok_and(|update| update.reason == "autoDispatchCompletion")
                        })
                },
            ),
        )
        .await??
        .params
        .context("Office completion params")?,
    )?;
    let completed_delegation =
        &completed.config["workspace"]["activity"]["runs"][0]["delegations"][0];
    assert_eq!(completed_delegation["id"], delegation_id);
    assert_eq!(completed_delegation["status"], "completed");
    assert_eq!(completed_delegation["turnId"], original_turn_id);
    assert_eq!(
        completed_delegation["dispatchReceipt"]["status"],
        "admitted"
    );
    assert_eq!(
        completed_delegation["dispatchReceipt"]["clientUserMessageId"],
        client_id
    );
    assert_eq!(
        completed_delegation["dispatchReceipt"]["turnId"],
        original_turn_id
    );
    let turns: ThreadTurnsListResponse = request(
        &mut restarted,
        "thread/turns/list",
        json!({
            "threadId": member_thread.id,
            "cursor": null,
            "limit": 20,
            "sortDirection": "asc",
            "itemsView": "full"
        }),
    )
    .await?;
    assert_eq!(
        matching_client_turns(&turns, &client_id),
        vec![original_turn_id.clone()]
    );
    restarted.shutdown().await?;

    let office_after_first = tokio::fs::read(office_path).await?;
    let scheduler_after_first = tokio::fs::read(&scheduler_path).await?;
    let scheduler_after: JsonValue = serde_json::from_slice(&scheduler_after_first)?;
    let intent_after = scheduler_after["intents"]
        .as_array()
        .and_then(|intents| {
            intents
                .iter()
                .find(|intent| intent["intentId"] == intent_id)
        })
        .context("recovered scheduler intent")?;
    assert_eq!(intent_after["status"], "dispatched");
    assert_eq!(intent_after["runId"], run.run_id);
    assert_eq!(intent_after["delegationId"], delegation_id);
    assert_eq!(intent_after["dispatchedThreadId"], member_thread.id);
    assert_eq!(intent_after["dispatchedTurnId"], original_turn_id);
    let recovery_requests = recovery_server
        .received_requests()
        .await
        .unwrap_or_default();
    assert_eq!(recovery_requests.len(), 1);
    assert_eq!(exact_task_request_count(&recovery_requests), 1);

    let mut restarted_again = TestAppServer::new(codex_home.path()).await?;
    timeout(TIMEOUT, restarted_again.initialize()).await??;
    let _: OfficeReadResponse = request(
        &mut restarted_again,
        "office/read",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "threadId": office_thread.id,
            "title": null
        }),
    )
    .await?;
    restarted_again.shutdown().await?;
    assert_eq!(tokio::fs::read(office_path).await?, office_after_first);
    assert_eq!(
        tokio::fs::read(&scheduler_path).await?,
        scheduler_after_first
    );
    let recovery_requests = recovery_server
        .received_requests()
        .await
        .unwrap_or_default();
    assert_eq!(recovery_requests.len(), 1);
    assert_eq!(exact_task_request_count(&recovery_requests), 1);
    Ok(())
}
