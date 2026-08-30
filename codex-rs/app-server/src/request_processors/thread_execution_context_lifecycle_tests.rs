use crewon_app_server_protocol::ThreadExecutionContext;
use crewon_app_server_protocol::ThreadExecutionContextBindingRef;
use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_protocol::ThreadId;
use crewon_protocol::protocol::EventMsg;
use crewon_protocol::protocol::RolloutItem;
use crewon_protocol::protocol::ThreadMemoryMode;
use crewon_protocol::protocol::TurnCompleteEvent;
use crewon_protocol::protocol::TurnStartedEvent;
use crewon_protocol::protocol::UserMessageEvent;
use crewon_thread_store::InMemoryThreadStore;
use crewon_thread_store::ResumeThreadParams;
use crewon_thread_store::ThreadPersistenceMetadata;
use crewon_thread_store::ThreadStore;
use pretty_assertions::assert_eq;

use super::ensure_local_core_turn_route;
use super::thread_has_core_turns;

#[tokio::test]
async fn core_turn_probe_ignores_empty_history_and_detects_user_turns() {
    let store = InMemoryThreadStore::for_id("thread-execution-context-lifecycle");
    let empty_thread = ThreadId::from_string("019f550e-ba52-7490-a248-b0d3a84103c1")
        .expect("valid empty Thread id");
    store
        .resume_thread(resume_params(empty_thread, Vec::new()))
        .await
        .expect("seed empty Thread history");
    assert!(
        !thread_has_core_turns(store.as_ref(), empty_thread)
            .await
            .expect("probe empty Thread history")
    );

    let local_thread = ThreadId::from_string("019f550e-ba52-7490-a248-b0d3a84103c2")
        .expect("valid local Thread id");
    store
        .resume_thread(resume_params(
            local_thread,
            vec![
                RolloutItem::EventMsg(EventMsg::TurnStarted(TurnStartedEvent {
                    turn_id: "turn-local-1".to_string(),
                    trace_id: None,
                    started_at: Some(100),
                    model_context_window: None,
                    collaboration_mode_kind: Default::default(),
                })),
                RolloutItem::EventMsg(EventMsg::UserMessage(UserMessageEvent {
                    client_id: Some("user-message-1".to_string()),
                    message: "local turn".to_string(),
                    images: None,
                    image_details: Vec::new(),
                    local_images: Vec::new(),
                    local_image_details: Vec::new(),
                    text_elements: Vec::new(),
                })),
                RolloutItem::EventMsg(EventMsg::TurnComplete(TurnCompleteEvent {
                    turn_id: "turn-local-1".to_string(),
                    last_agent_message: Some("done".to_string()),
                    completed_at: Some(101),
                    duration_ms: Some(1_000),
                    time_to_first_token_ms: Some(100),
                })),
            ],
        ))
        .await
        .expect("seed local Thread history");
    assert!(
        thread_has_core_turns(store.as_ref(), local_thread)
            .await
            .expect("probe local Thread history")
    );
}

#[test]
fn local_core_route_fails_closed_for_cloud_agent_context() {
    let mut context = execution_context();
    assert_eq!(ensure_local_core_turn_route(&context), Ok(()));
    context.execution_binding = context.resource_bindings.first().cloned();
    assert_eq!(
        ensure_local_core_turn_route(&context)
            .expect_err("Cloud Agent context must not fall back to local Core")
            .message,
        "Cloud Agent execution requires the durable Cloud Agent coordinator"
    );
}

fn resume_params(thread_id: ThreadId, history: Vec<RolloutItem>) -> ResumeThreadParams {
    ResumeThreadParams {
        thread_id,
        rollout_path: None,
        history: Some(history),
        include_archived: true,
        metadata: ThreadPersistenceMetadata {
            cwd: None,
            model_provider: "test".to_string(),
            memory_mode: ThreadMemoryMode::Enabled,
        },
    }
}

fn execution_context() -> ThreadExecutionContext {
    let binding = ThreadExecutionContextBindingRef {
        binding_id: "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301".to_string(),
        revision: 1,
    };
    ThreadExecutionContext {
        thread_id: "019f550e-ba52-7490-a248-b0d3a84103c1".to_string(),
        workspace: WorkspaceRef {
            workspace_key: "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c201".to_string(),
            binding_id: "binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c201".to_string(),
            scope: WorkspaceScope::Conversation,
            scope_id: "019f550e-ba52-7490-a248-b0d3a84103c1".to_string(),
            node_id: "node-1".to_string(),
            environment_id: "local".to_string(),
        },
        resource_bindings: vec![binding],
        execution_binding: None,
        revision: 1,
        created_at: 100,
        updated_at: 100,
    }
}
