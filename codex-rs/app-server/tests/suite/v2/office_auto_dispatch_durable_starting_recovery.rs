use std::collections::BTreeMap;
use std::time::Duration;

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
use crewon_features::Feature;
use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;
use tempfile::TempDir;
use tokio::time::timeout;

const TIMEOUT: Duration = Duration::from_secs(30);
const EXACT_DELEGATED_TASK: &str = "Recover this exact durable checklist sentinel";

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
async fn starting_receipt_restart_recovers_original_durable_turn_without_replay() -> Result<()> {
    let manager_message = format!(
        r#"Plan ready.
```json
{{
  "officeUpdate": {{
    "summary": "Prepared a crash-window recovery delegation.",
    "delegations": [
      {{
        "member": "Engineer",
        "agentId": "agent-engineer",
        "task": "{EXACT_DELEGATED_TASK}",
        "status": "pending",
        "dispatchMode": "auto",
        "riskSeverity": "low",
        "approvalRequired": false
      }}
    ]
  }}
}}
```"#
    );
    let server = create_mock_responses_server_sequence_unchecked(vec![
        create_final_assistant_message_sse_response(&manager_message)?,
        create_final_assistant_message_sse_response("This response must not be replayed.")?,
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
            "title": "Durable Starting Recovery Office",
            "subtitle": null,
            "threadId": office_thread.id,
            "goal": "Recover an admitted dispatch after the receipt commit crash window"
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
                "text": "Prepare one recoverable work item",
                "kind": "message"
            },
            "text": "Prepare one recoverable work item",
            "locale": "en",
            "threadId": null,
            "clientUserMessageId": "durable-recovery-manager-message"
        }),
    )
    .await?;
    let admitted: OfficeRunUpdatedNotification = serde_json::from_value(
        timeout(
            TIMEOUT,
            app.read_stream_until_matching_notification(
                "initial durable delegation admitted",
                |notification| {
                    notification.method == "office/run/updated"
                        && notification.params.as_ref().is_some_and(|params| {
                            serde_json::from_value::<OfficeRunUpdatedNotification>(params.clone())
                                .is_ok_and(|update| update.reason == "autoDispatchAdmitted")
                        })
                },
            ),
        )
        .await??
        .params
        .expect("office/run/updated params"),
    )?;
    let delegation = &admitted.config["workspace"]["activity"]["runs"][0]["delegations"][0];
    let original_turn_id = delegation["turnId"]
        .as_str()
        .expect("initial durable turn id")
        .to_string();
    let receipt = delegation["dispatchReceipt"]
        .as_object()
        .expect("initial durable receipt");
    let client_id = receipt["clientUserMessageId"]
        .as_str()
        .expect("durable receipt client identity")
        .to_string();
    assert_eq!(receipt["turnId"], original_turn_id);
    assert_eq!(receipt["reserveCount"], 1);

    let initial_turns = timeout(TIMEOUT, async {
        loop {
            let turns: ThreadTurnsListResponse = request(
                &mut app,
                "thread/turns/list",
                json!({
                    "threadId": member_thread.id,
                    "cursor": null,
                    "limit": 20,
                    "sortDirection": "asc",
                    "itemsView": "full"
                }),
            )
            .await
            .expect("read initial member transcript");
            if !matching_client_turns(&turns, &client_id).is_empty() {
                break turns;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await?;
    assert_eq!(
        matching_client_turns(&initial_turns, &client_id),
        vec![original_turn_id.clone()]
    );
    timeout(TIMEOUT, async {
        loop {
            let requests = server.received_requests().await.unwrap_or_default();
            if requests.iter().any(|request| {
                request
                    .body_json::<JsonValue>()
                    .is_ok_and(|body| body.to_string().contains(EXACT_DELEGATED_TASK))
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await?;

    app.shutdown().await?;

    let office_path = std::path::PathBuf::from(&admitted.file_path);
    let mut office_record: JsonValue =
        serde_json::from_slice(&tokio::fs::read(&office_path).await?)?;
    let delegation =
        &mut office_record["config"]["workspace"]["activity"]["runs"][0]["delegations"][0];
    delegation
        .as_object_mut()
        .expect("persisted delegation")
        .remove("turnId");
    delegation["status"] = json!("queued");
    delegation["dispatchLeaseId"] = json!("office-child-dispatch-expired-crash-window");
    delegation["dispatchLeaseStartedAt"] = json!("2020-01-01T00:00:00Z");
    delegation["dispatchLeaseExpiresAt"] = json!("2020-01-01T00:02:00Z");
    delegation["dispatchReceipt"]["status"] = json!("starting");
    delegation["dispatchReceipt"]["admissionState"] = JsonValue::Null;
    delegation["dispatchReceipt"]["turnId"] = JsonValue::Null;
    delegation["dispatchReceipt"]["lastError"] = JsonValue::Null;
    tokio::fs::write(&office_path, serde_json::to_vec_pretty(&office_record)?).await?;

    let scheduler_path = workspace
        .path()
        .join(".crewon")
        .join("office-runs")
        .join("scheduler.json");
    let mut scheduler: JsonValue =
        serde_json::from_slice(&tokio::fs::read(&scheduler_path).await?)?;
    let intent = scheduler["intents"]
        .as_array_mut()
        .expect("scheduler intents")
        .iter_mut()
        .find(|intent| intent["sourceTurnId"] == run.turn.id)
        .expect("exact scheduler intent");
    intent["status"] = json!("dispatching");
    intent["leaseId"] = json!("office-scheduler-expired-crash-window");
    intent["leaseStartedAt"] = json!("2020-01-01T00:00:00Z");
    intent["leaseExpiresAt"] = json!("2020-01-01T00:02:00Z");
    let intent = intent.as_object_mut().expect("scheduler intent object");
    for field in [
        "runId",
        "dispatchKind",
        "delegationId",
        "verificationCheckId",
        "filePath",
        "dispatchedThreadId",
        "dispatchedTurnId",
    ] {
        intent.remove(field);
    }
    tokio::fs::write(&scheduler_path, serde_json::to_vec_pretty(&scheduler)?).await?;

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
                        intent["sourceTurnId"] == run.turn.id && intent["status"] == "dispatched"
                    })
                });
                if receipt["status"] == "admitted"
                    && receipt["admissionState"] == "persisted"
                    && dispatched
                {
                    break (office, scheduler);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await?;

    let recovered_delegation =
        &recovered_office["config"]["workspace"]["activity"]["runs"][0]["delegations"][0];
    let recovered_receipt = &recovered_delegation["dispatchReceipt"];
    assert_eq!(recovered_delegation["turnId"], original_turn_id);
    assert_eq!(recovered_receipt["turnId"], original_turn_id);
    assert_eq!(recovered_receipt["clientUserMessageId"], client_id);
    assert_eq!(recovered_receipt["status"], "admitted");
    assert_eq!(recovered_receipt["admissionState"], "persisted");
    assert_eq!(recovered_receipt["reserveCount"], 2);
    for field in [
        "dispatchLeaseId",
        "dispatchLeaseStartedAt",
        "dispatchLeaseExpiresAt",
    ] {
        assert!(recovered_delegation.get(field).is_none());
    }
    let recovered_intent = recovered_scheduler["intents"]
        .as_array()
        .expect("recovered scheduler intents")
        .iter()
        .find(|intent| intent["sourceTurnId"] == run.turn.id)
        .expect("recovered exact intent");
    assert_eq!(recovered_intent["status"], "dispatched");
    assert_eq!(recovered_intent["dispatchedTurnId"], original_turn_id);
    assert_eq!(recovered_intent["dispatchedThreadId"], member_thread.id);

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
        vec![original_turn_id]
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    let exact_task_request_count = server
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .filter(|request| {
            request
                .body_json::<JsonValue>()
                .is_ok_and(|body| body.to_string().contains(EXACT_DELEGATED_TASK))
        })
        .count();
    assert_eq!(exact_task_request_count, 1);
    Ok(())
}
