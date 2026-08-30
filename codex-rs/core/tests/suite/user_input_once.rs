use anyhow::Result;
use core_test_support::responses::mount_sse_once;
use core_test_support::responses::mount_sse_sequence;
use core_test_support::responses::start_mock_server;
use core_test_support::responses::{self};
use core_test_support::skip_if_no_network;
use core_test_support::test_crewon::test_crewon;
use core_test_support::wait_for_event;
use crewon_core::ExistingUserInputOncePolicy;
use crewon_core::SubmitUserInputOnceError;
use crewon_core::SubmitUserInputOnceRequest;
use crewon_core::TurnContextPrecondition;
use crewon_core::UserInputOnceExecutionState;
use crewon_core::UserInputOnceState;
use crewon_features::Feature;
use crewon_protocol::protocol::CodexErrorInfo;
use crewon_protocol::protocol::EventMsg;
use crewon_protocol::protocol::InitialHistory;
use crewon_protocol::protocol::Op;
use crewon_protocol::protocol::RolloutItem;
use crewon_protocol::protocol::Submission;
use crewon_protocol::protocol::UserInputOnceMarker;
use crewon_protocol::protocol::UserInputOnceMarkerPhase;
use crewon_protocol::user_input::UserInput;
use crewon_rollout::RolloutRecorder;
use crewon_rollout::append_rollout_item_to_path;
use pretty_assertions::assert_eq;
const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
fn request(client_id: &str, hash: &str) -> SubmitUserInputOnceRequest {
    SubmitUserInputOnceRequest {
        op: Op::UserInput {
            items: vec![UserInput::Text {
                text: "hello".to_string(),
                text_elements: Vec::new(),
            }],
            final_output_json_schema: None,
            responsesapi_client_metadata: None,
            additional_context: Default::default(),
            thread_settings: Default::default(),
        },
        client_id: client_id.to_string(),
        payload_hash: hash.to_string(),
        turn_context_precondition: TurnContextPrecondition::Unconstrained,
    }
}
fn enable(config: &mut crewon_core::config::Config) {
    let _ = config.features.enable(Feature::UserInputOnce);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn matching_turn_cwd_precondition_starts_once() -> Result<()> {
    skip_if_no_network!(Ok(()));
    let server = start_mock_server().await;
    let mock = mount_sse_once(&server, responses::sse_completed("response-1")).await;
    let test = test_crewon().with_config(enable).build(&server).await?;
    let cwd = test.crewon.config_snapshot().await.cwd().clone();
    let mut request = request("cwd-match", HASH_A);
    request.turn_context_precondition = TurnContextPrecondition::CwdEquals(cwd);

    let outcome = test.crewon.submit_user_input_once(request).await?;
    assert!(!outcome.already_accepted);
    assert_eq!(
        outcome.execution_state,
        UserInputOnceExecutionState::Started
    );
    wait_for_event(&test.crewon, |event| {
        matches!(event, EventMsg::TurnComplete(_))
    })
    .await;
    assert_eq!(mock.requests().len(), 1);
    let rollout_path = test
        .session_configured
        .rollout_path
        .clone()
        .expect("rollout path");
    test.crewon.shutdown_and_wait().await?;
    let InitialHistory::Resumed(history) =
        RolloutRecorder::get_rollout_history(&rollout_path).await?
    else {
        panic!("expected resumed rollout history");
    };
    let marker_phases = history
        .history
        .iter()
        .filter_map(|item| match item {
            RolloutItem::UserInputOnceMarker(marker) if marker.client_id == "cwd-match" => {
                Some((marker.version, marker.phase))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        marker_phases,
        vec![
            (2, UserInputOnceMarkerPhase::Admission),
            (2, UserInputOnceMarkerPhase::ExecutionFence),
        ]
    );
    assert!(
        !mock
            .single_request()
            .body_json()
            .to_string()
            .contains("executionFence")
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cwd_mismatch_does_not_consume_the_once_identity() -> Result<()> {
    skip_if_no_network!(Ok(()));
    let server = start_mock_server().await;
    let mock = mount_sse_once(&server, responses::sse_completed("response-1")).await;
    let test = test_crewon().with_config(enable).build(&server).await?;
    let actual_cwd = test.crewon.config_snapshot().await.cwd().clone();
    let wrong_cwd = actual_cwd.join("wrong-workspace");
    let mut rejected = request("cwd-retry", HASH_A);
    rejected.turn_context_precondition = TurnContextPrecondition::CwdEquals(wrong_cwd.clone());

    assert!(matches!(
        test.crewon.submit_user_input_once(rejected).await,
        Err(SubmitUserInputOnceError::TurnContextPreconditionFailed {
            expected_cwd,
            actual_cwd: observed_cwd,
        }) if expected_cwd == wrong_cwd && observed_cwd == actual_cwd
    ));

    let mut retry = request("cwd-retry", HASH_A);
    retry.turn_context_precondition = TurnContextPrecondition::CwdEquals(actual_cwd);
    let outcome = test.crewon.submit_user_input_once(retry).await?;
    assert!(!outcome.already_accepted);
    wait_for_event(&test.crewon, |event| {
        matches!(event, EventMsg::TurnComplete(_))
    })
    .await;
    assert_eq!(mock.requests().len(), 1);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unavailable_persistence_does_not_leave_a_ghost_admission() -> Result<()> {
    skip_if_no_network!(Ok(()));
    let server = start_mock_server().await;
    let test = test_crewon()
        .with_config(|config| {
            enable(config);
            config.ephemeral = true;
        })
        .build(&server)
        .await?;

    for _ in 0..2 {
        assert!(matches!(
            test.crewon
                .submit_user_input_once(request("persistence-retry", HASH_A))
                .await,
            Err(SubmitUserInputOnceError::Persistence(message)) if message == "unavailable"
        ));
    }

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_same_identity_issues_one_model_request() -> Result<()> {
    skip_if_no_network!(Ok(()));
    let server = start_mock_server().await;
    let mock = mount_sse_once(&server, responses::sse_completed("response-1")).await;
    let test = test_crewon().with_config(enable).build(&server).await?;
    let (first, second) = tokio::join!(
        test.crewon.submit_user_input_once(request("same", HASH_A)),
        test.crewon.submit_user_input_once(request("same", HASH_A)),
    );
    let first = first?;
    let second = second?;
    assert_eq!(first.turn_id, second.turn_id);
    assert_eq!(
        usize::from(first.already_accepted) + usize::from(second.already_accepted),
        1
    );
    assert_eq!(first.state, UserInputOnceState::AdmissionOnly);
    assert_eq!(second.state, UserInputOnceState::AdmissionOnly);
    assert_eq!(first.execution_state, UserInputOnceExecutionState::Started);
    assert_eq!(second.execution_state, UserInputOnceExecutionState::Started);
    wait_for_event(&test.crewon, |event| {
        matches!(event, EventMsg::TurnComplete(_))
    })
    .await;
    test.crewon
        .submit_with_id(Submission {
            id: "regular-duplicate".to_string(),
            op: request("same", HASH_A).op,
            client_user_message_id: Some("same".to_string()),
            trace: None,
        })
        .await?;
    wait_for_event(&test.crewon, |event| {
        matches!(event, EventMsg::Error(error) if error.codex_error_info == Some(CodexErrorInfo::BadRequest))
    })
    .await;
    assert_eq!(mock.requests().len(), 1);
    Ok(())
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reused_identity_with_different_hash_conflicts() -> Result<()> {
    skip_if_no_network!(Ok(()));
    let server = start_mock_server().await;
    mount_sse_once(&server, responses::sse_completed("response-1")).await;
    let test = test_crewon().with_config(enable).build(&server).await?;
    let accepted = test
        .crewon
        .submit_user_input_once(request("same", HASH_A))
        .await?;
    let conflict = test
        .crewon
        .submit_user_input_once(request("same", HASH_B))
        .await;
    assert!(
        matches!(conflict, Err(SubmitUserInputOnceError::Conflict { turn_id }) if turn_id == accepted.turn_id)
    );
    assert_eq!(accepted.state, UserInputOnceState::AdmissionOnly);
    assert_eq!(
        accepted.execution_state,
        UserInputOnceExecutionState::Started
    );
    wait_for_event(&test.crewon, |event| {
        matches!(event, EventMsg::TurnComplete(_))
    })
    .await;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_returns_persisted_receipt_without_resubmitting() -> Result<()> {
    skip_if_no_network!(Ok(()));
    let server = start_mock_server().await;
    let mock = mount_sse_once(&server, responses::sse_completed("response-1")).await;
    let mut builder = test_crewon().with_config(enable);
    let test = builder.build(&server).await?;
    let accepted = test
        .crewon
        .submit_user_input_once(request("resume", HASH_A))
        .await?;
    wait_for_event(&test.crewon, |event| {
        matches!(event, EventMsg::TurnComplete(_))
    })
    .await;
    let rollout_path = test
        .session_configured
        .rollout_path
        .clone()
        .expect("rollout path");
    let home = test.home.clone();
    let original_cwd = test.config.cwd.clone();
    let resumed_cwd = original_cwd.join("resumed-workspace");
    std::fs::create_dir_all(resumed_cwd.as_path())?;
    test.crewon.shutdown_and_wait().await?;
    let mut resume_builder = test_crewon().with_config(move |config| {
        enable(config);
        config.cwd = resumed_cwd;
    });
    let resumed = resume_builder.resume(&server, home, rollout_path).await?;
    let mut replay = request("resume", HASH_A);
    replay.turn_context_precondition = TurnContextPrecondition::CwdEquals(original_cwd);
    let outcome = resumed.crewon.submit_user_input_once(replay).await?;
    assert_eq!(outcome.turn_id, accepted.turn_id);
    assert!(outcome.already_accepted);
    assert_eq!(outcome.state, UserInputOnceState::Persisted);
    assert_eq!(
        outcome.execution_state,
        UserInputOnceExecutionState::Started
    );
    assert_eq!(mock.requests().len(), 1);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guarded_resume_starts_exact_v2_admission_without_a_fence_once() -> Result<()> {
    skip_if_no_network!(Ok(()));
    let server = start_mock_server().await;
    let mock = mount_sse_sequence(
        &server,
        vec![
            responses::sse_completed("setup-response"),
            responses::sse_completed("guarded-response"),
        ],
    )
    .await;
    let test = test_crewon().with_config(enable).build(&server).await?;
    test.submit_turn("materialize rollout").await?;
    let rollout_path = test
        .session_configured
        .rollout_path
        .clone()
        .expect("rollout path");
    let thread_id = test.session_configured.thread_id;
    let home = test.home.clone();
    test.crewon.shutdown_and_wait().await?;
    append_rollout_item_to_path(
        &rollout_path,
        &RolloutItem::UserInputOnceMarker(UserInputOnceMarker {
            version: 2,
            phase: UserInputOnceMarkerPhase::Admission,
            thread_id,
            client_id: "guarded".to_string(),
            payload_hash: HASH_A.to_string(),
            turn_id: "guarded-turn".to_string(),
        }),
    )
    .await?;

    let resumed = test_crewon()
        .with_config(enable)
        .resume(&server, home, rollout_path)
        .await?;
    let returned = resumed
        .crewon
        .submit_user_input_once(request("guarded", HASH_A))
        .await?;
    assert_eq!(returned.turn_id, "guarded-turn");
    assert!(returned.already_accepted);
    assert_eq!(
        returned.execution_state,
        UserInputOnceExecutionState::NotStarted
    );
    assert_eq!(mock.requests().len(), 1);

    let started = resumed
        .crewon
        .submit_user_input_once_with_existing_policy(
            request("guarded", HASH_A),
            ExistingUserInputOncePolicy::StartIfNotStarted,
        )
        .await?;
    assert_eq!(started.turn_id, "guarded-turn");
    assert!(started.already_accepted);
    assert_eq!(
        started.execution_state,
        UserInputOnceExecutionState::Started
    );
    wait_for_event(&resumed.crewon, |event| {
        matches!(event, EventMsg::TurnComplete(_))
    })
    .await;

    let replay = resumed
        .crewon
        .submit_user_input_once_with_existing_policy(
            request("guarded", HASH_A),
            ExistingUserInputOncePolicy::StartIfNotStarted,
        )
        .await?;
    assert_eq!(replay.turn_id, "guarded-turn");
    assert_eq!(replay.execution_state, UserInputOnceExecutionState::Started);
    assert_eq!(mock.requests().len(), 2);
    Ok(())
}
