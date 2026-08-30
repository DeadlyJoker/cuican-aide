use std::time::Duration;

use anyhow::Context;
use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::create_final_assistant_message_sse_response;
use app_test_support::create_mock_responses_server_sequence_unchecked;
use app_test_support::create_mock_responses_server_sequence_unchecked_with_delays;
use app_test_support::create_shell_command_sse_response;
use app_test_support::to_response;
use app_test_support::write_mock_responses_config_toml_with_chatgpt_base_url;
use crewon_app_server_protocol::JSONRPCError;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::OfficeMemberAddResponse;
use crewon_app_server_protocol::OfficeMemoryListResponse;
use crewon_app_server_protocol::OfficeMessageDelivery;
use crewon_app_server_protocol::OfficeMessageSubmitResponse;
use crewon_app_server_protocol::OfficeReadResponse;
use crewon_app_server_protocol::OfficeRunSyncResponse;
use crewon_app_server_protocol::OfficeSaveResponse;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::ThreadLoadedListResponse;
use crewon_app_server_protocol::ThreadSource;
use crewon_app_server_protocol::ThreadStartParams;
use crewon_app_server_protocol::ThreadStartResponse;
use crewon_app_server_protocol::Turn;
use crewon_app_server_protocol::TurnCompletedNotification;
use crewon_app_server_protocol::TurnItemsView;
use crewon_app_server_protocol::TurnStartParams;
use crewon_app_server_protocol::TurnStartResponse;
use crewon_app_server_protocol::TurnStatus;
use crewon_app_server_protocol::UserInput;
use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;
use tempfile::TempDir;
use tokio::time::timeout;
use uuid::Uuid;

const TIMEOUT: Duration = Duration::from_secs(30);

async fn initialized_app_server(codex_home: &TempDir) -> Result<TestAppServer> {
    let mut app = TestAppServer::new(codex_home.path()).await?;
    timeout(TIMEOUT, app.initialize()).await??;
    Ok(app)
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

async fn start_thread(app: &mut TestAppServer, workspace: &TempDir) -> Result<String> {
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
    let thread_id = to_response::<ThreadStartResponse>(response)?.thread.id;
    timeout(
        TIMEOUT,
        app.read_stream_until_notification_message("thread/started"),
    )
    .await??;
    let materialize_id = app
        .send_turn_start_request(TurnStartParams {
            thread_id: thread_id.clone(),
            input: vec![UserInput::Text {
                text: "Materialize the workspace rollout".to_string(),
                text_elements: Vec::new(),
            }],
            ..Default::default()
        })
        .await?;
    let _: TurnStartResponse = to_response(
        timeout(
            TIMEOUT,
            app.read_stream_until_response_message(RequestId::Integer(materialize_id)),
        )
        .await??,
    )?;
    timeout(
        TIMEOUT,
        app.read_stream_until_notification_message("turn/completed"),
    )
    .await??;
    Ok(thread_id)
}

fn office_config(thread_id: &str) -> JsonValue {
    json!({
        "title": "Message Submit Office",
        "workspace": {
            "goal": "Exercise the Office composer containment runtime",
            "threadId": thread_id,
            "members": [],
            "messages": [],
            "tasks": [],
            "activity": { "approvals": [], "artifacts": [], "runs": [] }
        }
    })
}

async fn save_legacy_office_config(
    app: &mut TestAppServer,
    workspace: &TempDir,
    config: JsonValue,
) -> Result<OfficeSaveResponse> {
    let office_directory = workspace.path().join(".crewon").join("offices");
    tokio::fs::create_dir_all(&office_directory).await?;
    tokio::fs::write(
        office_directory.join(format!("legacy-{}.json", Uuid::now_v7())),
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "kind": "office",
            "savedAt": "2026-07-15T00:00:00.000Z",
            "config": config.clone()
        }))?,
    )
    .await?;
    request(
        app,
        "office/save",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": config
        }),
    )
    .await
}

fn submit_params(workspace: &TempDir, config: &JsonValue, id: &str, text: &str) -> JsonValue {
    json!({
        "cwd": workspace.path().to_string_lossy(),
        "config": config,
        "text": text,
        "clientUserMessageId": id,
        "locale": "en",
        "threadId": null,
        "mentions": []
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_submit_is_canonical_idempotent_and_preserved_by_ordinary_save() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(vec![
        create_final_assistant_message_sse_response("Materialized")?,
        create_final_assistant_message_sse_response("Done")?,
    ])
    .await;
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut app = initialized_app_server(&codex_home).await?;
    let thread_id = start_thread(&mut app, &workspace).await?;
    let saved = save_legacy_office_config(&mut app, &workspace, office_config(&thread_id)).await?;
    let mut params = submit_params(&workspace, &saved.config, "submit-idle-1", "Start once");
    params["config"]["workspace"]["messages"] = json!([{
        "author": "Forged client author",
        "messageId": "forged-client-message",
        "text": "Forged client message"
    }]);

    let first: OfficeMessageSubmitResponse =
        request(&mut app, "office/message/submit", params.clone()).await?;
    let (run_id, turn_id) = match &first.delivery {
        OfficeMessageDelivery::RunStarted { run_id, turn, .. } => {
            assert_eq!(turn.status, TurnStatus::InProgress);
            (run_id.clone(), turn.id.clone())
        }
        delivery => panic!("expected runStarted, got {delivery:?}"),
    };
    assert!(!first.replayed);
    assert_eq!(
        first.config["workspace"]["messages"]
            .as_array()
            .expect("messages")
            .iter()
            .filter(|message| message["clientUserMessageId"] == "submit-idle-1")
            .count(),
        1
    );
    assert_eq!(first.config["workspace"]["messages"][0]["author"], "You");
    assert_eq!(
        first.config["workspace"]["messages"][0]["text"],
        "Start once"
    );
    assert_ne!(
        first.config["workspace"]["messages"][0]["messageId"],
        "forged-client-message"
    );
    assert_eq!(
        first.config["workspace"]["activity"]["runs"][0]["id"],
        run_id
    );
    assert_eq!(
        first.config["workspace"]["activity"]["runs"][0]["turnId"],
        turn_id
    );

    timeout(
        TIMEOUT,
        app.read_stream_until_notification_message("turn/completed"),
    )
    .await??;
    let replay: OfficeMessageSubmitResponse =
        request(&mut app, "office/message/submit", params.clone()).await?;
    assert!(replay.replayed);
    assert!(matches!(
        replay.delivery,
        OfficeMessageDelivery::RunStarted { .. }
    ));
    assert_eq!(
        server.received_requests().await.unwrap_or_default().len(),
        2
    );

    let conflict_id = app
        .send_raw_request(
            "office/message/submit",
            Some(submit_params(
                &workspace,
                &saved.config,
                "submit-idle-1",
                "Different payload",
            )),
        )
        .await?;
    let conflict: JSONRPCError = timeout(
        TIMEOUT,
        app.read_stream_until_error_message(RequestId::Integer(conflict_id)),
    )
    .await??;
    assert_eq!(
        conflict
            .error
            .data
            .as_ref()
            .and_then(|data| data.get("type")),
        Some(&json!("officeMessageIdConflict"))
    );

    let mut forged = replay.config.clone();
    forged["workspace"]["messages"][0]["text"] = json!("forged text");
    let preserved: OfficeSaveResponse = request(
        &mut app,
        "office/save",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": forged
        }),
    )
    .await?;
    assert_eq!(
        preserved.config["workspace"]["messages"][0]["text"],
        "Start once"
    );
    assert_eq!(preserved.file_path, first.file_path);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn status_question_stays_conversational_without_creating_a_task() -> Result<()> {
    let manager_reply = concat!(
        "Current status: all systems are ready.\n",
        "```json\n",
        "{\"officeUpdate\":{\"summary\":\"forged summary\",",
        "\"goalUpdate\":\"forged goal\",",
        "\"tasks\":[{\"title\":\"forged task\",\"owner\":\"Team\",\"status\":\"doing\"}],",
        "\"delegations\":[{\"member\":\"Engineer\",\"agentId\":\"agent-conversation-engineer\",\"task\":\"forged work\",\"status\":\"pending\"}],",
        "\"verificationChecks\":[{\"check\":\"forged check\",\"status\":\"passed\"}],",
        "\"evidence\":[{\"summary\":\"forged evidence\",\"status\":\"verified\"}],",
        "\"memories\":[{\"scope\":\"office\",\"kind\":\"fact\",\"content\":\"forged memory\",\"status\":\"accepted\"}]}}\n",
        "```",
    );
    let server = create_mock_responses_server_sequence_unchecked(vec![
        create_final_assistant_message_sse_response("Materialized")?,
        create_final_assistant_message_sse_response(manager_reply)?,
        create_final_assistant_message_sse_response("Forged delegation should never run")?,
    ])
    .await;
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut app = initialized_app_server(&codex_home).await?;
    let thread_id = start_thread(&mut app, &workspace).await?;
    let saved = save_legacy_office_config(&mut app, &workspace, office_config(&thread_id)).await?;
    let member_added: OfficeMemberAddResponse = request(
        &mut app,
        "office/member/add",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": saved.config,
            "agentId": "agent-conversation-engineer",
            "member": {
                "name": "Engineer",
                "role": "Build",
                "status": "online"
            }
        }),
    )
    .await?;

    let submitted: OfficeMessageSubmitResponse = request(
        &mut app,
        "office/message/submit",
        submit_params(
            &workspace,
            &member_added.config,
            "submit-conversation-1",
            "What is the current status?",
        ),
    )
    .await?;
    let run_id = match &submitted.delivery {
        OfficeMessageDelivery::RunStarted { run_id, .. } => run_id.clone(),
        delivery => panic!("expected runStarted, got {delivery:?}"),
    };
    assert_eq!(
        submitted.config["workspace"]["activity"]["runs"][0]["messageIntent"],
        "conversation"
    );
    assert_eq!(
        submitted.config["workspace"]["activity"]["runs"][0]["loop"],
        json!({
            "mode": "officeConversation",
            "iteration": 1,
            "maxIterations": 1,
            "cycle": ["understand", "answer", "summarize"],
            "memoryPolicy": "disabled",
            "phase": "answer",
            "status": "responding"
        })
    );
    assert_eq!(submitted.config["workspace"]["tasks"], json!([]));

    timeout(
        TIMEOUT,
        app.read_stream_until_notification_message("turn/completed"),
    )
    .await??;
    let canonical = timeout(TIMEOUT, async {
        loop {
            let read: OfficeReadResponse = request(
                &mut app,
                "office/read",
                json!({
                    "cwd": workspace.path().to_string_lossy(),
                    "threadId": thread_id,
                    "title": null
                }),
            )
            .await?;
            let config = read.record.context("canonical Office record")?.config;
            let completed = config["workspace"]["activity"]["runs"]
                .as_array()
                .context("canonical Office runs")?
                .iter()
                .any(|run| run["id"] == run_id && run["status"] == "completed");
            let replied = config["workspace"]["messages"]
                .as_array()
                .context("canonical Office messages")?
                .iter()
                .any(|message| {
                    message["runId"] == run_id && message["event"] == "conversationSync"
                });
            if completed && replied {
                break Ok::<JsonValue, anyhow::Error>(config);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await??;

    assert_eq!(canonical["workspace"]["tasks"], json!([]));
    assert_eq!(
        canonical["workspace"]["goal"],
        "Exercise the Office composer containment runtime"
    );
    let run = &canonical["workspace"]["activity"]["runs"][0];
    assert!(run.get("delegations").is_none());
    assert!(run.get("verificationChecks").is_none());
    assert!(run.get("evidence").is_none());
    assert_eq!(
        canonical["workspace"]["activity"]["runs"][0]["loop"]["status"],
        "completed"
    );
    let reply = canonical["workspace"]["messages"]
        .as_array()
        .context("canonical Office messages")?
        .iter()
        .find(|message| message["runId"] == run_id && message["event"] == "conversationSync")
        .context("conversation reply")?;
    assert_eq!(reply["kind"], "message");
    assert_eq!(reply["author"], "Office manager");
    assert_eq!(reply["text"], "Current status: all systems are ready.");

    let memories: OfficeMemoryListResponse = request(
        &mut app,
        "office/memory/list",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": canonical,
            "status": "pending",
            "cursor": null,
            "limit": 10
        }),
    )
    .await?;
    assert_eq!(memories.data, Vec::new());

    let requests = server
        .received_requests()
        .await
        .context("read model requests")?;
    let body = requests
        .last()
        .context("conversation model request")?
        .body_json::<JsonValue>()?
        .to_string();
    assert!(body.contains("Turn classification: conversation"));
    assert!(body.contains("Office group-chat conversation contract (app-server authority)"));
    assert!(body.contains("scope__office_contract__manager_conversation_0"));
    assert!(!body.contains("Loop Engineering"));
    assert!(!body.contains("Server-authorized Automation bindings"));
    assert_eq!(requests.len(), 2);

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actionable_follow_up_promotes_and_steers_the_active_conversation() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked_with_delays(vec![
        (
            create_final_assistant_message_sse_response("Materialized")?,
            Duration::ZERO,
        ),
        (
            create_final_assistant_message_sse_response("Initial status reply")?,
            Duration::from_secs(2),
        ),
        (
            create_final_assistant_message_sse_response("Task promoted and completed")?,
            Duration::ZERO,
        ),
    ])
    .await;
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut app = initialized_app_server(&codex_home).await?;
    let thread_id = start_thread(&mut app, &workspace).await?;
    let saved = save_legacy_office_config(&mut app, &workspace, office_config(&thread_id)).await?;

    let conversation: OfficeMessageSubmitResponse = request(
        &mut app,
        "office/message/submit",
        submit_params(
            &workspace,
            &saved.config,
            "submit-promote-conversation",
            "What is the current status?",
        ),
    )
    .await?;
    let (run_id, turn_id) = match &conversation.delivery {
        OfficeMessageDelivery::RunStarted { run_id, turn, .. } => (run_id.clone(), turn.id.clone()),
        delivery => panic!("expected runStarted, got {delivery:?}"),
    };

    let promoted: OfficeMessageSubmitResponse = request(
        &mut app,
        "office/message/submit",
        submit_params(
            &workspace,
            &conversation.config,
            "submit-promote-task",
            "Please implement the fix and add tests",
        ),
    )
    .await?;
    assert_eq!(
        promoted.delivery,
        OfficeMessageDelivery::Steered {
            run_id: run_id.clone(),
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
        }
    );
    let promoted_run = promoted.config["workspace"]["activity"]["runs"]
        .as_array()
        .context("promoted Office runs")?
        .iter()
        .find(|run| run["id"] == run_id)
        .context("promoted Office run")?;
    assert_eq!(promoted_run["messageIntent"], "task");
    assert_eq!(
        promoted_run["title"],
        "Please implement the fix and add tests"
    );
    assert_eq!(promoted_run["loop"]["mode"], "officeLoopEngineering");
    assert_eq!(
        promoted_run["promotedByClientUserMessageId"],
        "submit-promote-task"
    );

    timeout(
        TIMEOUT,
        app.read_stream_until_notification_message("turn/completed"),
    )
    .await??;
    let requests = server
        .received_requests()
        .await
        .context("read model requests")?;
    assert_eq!(requests.len(), 3);
    let follow_up_body = requests[2].body_json::<JsonValue>()?.to_string();
    assert!(follow_up_body.contains("Please implement the fix and add tests"));
    assert!(follow_up_body.contains("Turn classification: task"));
    assert!(follow_up_body.contains("Office task contract (app-server authority)"));
    assert!(follow_up_body.contains("scope__office_contract__manager_task_0"));
    assert!(follow_up_body.contains(
        "active scope snapshot; this snapshot supersedes earlier values from the same scope"
    ));
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cold_idle_manager_is_loaded_before_submit_starts_run() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(vec![
        create_final_assistant_message_sse_response("Materialized")?,
        create_final_assistant_message_sse_response("Cold manager completed")?,
    ])
    .await;
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut app = initialized_app_server(&codex_home).await?;
    let thread_id = start_thread(&mut app, &workspace).await?;
    let saved = save_legacy_office_config(&mut app, &workspace, office_config(&thread_id)).await?;
    drop(app);

    let mut cold = initialized_app_server(&codex_home).await?;
    let loaded: ThreadLoadedListResponse =
        request(&mut cold, "thread/loaded/list", json!({})).await?;
    assert_eq!(
        loaded.data.iter().any(|loaded_id| loaded_id == &thread_id),
        false
    );

    let submitted: OfficeMessageSubmitResponse = request(
        &mut cold,
        "office/message/submit",
        submit_params(
            &workspace,
            &saved.config,
            "submit-cold-manager-1",
            "Start after loading the cold manager",
        ),
    )
    .await?;
    let turn_id = match submitted.delivery {
        OfficeMessageDelivery::RunStarted {
            thread_id: started_thread_id,
            turn,
            ..
        } => {
            assert_eq!(started_thread_id, thread_id);
            assert_eq!(turn.status, TurnStatus::InProgress);
            turn.id
        }
        delivery => panic!("expected runStarted, got {delivery:?}"),
    };
    let completed: TurnCompletedNotification = serde_json::from_value(
        timeout(
            TIMEOUT,
            cold.read_stream_until_notification_message("turn/completed"),
        )
        .await??
        .params
        .context("turn/completed params")?,
    )?;
    assert_eq!(completed.thread_id, thread_id);
    assert_eq!(completed.turn.id, turn_id);
    assert_eq!(completed.turn.status, TurnStatus::Completed);
    assert_eq!(
        server.received_requests().await.unwrap_or_default().len(),
        2
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cold_replay_recovers_turn_started_before_canonical_commit() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(vec![
        create_final_assistant_message_sse_response("Materialized")?,
        create_final_assistant_message_sse_response("Persisted before the crash")?,
    ])
    .await;
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut app = initialized_app_server(&codex_home).await?;
    let thread_id = start_thread(&mut app, &workspace).await?;
    let saved = save_legacy_office_config(&mut app, &workspace, office_config(&thread_id)).await?;
    let submitted: OfficeMessageSubmitResponse = request(
        &mut app,
        "office/message/submit",
        submit_params(
            &workspace,
            &saved.config,
            "submit-crash-recovery-1",
            "Recover the exact persisted turn",
        ),
    )
    .await?;
    let (run_id, turn_id) = match &submitted.delivery {
        OfficeMessageDelivery::RunStarted { run_id, turn, .. } => (run_id.clone(), turn.id.clone()),
        delivery => panic!("expected runStarted, got {delivery:?}"),
    };
    timeout(
        TIMEOUT,
        app.read_stream_until_notification_message("turn/completed"),
    )
    .await??;
    drop(app);

    let mut crash_snapshot = submitted.config.clone();
    let receipt = crash_snapshot["workspace"]["messages"]
        .as_array_mut()
        .context("canonical Office messages")?
        .iter_mut()
        .find(|message| message["clientUserMessageId"] == "submit-crash-recovery-1")
        .and_then(|message| message.get_mut("officeMessageReceipt"))
        .and_then(JsonValue::as_object_mut)
        .context("canonical Office message receipt")?;
    receipt.insert("status".to_string(), json!("dispatching"));
    receipt.insert("action".to_string(), json!("startRun"));
    receipt.insert("leaseId".to_string(), json!("expired-before-restart"));
    receipt.insert("leaseExpiresAt".to_string(), json!("2000-01-01T00:00:00Z"));
    receipt.remove("runId");
    receipt.remove("turnId");
    let run = crash_snapshot["workspace"]["activity"]["runs"]
        .as_array_mut()
        .context("canonical Office runs")?
        .iter_mut()
        .find(|run| run["id"] == run_id)
        .and_then(JsonValue::as_object_mut)
        .context("submitted Office run")?;
    run.insert("status".to_string(), json!("queued"));
    run.insert(
        "dispatchLeaseExpiresAt".to_string(),
        json!("2000-01-01T00:00:00Z"),
    );
    run.remove("turnId");
    let mut persisted_record =
        serde_json::from_slice::<JsonValue>(&tokio::fs::read(&submitted.file_path).await?)?;
    persisted_record["config"] = crash_snapshot.clone();
    let mut crash_bytes = serde_json::to_vec_pretty(&persisted_record)?;
    crash_bytes.push(b'\n');
    tokio::fs::write(&submitted.file_path, crash_bytes).await?;

    let mut cold = initialized_app_server(&codex_home).await?;
    let recovered: OfficeMessageSubmitResponse = request(
        &mut cold,
        "office/message/submit",
        submit_params(
            &workspace,
            &crash_snapshot,
            "submit-crash-recovery-1",
            "Recover the exact persisted turn",
        ),
    )
    .await?;

    assert!(recovered.replayed);
    match &recovered.delivery {
        OfficeMessageDelivery::RunStarted {
            run_id: recovered_run_id,
            thread_id: recovered_thread_id,
            turn,
        } => {
            assert_eq!(recovered_run_id, &run_id);
            assert_eq!(recovered_thread_id, &thread_id);
            assert_eq!(turn.id, turn_id);
            assert_eq!(turn.status, TurnStatus::Completed);
        }
        delivery => panic!("expected recovered runStarted, got {delivery:?}"),
    }
    assert_eq!(
        recovered.config["workspace"]["activity"]["runs"][0]["turnId"],
        turn_id
    );
    assert_eq!(
        recovered.config["workspace"]["messages"]
            .as_array()
            .context("recovered Office messages")?
            .iter()
            .find(|message| message["clientUserMessageId"] == "submit-crash-recovery-1")
            .context("recovered Office message")?["officeMessageReceipt"]["status"],
        "delivered"
    );
    assert_eq!(
        server.received_requests().await.unwrap_or_default().len(),
        2
    );

    let mut receipt_store_path = None;
    let mut entries = tokio::fs::read_dir(
        std::path::Path::new(&recovered.file_path)
            .parent()
            .context("Office record parent")?,
    )
    .await?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(".message-receipts-") && name.ends_with(".state") {
            receipt_store_path = Some(entry.path());
            break;
        }
    }
    let receipt_store_path = receipt_store_path.context("Office receipt sidecar")?;
    let mut synchronized_state = None;
    for _ in 0..200 {
        let receipt_store =
            serde_json::from_slice::<JsonValue>(&tokio::fs::read(&receipt_store_path).await?)?;
        let persisted_record =
            serde_json::from_slice::<JsonValue>(&tokio::fs::read(&recovered.file_path).await?)?;
        if receipt_store["recordRevision"]
            == persisted_record["config"]["workspace"]["recordRevision"]
        {
            synchronized_state = Some((receipt_store, persisted_record));
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let (receipt_store, persisted_record) = synchronized_state.context(
        "Office receipt sidecar did not converge to the latest canonical record revision",
    )?;
    assert_eq!(
        receipt_store["recordRevision"],
        persisted_record["config"]["workspace"]["recordRevision"]
    );
    assert_eq!(receipt_store["receipts"][0]["status"], "delivered");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_submit_steers_exact_turn_with_complete_office_context() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let server = create_mock_responses_server_sequence_unchecked(vec![
        create_final_assistant_message_sse_response("Materialized")?,
        create_shell_command_sse_response(
            vec!["sleep".to_string(), "1".to_string()],
            Some(workspace.path()),
            Some(10_000),
            "call-office-sleep",
        )?,
        create_final_assistant_message_sse_response("Finished after guidance")?,
    ])
    .await;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut app = initialized_app_server(&codex_home).await?;
    let thread_id = start_thread(&mut app, &workspace).await?;
    let mut config = office_config(&thread_id);
    config["workspace"]["members"] = json!([{
        "memberId": "member-analyst",
        "name": "Analyst",
        "role": "Evidence analyst",
        "status": "online",
        "agentId": "agent-analyst"
    }]);
    let saved = save_legacy_office_config(&mut app, &workspace, config).await?;
    let analyst_member_id = saved.config["workspace"]["members"][0]["memberId"]
        .as_str()
        .context("server-owned analyst memberId")?
        .to_string();
    let first: OfficeMessageSubmitResponse = request(
        &mut app,
        "office/message/submit",
        submit_params(
            &workspace,
            &saved.config,
            "submit-active-1",
            "Run the slow check",
        ),
    )
    .await?;
    let (run_id, turn_id) = match &first.delivery {
        OfficeMessageDelivery::RunStarted { run_id, turn, .. } => (run_id.clone(), turn.id.clone()),
        delivery => panic!("expected runStarted, got {delivery:?}"),
    };
    let mut steer_params = submit_params(
        &workspace,
        &first.config,
        "submit-active-2",
        "What is the current progress?",
    );
    steer_params["mentions"] = json!([{ "memberId": analyst_member_id }]);
    let steered: OfficeMessageSubmitResponse =
        request(&mut app, "office/message/submit", steer_params).await?;
    assert_eq!(
        steered.delivery,
        OfficeMessageDelivery::Steered {
            run_id,
            thread_id: thread_id.clone(),
            turn_id,
        }
    );

    timeout(
        TIMEOUT,
        app.read_stream_until_notification_message("turn/completed"),
    )
    .await??;
    let requests = server
        .received_requests()
        .await
        .context("read model requests")?;
    let response_requests = requests
        .iter()
        .filter(|request| request.url.path().ends_with("/responses"))
        .collect::<Vec<_>>();
    assert_eq!(response_requests.len(), 3);
    let second_body = response_requests[2].body_json::<JsonValue>()?.to_string();
    assert!(second_body.contains("What is the current progress?"));
    assert!(second_body.contains("Office task contract (app-server authority)"));
    assert!(!second_body.contains("Office group-chat conversation contract"));
    assert!(second_body.contains(&format!(
        "memberId={analyst_member_id}, name=Analyst, agentId=agent-analyst"
    )));
    for index in 0..7 {
        assert!(second_body.contains(&format!(
            "<external_scope__office__office_manager_context_{index}>"
        )));
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_mention_dispatches_and_returns_member_reply_when_manager_omits_update()
-> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(vec![
        create_final_assistant_message_sse_response("Materialized")?,
        create_final_assistant_message_sse_response(
            "I will route this request to the explicitly mentioned member.",
        )?,
        create_final_assistant_message_sse_response(
            "I am the Cloud Agent and can help with product and engineering work.",
        )?,
    ])
    .await;
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut app = initialized_app_server(&codex_home).await?;
    let thread_id = start_thread(&mut app, &workspace).await?;
    let saved = save_legacy_office_config(&mut app, &workspace, office_config(&thread_id)).await?;
    let member_added: OfficeMemberAddResponse = request(
        &mut app,
        "office/member/add",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": saved.config,
            "agentId": "cloud-agent",
            "member": {
                "name": "Cloud Agent",
                "role": "Product and engineering",
                "status": "online"
            }
        }),
    )
    .await?;
    let member_id = member_added.config["workspace"]["members"][0]["memberId"]
        .as_str()
        .context("server-owned Cloud Agent memberId")?
        .to_string();
    drop(app);
    let mut app = initialized_app_server(&codex_home).await?;
    let mut params = submit_params(
        &workspace,
        &member_added.config,
        "submit-explicit-member-1",
        "@Cloud Agent introduce yourself",
    );
    params["mentions"] = json!([{ "memberId": member_id }]);

    let submitted: OfficeMessageSubmitResponse =
        request(&mut app, "office/message/submit", params).await?;
    let run_id = match &submitted.delivery {
        OfficeMessageDelivery::RunStarted { run_id, .. } => run_id.clone(),
        delivery => panic!("expected runStarted, got {delivery:?}"),
    };

    timeout(
        TIMEOUT,
        app.read_stream_until_notification_message("turn/completed"),
    )
    .await??;
    timeout(
        TIMEOUT,
        app.read_stream_until_notification_message("turn/completed"),
    )
    .await??;
    let canonical = timeout(TIMEOUT, async {
        loop {
            let read: OfficeReadResponse = request(
                &mut app,
                "office/read",
                json!({
                    "cwd": workspace.path().to_string_lossy(),
                    "threadId": thread_id,
                    "title": null
                }),
            )
            .await?;
            let config = read.record.context("canonical Office record")?.config;
            let reply = config["workspace"]["messages"]
                .as_array()
                .context("canonical Office messages")?
                .iter()
                .find(|message| message["runId"] == run_id && message["event"] == "delegationSync")
                .cloned();
            if let Some(reply) = reply {
                break Ok::<(JsonValue, JsonValue), anyhow::Error>((config, reply));
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await??;

    assert_eq!(canonical.1["kind"], "message");
    assert_eq!(canonical.1["author"], "Cloud Agent");
    assert_eq!(
        canonical.1["text"],
        "I am the Cloud Agent and can help with product and engineering work."
    );
    assert_eq!(
        canonical.0["workspace"]["activity"]["runs"][0]["delegations"][0]["memberId"],
        member_id
    );
    assert_eq!(
        server.received_requests().await.unwrap_or_default().len(),
        3
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_active_turn_queues_and_invalid_mention_has_no_side_effect() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let server = create_mock_responses_server_sequence_unchecked(vec![
        create_final_assistant_message_sse_response("Materialized")?,
    ])
    .await;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut app = initialized_app_server(&codex_home).await?;
    let thread_id = start_thread(&mut app, &workspace).await?;
    let mut config = office_config(&thread_id);
    config["workspace"]["activity"]["runs"] = json!([{
        "id": "stale-run",
        "status": "running",
        "threadId": thread_id,
        "turnId": "stale-turn"
    }]);
    let saved = save_legacy_office_config(&mut app, &workspace, config).await?;

    let queued: OfficeMessageSubmitResponse = request(
        &mut app,
        "office/message/submit",
        submit_params(
            &workspace,
            &saved.config,
            "submit-stale-1",
            "Do not retarget",
        ),
    )
    .await?;
    assert_eq!(
        queued.delivery,
        OfficeMessageDelivery::Queued {
            after_run_id: "stale-run".to_string(),
            position: 1,
        }
    );

    let invalid_id = app
        .send_raw_request(
            "office/message/submit",
            Some(json!({
                "cwd": workspace.path().to_string_lossy(),
                "config": queued.config,
                "text": "Forged mention",
                "clientUserMessageId": "submit-invalid-mention",
                "locale": "en",
                "threadId": null,
                "mentions": [{ "memberId": "not-a-member" }]
            })),
        )
        .await?;
    let invalid: JSONRPCError = timeout(
        TIMEOUT,
        app.read_stream_until_error_message(RequestId::Integer(invalid_id)),
    )
    .await??;
    assert_eq!(
        invalid
            .error
            .data
            .as_ref()
            .and_then(|data| data.get("type")),
        Some(&json!("officeMessageMentionInvalid"))
    );
    let canonical: OfficeReadResponse = request(
        &mut app,
        "office/read",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "threadId": thread_id,
            "title": null
        }),
    )
    .await?;
    let canonical = canonical.record.context("canonical Office record")?;
    assert_eq!(
        canonical.config["workspace"]["messages"]
            .as_array()
            .context("canonical Office messages")?
            .iter()
            .any(|message| { message["clientUserMessageId"] == "submit-invalid-mention" }),
        false
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queued_messages_auto_execute_in_fifo_order_after_terminal_sync() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(vec![
        create_final_assistant_message_sse_response("Materialized")?,
        create_final_assistant_message_sse_response("First queued message completed")?,
        create_final_assistant_message_sse_response("Second queued message completed")?,
    ])
    .await;
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut app = initialized_app_server(&codex_home).await?;
    let thread_id = start_thread(&mut app, &workspace).await?;
    let mut config = office_config(&thread_id);
    config["workspace"]["activity"]["runs"] = json!([{
        "id": "blocking-run",
        "status": "running",
        "threadId": thread_id,
        "turnId": "missing-active-turn"
    }]);
    let saved = save_legacy_office_config(&mut app, &workspace, config).await?;

    let first_queued: OfficeMessageSubmitResponse = request(
        &mut app,
        "office/message/submit",
        submit_params(
            &workspace,
            &saved.config,
            "submit-queued-first",
            "Execute first after the blocker",
        ),
    )
    .await?;
    assert_eq!(
        first_queued.delivery,
        OfficeMessageDelivery::Queued {
            after_run_id: "blocking-run".to_string(),
            position: 1,
        }
    );
    let second_queued: OfficeMessageSubmitResponse = request(
        &mut app,
        "office/message/submit",
        submit_params(
            &workspace,
            &first_queued.config,
            "submit-queued-second",
            "Execute second after the blocker",
        ),
    )
    .await?;
    assert_eq!(
        second_queued.delivery,
        OfficeMessageDelivery::Queued {
            after_run_id: "blocking-run".to_string(),
            position: 2,
        }
    );

    let _: OfficeRunSyncResponse = request(
        &mut app,
        "office/run/sync",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "config": second_queued.config,
            "runId": "blocking-run",
            "turn": Turn {
                id: "missing-active-turn".to_string(),
                items: Vec::new(),
                items_view: TurnItemsView::NotLoaded,
                status: TurnStatus::Completed,
                error: None,
                started_at: None,
                completed_at: None,
                duration_ms: None,
            },
            "locale": "en"
        }),
    )
    .await?;
    timeout(
        TIMEOUT,
        app.read_stream_until_notification_message("turn/completed"),
    )
    .await??;
    timeout(
        TIMEOUT,
        app.read_stream_until_notification_message("turn/completed"),
    )
    .await??;
    let canonical: OfficeReadResponse = request(
        &mut app,
        "office/read",
        json!({
            "cwd": workspace.path().to_string_lossy(),
            "threadId": thread_id,
            "title": null
        }),
    )
    .await?;
    let config = canonical.record.context("canonical Office record")?.config;
    let messages = config["workspace"]["messages"]
        .as_array()
        .context("canonical Office messages")?;
    let delivered_ids = messages
        .iter()
        .filter_map(|message| {
            let receipt = message.get("officeMessageReceipt")?;
            (receipt.get("status").and_then(JsonValue::as_str) == Some("delivered"))
                .then(|| {
                    receipt
                        .get("clientUserMessageId")
                        .and_then(JsonValue::as_str)
                        .map(str::to_string)
                })
                .flatten()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        delivered_ids,
        vec![
            "submit-queued-first".to_string(),
            "submit-queued-second".to_string()
        ]
    );
    assert_eq!(
        server.received_requests().await.unwrap_or_default().len(),
        3
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_duplicate_submit_starts_only_one_model_turn() -> Result<()> {
    let server = create_mock_responses_server_sequence_unchecked(vec![
        create_final_assistant_message_sse_response("Materialized")?,
        create_final_assistant_message_sse_response("One turn only")?,
    ])
    .await;
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &server.uri(),
        &server.uri(),
    )?;
    let mut app = initialized_app_server(&codex_home).await?;
    let thread_id = start_thread(&mut app, &workspace).await?;
    let saved = save_legacy_office_config(&mut app, &workspace, office_config(&thread_id)).await?;
    let params = submit_params(
        &workspace,
        &saved.config,
        "submit-concurrent-1",
        "Start exactly once",
    );
    let first_id = app
        .send_raw_request("office/message/submit", Some(params.clone()))
        .await?;
    let second_id = app
        .send_raw_request("office/message/submit", Some(params))
        .await?;
    let first = to_response::<OfficeMessageSubmitResponse>(
        timeout(
            TIMEOUT,
            app.read_stream_until_response_message(RequestId::Integer(first_id)),
        )
        .await??,
    )?;
    let second = to_response::<OfficeMessageSubmitResponse>(
        timeout(
            TIMEOUT,
            app.read_stream_until_response_message(RequestId::Integer(second_id)),
        )
        .await??,
    )?;

    assert!(!first.replayed);
    assert!(second.replayed);
    assert_eq!(first.receipt_id, second.receipt_id);
    timeout(
        TIMEOUT,
        app.read_stream_until_notification_message("turn/completed"),
    )
    .await??;
    assert_eq!(
        server.received_requests().await.unwrap_or_default().len(),
        2
    );
    Ok(())
}
