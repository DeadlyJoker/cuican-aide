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
const EXACT_TASK: &str = "Recover the durable partial-commit sentinel";
const EXECUTION_UNKNOWN_MESSAGE: &str =
    "Office dispatch execution is unknown and requires reconciliation";

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

fn marker_only_rollout(rollout: &[u8], client_id: &str) -> Result<Vec<u8>> {
    let mut session_meta = None;
    let mut marker = None;
    for line in String::from_utf8_lossy(rollout).lines() {
        let item: JsonValue = serde_json::from_str(line)?;
        match item["type"].as_str() {
            Some("session_meta") if session_meta.is_none() => session_meta = Some(line.to_string()),
            Some("user_input_once_marker")
                if item["payload"]["clientId"] == client_id && marker.is_none() =>
            {
                marker = Some(line.to_string());
            }
            _ => {}
        }
    }
    Ok(format!(
        "{}\n{}\n",
        session_meta.context("member session meta")?,
        marker.context("exact member admission marker")?
    )
    .into_bytes())
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

async fn wait_for_execution_unknown_intent(path: &Path, intent_id: &str) -> Result<JsonValue> {
    timeout(TIMEOUT, async {
        loop {
            let scheduler: JsonValue = serde_json::from_slice(&tokio::fs::read(path).await?)?;
            if let Some(intent) = scheduler["intents"]
                .as_array()
                .and_then(|intents| {
                    intents
                        .iter()
                        .find(|intent| intent["intentId"] == intent_id)
                })
                .filter(|intent| intent["status"] == "executionUnknown")
            {
                return Ok::<_, anyhow::Error>(intent.clone());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await?
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn execution_unknown_office_reconciles_expired_scheduler_partial_commit_once() -> Result<()> {
    let manager_message = format!(
        r#"Plan ready.
```json
{{
  "officeUpdate": {{
    "summary": "Prepared one durable partial-commit delegation.",
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
        create_final_assistant_message_sse_response("Seed partial-commit dispatch complete.")?,
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
            "title": "Durable Partial Commit Office",
            "subtitle": null,
            "threadId": office_thread.id,
            "goal": "Reconcile an interrupted two-file execution quarantine commit"
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
                "text": "Prepare the durable partial-commit sentinel",
                "kind": "message"
            },
            "text": "Prepare the durable partial-commit sentinel",
            "locale": "en",
            "threadId": null,
            "clientUserMessageId": "durable-partial-commit-manager-message"
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

    let marker_only = marker_only_rollout(&read_nonempty(&member_rollout_path).await?, &client_id)?;
    tokio::fs::write(&member_rollout_path, &marker_only).await?;

    let office_path = Path::new(&admitted.file_path);
    let mut office: JsonValue = serde_json::from_slice(&tokio::fs::read(office_path).await?)?;
    let delegation = office["config"]["workspace"]["activity"]["runs"][0]["delegations"][0]
        .as_object_mut()
        .context("persisted delegation")?;
    for field in [
        "dispatchMethod",
        "completedAt",
        "resultPreview",
        "dispatchLeaseId",
        "dispatchLeaseStartedAt",
        "dispatchLeaseExpiresAt",
    ] {
        delegation.remove(field);
    }
    delegation.insert("status".to_string(), json!("queued"));
    delegation.insert("turnId".to_string(), json!(turn_id));
    let receipt = delegation
        .get_mut("dispatchReceipt")
        .context("persisted dispatch receipt")?;
    *receipt = seeded_receipt;
    receipt["status"] = json!("executionUnknown");
    receipt["admissionState"] = json!("admissionOnly");
    receipt["turnId"] = json!(turn_id);
    receipt["lastError"] = json!(EXECUTION_UNKNOWN_MESSAGE);
    tokio::fs::write(office_path, serde_json::to_vec_pretty(&office)?).await?;
    let office_before = tokio::fs::read(office_path).await?;

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
    intent["leaseId"] = json!("expired-partial-commit-scheduler");
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
        create_final_assistant_message_sse_response("Unexpected partial-commit replay.")?,
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
    let reconciled = wait_for_execution_unknown_intent(&scheduler_path, &intent_id).await?;
    assert_eq!(reconciled["runId"], run.run_id);
    assert_eq!(reconciled["delegationId"], delegation_id);
    assert_eq!(reconciled["dispatchedThreadId"], member_thread.id);
    assert_eq!(reconciled["dispatchedTurnId"], turn_id);
    assert_eq!(reconciled["lastError"], EXECUTION_UNKNOWN_MESSAGE);
    assert_eq!(reconciled["leaseId"], JsonValue::Null);
    assert_eq!(reconciled["leaseStartedAt"], JsonValue::Null);
    assert_eq!(reconciled["leaseExpiresAt"], JsonValue::Null);
    restarted.shutdown().await?;

    let scheduler_after_first = tokio::fs::read(&scheduler_path).await?;
    assert_eq!(tokio::fs::read(office_path).await?, office_before);
    assert_eq!(read_nonempty(&member_rollout_path).await?, marker_only);
    let recovery_requests = recovery_server
        .received_requests()
        .await
        .unwrap_or_default();
    assert_eq!(recovery_requests.len(), 0);
    assert_eq!(exact_task_request_count(&recovery_requests), 0);

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
    assert_eq!(tokio::fs::read(office_path).await?, office_before);
    assert_eq!(
        tokio::fs::read(&scheduler_path).await?,
        scheduler_after_first
    );
    assert_eq!(read_nonempty(&member_rollout_path).await?, marker_only);
    let recovery_requests = recovery_server
        .received_requests()
        .await
        .unwrap_or_default();
    assert_eq!(recovery_requests.len(), 0);
    assert_eq!(exact_task_request_count(&recovery_requests), 0);
    Ok(())
}
