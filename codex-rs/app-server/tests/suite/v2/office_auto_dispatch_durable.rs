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
use crewon_app_server_protocol::ThreadSource;
use crewon_app_server_protocol::ThreadStartParams;
use crewon_app_server_protocol::ThreadStartResponse;
use crewon_features::Feature;
use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;
use tempfile::TempDir;
use tokio::time::timeout;

const TIMEOUT: Duration = Duration::from_secs(30);
const EXACT_DELEGATED_TASK: &str = "Build the durable launch checklist sentinel";

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

fn assert_sha256(value: &JsonValue) {
    assert!(value.as_str().is_some_and(|value| {
        value.len() == 64
            && value
                .chars()
                .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
    }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn office_auto_dispatch_durable_admits_exact_delegation_once() -> Result<()> {
    let manager_message = format!(
        r#"Plan ready.
```json
{{
  "officeUpdate": {{
    "summary": "Prepared one safe durable delegation.",
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
        create_final_assistant_message_sse_response("Durable checklist complete.")?,
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
            "title": "Durable Auto Dispatch Office",
            "subtitle": null,
            "threadId": office_thread.id,
            "goal": "Exercise durable automatic delegation admission"
        }),
    )
    .await?;
    let record_id = created.config["workspace"]["recordId"]
        .as_str()
        .expect("created Office record id")
        .to_string();
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
                "text": "Prepare one safe launch work item",
                "kind": "message"
            },
            "text": "Prepare one safe launch work item",
            "locale": "en",
            "threadId": null,
            "clientUserMessageId": "durable-office-manager-message"
        }),
    )
    .await?;

    let admitted: OfficeRunUpdatedNotification = serde_json::from_value(
        timeout(
            TIMEOUT,
            app.read_stream_until_matching_notification(
                "durable Office delegation admitted",
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
                        .is_some_and(|update| update.reason == "autoDispatchAdmitted")
                },
            ),
        )
        .await??
        .params
        .expect("office/run/updated params must be present"),
    )?;
    assert_eq!(admitted.reason, "autoDispatchAdmitted");
    assert_eq!(
        admitted.source_thread_id.as_deref(),
        Some(member_thread.id.as_str())
    );
    let run_record = &admitted.config["workspace"]["activity"]["runs"][0];
    let delegation = &run_record["delegations"][0];
    let delegation_id = delegation["id"].as_str().expect("durable delegation id");
    let turn_id = delegation["turnId"]
        .as_str()
        .expect("durably admitted turn id");
    assert_eq!(delegation["status"], "queued");
    assert_eq!(delegation["threadId"], member_thread.id);
    assert_eq!(admitted.source_turn_id.as_deref(), Some(turn_id));
    for lease_field in [
        "dispatchLeaseId",
        "dispatchLeaseStartedAt",
        "dispatchLeaseExpiresAt",
    ] {
        assert!(delegation.get(lease_field).is_none());
    }

    let receipt = delegation["dispatchReceipt"]
        .as_object()
        .expect("durable dispatch receipt");
    assert_eq!(
        receipt["authority"],
        "crewon.app-server.office-dispatch-receipt/v1"
    );
    assert_eq!(receipt["version"], 1);
    assert_eq!(receipt["recordId"], record_id);
    assert_eq!(receipt["sourceThreadId"], office_thread.id);
    assert_eq!(receipt["sourceTurnId"], run.turn.id);
    assert_eq!(receipt["runId"], run.run_id);
    assert_eq!(receipt["delegationId"], delegation_id);
    assert_eq!(receipt["targetThreadId"], member_thread.id);
    assert_eq!(receipt["dispatchKind"], "delegation");
    assert_eq!(receipt["status"], "admitted");
    assert_eq!(receipt["admissionState"], "admissionOnly");
    assert_eq!(receipt["turnId"], turn_id);
    assert_eq!(receipt["reserveCount"], 1);
    assert_eq!(receipt["lastError"], JsonValue::Null);
    assert_eq!(receipt["receiptId"], receipt["clientUserMessageId"]);
    assert!(
        receipt["intentId"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert!(
        receipt["clientUserMessageId"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert!(
        receipt["promptSnapshot"]
            .as_str()
            .is_some_and(|prompt| prompt.contains(EXACT_DELEGATED_TASK))
    );
    assert_sha256(&receipt["payloadHash"]);
    for timestamp_field in ["createdAt", "updatedAt"] {
        assert!(
            receipt[timestamp_field]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        );
    }

    let scheduler_path = workspace
        .path()
        .join(".crewon")
        .join("office-runs")
        .join("scheduler.json");
    let scheduler: JsonValue = serde_json::from_slice(&tokio::fs::read(scheduler_path).await?)?;
    let intent = scheduler["intents"]
        .as_array()
        .expect("Office scheduler intents")
        .iter()
        .find(|intent| intent["sourceTurnId"] == run.turn.id)
        .expect("durable dispatched scheduler intent");
    assert_eq!(intent["status"], "dispatched");
    assert_eq!(intent["runId"], run.run_id);
    assert_eq!(intent["delegationId"], delegation_id);
    assert_eq!(intent["dispatchedThreadId"], member_thread.id);
    assert_eq!(intent["dispatchedTurnId"], turn_id);
    assert_eq!(intent["leaseId"], JsonValue::Null);
    assert_eq!(intent["leaseStartedAt"], JsonValue::Null);
    assert_eq!(intent["leaseExpiresAt"], JsonValue::Null);

    let requests = timeout(TIMEOUT, async {
        loop {
            let requests = server.received_requests().await.unwrap_or_default();
            if requests.iter().any(|request| {
                request
                    .body_json::<JsonValue>()
                    .is_ok_and(|body| body.to_string().contains(EXACT_DELEGATED_TASK))
            }) {
                break requests;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await?;
    let exact_task_request_count = requests
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
