use anyhow::Result;
use core_test_support::fault_thread_store::FaultThreadStore;
use core_test_support::fault_thread_store::WriterFault;
use core_test_support::responses;
use core_test_support::responses::mount_sse_once;
use core_test_support::responses::start_mock_server;
use core_test_support::skip_if_no_network;
use core_test_support::test_crewon::test_crewon;
use core_test_support::wait_for_event_with_timeout;
use crewon_core::ExistingUserInputOncePolicy;
use crewon_core::SubmitUserInputOnceError;
use crewon_core::SubmitUserInputOnceRequest;
use crewon_core::TurnContextPrecondition;
use crewon_core::UserInputOnceExecutionState;
use crewon_features::Feature;
use crewon_protocol::ThreadId;
use crewon_protocol::protocol::EventMsg;
use crewon_protocol::protocol::Op;
use crewon_protocol::protocol::RolloutItem;
use crewon_protocol::protocol::UserInputOnceMarker;
use crewon_protocol::protocol::UserInputOnceMarkerPhase;
use crewon_protocol::user_input::UserInput;
use crewon_thread_store::InMemoryThreadStore;
use crewon_thread_store::LoadThreadHistoryParams;
use crewon_thread_store::ThreadStore;
use pretty_assertions::assert_eq;
use std::sync::Arc;

const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn request(client_id: &str) -> SubmitUserInputOnceRequest {
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
        payload_hash: HASH.to_string(),
        turn_context_precondition: TurnContextPrecondition::Unconstrained,
    }
}

fn enable(config: &mut crewon_core::config::Config) {
    let _ = config.features.enable(Feature::UserInputOnce);
    config.model_provider.supports_websockets = false;
    config.model_provider.websocket_connect_timeout_ms = Some(100);
}

async fn matching_markers(
    store: &InMemoryThreadStore,
    thread_id: ThreadId,
    client_id: &str,
) -> Result<Vec<UserInputOnceMarker>> {
    Ok(store
        .load_history(LoadThreadHistoryParams {
            thread_id,
            include_archived: true,
        })
        .await?
        .items
        .into_iter()
        .filter_map(|item| match item {
            RolloutItem::UserInputOnceMarker(marker) if marker.client_id == client_id => {
                Some(marker)
            }
            _ => None,
        })
        .collect())
}

async fn response_request_count(server: &wiremock::MockServer) -> usize {
    server
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .filter(|request| request.url.path().ends_with("/responses"))
        .count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejected_admission_append_allows_same_identity_to_execute_once() -> Result<()> {
    skip_if_no_network!(Ok(()));
    let server = start_mock_server().await;
    let mock = mount_sse_once(&server, responses::sse_completed("response-1")).await;
    let store = Arc::new(InMemoryThreadStore::default());
    let fault_store = Arc::new(FaultThreadStore::new(store.clone()));
    let mut builder = test_crewon()
        .with_config(enable)
        .with_thread_store(fault_store.clone());
    let test = builder.build(&server).await?;
    fault_store
        .enqueue(WriterFault::RejectAppend(
            UserInputOnceMarkerPhase::Admission,
        ))
        .await;

    assert!(matches!(
        test.crewon
            .submit_user_input_once(request("reject-admission"))
            .await,
        Err(SubmitUserInputOnceError::Persistence(message))
            if message.contains("rejected append")
    ));
    assert_eq!(mock.requests().len(), 0);
    assert_eq!(
        matching_markers(
            &store,
            test.session_configured.thread_id,
            "reject-admission"
        )
        .await?,
        Vec::new()
    );

    let outcome = test
        .crewon
        .submit_user_input_once(request("reject-admission"))
        .await?;
    assert!(!outcome.already_accepted);
    assert_eq!(
        outcome.execution_state,
        UserInputOnceExecutionState::Started
    );
    let terminal = wait_for_event_with_timeout(
        &test.crewon,
        |event| matches!(event, EventMsg::TurnComplete(_) | EventMsg::Error(_)),
        std::time::Duration::from_secs(30),
    )
    .await;
    assert!(
        matches!(terminal, EventMsg::TurnComplete(_)),
        "{terminal:?}"
    );
    assert_eq!(mock.requests().len(), 1);
    assert_eq!(response_request_count(&server).await, 1);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn durable_admission_with_failed_flush_resumes_original_turn_once() -> Result<()> {
    skip_if_no_network!(Ok(()));
    let server = start_mock_server().await;
    let mock = mount_sse_once(&server, responses::sse_completed("response-1")).await;
    let store = Arc::new(InMemoryThreadStore::default());
    let fault_store = Arc::new(FaultThreadStore::new(store.clone()));
    let mut builder = test_crewon()
        .with_config(enable)
        .with_thread_store(fault_store.clone());
    let test = builder.build(&server).await?;
    fault_store.enqueue(WriterFault::FailFlush).await;

    assert!(matches!(
        test.crewon
            .submit_user_input_once(request("flush-admission"))
            .await,
        Err(SubmitUserInputOnceError::Persistence(message)) if message.contains("failed flush")
    ));
    assert_eq!(mock.requests().len(), 0);
    let markers =
        matching_markers(&store, test.session_configured.thread_id, "flush-admission").await?;
    let [admission] = markers.as_slice() else {
        panic!("expected one durable admission marker, got {markers:?}");
    };
    assert_eq!(admission.phase, UserInputOnceMarkerPhase::Admission);

    let outcome = test
        .crewon
        .submit_user_input_once_with_existing_policy(
            request("flush-admission"),
            ExistingUserInputOncePolicy::StartIfNotStarted,
        )
        .await?;
    assert_eq!(outcome.turn_id, admission.turn_id);
    assert!(outcome.already_accepted);
    assert_eq!(
        outcome.execution_state,
        UserInputOnceExecutionState::Started
    );
    let terminal = wait_for_event_with_timeout(
        &test.crewon,
        |event| matches!(event, EventMsg::TurnComplete(_) | EventMsg::Error(_)),
        std::time::Duration::from_secs(30),
    )
    .await;
    assert!(
        matches!(terminal, EventMsg::TurnComplete(_)),
        "{terminal:?}"
    );
    assert_eq!(mock.requests().len(), 1);
    assert_eq!(response_request_count(&server).await, 1);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn committed_fence_with_lost_ack_never_executes_twice() -> Result<()> {
    skip_if_no_network!(Ok(()));
    let server = start_mock_server().await;
    let mock = mount_sse_once(&server, responses::sse_completed("response-1")).await;
    let store = Arc::new(InMemoryThreadStore::default());
    let fault_store = Arc::new(FaultThreadStore::new(store.clone()));
    let mut builder = test_crewon()
        .with_config(enable)
        .with_thread_store(fault_store.clone());
    let test = builder.build(&server).await?;
    fault_store
        .enqueue(WriterFault::CommitAppendThenFail(
            UserInputOnceMarkerPhase::ExecutionFence,
        ))
        .await;

    assert!(matches!(
        test.crewon
            .submit_user_input_once(request("ambiguous-fence"))
            .await,
        Err(SubmitUserInputOnceError::ExecutionStartLost { .. })
    ));
    assert_eq!(mock.requests().len(), 0);
    let markers =
        matching_markers(&store, test.session_configured.thread_id, "ambiguous-fence").await?;
    assert_eq!(
        markers
            .iter()
            .map(|marker| marker.phase)
            .collect::<Vec<_>>(),
        vec![
            UserInputOnceMarkerPhase::Admission,
            UserInputOnceMarkerPhase::ExecutionFence,
        ]
    );

    let returned = test
        .crewon
        .submit_user_input_once(request("ambiguous-fence"))
        .await?;
    assert_eq!(returned.turn_id, markers[0].turn_id);
    assert_eq!(
        returned.execution_state,
        UserInputOnceExecutionState::Started
    );
    assert_eq!(mock.requests().len(), 0);

    let replay = test
        .crewon
        .submit_user_input_once_with_existing_policy(
            request("ambiguous-fence"),
            ExistingUserInputOncePolicy::StartIfNotStarted,
        )
        .await?;
    assert_eq!(replay.turn_id, markers[0].turn_id);
    assert_eq!(replay.execution_state, UserInputOnceExecutionState::Started);
    assert_eq!(mock.requests().len(), 0);
    assert_eq!(response_request_count(&server).await, 0);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn absent_admission_after_failed_flush_allows_clean_retry() -> Result<()> {
    skip_if_no_network!(Ok(()));
    let server = start_mock_server().await;
    mount_sse_once(&server, responses::sse_completed("response-1")).await;
    let store = Arc::new(InMemoryThreadStore::default());
    let fault_store = Arc::new(FaultThreadStore::new(store.clone()));
    let test = test_crewon()
        .with_config(enable)
        .with_thread_store(fault_store.clone())
        .build(&server)
        .await?;
    fault_store
        .enqueue(WriterFault::DropAppend(UserInputOnceMarkerPhase::Admission))
        .await;
    fault_store.enqueue(WriterFault::FailFlush).await;

    assert!(matches!(
        test.crewon
            .submit_user_input_once(request("absent-admission"))
            .await,
        Err(SubmitUserInputOnceError::Persistence(_))
    ));
    assert_eq!(
        matching_markers(
            &store,
            test.session_configured.thread_id,
            "absent-admission"
        )
        .await?,
        Vec::new()
    );

    let outcome = test
        .crewon
        .submit_user_input_once(request("absent-admission"))
        .await?;
    assert!(!outcome.already_accepted);
    let terminal = wait_for_event_with_timeout(
        &test.crewon,
        |event| matches!(event, EventMsg::TurnComplete(_) | EventMsg::Error(_)),
        std::time::Duration::from_secs(30),
    )
    .await;
    assert!(
        matches!(terminal, EventMsg::TurnComplete(_)),
        "{terminal:?}"
    );
    assert_eq!(response_request_count(&server).await, 1);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_admission_durability_poisoned_identity_never_executes() -> Result<()> {
    skip_if_no_network!(Ok(()));
    let server = start_mock_server().await;
    let store = Arc::new(InMemoryThreadStore::default());
    let fault_store = Arc::new(FaultThreadStore::new(store));
    let test = test_crewon()
        .with_config(enable)
        .with_thread_store(fault_store.clone())
        .build(&server)
        .await?;
    fault_store
        .enqueue(WriterFault::DropAppend(UserInputOnceMarkerPhase::Admission))
        .await;
    fault_store.enqueue(WriterFault::FailFlush).await;
    fault_store.enqueue(WriterFault::FailLoadHistory).await;

    assert!(matches!(
        test.crewon
            .submit_user_input_once(request("unknown-admission"))
            .await,
        Err(SubmitUserInputOnceError::Persistence(_))
    ));
    for policy in [
        ExistingUserInputOncePolicy::ReturnOnly,
        ExistingUserInputOncePolicy::StartIfNotStarted,
    ] {
        assert!(matches!(
            test.crewon
                .submit_user_input_once_with_existing_policy(request("unknown-admission"), policy)
                .await,
            Err(SubmitUserInputOnceError::Legacy)
        ));
    }
    assert_eq!(response_request_count(&server).await, 0);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejected_fence_append_can_be_retried_once_from_exact_admission() -> Result<()> {
    skip_if_no_network!(Ok(()));
    let server = start_mock_server().await;
    mount_sse_once(&server, responses::sse_completed("response-1")).await;
    let store = Arc::new(InMemoryThreadStore::default());
    let fault_store = Arc::new(FaultThreadStore::new(store));
    let test = test_crewon()
        .with_config(enable)
        .with_thread_store(fault_store.clone())
        .build(&server)
        .await?;
    fault_store
        .enqueue(WriterFault::RejectAppend(
            UserInputOnceMarkerPhase::ExecutionFence,
        ))
        .await;

    assert!(matches!(
        test.crewon
            .submit_user_input_once(request("reject-fence"))
            .await,
        Err(SubmitUserInputOnceError::Persistence(_))
    ));
    let outcome = test
        .crewon
        .submit_user_input_once_with_existing_policy(
            request("reject-fence"),
            ExistingUserInputOncePolicy::StartIfNotStarted,
        )
        .await?;
    assert!(outcome.already_accepted);
    let terminal = wait_for_event_with_timeout(
        &test.crewon,
        |event| matches!(event, EventMsg::TurnComplete(_) | EventMsg::Error(_)),
        std::time::Duration::from_secs(30),
    )
    .await;
    assert!(
        matches!(terminal, EventMsg::TurnComplete(_)),
        "{terminal:?}"
    );
    assert_eq!(response_request_count(&server).await, 1);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unreadable_history_after_fence_error_never_executes() -> Result<()> {
    skip_if_no_network!(Ok(()));
    let server = start_mock_server().await;
    let store = Arc::new(InMemoryThreadStore::default());
    let fault_store = Arc::new(FaultThreadStore::new(store));
    let test = test_crewon()
        .with_config(enable)
        .with_thread_store(fault_store.clone())
        .build(&server)
        .await?;
    fault_store
        .enqueue(WriterFault::CommitAppendThenFail(
            UserInputOnceMarkerPhase::ExecutionFence,
        ))
        .await;
    fault_store.enqueue(WriterFault::FailLoadHistory).await;

    assert!(matches!(
        test.crewon
            .submit_user_input_once(request("unknown-fence"))
            .await,
        Err(SubmitUserInputOnceError::Persistence(_))
    ));
    for policy in [
        ExistingUserInputOncePolicy::ReturnOnly,
        ExistingUserInputOncePolicy::StartIfNotStarted,
    ] {
        let outcome = test
            .crewon
            .submit_user_input_once_with_existing_policy(request("unknown-fence"), policy)
            .await?;
        assert_eq!(
            outcome.execution_state,
            UserInputOnceExecutionState::LegacyUnknown
        );
    }
    assert_eq!(response_request_count(&server).await, 0);
    Ok(())
}
