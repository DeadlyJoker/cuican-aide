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
use crewon_app_server_protocol::OfficeRunResponse;
use crewon_app_server_protocol::OfficeRunUpdatedNotification;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::ThreadSource;
use crewon_app_server_protocol::ThreadStartParams;
use crewon_app_server_protocol::ThreadStartResponse;
use crewon_app_server_protocol::TurnCompletedNotification;
use crewon_features::Feature;
use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;
use tempfile::TempDir;
use tokio::time::timeout;

const TIMEOUT: Duration = Duration::from_secs(30);
const EXACT_TASK: &str = "Quarantine the marker-only durable execution sentinel";
const MAX_ERROR_CHARS: usize = 512;

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

async fn read_nonempty(path: &Path) -> Result<Vec<u8>> {
    timeout(TIMEOUT, async {
        loop {
            match tokio::fs::read(path).await {
                Ok(bytes) if !bytes.is_empty() => return Ok::<_, anyhow::Error>(bytes),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await?
}

fn marker_only_rollout(rollout: &[u8], client_id: &str) -> Result<(Vec<u8>, JsonValue)> {
    let mut session_meta = None;
    let mut exact_marker = None;
    for line in String::from_utf8_lossy(rollout).lines() {
        let item: JsonValue = serde_json::from_str(line)?;
        match item["type"].as_str() {
            Some("session_meta") if session_meta.is_none() => session_meta = Some(line.to_string()),
            Some("user_input_once_marker")
                if item["payload"]["clientId"] == client_id && exact_marker.is_none() =>
            {
                exact_marker = Some(item);
            }
            _ => {}
        }
    }
    let session_meta = session_meta.context("member session meta")?;
    let mut marker = exact_marker.context("exact member admission marker")?;
    marker["payload"]["version"] = json!(1);
    marker["payload"]
        .as_object_mut()
        .context("legacy admission marker payload")?
        .remove("phase");
    let marker_line = serde_json::to_string(&marker)?;
    Ok((
        format!("{session_meta}\n{marker_line}\n").into_bytes(),
        marker,
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

fn exact_delegation<'a>(record: &'a JsonValue, delegation_id: &str) -> Result<&'a JsonValue> {
    record["config"]["workspace"]["activity"]["runs"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|run| run["delegations"].as_array().into_iter().flatten())
        .find(|delegation| delegation["id"] == delegation_id)
        .context("exact durable delegation")
}

fn exact_intent<'a>(scheduler: &'a JsonValue, intent_id: &str) -> Result<&'a JsonValue> {
    scheduler["intents"]
        .as_array()
        .and_then(|intents| {
            intents
                .iter()
                .find(|intent| intent["intentId"] == intent_id)
        })
        .context("exact durable scheduler intent")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn marker_only_restart_is_quarantined_without_execution_and_remains_idempotent() -> Result<()>
{
    let manager_message = format!(
        r#"Plan ready.
```json
{{
  "officeUpdate": {{
    "summary": "Prepared one marker-only quarantine delegation.",
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
        create_final_assistant_message_sse_response("Seed marker-only dispatch complete.")?,
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
            "title": "Marker Only Quarantine Office",
            "subtitle": null,
            "threadId": office_thread.id,
            "goal": "Quarantine unknown execution without replay"
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
                "text": "Prepare the marker-only quarantine sentinel",
                "kind": "message"
            },
            "text": "Prepare the marker-only quarantine sentinel",
            "locale": "en",
            "threadId": null,
            "clientUserMessageId": "marker-only-quarantine-manager-message"
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
        .context("office/run/updated params")?,
    )?;
    let delegation = &admitted.config["workspace"]["activity"]["runs"][0]["delegations"][0];
    let delegation_id = delegation["id"]
        .as_str()
        .context("durable delegation id")?
        .to_string();
    let turn_id = delegation["turnId"]
        .as_str()
        .context("durable turn id")?
        .to_string();
    let seeded_receipt = delegation["dispatchReceipt"].clone();
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
        app.read_stream_until_matching_notification("member completion", |notification| {
            notification.method == "turn/completed"
                && notification.params.as_ref().is_some_and(|params| {
                    serde_json::from_value::<TurnCompletedNotification>(params.clone()).is_ok_and(
                        |completed| {
                            completed.thread_id == member_thread.id && completed.turn.id == turn_id
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

    let (marker_only, marker) =
        marker_only_rollout(&read_nonempty(&member_rollout_path).await?, &client_id)?;
    assert_eq!(marker["payload"]["version"], 1);
    assert_eq!(marker["payload"]["turnId"], turn_id);
    tokio::fs::write(&member_rollout_path, &marker_only).await?;

    let office_path = Path::new(&admitted.file_path);
    let mut office: JsonValue = serde_json::from_slice(&tokio::fs::read(office_path).await?)?;
    let delegation = office["config"]["workspace"]["activity"]["runs"][0]["delegations"][0]
        .as_object_mut()
        .context("persisted delegation")?;
    for field in ["turnId", "dispatchMethod", "completedAt", "resultPreview"] {
        delegation.remove(field);
    }
    delegation.insert("status".to_string(), json!("queued"));
    delegation.insert(
        "dispatchLeaseId".to_string(),
        json!("expired-marker-only-child"),
    );
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
    intent["leaseId"] = json!("expired-marker-only-scheduler");
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
        create_final_assistant_message_sse_response("Unexpected marker-only replay.")?,
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
    let update: OfficeRunUpdatedNotification = serde_json::from_value(
        timeout(
            TIMEOUT,
            restarted.read_stream_until_matching_notification(
                "marker-only execution quarantine",
                |notification| {
                    notification.method == "office/run/updated"
                        && notification.params.as_ref().is_some_and(|params| {
                            serde_json::from_value::<OfficeRunUpdatedNotification>(params.clone())
                                .is_ok_and(|update| update.reason == "autoDispatchExecutionUnknown")
                        })
                },
            ),
        )
        .await??
        .params
        .context("execution unknown notification params")?,
    )?;
    assert_eq!(update.reason, "autoDispatchExecutionUnknown");

    restarted.shutdown().await?;
    let office_after_first = tokio::fs::read(office_path).await?;
    let persisted_after: JsonValue = serde_json::from_slice(&office_after_first)?;
    let delegation_after = exact_delegation(&persisted_after, &delegation_id)?;
    let receipt_after = &delegation_after["dispatchReceipt"];
    assert_eq!(receipt_after["status"], "executionUnknown");
    assert_eq!(receipt_after["turnId"], turn_id);
    assert_eq!(receipt_after["admissionState"], "admissionOnly");
    let last_error = receipt_after["lastError"]
        .as_str()
        .context("bounded execution unknown reason")?;
    assert!(!last_error.trim().is_empty());
    assert!(last_error.chars().count() <= MAX_ERROR_CHARS);
    for field in [
        "dispatchLeaseId",
        "dispatchLeaseStartedAt",
        "dispatchLeaseExpiresAt",
    ] {
        assert!(delegation_after.get(field).is_none());
    }

    let scheduler_after_first = tokio::fs::read(&scheduler_path).await?;
    let scheduler_after: JsonValue = serde_json::from_slice(&scheduler_after_first)?;
    let intent_after = exact_intent(&scheduler_after, &intent_id)?;
    assert_eq!(intent_after["status"], "executionUnknown");
    assert_eq!(intent_after["runId"], run.run_id);
    assert_eq!(intent_after["delegationId"], delegation_id);
    assert_eq!(intent_after["dispatchedThreadId"], member_thread.id);
    assert_eq!(intent_after["dispatchedTurnId"], turn_id);
    assert_eq!(intent_after["leaseId"], JsonValue::Null);
    assert_eq!(intent_after["leaseStartedAt"], JsonValue::Null);
    assert_eq!(intent_after["leaseExpiresAt"], JsonValue::Null);
    assert_eq!(read_nonempty(&member_rollout_path).await?, marker_only);
    assert_eq!(
        exact_task_request_count(
            &recovery_server
                .received_requests()
                .await
                .unwrap_or_default()
        ),
        0
    );

    let mut restarted_again = TestAppServer::new(codex_home.path()).await?;
    timeout(TIMEOUT, restarted_again.initialize()).await??;
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(tokio::fs::read(office_path).await?, office_after_first);
    assert_eq!(
        tokio::fs::read(&scheduler_path).await?,
        scheduler_after_first
    );
    assert_eq!(read_nonempty(&member_rollout_path).await?, marker_only);
    assert_eq!(
        exact_task_request_count(
            &recovery_server
                .received_requests()
                .await
                .unwrap_or_default()
        ),
        0
    );
    restarted_again.shutdown().await?;
    Ok(())
}
