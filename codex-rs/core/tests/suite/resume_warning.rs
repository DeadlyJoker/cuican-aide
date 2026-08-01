#![allow(clippy::unwrap_used, clippy::expect_used)]

use core::time::Duration;
use core_test_support::load_default_config_for_test;
use core_test_support::wait_for_event;
use crewon_core::NewThread;
use crewon_core::RolloutRecorder;
use crewon_core::RolloutRecorderParams;
use crewon_login::CrewonAuth;
use crewon_protocol::ThreadId;
use crewon_protocol::config_types::ModeKind;
use crewon_protocol::config_types::ReasoningSummary;
use crewon_protocol::models::BaseInstructions;
use crewon_protocol::protocol::EventMsg;
use crewon_protocol::protocol::RolloutItem;
use crewon_protocol::protocol::SessionSource;
use crewon_protocol::protocol::TurnCompleteEvent;
use crewon_protocol::protocol::TurnContextItem;
use crewon_protocol::protocol::TurnStartedEvent;
use crewon_protocol::protocol::UserMessageEvent;
use crewon_protocol::protocol::WarningEvent;
use tempfile::TempDir;

fn resume_items(config: &crewon_core::config::Config, previous_model: &str) -> Vec<RolloutItem> {
    let turn_id = "resume-warning-seed-turn".to_string();
    let turn_ctx = TurnContextItem {
        turn_id: Some(turn_id.clone()),
        cwd: config.cwd.to_path_buf(),
        workspace_roots: None,
        current_date: None,
        timezone: None,
        approval_policy: config.permissions.approval_policy.value(),
        sandbox_policy: config.legacy_sandbox_policy(),
        permission_profile: None,
        network: None,
        file_system_sandbox_policy: None,
        model: previous_model.to_string(),
        comp_hash: None,
        personality: None,
        collaboration_mode: None,
        multi_agent_version: None,
        realtime_active: None,
        effort: config.model_reasoning_effort.clone(),
        summary: config
            .model_reasoning_summary
            .unwrap_or(ReasoningSummary::Auto),
    };

    vec![
        RolloutItem::EventMsg(EventMsg::TurnStarted(TurnStartedEvent {
            turn_id: turn_id.clone(),
            trace_id: None,
            started_at: None,
            model_context_window: None,
            collaboration_mode_kind: ModeKind::Default,
        })),
        RolloutItem::EventMsg(EventMsg::UserMessage(UserMessageEvent {
            client_id: None,
            message: "seed".to_string(),
            images: None,
            local_images: vec![],
            text_elements: vec![],
            ..Default::default()
        })),
        RolloutItem::TurnContext(turn_ctx),
        RolloutItem::EventMsg(EventMsg::TurnComplete(TurnCompleteEvent {
            turn_id,
            last_agent_message: None,
            completed_at: None,
            duration_ms: None,
            time_to_first_token_ms: None,
        })),
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn emits_warning_when_resumed_model_differs() {
    // Arrange a config with a current model and a prior rollout recorded under a different model.
    let home = TempDir::new().expect("tempdir");
    let mut config = load_default_config_for_test(&home).await;
    config.model = Some("current-model".to_string());
    // Ensure cwd is absolute (the helper sets it to the temp dir already).
    assert!(config.cwd.is_absolute());

    let conversation_id = ThreadId::new();
    let resume_items = resume_items(&config, "previous-model");
    let recorder = RolloutRecorder::new(
        &config,
        RolloutRecorderParams::new(
            conversation_id,
            /*forked_from_id*/ None,
            /*parent_thread_id*/ None,
            SessionSource::Exec,
            /*thread_source*/ None,
            BaseInstructions::default(),
            Vec::new(),
        ),
    )
    .await
    .expect("create rollout fixture");
    recorder
        .record_canonical_items(resume_items.as_slice())
        .await
        .expect("record rollout fixture");
    recorder.flush().await.expect("flush rollout fixture");
    let rollout_path = recorder.rollout_path().to_path_buf();
    recorder.shutdown().await.expect("close rollout fixture");
    let initial_history = RolloutRecorder::get_rollout_history(&rollout_path)
        .await
        .expect("reload exact rollout fixture");

    let thread_manager = crewon_core::test_support::thread_manager_with_models_provider(
        CrewonAuth::from_api_key("test"),
        config.model_provider.clone(),
    );
    let auth_manager =
        crewon_core::test_support::auth_manager_from_auth(CrewonAuth::from_api_key("test"));

    // Act: resume the conversation.
    let NewThread {
        thread: conversation,
        ..
    } = thread_manager
        .resume_thread_with_history(
            config.clone(),
            initial_history,
            auth_manager,
            /*parent_trace*/ None,
        )
        .await
        .expect("resume conversation");

    // Assert: a Warning event is emitted describing the model mismatch.
    let warning = wait_for_event(&conversation, |ev| {
        matches!(
            ev,
            EventMsg::Warning(WarningEvent { message })
                if message.contains("previous-model") && message.contains("current-model")
        )
    })
    .await;
    let EventMsg::Warning(WarningEvent { message }) = warning else {
        panic!("expected warning event");
    };
    assert!(message.contains("previous-model"));
    assert!(message.contains("current-model"));

    // Drain the TurnComplete/Shutdown window to avoid leaking tasks between tests.
    // The warning is emitted during initialization, so a short sleep is sufficient.
    tokio::time::sleep(Duration::from_millis(50)).await;
}
