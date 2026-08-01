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
const EXACT_TASK: &str = "Recover the after-commit ambiguous durable sentinel";
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
fn marker_phase_counts(rollout: &[u8], client_id: &str) -> (usize, usize) {
    String::from_utf8_lossy(rollout)
        .lines()
        .filter_map(|line| serde_json::from_str::<JsonValue>(line).ok())
        .filter(|item| {
            item["type"] == "user_input_once_marker" && item["payload"]["clientId"] == client_id
        })
        .fold((0, 0), |(admissions, fences), item| {
            if item["payload"]["phase"] == "executionFence" {
                (admissions, fences + 1)
            } else {
                (admissions + 1, fences)
            }
        })
}
fn session_meta_only(rollout: &[u8]) -> Result<Vec<u8>> {
    let rollout = String::from_utf8_lossy(rollout);
    let line = rollout
        .lines()
        .find(|line| {
            serde_json::from_str::<JsonValue>(line).is_ok_and(|item| item["type"] == "session_meta")
        })
        .context("member session meta")?;
    Ok(format!("{line}\n").into_bytes())
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
async fn member_turns(app: &mut TestAppServer, thread_id: &str) -> Result<ThreadTurnsListResponse> {
    request(
        app,
        "thread/turns/list",
        json!({
            "threadId": thread_id,
            "cursor": null,
            "limit": 20,
            "sortDirection": "asc",
            "itemsView": "full"
        }),
    )
    .await
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn after_commit_ambiguous_restart_admits_once_and_second_restart_is_idempotent() -> Result<()>
{
    let manager_message = format!(
        r#"Plan ready.
```json
{{
  "officeUpdate": {{
    "summary": "Prepared one after-commit ambiguous delegation.",
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
        create_final_assistant_message_sse_response("Seed dispatch complete.")?,
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
            "title": "After Commit Ambiguous Recovery Office",
            "subtitle": null,
            "threadId": office_thread.id,
            "goal": "Recover one receipt reservation without duplicate work"
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
                "text": "Prepare the after-commit ambiguous sentinel",
                "kind": "message"
            },
            "text": "Prepare the after-commit ambiguous sentinel",
            "locale": "en",
            "threadId": null,
            "clientUserMessageId": "after-commit-ambiguous-manager-message"
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
    let seeded_delegation = &admitted.config["workspace"]["activity"]["runs"][0]["delegations"][0];
    let delegation_id = seeded_delegation["id"]
        .as_str()
        .context("delegation id")?
        .to_string();
    let seeded_turn_id = seeded_delegation["turnId"]
        .as_str()
        .context("seeded turn id")?
        .to_string();
    let seeded_receipt = seeded_delegation["dispatchReceipt"].clone();
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
                                && completed.turn.id == seeded_turn_id
                        },
                    )
                })
        }),
    )
    .await??;
    app.shutdown().await?;
    let pristine_member_rollout = session_meta_only(&read_nonempty(&member_rollout_path).await?)?;
    tokio::fs::write(&member_rollout_path, &pristine_member_rollout).await?;
    assert_eq!(
        marker_phase_counts(&pristine_member_rollout, &client_id),
        (0, 0)
    );

    let office_path = std::path::PathBuf::from(&admitted.file_path);
    let mut office: JsonValue = serde_json::from_slice(&tokio::fs::read(&office_path).await?)?;
    let delegation = office["config"]["workspace"]["activity"]["runs"]
        .as_array_mut()
        .into_iter()
        .flatten()
        .flat_map(|run| run["delegations"].as_array_mut().into_iter().flatten())
        .find(|delegation| delegation["id"] == delegation_id)
        .context("persisted delegation")?;
    delegation["status"] = json!("queued");
    delegation
        .as_object_mut()
        .context("delegation object")?
        .remove("turnId");
    delegation["dispatchLeaseId"] = json!("expired-child-after-commit-ambiguous");
    delegation["dispatchLeaseStartedAt"] = json!("2000-01-01T00:00:00Z");
    delegation["dispatchLeaseExpiresAt"] = json!("2000-01-01T00:00:01Z");
    delegation["dispatchReceipt"] = seeded_receipt;
    delegation["dispatchReceipt"]["status"] = json!("starting");
    delegation["dispatchReceipt"]["admissionState"] = JsonValue::Null;
    delegation["dispatchReceipt"]["turnId"] = JsonValue::Null;
    delegation["dispatchReceipt"]["lastError"] = JsonValue::Null;
    tokio::fs::write(&office_path, serde_json::to_vec_pretty(&office)?).await?;

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
        .context("exact scheduler intent")?;
    intent["status"] = json!("dispatching");
    intent["leaseId"] = json!("expired-scheduler-after-commit-ambiguous");
    intent["leaseStartedAt"] = json!("2000-01-01T00:00:00Z");
    intent["leaseExpiresAt"] = json!("2000-01-01T00:00:01Z");
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
    tokio::fs::write(&scheduler_path, serde_json::to_vec_pretty(&scheduler)?).await?;

    let recovery_server = create_mock_responses_server_sequence_unchecked(vec![
        create_final_assistant_message_sse_response("Recovered exactly once.")?,
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
    let (recovered_office, recovered_scheduler) =
        timeout(TIMEOUT, async {
            loop {
                let office: JsonValue = serde_json::from_slice(
                    &tokio::fs::read(&office_path)
                        .await
                        .expect("read recovered Office"),
                )
                .expect("parse recovered Office");
                let scheduler: JsonValue = serde_json::from_slice(
                    &tokio::fs::read(&scheduler_path)
                        .await
                        .expect("read recovered scheduler"),
                )
                .expect("parse recovered scheduler");
                let receipt = &office["config"]["workspace"]["activity"]["runs"][0]["delegations"]
                    [0]["dispatchReceipt"];
                let dispatched = scheduler["intents"].as_array().is_some_and(|intents| {
                    intents.iter().any(|intent| {
                        intent["intentId"] == intent_id && intent["status"] == "dispatched"
                    })
                });
                if receipt["status"] == "admitted"
                    && office["config"]["workspace"]["activity"]["runs"][0]["delegations"][0]
                        ["status"]
                        == "completed"
                    && dispatched
                {
                    break (office, scheduler);
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await?;
    let receipt = &recovered_office["config"]["workspace"]["activity"]["runs"][0]["delegations"][0]
        ["dispatchReceipt"];
    let recovered_turn_id = receipt["turnId"]
        .as_str()
        .context("recovered turn id")?
        .to_string();
    let recovered_admission_state = receipt["admissionState"].clone();
    assert_eq!(receipt["status"], "admitted");
    assert_eq!(receipt["clientUserMessageId"], client_id);
    assert_eq!(receipt["reserveCount"], 2);
    let recovered_intent = recovered_scheduler["intents"]
        .as_array()
        .and_then(|intents| {
            intents
                .iter()
                .find(|intent| intent["intentId"] == intent_id)
        })
        .context("recovered scheduler intent")?;
    assert_eq!(recovered_intent["status"], "dispatched");
    assert_eq!(recovered_intent["dispatchedThreadId"], member_thread.id);
    assert_eq!(recovered_intent["dispatchedTurnId"], recovered_turn_id);
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
                                    && completed.turn.id == recovered_turn_id
                            })
                    })
            },
        ),
    )
    .await??;
    let turns = member_turns(&mut restarted, &member_thread.id).await?;
    assert_eq!(
        matching_client_turns(&turns, &client_id),
        vec![recovered_turn_id]
    );
    let requests_after_first = recovery_server
        .received_requests()
        .await
        .unwrap_or_default();
    assert_eq!(exact_task_request_count(&requests_after_first), 1);
    restarted.shutdown().await?;
    let rollout_after_first = read_nonempty(&member_rollout_path).await?;
    assert_eq!(
        marker_phase_counts(&rollout_after_first, &client_id),
        (1, 1)
    );
    let office_after_first = tokio::fs::read(&office_path).await?;
    let scheduler_after_first = tokio::fs::read(&scheduler_path).await?;
    let mut restarted_again = TestAppServer::new(codex_home.path()).await?;
    timeout(TIMEOUT, restarted_again.initialize()).await??;
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(tokio::fs::read(&office_path).await?, office_after_first);
    assert_eq!(
        tokio::fs::read(&scheduler_path).await?,
        scheduler_after_first
    );
    assert_eq!(
        read_nonempty(&member_rollout_path).await?,
        rollout_after_first
    );
    assert_eq!(
        matching_client_turns(
            &member_turns(&mut restarted_again, &member_thread.id).await?,
            &client_id
        ),
        vec![
            receipt["turnId"]
                .as_str()
                .context("stable turn id")?
                .to_string()
        ]
    );
    let requests_after_second = recovery_server
        .received_requests()
        .await
        .unwrap_or_default();
    assert_eq!(requests_after_second.len(), requests_after_first.len());
    assert_eq!(exact_task_request_count(&requests_after_second), 1);
    assert_eq!(run.run_id, receipt["runId"]);
    assert_eq!(recovered_admission_state, "admissionOnly");
    Ok(())
}
