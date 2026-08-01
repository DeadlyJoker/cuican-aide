use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;

use anyhow::Context;
use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::create_final_assistant_message_sse_response;
use app_test_support::to_response;
use app_test_support::write_mock_responses_config_toml;
use core_test_support::responses;
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
use tokio::sync::oneshot;
use tokio::time::timeout;
use wiremock::Mock;
use wiremock::MockServer;
use wiremock::Respond;
use wiremock::ResponseTemplate;
use wiremock::matchers::method;
use wiremock::matchers::path_regex;

const TIMEOUT: Duration = Duration::from_secs(30);
const EXACT_TASK: &str = "Keep the exact durable member turn active during recovery";

struct GatedMemberResponder {
    requests: Arc<AtomicUsize>,
    manager_response: String,
    member_response: String,
    member_started: Mutex<Option<oneshot::Sender<()>>>,
    member_release: Mutex<Option<mpsc::Receiver<()>>>,
}

impl Respond for GatedMemberResponder {
    fn respond(&self, _: &wiremock::Request) -> ResponseTemplate {
        match self.requests.fetch_add(1, Ordering::SeqCst) {
            0 => responses::sse_response(self.manager_response.clone()),
            1 => {
                if let Some(started) = self
                    .member_started
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take()
                {
                    let _ = started.send(());
                }
                let release = self
                    .member_release
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take();
                match release {
                    Some(release) if release.recv().is_ok() => {
                        responses::sse_response(self.member_response.clone())
                    }
                    Some(_) | None => ResponseTemplate::new(500),
                }
            }
            request_index => panic!("unexpected model request {request_index}"),
        }
    }
}

async fn gated_model_server(
    manager_response: String,
    member_response: String,
) -> (
    MockServer,
    oneshot::Receiver<()>,
    mpsc::Sender<()>,
    Arc<AtomicUsize>,
) {
    let server = responses::start_mock_server().await;
    let requests = Arc::new(AtomicUsize::new(0));
    let (member_started_tx, member_started_rx) = oneshot::channel();
    let (member_release_tx, member_release_rx) = mpsc::channel();
    Mock::given(method("POST"))
        .and(path_regex(".*/responses$"))
        .respond_with(GatedMemberResponder {
            requests: Arc::clone(&requests),
            manager_response,
            member_response,
            member_started: Mutex::new(Some(member_started_tx)),
            member_release: Mutex::new(Some(member_release_rx)),
        })
        .expect(2)
        .mount(&server)
        .await;
    (server, member_started_rx, member_release_tx, requests)
}

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

fn exact_delegation<'a>(config: &'a JsonValue, delegation_id: &str) -> Result<&'a JsonValue> {
    config["workspace"]["activity"]["runs"]
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
        .context("exact scheduler intent")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exact_active_durable_turn_is_attached_without_replay_or_quarantine() -> Result<()> {
    let manager_message = format!(
        r#"Plan ready.
```json
{{
  "officeUpdate": {{
    "summary": "Prepared one exact active recovery delegation.",
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
    let (server, member_started, member_release, model_requests) = gated_model_server(
        create_final_assistant_message_sse_response(&manager_message)?,
        create_final_assistant_message_sse_response("Exact active member completed.")?,
    )
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
            "title": "Exact Active Durable Recovery Office",
            "subtitle": null,
            "threadId": office_thread.id,
            "goal": "Attach the exact active member without replay"
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
    let _: OfficeRunResponse = request(
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
                "text": "Prepare the exact active recovery sentinel",
                "kind": "message"
            },
            "text": "Prepare the exact active recovery sentinel",
            "locale": "en",
            "threadId": null,
            "clientUserMessageId": "exact-active-recovery-manager-message"
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
    timeout(TIMEOUT, member_started).await??;
    assert_eq!(model_requests.load(Ordering::SeqCst), 2);

    let seeded = &admitted.config["workspace"]["activity"]["runs"][0]["delegations"][0];
    let delegation_id = seeded["id"].as_str().context("delegation id")?;
    let turn_id = seeded["turnId"].as_str().context("active turn id")?;
    let receipt = &seeded["dispatchReceipt"];
    let intent_id = receipt["intentId"].as_str().context("intent id")?;
    assert_eq!(receipt["status"], "admitted");

    let office_path = Path::new(&admitted.file_path);
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
        .context("dispatched scheduler intent")?;
    intent["status"] = json!("dispatching");
    intent["leaseId"] = json!("expired-exact-active-recovery");
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

    let read: OfficeReadResponse = request(
        &mut app,
        "office/read",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "threadId": office_thread.id,
            "title": null
        }),
    )
    .await?;
    let recovered: OfficeRunUpdatedNotification = serde_json::from_value(
        timeout(
            TIMEOUT,
            app.read_stream_until_matching_notification("active recovery", |notification| {
                notification.method == "office/run/updated"
                    && notification.params.as_ref().is_some_and(|params| {
                        serde_json::from_value::<OfficeRunUpdatedNotification>(params.clone())
                            .is_ok_and(|update| update.reason == "autoDispatchRecovered")
                    })
            }),
        )
        .await??
        .params
        .context("active recovery params")?,
    )?;
    assert_eq!(
        recovered.source_thread_id.as_deref(),
        Some(member_thread.id.as_str())
    );
    assert_eq!(recovered.source_turn_id.as_deref(), Some(turn_id));
    let record = read.record.context("recovered Office record")?;
    let recovered_delegation = exact_delegation(&record.config, delegation_id)?;
    assert_eq!(
        recovered_delegation["dispatchReceipt"]["status"],
        "admitted"
    );
    assert_eq!(recovered_delegation["dispatchReceipt"]["turnId"], turn_id);
    assert_eq!(tokio::fs::read(office_path).await?, office_before);

    let scheduler_after: JsonValue =
        serde_json::from_slice(&tokio::fs::read(&scheduler_path).await?)?;
    let recovered_intent = exact_intent(&scheduler_after, intent_id)?;
    assert_eq!(recovered_intent["status"], "dispatched");
    assert_eq!(recovered_intent["dispatchedThreadId"], member_thread.id);
    assert_eq!(recovered_intent["dispatchedTurnId"], turn_id);
    assert_eq!(model_requests.load(Ordering::SeqCst), 2);

    member_release
        .send(())
        .context("release exact active member response")?;
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
    let completed: OfficeRunUpdatedNotification = serde_json::from_value(
        timeout(
            TIMEOUT,
            app.read_stream_until_matching_notification("Office completion", |notification| {
                notification.method == "office/run/updated"
                    && notification.params.as_ref().is_some_and(|params| {
                        serde_json::from_value::<OfficeRunUpdatedNotification>(params.clone())
                            .is_ok_and(|update| update.reason == "autoDispatchCompletion")
                    })
            }),
        )
        .await??
        .params
        .context("Office completion params")?,
    )?;
    let completed_delegation = exact_delegation(&completed.config, delegation_id)?;
    assert_eq!(completed_delegation["status"], "completed");
    assert_eq!(
        completed_delegation["dispatchReceipt"]["status"],
        "admitted"
    );
    assert_eq!(model_requests.load(Ordering::SeqCst), 2);
    let requests = server.received_requests().await.unwrap_or_default();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests
            .iter()
            .filter(|request| request
                .body_json::<JsonValue>()
                .is_ok_and(|body| { body.to_string().contains(EXACT_TASK) }))
            .count(),
        1
    );
    app.shutdown().await?;
    Ok(())
}
