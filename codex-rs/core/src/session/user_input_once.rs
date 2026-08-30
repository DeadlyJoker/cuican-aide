use std::sync::Arc;

use crewon_features::Feature;
use crewon_protocol::error::CodexErr;
use crewon_protocol::protocol::Op;
use crewon_protocol::protocol::RolloutItem;
use crewon_protocol::protocol::Submission;
use crewon_protocol::protocol::UserInputOnceMarker;
use crewon_protocol::protocol::UserInputOnceMarkerPhase;
use thiserror::Error;
use tokio::sync::oneshot;

use super::Crewon;
use super::TurnInput;
use super::session::Session;
use super::turn_context::TurnContextPrecondition;
use super::user_input_once_durable::DurableAdmissionMatch;
use super::user_input_once_durable::DurableExecutionFenceMatch;
use super::user_input_once_durable::classify_durable_admission;
use super::user_input_once_durable::classify_durable_execution_fence;
use super::user_input_once_index::EXECUTION_FENCE_VERSION;
use super::user_input_once_index::MARKER_VERSION;
use super::user_input_once_index::UserInputOnceExecutionState;
use super::user_input_once_index::UserInputOnceLookupError;
use super::user_input_once_index::UserInputOnceState;
use super::user_input_once_index::valid_client_id;
use super::user_input_once_index::valid_payload_hash;
use crate::state::ActiveTurn;
use crate::tasks::RegularTask;
pub struct SubmitUserInputOnceRequest {
    pub op: Op,
    pub client_id: String,
    pub payload_hash: String,
    pub turn_context_precondition: TurnContextPrecondition,
}
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ExistingUserInputOncePolicy {
    #[default]
    ReturnOnly,
    StartIfNotStarted,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubmitUserInputOnceOutcome {
    pub turn_id: String,
    pub already_accepted: bool,
    pub state: UserInputOnceState,
    pub execution_state: UserInputOnceExecutionState,
}
#[derive(Debug, Error)]
pub enum SubmitUserInputOnceError {
    #[error("user_input_once is disabled")]
    Disabled,
    #[error("invalid idempotent user input: {0}")]
    Invalid(&'static str),
    #[error("client id conflicts with already accepted turn `{turn_id}`")]
    Conflict { turn_id: String },
    #[error("client id exists in legacy history without an admission marker")]
    Legacy,
    #[error("existing admitted turn `{turn_id}` cannot start while another turn is active")]
    ExistingAdmissionBusy { turn_id: String },
    #[error("execution fence for admitted turn `{turn_id}` was durable but task start was lost")]
    ExecutionStartLost { turn_id: String },
    #[error("admission persistence failed: {0}")]
    Persistence(String),
    #[error("turn cwd precondition failed")]
    TurnContextPreconditionFailed {
        expected_cwd: crewon_utils_absolute_path::AbsolutePathBuf,
        actual_cwd: crewon_utils_absolute_path::AbsolutePathBuf,
    },
    #[error(transparent)]
    Core(#[from] CodexErr),
}
pub(crate) enum SessionSubmission {
    Regular(Submission),
    Once {
        submission: Submission,
        payload_hash: String,
        turn_context_precondition: TurnContextPrecondition,
        existing_policy: ExistingUserInputOncePolicy,
        reply: oneshot::Sender<Result<SubmitUserInputOnceOutcome, SubmitUserInputOnceError>>,
    },
}
impl From<Submission> for SessionSubmission {
    fn from(value: Submission) -> Self {
        Self::Regular(value)
    }
}
impl std::ops::Deref for SessionSubmission {
    type Target = Submission;
    fn deref(&self) -> &Self::Target {
        match self {
            Self::Regular(submission) | Self::Once { submission, .. } => submission,
        }
    }
}
impl Crewon {
    pub(crate) async fn submit_session(&self, value: SessionSubmission) -> Result<(), CodexErr> {
        self.tx_sub
            .send(value)
            .await
            .map_err(|_| CodexErr::InternalAgentDied)
    }
    pub(crate) async fn submit_user_input_once(
        &self,
        request: SubmitUserInputOnceRequest,
    ) -> Result<SubmitUserInputOnceOutcome, SubmitUserInputOnceError> {
        self.submit_user_input_once_with_existing_policy(
            request,
            ExistingUserInputOncePolicy::ReturnOnly,
        )
        .await
    }
    pub(crate) async fn submit_user_input_once_with_existing_policy(
        &self,
        request: SubmitUserInputOnceRequest,
        existing_policy: ExistingUserInputOncePolicy,
    ) -> Result<SubmitUserInputOnceOutcome, SubmitUserInputOnceError> {
        if !self.session.features.enabled(Feature::UserInputOnce) {
            return Err(SubmitUserInputOnceError::Disabled);
        }
        validate(&request)?;
        let (reply, response) = oneshot::channel();
        self.submit_session(SessionSubmission::Once {
            submission: Submission {
                id: uuid::Uuid::now_v7().to_string(),
                op: request.op,
                client_user_message_id: Some(request.client_id),
                trace: crewon_otel::current_span_w3c_trace_context(),
            },
            payload_hash: request.payload_hash,
            turn_context_precondition: request.turn_context_precondition,
            existing_policy,
            reply,
        })
        .await?;
        response
            .await
            .map_err(|_| SubmitUserInputOnceError::Core(CodexErr::InternalAgentDied))?
    }
}
pub(super) async fn process(
    sess: &Arc<Session>,
    submission: Submission,
    payload_hash: String,
    turn_context_precondition: TurnContextPrecondition,
    existing_policy: ExistingUserInputOncePolicy,
) -> Result<SubmitUserInputOnceOutcome, SubmitUserInputOnceError> {
    if !sess.features.enabled(Feature::UserInputOnce) {
        return Err(SubmitUserInputOnceError::Disabled);
    }
    let client_id = submission
        .client_user_message_id
        .ok_or(SubmitUserInputOnceError::Invalid("missing client id"))?;
    let existing = sess
        .user_input_once_index
        .lock()
        .await
        .lookup(&client_id, &payload_hash)
        .map_err(|error| match error {
            UserInputOnceLookupError::Legacy => SubmitUserInputOnceError::Legacy,
            UserInputOnceLookupError::Conflict { turn_id } => {
                SubmitUserInputOnceError::Conflict { turn_id }
            }
        })?;
    let resumed_receipt = existing.clone().filter(|receipt| {
        existing_policy == ExistingUserInputOncePolicy::StartIfNotStarted
            && receipt.state == UserInputOnceState::AdmissionOnly
            && receipt.execution_state == UserInputOnceExecutionState::NotStarted
    });
    if let Some(receipt) = existing
        && resumed_receipt.is_none()
    {
        return Ok(SubmitUserInputOnceOutcome {
            turn_id: receipt.turn_id,
            already_accepted: true,
            state: receipt.state,
            execution_state: receipt.execution_state,
        });
    }
    sess.services
        .agent_control
        .ensure_execution_capacity_for_op(sess.thread_id, &submission.op)
        .await?;
    let Op::UserInput {
        items,
        final_output_json_schema: _,
        responsesapi_client_metadata: _,
        additional_context: _,
        thread_settings: _,
    } = submission.op
    else {
        return Err(SubmitUserInputOnceError::Invalid(
            "operation must be user input",
        ));
    };
    let reservation = {
        let mut active = sess.active_turn.lock().await;
        if active.is_some() {
            if let Some(receipt) = resumed_receipt.as_ref() {
                return Err(SubmitUserInputOnceError::ExistingAdmissionBusy {
                    turn_id: receipt.turn_id.clone(),
                });
            }
            return Err(SubmitUserInputOnceError::Invalid("active turn is busy"));
        }
        Arc::clone(&active.get_or_insert_with(ActiveTurn::default).turn_state)
    };
    let prepared_context = match sess
        .prepare_default_turn_context(&turn_context_precondition)
        .await
    {
        Ok(prepared_context) => prepared_context,
        Err(error) => {
            release_reservation(sess, &reservation).await;
            return Err(SubmitUserInputOnceError::TurnContextPreconditionFailed {
                expected_cwd: error.expected_cwd,
                actual_cwd: error.actual_cwd,
            });
        }
    };
    let Some(live) = sess.live_thread() else {
        release_reservation(sess, &reservation).await;
        return Err(SubmitUserInputOnceError::Persistence(
            "unavailable".to_string(),
        ));
    };
    let (turn_id, already_accepted, state) = match resumed_receipt {
        Some(receipt) => (receipt.turn_id, true, receipt.state),
        None => {
            let marker = UserInputOnceMarker {
                version: MARKER_VERSION,
                phase: UserInputOnceMarkerPhase::Admission,
                thread_id: sess.thread_id,
                client_id: client_id.clone(),
                payload_hash: payload_hash.clone(),
                turn_id: submission.id.clone(),
            };
            if let Err(error) = live
                .append_items(&[RolloutItem::UserInputOnceMarker(marker.clone())])
                .await
            {
                let _ = reconcile_failed_admission_append(sess, live, &marker).await;
                release_reservation(sess, &reservation).await;
                return Err(SubmitUserInputOnceError::Persistence(error.to_string()));
            }
            if let Err(error) = live.flush().await {
                let _ = reconcile_failed_admission_append(sess, live, &marker).await;
                release_reservation(sess, &reservation).await;
                return Err(SubmitUserInputOnceError::Persistence(error.to_string()));
            }
            sess.user_input_once_index
                .lock()
                .await
                .insert(marker.clone());
            (marker.turn_id, false, UserInputOnceState::AdmissionOnly)
        }
    };
    let execution_fence = UserInputOnceMarker {
        version: EXECUTION_FENCE_VERSION,
        phase: UserInputOnceMarkerPhase::ExecutionFence,
        thread_id: sess.thread_id,
        client_id: client_id.clone(),
        payload_hash,
        turn_id: turn_id.clone(),
    };
    let fence_persistence_result = async {
        live.append_items(&[RolloutItem::UserInputOnceMarker(execution_fence.clone())])
            .await
            .map_err(|error| SubmitUserInputOnceError::Persistence(error.to_string()))?;
        live.flush()
            .await
            .map_err(|error| SubmitUserInputOnceError::Persistence(error.to_string()))
    }
    .await;
    if let Err(error) = fence_persistence_result {
        let durable_match =
            reconcile_failed_execution_fence_append(sess, live, &execution_fence).await;
        release_reservation(sess, &reservation).await;
        return if durable_match == DurableExecutionFenceMatch::Exact {
            Err(SubmitUserInputOnceError::ExecutionStartLost { turn_id })
        } else {
            Err(error)
        };
    }
    sess.user_input_once_index
        .lock()
        .await
        .insert_execution_fence(&execution_fence);
    let context = sess
        .new_prepared_default_turn_with_sub_id(turn_id.clone(), prepared_context)
        .await;
    let pending = vec![TurnInput::UserInput {
        content: items,
        client_id: Some(client_id),
    }];
    let started = sess
        .start_task_for_reservation(context, pending, RegularTask::new(), reservation)
        .await;
    if !started {
        return Err(SubmitUserInputOnceError::ExecutionStartLost { turn_id });
    }
    Ok(SubmitUserInputOnceOutcome {
        turn_id,
        already_accepted,
        state,
        execution_state: UserInputOnceExecutionState::Started,
    })
}

async fn reconcile_failed_execution_fence_append(
    sess: &Session,
    live: &crewon_thread_store::LiveThread,
    fence: &UserInputOnceMarker,
) -> DurableExecutionFenceMatch {
    let durable_match = match live.load_history(/*include_archived*/ true).await {
        Ok(history) => classify_durable_execution_fence(&history.items, fence),
        Err(_) => DurableExecutionFenceMatch::Ambiguous,
    };
    let mut index = sess.user_input_once_index.lock().await;
    match durable_match {
        DurableExecutionFenceMatch::Exact => index.insert_execution_fence(fence),
        DurableExecutionFenceMatch::Absent => {}
        DurableExecutionFenceMatch::Ambiguous => {
            index.mark_execution_ambiguous(&fence.client_id);
        }
    }
    durable_match
}

async fn reconcile_failed_admission_append(
    sess: &Session,
    live: &crewon_thread_store::LiveThread,
    marker: &UserInputOnceMarker,
) -> DurableAdmissionMatch {
    let durable_match = match live.load_history(/*include_archived*/ true).await {
        Ok(history) => classify_durable_admission(&history.items, marker),
        Err(_) => DurableAdmissionMatch::Ambiguous,
    };
    let mut index = sess.user_input_once_index.lock().await;
    match durable_match {
        DurableAdmissionMatch::Exact => index.insert(marker.clone()),
        DurableAdmissionMatch::Absent => {}
        DurableAdmissionMatch::Ambiguous => {
            index.reserve_legacy(marker.client_id.clone());
        }
    }
    durable_match
}

async fn release_reservation(
    sess: &Session,
    reservation: &Arc<tokio::sync::Mutex<crate::state::TurnState>>,
) {
    let mut active = sess.active_turn.lock().await;
    if active
        .as_ref()
        .is_some_and(|turn| turn.task.is_none() && Arc::ptr_eq(&turn.turn_state, reservation))
    {
        *active = None;
    }
}
fn validate(request: &SubmitUserInputOnceRequest) -> Result<(), SubmitUserInputOnceError> {
    let Op::UserInput {
        final_output_json_schema,
        responsesapi_client_metadata,
        additional_context,
        thread_settings,
        ..
    } = &request.op
    else {
        return Err(SubmitUserInputOnceError::Invalid(
            "operation must be user input",
        ));
    };
    if final_output_json_schema.is_some()
        || responsesapi_client_metadata.is_some()
        || !additional_context.is_empty()
        || thread_settings != &Default::default()
    {
        return Err(SubmitUserInputOnceError::Invalid(
            "unsupported user input options",
        ));
    }
    if !valid_client_id(&request.client_id) {
        return Err(SubmitUserInputOnceError::Invalid("invalid client id"));
    }
    if !valid_payload_hash(&request.payload_hash) {
        return Err(SubmitUserInputOnceError::Invalid("invalid payload hash"));
    }
    Ok(())
}
