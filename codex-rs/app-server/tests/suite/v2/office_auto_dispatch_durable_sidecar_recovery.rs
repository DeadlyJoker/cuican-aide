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
use crewon_app_server_protocol::ThreadReadResponse;
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
const EXACT_TASK: &str = "Build the admitted sidecar recovery sentinel";

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

async fn thread_turn_ids(app: &mut TestAppServer, thread_id: &str) -> Result<Vec<String>> {
    let read: ThreadReadResponse = request(
        app,
        "thread/read",
        json!({ "threadId": thread_id, "includeTurns": true }),
    )
    .await?;
    Ok(read.thread.turns.into_iter().map(|turn| turn.id).collect())
}

async fn completed_office_record(path: &Path, delegation_id: &str) -> Result<(Vec<u8>, JsonValue)> {
    timeout(TIMEOUT, async {
        let mut previous_terminal_bytes: Option<Vec<u8>> = None;
        loop {
            let bytes = tokio::fs::read(path).await?;
            let record: JsonValue = serde_json::from_slice(&bytes)?;
            let delegation = record["config"]["workspace"]["activity"]["runs"]
                .as_array()
                .and_then(|runs| {
                    runs.iter()
                        .flat_map(|run| run["delegations"].as_array().into_iter().flatten())
                        .find(|delegation| delegation["id"] == delegation_id)
                });
            let terminal = delegation.is_some_and(|delegation| {
                delegation["status"] == "completed"
                    && delegation["dispatchReceipt"]["status"] == "admitted"
            });
            if terminal && previous_terminal_bytes.as_deref() == Some(bytes.as_slice()) {
                return Ok::<_, anyhow::Error>((bytes, record));
            }
            previous_terminal_bytes = terminal.then_some(bytes);
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await?
}

async fn wait_for_recovered_scheduler_intent(path: &Path, intent_id: &str) -> Result<JsonValue> {
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
                .filter(|intent| intent["status"] == "dispatched")
            {
                return Ok::<_, anyhow::Error>(intent.clone());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await?
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn admitted_receipt_recovers_only_the_expired_scheduler_sidecar_after_restart() -> Result<()>
{
    let manager_message = format!(
        r#"Plan ready.
```json
{{
  "officeUpdate": {{
    "summary": "Prepared one admitted sidecar recovery delegation.",
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
    let server = create_mock_responses_server_sequence_unchecked(vec![
        create_final_assistant_message_sse_response(&manager_message)?,
        create_final_assistant_message_sse_response("Admitted sidecar sentinel complete.")?,
    ])
    .await;
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml(
        codex_home.path(),
        &server.uri(),
        &BTreeMap::from([
            (Feature::UserInputOnce, true),
            (Feature::OfficeAutoDelegationDurableAdmission, true),
        ]),
        /*auto_compact_limit*/ 200_000,
        /*requires_openai_auth*/ None,
        "mock_provider",
        "compact prompt",
    )?;
    let mut app = TestAppServer::new(codex_home.path()).await?;
    timeout(TIMEOUT, app.initialize()).await??;

    let office_thread = start_workspace_thread(&mut app, &workspace).await?.thread;
    let member_thread = start_workspace_thread(&mut app, &workspace).await?.thread;
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
            "title": "Admitted Sidecar Recovery Office",
            "subtitle": null,
            "threadId": office_thread.id,
            "goal": "Recover only the scheduler sidecar after restart"
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
                "text": "Prepare the admitted recovery sentinel",
                "kind": "message"
            },
            "text": "Prepare the admitted recovery sentinel",
            "locale": "en",
            "threadId": null,
            "clientUserMessageId": "admitted-sidecar-manager-message"
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
    let original_turn_id = delegation["turnId"]
        .as_str()
        .context("admitted member turn id")?
        .to_string();

    timeout(
        TIMEOUT,
        app.read_stream_until_matching_notification("member completion", |notification| {
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

    let member_turns_before = thread_turn_ids(&mut app, &member_thread.id).await?;
    let requests_before = server.received_requests().await.unwrap_or_default();
    assert_eq!(exact_task_request_count(&requests_before), 1);
    app.shutdown().await?;

    let office_path = Path::new(&admitted.file_path);
    let (office_bytes_before, persisted_before) =
        completed_office_record(office_path, &delegation_id).await?;
    let receipt_before = persisted_before["config"]["workspace"]["activity"]["runs"]
        .as_array()
        .and_then(|runs| {
            runs.iter()
                .flat_map(|run| run["delegations"].as_array().into_iter().flatten())
                .find(|delegation| delegation["id"] == delegation_id)
        })
        .and_then(|delegation| delegation.get("dispatchReceipt"))
        .cloned()
        .context("persisted admitted dispatch receipt")?;
    assert_eq!(receipt_before["status"], "admitted");
    assert_eq!(receipt_before["turnId"], original_turn_id);
    let receipt_bytes_before = serde_json::to_vec(&receipt_before)?;
    let reserve_count_before = receipt_before["reserveCount"].clone();
    let updated_at_before = receipt_before["updatedAt"].clone();
    let intent_id = receipt_before["intentId"]
        .as_str()
        .context("receipt intent id")?
        .to_string();

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
        .context("exact dispatched scheduler intent")?;
    assert_eq!(intent["status"], "dispatched");

    intent["status"] = json!("dispatching");
    intent["leaseId"] = json!("expired-admitted-sidecar-recovery");
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

    let mut restarted = TestAppServer::new(codex_home.path()).await?;
    timeout(TIMEOUT, restarted.initialize()).await??;
    let recovered_intent = wait_for_recovered_scheduler_intent(&scheduler_path, &intent_id).await?;
    assert_eq!(recovered_intent["runId"], run.run_id);
    assert_eq!(recovered_intent["delegationId"], delegation_id);
    assert_eq!(recovered_intent["dispatchedThreadId"], member_thread.id);
    assert_eq!(recovered_intent["dispatchedTurnId"], original_turn_id);
    assert_eq!(recovered_intent["leaseId"], JsonValue::Null);
    assert_eq!(recovered_intent["leaseStartedAt"], JsonValue::Null);
    assert_eq!(recovered_intent["leaseExpiresAt"], JsonValue::Null);

    let office_bytes_after = tokio::fs::read(office_path).await?;
    assert_eq!(office_bytes_after, office_bytes_before);
    let persisted_after: JsonValue = serde_json::from_slice(&office_bytes_after)?;
    let receipt_after = persisted_after["config"]["workspace"]["activity"]["runs"]
        .as_array()
        .and_then(|runs| {
            runs.iter()
                .flat_map(|run| run["delegations"].as_array().into_iter().flatten())
                .find(|delegation| delegation["id"] == delegation_id)
        })
        .and_then(|delegation| delegation.get("dispatchReceipt"))
        .cloned()
        .context("recovered admitted dispatch receipt")?;
    assert_eq!(serde_json::to_vec(&receipt_after)?, receipt_bytes_before);
    assert_eq!(receipt_after, receipt_before);
    assert_eq!(receipt_after["reserveCount"], reserve_count_before);
    assert_eq!(receipt_after["updatedAt"], updated_at_before);
    assert_eq!(
        thread_turn_ids(&mut restarted, &member_thread.id).await?,
        member_turns_before
    );
    let requests_after = server.received_requests().await.unwrap_or_default();
    assert_eq!(requests_after.len(), requests_before.len());
    assert_eq!(exact_task_request_count(&requests_after), 1);
    Ok(())
}
