use super::*;
use crate::state::ActiveTurn;
use crewon_protocol::protocol::Event;
use std::sync::Arc;

async fn reserved_session() -> (
    Arc<Session>,
    Arc<TurnContext>,
    Arc<tokio::sync::Mutex<TurnState>>,
    async_channel::Receiver<Event>,
) {
    let (session, turn_context, events) =
        crate::session::tests::make_session_and_context_with_rx().await;
    let expected = Arc::clone(
        &session
            .active_turn
            .lock()
            .await
            .get_or_insert_with(ActiveTurn::default)
            .turn_state,
    );
    (session, turn_context, expected, events)
}

#[tokio::test]
async fn reservation_mismatch_does_not_start_task() {
    let (session, turn_context, expected, _events) = reserved_session().await;
    *session.active_turn.lock().await = Some(ActiveTurn::default());
    let started = session
        .start_task_for_reservation(turn_context, Vec::new(), RegularTask::new(), expected)
        .await;
    assert!(!started);
    assert!(
        session
            .active_turn
            .lock()
            .await
            .as_ref()
            .is_some_and(|turn| turn.task.is_none())
    );
}

#[tokio::test]
async fn matching_reservation_registers_task_before_starting() {
    let (session, turn_context, expected, _events) = reserved_session().await;
    let started = session
        .start_task_for_reservation(
            turn_context,
            Vec::new(),
            RegularTask::new(),
            Arc::clone(&expected),
        )
        .await;
    assert!(started);
    assert!(
        session
            .active_turn
            .lock()
            .await
            .as_ref()
            .is_some_and(|turn| {
                turn.task.is_some() && Arc::ptr_eq(&turn.turn_state, &expected)
            })
    );
    session.abort_all_tasks(TurnAbortReason::Interrupted).await;
}

#[tokio::test]
async fn cancelled_gate_does_not_emit_turn_start() {
    let (session, turn_context, expected, events) = reserved_session().await;
    assert!(
        session
            .start_task_for_reservation(turn_context, Vec::new(), RegularTask::new(), expected,)
            .await
    );
    let cancellation_token = session
        .active_turn
        .lock()
        .await
        .as_ref()
        .and_then(|turn| turn.task.as_ref())
        .expect("running task")
        .cancellation_token
        .clone();
    cancellation_token.cancel();
    tokio::task::yield_now().await;
    assert!(
        !std::iter::from_fn(|| events.try_recv().ok())
            .any(|event| matches!(event.msg, EventMsg::TurnStarted(_)))
    );
    session.abort_all_tasks(TurnAbortReason::Interrupted).await;
}
