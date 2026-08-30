use chrono::SecondsFormat;
use chrono::Utc;
use crewon_device_journal::FilesystemReadJournalListQuery;
use crewon_device_journal::ToolJournalListQuery;
use crewon_device_journal::WorkspaceJournalListQuery;
use crewon_device_protocol::DEVICE_PROTOCOL_VERSION;
use crewon_device_protocol::DeviceAcknowledgedExecution;
use crewon_device_protocol::DeviceHello;

use crate::DeviceRuntimeError;
use crate::runtime::DeviceRuntimeState;
use crate::runtime::MAX_ACKNOWLEDGED_EXECUTIONS;
use crate::runtime::MAX_UNACKNOWLEDGED_EXECUTIONS;
use crate::runtime::RAW_WORKSPACE_READ_CAPABILITY;
use crate::runtime::RuntimeEvent;
use crate::runtime::WORKSPACE_LIST_CAPABILITY;
use crate::runtime::WORKSPACE_READ_CAPABILITY;

pub(crate) async fn build_hello(
    state: &DeviceRuntimeState,
    connection_id: &str,
) -> Result<DeviceHello, DeviceRuntimeError> {
    let mut acknowledged = Vec::new();
    append_list_acknowledgements(state, &mut acknowledged).await?;
    append_read_acknowledgements(state, &mut acknowledged).await?;
    append_tool_acknowledgements(state, &mut acknowledged).await?;
    Ok(DeviceHello {
        schema_version: "crewon.device-hello.v0".to_string(),
        supported_protocol_versions: vec![DEVICE_PROTOCOL_VERSION],
        device_id: state.device_id.clone(),
        connection_id: connection_id.to_string(),
        capabilities: vec![
            WORKSPACE_LIST_CAPABILITY.to_string(),
            WORKSPACE_READ_CAPABILITY.to_string(),
            RAW_WORKSPACE_READ_CAPABILITY.to_string(),
        ],
        last_acknowledged: acknowledged,
        sent_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

async fn append_list_acknowledgements(
    state: &DeviceRuntimeState,
    acknowledged: &mut Vec<DeviceAcknowledgedExecution>,
) -> Result<(), DeviceRuntimeError> {
    let mut cursor = None;
    loop {
        let page = state
            .journal
            .list_workspace_list_acknowledgements(&WorkspaceJournalListQuery {
                after_execution_id: cursor,
                limit: 100,
            })
            .await
            .map_err(|error| {
                DeviceRuntimeError::with_source("device_runtime_journal_invalid", error)
            })?;
        append_acknowledgements(
            acknowledged,
            page.acknowledgements
                .into_iter()
                .map(|item| DeviceAcknowledgedExecution {
                    execution_id: item.execution_id,
                    sequence: item.through_sequence,
                }),
        )?;
        let Some(next_cursor) = page.next_cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    Ok(())
}

async fn append_read_acknowledgements(
    state: &DeviceRuntimeState,
    acknowledged: &mut Vec<DeviceAcknowledgedExecution>,
) -> Result<(), DeviceRuntimeError> {
    let mut cursor = None;
    loop {
        let page = state
            .journal
            .list_filesystem_read_acknowledgements(&FilesystemReadJournalListQuery {
                after_execution_id: cursor,
                limit: 100,
            })
            .await
            .map_err(|error| {
                DeviceRuntimeError::with_source("device_runtime_journal_invalid", error)
            })?;
        append_acknowledgements(
            acknowledged,
            page.acknowledgements
                .into_iter()
                .map(|item| DeviceAcknowledgedExecution {
                    execution_id: item.execution_id,
                    sequence: item.through_sequence,
                }),
        )?;
        let Some(next_cursor) = page.next_cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    Ok(())
}

async fn append_tool_acknowledgements(
    state: &DeviceRuntimeState,
    acknowledged: &mut Vec<DeviceAcknowledgedExecution>,
) -> Result<(), DeviceRuntimeError> {
    let mut cursor = None;
    loop {
        let page = state
            .journal
            .list_tool_acknowledgements(&ToolJournalListQuery {
                after_execution_id: cursor,
                limit: 100,
            })
            .await
            .map_err(journal_error)?;
        append_acknowledgements(
            acknowledged,
            page.acknowledgements
                .into_iter()
                .map(|item| DeviceAcknowledgedExecution {
                    execution_id: item.execution_id,
                    sequence: item.through_sequence,
                }),
        )?;
        let Some(next_cursor) = page.next_cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    Ok(())
}

fn append_acknowledgements(
    acknowledged: &mut Vec<DeviceAcknowledgedExecution>,
    page: impl ExactSizeIterator<Item = DeviceAcknowledgedExecution>,
) -> Result<(), DeviceRuntimeError> {
    if acknowledged.len() + page.len() > MAX_ACKNOWLEDGED_EXECUTIONS {
        return Err(DeviceRuntimeError::new(
            "device_runtime_acknowledgement_capacity_exceeded",
        ));
    }
    acknowledged.extend(page);
    Ok(())
}

pub(crate) async fn collect_replay_events(
    state: &DeviceRuntimeState,
) -> Result<Vec<RuntimeEvent>, DeviceRuntimeError> {
    let mut events = Vec::new();
    let mut count = 0;
    let mut cursor = None;
    loop {
        let page = state
            .orchestrator
            .reconnect_page(&WorkspaceJournalListQuery {
                after_execution_id: cursor,
                limit: 100,
            })
            .await
            .map_err(|error| {
                DeviceRuntimeError::with_source("device_runtime_journal_invalid", error)
            })?;
        extend_replay(
            &mut events,
            &mut count,
            page.items.len(),
            page.items
                .into_iter()
                .flat_map(|item| item.events)
                .map(RuntimeEvent::WorkspaceList),
        )?;
        let Some(next_cursor) = page.next_cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    let mut cursor = None;
    loop {
        let page = state
            .read_orchestrator
            .reconnect_page(&FilesystemReadJournalListQuery {
                after_execution_id: cursor,
                limit: 100,
            })
            .await
            .map_err(|error| {
                DeviceRuntimeError::with_source("device_runtime_journal_invalid", error)
            })?;
        extend_replay(
            &mut events,
            &mut count,
            page.items.len(),
            page.items
                .into_iter()
                .flat_map(|item| item.events)
                .map(RuntimeEvent::FilesystemRead),
        )?;
        let Some(next_cursor) = page.next_cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    let mut cursor = None;
    loop {
        let page = state
            .tool_orchestrator
            .reconnect(&ToolJournalListQuery {
                after_execution_id: cursor,
                limit: 100,
            })
            .await
            .map_err(|error| {
                DeviceRuntimeError::with_source("device_runtime_journal_invalid", error)
            })?;
        let next_cursor = page.last().map(|item| item.execution_id.clone());
        extend_replay(
            &mut events,
            &mut count,
            page.len(),
            page.into_iter()
                .flat_map(|item| item.events)
                .map(RuntimeEvent::Tool),
        )?;
        let Some(next_cursor) = next_cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    Ok(events)
}

fn extend_replay(
    events: &mut Vec<RuntimeEvent>,
    count: &mut usize,
    page_len: usize,
    page: impl Iterator<Item = RuntimeEvent>,
) -> Result<(), DeviceRuntimeError> {
    *count += page_len;
    if *count > MAX_UNACKNOWLEDGED_EXECUTIONS {
        return Err(DeviceRuntimeError::new(
            "device_runtime_replay_capacity_exceeded",
        ));
    }
    events.extend(page);
    Ok(())
}

fn journal_error(error: crewon_device_journal::DeviceJournalError) -> DeviceRuntimeError {
    DeviceRuntimeError::with_source("device_runtime_journal_invalid", error)
}
