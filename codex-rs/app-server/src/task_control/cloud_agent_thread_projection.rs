use std::fmt;
use std::sync::Arc;

#[path = "cloud_agent_thread_artifact_projection.rs"]
pub(super) mod artifact_projection;

use crewon_app_server_protocol::CodexErrorInfo;
use crewon_app_server_protocol::SortDirection;
use crewon_app_server_protocol::ThreadItem;
use crewon_app_server_protocol::ThreadStatus;
use crewon_app_server_protocol::ThreadTurnsListResponse;
use crewon_app_server_protocol::Turn;
use crewon_app_server_protocol::TurnError;
use crewon_app_server_protocol::TurnItemsView;
use crewon_app_server_protocol::TurnStatus;
use crewon_app_server_protocol::TurnsPage;
use crewon_app_server_protocol::UserInput;
use crewon_state::CloudAgentTurnPageAnchor;
use crewon_state::CloudAgentTurnPageQuery;
use crewon_state::CloudAgentTurnRecord;
use crewon_state::CloudAgentTurnSortDirection;
use crewon_state::CloudAgentTurnStatus;
use crewon_state::StateRuntime;
use serde::Deserialize;
use serde::Serialize;

use crate::platform_control::RequestIdentity;
use crate::platform_control::thread_execution_context_adapter::authorize_thread_execution_context_record;

const DEFAULT_PAGE_SIZE: u32 = 25;
const MAX_PAGE_SIZE: u32 = 100;
const MAX_READ_TURNS: usize = 512;

use artifact_projection::CloudAgentThreadArtifactProjector;

#[derive(Clone)]
pub(crate) struct CloudAgentThreadProjectionRuntime {
    state: Arc<StateRuntime>,
    identity: RequestIdentity,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CloudAgentThreadReadProjection {
    pub(crate) turns: Vec<Turn>,
    pub(crate) status: ThreadStatus,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CloudAgentThreadResumeProjection {
    pub(crate) turns: Option<Vec<Turn>>,
    pub(crate) initial_turns_page: Option<TurnsPage>,
    pub(crate) status: ThreadStatus,
}

impl CloudAgentThreadProjectionRuntime {
    pub(crate) fn new(state: Arc<StateRuntime>, identity: RequestIdentity) -> Self {
        Self { state, identity }
    }

    pub(crate) async fn read_all(
        &self,
        thread_id: &str,
        items_view: TurnItemsView,
    ) -> Result<Option<CloudAgentThreadReadProjection>, CloudAgentThreadProjectionError> {
        let Some(context) = self.authorized_cloud_context(thread_id).await? else {
            return Ok(None);
        };
        let mut turns = Vec::new();
        let mut anchor = None;
        loop {
            let remaining_with_probe = MAX_READ_TURNS.saturating_add(1).saturating_sub(turns.len());
            if remaining_with_probe == 0 {
                return Err(CloudAgentThreadProjectionError::CapacityExceeded);
            }
            let limit = u32::try_from(remaining_with_probe.min(MAX_PAGE_SIZE as usize))
                .map_err(|_| CloudAgentThreadProjectionError::CapacityExceeded)?;
            let page = self
                .state
                .list_cloud_agent_turn_page(&CloudAgentTurnPageQuery {
                    thread_id: thread_id.to_string(),
                    anchor,
                    limit,
                    sort_direction: CloudAgentTurnSortDirection::Asc,
                })
                .await
                .map_err(|_| CloudAgentThreadProjectionError::StateUnavailable)?;
            if page.data.is_empty() {
                break;
            }
            for record in page.data {
                validate_turn_authority(&record, &context)?;
                turns.push(self.project_turn(&record, items_view).await?);
                if turns.len() > MAX_READ_TURNS {
                    return Err(CloudAgentThreadProjectionError::CapacityExceeded);
                }
            }
            if !page.has_more {
                break;
            }
            anchor = turns.last().map(|turn| CloudAgentTurnPageAnchor {
                turn_id: turn.id.clone(),
                include_anchor: false,
            });
        }
        let status = projected_thread_status(&turns);
        Ok(Some(CloudAgentThreadReadProjection { turns, status }))
    }

    pub(crate) async fn read_status(
        &self,
        thread_id: &str,
    ) -> Result<Option<ThreadStatus>, CloudAgentThreadProjectionError> {
        let Some(context) = self.authorized_cloud_context(thread_id).await? else {
            return Ok(None);
        };
        let page = self
            .state
            .list_cloud_agent_turn_page(&CloudAgentTurnPageQuery {
                thread_id: thread_id.to_string(),
                anchor: None,
                limit: 1,
                sort_direction: CloudAgentTurnSortDirection::Desc,
            })
            .await
            .map_err(|_| CloudAgentThreadProjectionError::StateUnavailable)?;
        let Some(turn) = page.data.first() else {
            return Ok(Some(ThreadStatus::Idle));
        };
        validate_turn_authority(turn, &context)?;
        Ok(Some(if turn.status.is_terminal() {
            ThreadStatus::Idle
        } else {
            ThreadStatus::Active {
                active_flags: Vec::new(),
            }
        }))
    }

    pub(crate) async fn resume_projection(
        &self,
        thread_id: &str,
        include_turns: bool,
        initial_page: Option<&crewon_app_server_protocol::ThreadResumeInitialTurnsPageParams>,
    ) -> Result<Option<CloudAgentThreadResumeProjection>, CloudAgentThreadProjectionError> {
        let Some(status) = self.read_status(thread_id).await? else {
            return Ok(None);
        };
        let turns = if include_turns {
            Some(
                self.read_all(thread_id, TurnItemsView::Full)
                    .await?
                    .ok_or(CloudAgentThreadProjectionError::NotFound)?
                    .turns,
            )
        } else {
            None
        };
        let initial_turns_page = if let Some(params) = initial_page {
            Some(
                self.list_page(
                    thread_id,
                    /*cursor*/ None,
                    params.limit,
                    params.sort_direction.unwrap_or(SortDirection::Desc),
                    params.items_view.unwrap_or(TurnItemsView::Summary),
                )
                .await?
                .ok_or(CloudAgentThreadProjectionError::NotFound)?
                .into(),
            )
        } else {
            None
        };
        Ok(Some(CloudAgentThreadResumeProjection {
            turns,
            initial_turns_page,
            status,
        }))
    }

    pub(crate) async fn list_page(
        &self,
        thread_id: &str,
        cursor: Option<&str>,
        limit: Option<u32>,
        sort_direction: SortDirection,
        items_view: TurnItemsView,
    ) -> Result<Option<ThreadTurnsListResponse>, CloudAgentThreadProjectionError> {
        let Some(context) = self.authorized_cloud_context(thread_id).await? else {
            return Ok(None);
        };
        let anchor = cursor.map(parse_cursor).transpose()?;
        if let Some(anchor) = anchor.as_ref() {
            let record = self
                .state
                .get_cloud_agent_turn_record(&anchor.turn_id)
                .await
                .map_err(|_| CloudAgentThreadProjectionError::StateUnavailable)?;
            if record
                .as_ref()
                .is_none_or(|record| record.thread_id != thread_id)
            {
                return Err(CloudAgentThreadProjectionError::InvalidCursor);
            }
        }
        let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE);
        let page = self
            .state
            .list_cloud_agent_turn_page(&CloudAgentTurnPageQuery {
                thread_id: thread_id.to_string(),
                anchor,
                limit,
                sort_direction: state_sort_direction(sort_direction),
            })
            .await
            .map_err(|_| CloudAgentThreadProjectionError::StateUnavailable)?;
        let mut turns = Vec::with_capacity(page.data.len());
        for record in page.data {
            validate_turn_authority(&record, &context)?;
            turns.push(self.project_turn(&record, items_view).await?);
        }
        let backwards_cursor = turns
            .first()
            .map(|turn| serialize_cursor(&turn.id, /*include_anchor*/ true))
            .transpose()?;
        let next_cursor = if page.has_more {
            turns
                .last()
                .map(|turn| serialize_cursor(&turn.id, /*include_anchor*/ false))
                .transpose()?
        } else {
            None
        };
        Ok(Some(ThreadTurnsListResponse {
            data: turns,
            next_cursor,
            backwards_cursor,
        }))
    }

    pub(crate) async fn project_exact_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
        expected_revision: Option<u64>,
        items_view: TurnItemsView,
    ) -> Result<Option<Turn>, CloudAgentThreadProjectionError> {
        let Some(context) = self.authorized_cloud_context(thread_id).await? else {
            return Ok(None);
        };
        let turn = self
            .state
            .get_cloud_agent_turn_record(turn_id)
            .await
            .map_err(|_| CloudAgentThreadProjectionError::StateUnavailable)?
            .ok_or(CloudAgentThreadProjectionError::NotFound)?;
        if turn.thread_id != thread_id
            || expected_revision.is_some_and(|revision| revision != turn.revision)
        {
            return Err(CloudAgentThreadProjectionError::NotFound);
        }
        validate_turn_authority(&turn, &context)?;
        self.project_turn(&turn, items_view).await.map(Some)
    }

    async fn authorized_cloud_context(
        &self,
        thread_id: &str,
    ) -> Result<Option<crewon_state::ThreadExecutionContextRecord>, CloudAgentThreadProjectionError>
    {
        let context = self
            .state
            .get_thread_execution_context_record(thread_id)
            .await
            .map_err(|_| CloudAgentThreadProjectionError::StateUnavailable)?;
        let Some(context) = context else {
            return Ok(None);
        };
        authorize_thread_execution_context_record(&self.identity, &context)
            .map_err(|_| CloudAgentThreadProjectionError::Unauthorized)?;
        if context.execution_binding.is_none() {
            return Ok(None);
        }
        Ok(Some(context))
    }

    async fn project_turn(
        &self,
        record: &CloudAgentTurnRecord,
        items_view: TurnItemsView,
    ) -> Result<Turn, CloudAgentThreadProjectionError> {
        let items = match items_view {
            TurnItemsView::NotLoaded => Vec::new(),
            TurnItemsView::Summary | TurnItemsView::Full => {
                let artifacts = CloudAgentThreadArtifactProjector::new(self.state.clone());
                let prompt = artifacts.read_prompt(record).await?;
                let mut items = vec![ThreadItem::UserMessage {
                    id: user_item_id(&record.turn_id),
                    client_id: Some(record.client_user_message_id.clone()),
                    content: vec![UserInput::Text {
                        text: prompt,
                        text_elements: Vec::new(),
                    }],
                }];
                if record.status == CloudAgentTurnStatus::Completed {
                    items.push(ThreadItem::AgentMessage {
                        id: assistant_item_id(&record.turn_id),
                        text: artifacts.read_output(record).await?,
                        phase: None,
                        memory_citation: None,
                    });
                }
                items
            }
        };
        Ok(Turn {
            id: record.turn_id.clone(),
            items,
            items_view,
            status: turn_status(record.status),
            error: turn_error(record.status),
            started_at: Some(record.created_at),
            completed_at: record.completed_at,
            duration_ms: duration_ms(record),
        })
    }
}

fn validate_turn_authority(
    turn: &CloudAgentTurnRecord,
    context: &crewon_state::ThreadExecutionContextRecord,
) -> Result<(), CloudAgentThreadProjectionError> {
    if turn.thread_id != context.thread_id
        || turn.local_actor_id != context.local_actor_id
        || turn.local_tenant_id != context.local_tenant_id
        || turn.local_space_id != context.local_space_id
        || turn.workspace_key != context.workspace_key
        || context.execution_binding.as_ref() != Some(&turn.execution_binding)
    {
        return Err(CloudAgentThreadProjectionError::Unauthorized);
    }
    Ok(())
}

fn turn_status(status: CloudAgentTurnStatus) -> TurnStatus {
    match status {
        CloudAgentTurnStatus::Queued
        | CloudAgentTurnStatus::Running
        | CloudAgentTurnStatus::Suspended
        | CloudAgentTurnStatus::Finalizing => TurnStatus::InProgress,
        CloudAgentTurnStatus::Completed => TurnStatus::Completed,
        CloudAgentTurnStatus::Failed | CloudAgentTurnStatus::ResultUnavailable => {
            TurnStatus::Failed
        }
        CloudAgentTurnStatus::Cancelled => TurnStatus::Interrupted,
    }
}

fn turn_error(status: CloudAgentTurnStatus) -> Option<TurnError> {
    let message = match status {
        CloudAgentTurnStatus::Failed => "Cloud Agent execution failed.",
        CloudAgentTurnStatus::ResultUnavailable => "Cloud Agent result is unavailable.",
        CloudAgentTurnStatus::Queued
        | CloudAgentTurnStatus::Running
        | CloudAgentTurnStatus::Suspended
        | CloudAgentTurnStatus::Finalizing
        | CloudAgentTurnStatus::Completed
        | CloudAgentTurnStatus::Cancelled => return None,
    };
    Some(TurnError {
        message: message.to_string(),
        codex_error_info: Some(CodexErrorInfo::InternalServerError),
        additional_details: None,
    })
}

fn duration_ms(turn: &CloudAgentTurnRecord) -> Option<i64> {
    turn.completed_at?
        .checked_sub(turn.created_at)?
        .checked_mul(1_000)
}

fn projected_thread_status(turns: &[Turn]) -> ThreadStatus {
    if turns
        .last()
        .is_some_and(|turn| turn.status == TurnStatus::InProgress)
    {
        ThreadStatus::Active {
            active_flags: Vec::new(),
        }
    } else {
        ThreadStatus::Idle
    }
}

pub(crate) fn user_item_id(turn_id: &str) -> String {
    format!("{turn_id}:user")
}

pub(crate) fn assistant_item_id(turn_id: &str) -> String {
    format!("{turn_id}:assistant")
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloudAgentTurnsCursor {
    turn_id: String,
    include_anchor: bool,
}

fn parse_cursor(cursor: &str) -> Result<CloudAgentTurnPageAnchor, CloudAgentThreadProjectionError> {
    let cursor: CloudAgentTurnsCursor =
        serde_json::from_str(cursor).map_err(|_| CloudAgentThreadProjectionError::InvalidCursor)?;
    let anchor = CloudAgentTurnPageAnchor {
        turn_id: cursor.turn_id,
        include_anchor: cursor.include_anchor,
    };
    anchor
        .validate()
        .map_err(|_| CloudAgentThreadProjectionError::InvalidCursor)?;
    Ok(anchor)
}

fn serialize_cursor(
    turn_id: &str,
    include_anchor: bool,
) -> Result<String, CloudAgentThreadProjectionError> {
    serde_json::to_string(&CloudAgentTurnsCursor {
        turn_id: turn_id.to_string(),
        include_anchor,
    })
    .map_err(|_| CloudAgentThreadProjectionError::StateUnavailable)
}

fn state_sort_direction(direction: SortDirection) -> CloudAgentTurnSortDirection {
    match direction {
        SortDirection::Asc => CloudAgentTurnSortDirection::Asc,
        SortDirection::Desc => CloudAgentTurnSortDirection::Desc,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloudAgentThreadProjectionError {
    Unauthorized,
    NotFound,
    InvalidCursor,
    InvalidProjection,
    CapacityExceeded,
    StateUnavailable,
}

impl fmt::Display for CloudAgentThreadProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Cloud Agent Thread projection failed: {self:?}")
    }
}

impl std::error::Error for CloudAgentThreadProjectionError {}

#[cfg(test)]
#[path = "cloud_agent_thread_projection_tests.rs"]
mod tests;
