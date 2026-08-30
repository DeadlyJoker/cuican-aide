use crewon_core::ExistingUserInputOncePolicy;
use crewon_core::SubmitUserInputOnceError;
use crewon_core::SubmitUserInputOnceRequest;
use crewon_core::TurnContextPrecondition;
use crewon_core::UserInputOnceState;
use crewon_protocol::error::CodexErr;
use thiserror::Error;

use super::*;

pub(crate) struct OfficeDurableTurnParams {
    pub(crate) thread_id: String,
    pub(crate) client_id: String,
    pub(crate) payload_hash: String,
    pub(crate) prompt: String,
    pub(crate) expected_cwd: AbsolutePathBuf,
    pub(crate) existing_policy: ExistingUserInputOncePolicy,
}

pub(crate) struct OfficeDurableTurnOutcome {
    pub(crate) turn: Turn,
    pub(crate) already_accepted: bool,
    pub(crate) state: UserInputOnceState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OfficeAutoDelegationAdmissionMode {
    Legacy,
    Durable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OfficeDurableAdmissionCertainty {
    NotAdmitted,
    Ambiguous,
    Conflict,
}

#[derive(Debug, Error)]
pub(crate) enum OfficeDurableTurnError {
    #[error("Office durable turn preflight failed")]
    Preflight(JSONRPCErrorError),
    #[error("Office durable admission is disabled")]
    Disabled,
    #[error("invalid Office durable admission: {0}")]
    Invalid(&'static str),
    #[error("Office durable identity conflicts with turn `{turn_id}`")]
    Conflict { turn_id: String },
    #[error("Office durable identity collides with legacy history")]
    Legacy,
    #[error("existing Office durable turn `{turn_id}` is temporarily blocked by another turn")]
    ExistingAdmissionBusy { turn_id: String },
    #[error("Office durable turn `{turn_id}` crossed its execution fence but did not start")]
    ExecutionStartLost { turn_id: String },
    #[error("Office durable admission persistence failed")]
    Persistence(String),
    #[error("Office durable turn cwd precondition failed")]
    TurnContextPreconditionFailed {
        expected_cwd: AbsolutePathBuf,
        actual_cwd: AbsolutePathBuf,
    },
    #[error("Office durable admission failed")]
    Core(CodexErr),
}

impl OfficeDurableTurnError {
    pub(crate) fn certainty(&self) -> OfficeDurableAdmissionCertainty {
        match self {
            Self::Preflight(_)
            | Self::Disabled
            | Self::Invalid(_)
            | Self::TurnContextPreconditionFailed { .. } => {
                OfficeDurableAdmissionCertainty::NotAdmitted
            }
            Self::ExistingAdmissionBusy { .. }
            | Self::ExecutionStartLost { .. }
            | Self::Persistence(_)
            | Self::Core(_) => OfficeDurableAdmissionCertainty::Ambiguous,
            Self::Conflict { .. } | Self::Legacy => OfficeDurableAdmissionCertainty::Conflict,
        }
    }
}

impl TurnRequestProcessor {
    pub(crate) async fn is_exact_turn_active_in_current_runtime(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<bool, JSONRPCErrorError> {
        let thread_id = ThreadId::from_string(thread_id)
            .map_err(|error| invalid_request(format!("invalid thread id: {error}")))?;
        match self.thread_manager.get_thread(thread_id).await {
            Ok(thread) => Ok(thread.is_exact_turn_active(turn_id).await),
            Err(CodexErr::ThreadNotFound(_)) => Ok(false),
            Err(error) => Err(internal_error(format!(
                "failed to inspect active Office runtime thread {thread_id}: {error}"
            ))),
        }
    }

    pub(crate) async fn resolve_office_auto_delegation_admission_mode(
        &self,
        thread_id: &str,
    ) -> Result<OfficeAutoDelegationAdmissionMode, OfficeDurableTurnError> {
        let (_, thread) = self
            .load_thread(thread_id)
            .await
            .map_err(OfficeDurableTurnError::Preflight)?;
        resolve_admission_mode(
            thread.enabled(Feature::OfficeAutoDelegationDurableAdmission),
            thread.enabled(Feature::UserInputOnce),
        )
    }

    pub(crate) async fn start_office_durable_turn(
        &self,
        request_id: &ConnectionRequestId,
        params: OfficeDurableTurnParams,
    ) -> Result<OfficeDurableTurnOutcome, OfficeDurableTurnError> {
        let OfficeDurableTurnParams {
            thread_id,
            client_id,
            payload_hash,
            prompt,
            expected_cwd,
            existing_policy,
        } = params;
        let (_, thread) = self
            .load_thread(&thread_id)
            .await
            .map_err(OfficeDurableTurnError::Preflight)?;
        super::super::cloud_agent_thread_source_fence::ensure_loaded_thread_mutation_allowed(
            thread.as_ref(),
            "office/durable-turn",
        )
        .await
        .map_err(OfficeDurableTurnError::Preflight)?;
        self.ensure_direct_input_allowed(request_id, thread.as_ref())
            .await
            .map_err(OfficeDurableTurnError::Preflight)?;

        let input = vec![V2UserInput::Text {
            text: prompt,
            text_elements: Vec::new(),
        }];
        Self::validate_v2_input_limit(&input).map_err(OfficeDurableTurnError::Preflight)?;
        let items = input.into_iter().map(V2UserInput::into_core).collect();
        let admission = thread
            .submit_user_input_once_with_existing_policy(
                build_admission_request(client_id, payload_hash, items, expected_cwd),
                existing_policy,
            )
            .await
            .map_err(map_admission_error)?;

        Ok(OfficeDurableTurnOutcome {
            turn: Turn {
                id: admission.turn_id,
                items: Vec::new(),
                items_view: TurnItemsView::NotLoaded,
                error: None,
                status: TurnStatus::InProgress,
                started_at: None,
                completed_at: None,
                duration_ms: None,
            },
            already_accepted: admission.already_accepted,
            state: admission.state,
        })
    }
}

fn resolve_admission_mode(
    durable_admission_enabled: bool,
    user_input_once_enabled: bool,
) -> Result<OfficeAutoDelegationAdmissionMode, OfficeDurableTurnError> {
    match (durable_admission_enabled, user_input_once_enabled) {
        (false, _) => Ok(OfficeAutoDelegationAdmissionMode::Legacy),
        (true, false) => Err(OfficeDurableTurnError::Disabled),
        (true, true) => Ok(OfficeAutoDelegationAdmissionMode::Durable),
    }
}

fn build_admission_request(
    client_id: String,
    payload_hash: String,
    items: Vec<crewon_protocol::user_input::UserInput>,
    expected_cwd: AbsolutePathBuf,
) -> SubmitUserInputOnceRequest {
    SubmitUserInputOnceRequest {
        op: Op::UserInput {
            items,
            final_output_json_schema: None,
            responsesapi_client_metadata: None,
            additional_context: Default::default(),
            thread_settings: Default::default(),
        },
        client_id,
        payload_hash,
        turn_context_precondition: TurnContextPrecondition::CwdEquals(expected_cwd),
    }
}

fn map_admission_error(error: SubmitUserInputOnceError) -> OfficeDurableTurnError {
    match error {
        SubmitUserInputOnceError::Disabled => OfficeDurableTurnError::Disabled,
        SubmitUserInputOnceError::Invalid(message) => OfficeDurableTurnError::Invalid(message),
        SubmitUserInputOnceError::Conflict { turn_id } => {
            OfficeDurableTurnError::Conflict { turn_id }
        }
        SubmitUserInputOnceError::Legacy => OfficeDurableTurnError::Legacy,
        SubmitUserInputOnceError::ExistingAdmissionBusy { turn_id } => {
            OfficeDurableTurnError::ExistingAdmissionBusy { turn_id }
        }
        SubmitUserInputOnceError::ExecutionStartLost { turn_id } => {
            OfficeDurableTurnError::ExecutionStartLost { turn_id }
        }
        SubmitUserInputOnceError::Persistence(message) => {
            OfficeDurableTurnError::Persistence(message)
        }
        SubmitUserInputOnceError::TurnContextPreconditionFailed {
            expected_cwd,
            actual_cwd,
        } => OfficeDurableTurnError::TurnContextPreconditionFailed {
            expected_cwd,
            actual_cwd,
        },
        SubmitUserInputOnceError::Core(error) => OfficeDurableTurnError::Core(error),
    }
}

#[cfg(test)]
#[path = "office_durable_tests.rs"]
mod tests;
