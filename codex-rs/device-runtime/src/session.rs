use std::sync::Arc;
use std::sync::atomic::Ordering;

use chrono::SecondsFormat;
use chrono::Utc;
use crewon_device::NativeDeviceConnection;
use crewon_device_journal::FilesystemReadJournalListQuery;
use crewon_device_journal::WorkspaceJournalListQuery;
use crewon_device_protocol::DEVICE_PROTOCOL_VERSION;
use crewon_device_protocol::DeviceAcknowledgedExecution;
use crewon_device_protocol::DeviceFilesystemReadAck;
use crewon_device_protocol::DeviceHello;
use crewon_device_protocol::DeviceWorkspaceListAck;
use crewon_device_protocol::parse_device_execution_cancel;
use crewon_device_protocol::parse_device_filesystem_read_ack;
use crewon_device_protocol::parse_device_gateway_welcome;
use crewon_device_protocol::parse_device_workspace_list_ack;
use futures::SinkExt as _;
use futures::StreamExt as _;
use serde_json::Value;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::sync::mpsc;
use tokio::sync::watch;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use crate::DeviceRuntimeError;
use crate::dispatch::DispatchRequest;
use crate::dispatch::apply_cancel;
use crate::dispatch::enqueue_command;
use crate::dispatch::enqueue_filesystem_read;
use crate::dispatch::run_dispatch_scheduler;
use crate::runtime::DeviceRuntimeReady;
use crate::runtime::DeviceRuntimeState;
use crate::runtime::MAX_ACKNOWLEDGED_EXECUTIONS;
use crate::runtime::MAX_SOCKET_MESSAGE_BYTES;
use crate::runtime::MAX_UNACKNOWLEDGED_EXECUTIONS;
use crate::runtime::RuntimeEvent;
use crate::runtime::WORKSPACE_LIST_CAPABILITY;
use crate::runtime::WORKSPACE_READ_CAPABILITY;

const OUTBOUND_CAPACITY: usize = 256;
const DISPATCH_QUEUE_CAPACITY: usize = 32;
const WELCOME_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

pub(crate) enum Outbound {
    Event(Box<RuntimeEvent>),
    Pong(Vec<u8>),
}

pub(crate) async fn run_socket_with_ready<Stream>(
    state: Arc<DeviceRuntimeState>,
    mut socket: WebSocketStream<Stream>,
    on_ready: &(impl Fn(DeviceRuntimeReady) + Send + Sync),
) -> Result<(), DeviceRuntimeError>
where
    Stream: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let connection_id = format!("native-connection-{}", Uuid::new_v4());
    let hello = build_hello(&state, &connection_id).await?;
    socket
        .send(Message::text(serialize(&hello)?))
        .await
        .map_err(|error| DeviceRuntimeError::with_source("device_runtime_socket_failed", error))?;
    let welcome_frame = tokio::time::timeout(WELCOME_TIMEOUT, socket.next())
        .await
        .map_err(|error| DeviceRuntimeError::with_source("device_runtime_welcome_timeout", error))?
        .ok_or_else(|| DeviceRuntimeError::new("device_runtime_welcome_missing"))?
        .map_err(|error| DeviceRuntimeError::with_source("device_runtime_socket_failed", error))?;
    let welcome_bytes = strict_text_frame(welcome_frame, "device_runtime_welcome_invalid")?;
    let welcome_value = parse_bounded_value(&welcome_bytes)?;
    let welcome = parse_device_gateway_welcome(welcome_value).map_err(|error| {
        DeviceRuntimeError::with_source("device_runtime_welcome_invalid", error)
    })?;
    if welcome.connection_id != connection_id || welcome.device_id != state.device_id {
        return Err(DeviceRuntimeError::new(
            "device_runtime_welcome_identity_mismatch",
        ));
    }
    let connection = NativeDeviceConnection::establish_with_runtime_binding(
        &state.fence,
        &state.authorizer,
        state.runtime_binding.clone(),
        &welcome_bytes,
        Utc::now(),
    )
    .map_err(|error| DeviceRuntimeError::with_source("device_runtime_welcome_rejected", error))?;
    let accepted = connection.accepted_connection().clone();
    let generation = next_generation(&state)?;
    let mut journal_events = state.events.subscribe();
    let replay_events = collect_replay_events(&state).await?;

    let (mut writer, mut reader) = socket.split();
    let (outbound_tx, mut outbound_rx) = mpsc::channel(OUTBOUND_CAPACITY);
    let (fatal_tx, mut fatal_rx) = watch::channel(false);
    let writer_fatal = fatal_tx.clone();
    let writer_task = tokio::spawn(async move {
        while let Some(outbound) = outbound_rx.recv().await {
            let message = match outbound {
                Outbound::Event(event) => match event.as_ref() {
                    RuntimeEvent::WorkspaceList(event) => serde_json::to_string(event),
                    RuntimeEvent::FilesystemRead(event) => serde_json::to_string(event),
                }
                .map_or_else(
                    |_| {
                        let _ = writer_fatal.send(true);
                        None
                    },
                    |event| Some(Message::text(event)),
                ),
                Outbound::Pong(payload) => Some(Message::Pong(payload.into())),
            };
            let Some(message) = message else {
                return;
            };
            if writer.send(message).await.is_err() {
                let _ = writer_fatal.send(true);
                return;
            }
        }
    });
    enqueue_replay_events(&outbound_tx, &replay_events).await?;
    let event_outbound = outbound_tx.clone();
    let event_fatal = fatal_tx.clone();
    let event_state = Arc::clone(&state);
    let event_task = tokio::spawn(async move {
        loop {
            match journal_events.recv().await {
                Ok(event) if event_state.generation.load(Ordering::Acquire) == generation => {
                    if event_outbound
                        .send(Outbound::Event(Box::new(event)))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                Ok(_) => return,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let _ = event_fatal.send(true);
                    return;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            }
        }
    });

    let (dispatch_tx, dispatch_rx) = mpsc::channel(DISPATCH_QUEUE_CAPACITY);
    let scheduler = tokio::spawn(run_dispatch_scheduler(
        Arc::clone(&state),
        accepted,
        dispatch_rx,
        fatal_tx.clone(),
    ));
    on_ready(DeviceRuntimeReady {
        device_id: state.device_id.clone(),
        runtime_binding_id: state.runtime_binding.runtime_binding_id.clone(),
        connection_epoch: welcome.connection_epoch,
    });
    let result = loop {
        tokio::select! {
            changed = fatal_rx.changed() => {
                if changed.is_err() || *fatal_rx.borrow() {
                    break Err(DeviceRuntimeError::new("device_runtime_writer_unavailable"));
                }
            }
            frame = reader.next() => {
                let Some(frame) = frame else {
                    break Ok(());
                };
                let frame = frame.map_err(|error| {
                    DeviceRuntimeError::with_source("device_runtime_socket_failed", error)
                })?;
                match frame {
                    Message::Text(text) => {
                        if state.generation.load(Ordering::Acquire) != generation {
                            break Ok(());
                        }
                        handle_text_frame(
                            &state,
                            text.as_bytes(),
                            &dispatch_tx,
                        ).await?;
                    }
                    Message::Ping(payload) => {
                        outbound_tx.try_send(Outbound::Pong(payload.to_vec())).map_err(|_| {
                            DeviceRuntimeError::new("device_runtime_writer_capacity_exceeded")
                        })?;
                    }
                    Message::Pong(_) => {}
                    Message::Close(_) => break Ok(()),
                    Message::Binary(_) | Message::Frame(_) => {
                        break Err(DeviceRuntimeError::new("device_runtime_frame_invalid"));
                    }
                }
            }
        }
    };
    drop(dispatch_tx);
    drop(scheduler);
    event_task.abort();
    writer_task.abort();
    result
}

async fn build_hello(
    state: &DeviceRuntimeState,
    connection_id: &str,
) -> Result<DeviceHello, DeviceRuntimeError> {
    let mut last_acknowledged = Vec::new();
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
        if last_acknowledged.len() + page.acknowledgements.len() > MAX_ACKNOWLEDGED_EXECUTIONS {
            return Err(DeviceRuntimeError::new(
                "device_runtime_acknowledgement_capacity_exceeded",
            ));
        }
        last_acknowledged.extend(page.acknowledgements.into_iter().map(|acknowledgement| {
            DeviceAcknowledgedExecution {
                execution_id: acknowledgement.execution_id,
                sequence: acknowledgement.through_sequence,
            }
        }));
        let Some(next_cursor) = page.next_cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
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
        if last_acknowledged.len() + page.acknowledgements.len() > MAX_ACKNOWLEDGED_EXECUTIONS {
            return Err(DeviceRuntimeError::new(
                "device_runtime_acknowledgement_capacity_exceeded",
            ));
        }
        last_acknowledged.extend(page.acknowledgements.into_iter().map(|acknowledgement| {
            DeviceAcknowledgedExecution {
                execution_id: acknowledgement.execution_id,
                sequence: acknowledgement.through_sequence,
            }
        }));
        let Some(next_cursor) = page.next_cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    Ok(DeviceHello {
        schema_version: "crewon.device-hello.v0".to_string(),
        supported_protocol_versions: vec![DEVICE_PROTOCOL_VERSION],
        device_id: state.device_id.clone(),
        connection_id: connection_id.to_string(),
        capabilities: vec![
            WORKSPACE_LIST_CAPABILITY.to_string(),
            WORKSPACE_READ_CAPABILITY.to_string(),
        ],
        last_acknowledged,
        sent_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

async fn collect_replay_events(
    state: &DeviceRuntimeState,
) -> Result<Vec<RuntimeEvent>, DeviceRuntimeError> {
    let mut events = Vec::new();
    let mut execution_count = 0_usize;
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
        execution_count += page.items.len();
        if execution_count > MAX_UNACKNOWLEDGED_EXECUTIONS {
            return Err(DeviceRuntimeError::new(
                "device_runtime_replay_capacity_exceeded",
            ));
        }
        for item in page.items {
            events.extend(item.events.into_iter().map(RuntimeEvent::WorkspaceList));
        }
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
        execution_count += page.items.len();
        if execution_count > MAX_UNACKNOWLEDGED_EXECUTIONS {
            return Err(DeviceRuntimeError::new(
                "device_runtime_replay_capacity_exceeded",
            ));
        }
        for item in page.items {
            events.extend(item.events.into_iter().map(RuntimeEvent::FilesystemRead));
        }
        let Some(next_cursor) = page.next_cursor else {
            break;
        };
        cursor = Some(next_cursor);
    }
    Ok(events)
}

async fn enqueue_replay_events(
    outbound: &mpsc::Sender<Outbound>,
    replay_events: &[RuntimeEvent],
) -> Result<(), DeviceRuntimeError> {
    for event in replay_events {
        outbound
            .send(Outbound::Event(Box::new(event.clone())))
            .await
            .map_err(|_| DeviceRuntimeError::new("device_runtime_writer_unavailable"))?;
    }
    Ok(())
}

async fn handle_text_frame(
    state: &Arc<DeviceRuntimeState>,
    frame: &[u8],
    dispatch_tx: &mpsc::Sender<DispatchRequest>,
) -> Result<(), DeviceRuntimeError> {
    let value = parse_bounded_value(frame)?;
    let schema = value
        .get("schemaVersion")
        .and_then(Value::as_str)
        .ok_or_else(|| DeviceRuntimeError::new("device_runtime_frame_invalid"))?;
    match schema {
        "crewon.device-workspace-list-command.v0" => {
            enqueue_command(state, frame, value, dispatch_tx)
        }
        "crewon.device-command.v0" => enqueue_filesystem_read(state, frame, value, dispatch_tx),
        "crewon.device-workspace-list-ack.v0" => {
            let ack = parse_device_workspace_list_ack(value).map_err(|error| {
                DeviceRuntimeError::with_source("device_runtime_ack_invalid", error)
            })?;
            validate_ack_device(state, &ack)?;
            state
                .orchestrator
                .acknowledge(&ack)
                .await
                .map_err(|error| {
                    DeviceRuntimeError::with_source("device_runtime_ack_rejected", error)
                })?;
            Ok(())
        }
        "crewon.device-filesystem-read-ack.v0" => {
            let ack = parse_device_filesystem_read_ack(value).map_err(|error| {
                DeviceRuntimeError::with_source("device_runtime_ack_invalid", error)
            })?;
            validate_read_ack_device(state, &ack)?;
            state
                .read_orchestrator
                .acknowledge(&ack)
                .await
                .map_err(|error| {
                    DeviceRuntimeError::with_source("device_runtime_ack_rejected", error)
                })?;
            Ok(())
        }
        "crewon.device-cancel.v0" => {
            let cancel = parse_device_execution_cancel(value).map_err(|error| {
                DeviceRuntimeError::with_source("device_runtime_cancel_invalid", error)
            })?;
            apply_cancel(state, &cancel).await.map(|_| ())
        }
        _ => Err(DeviceRuntimeError::new("device_runtime_frame_unsupported")),
    }
}

fn validate_read_ack_device(
    state: &DeviceRuntimeState,
    ack: &DeviceFilesystemReadAck,
) -> Result<(), DeviceRuntimeError> {
    if ack.device_id != state.device_id {
        return Err(DeviceRuntimeError::new("device_runtime_ack_invalid"));
    }
    Ok(())
}

fn validate_ack_device(
    state: &DeviceRuntimeState,
    ack: &DeviceWorkspaceListAck,
) -> Result<(), DeviceRuntimeError> {
    if ack.device_id != state.device_id {
        return Err(DeviceRuntimeError::new("device_runtime_ack_invalid"));
    }
    Ok(())
}

fn parse_bounded_value(frame: &[u8]) -> Result<Value, DeviceRuntimeError> {
    if frame.is_empty() || frame.len() > MAX_SOCKET_MESSAGE_BYTES {
        return Err(DeviceRuntimeError::new("device_runtime_frame_size_invalid"));
    }
    serde_json::from_slice(frame)
        .map_err(|error| DeviceRuntimeError::with_source("device_runtime_frame_invalid", error))
}

fn strict_text_frame(frame: Message, code: &'static str) -> Result<Vec<u8>, DeviceRuntimeError> {
    match frame {
        Message::Text(text) => Ok(text.as_bytes().to_vec()),
        Message::Binary(_)
        | Message::Ping(_)
        | Message::Pong(_)
        | Message::Close(_)
        | Message::Frame(_) => Err(DeviceRuntimeError::new(code)),
    }
}

fn next_generation(state: &DeviceRuntimeState) -> Result<u64, DeviceRuntimeError> {
    state
        .generation
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            current.checked_add(1)
        })
        .map(|previous| previous + 1)
        .map_err(|_| DeviceRuntimeError::new("device_runtime_generation_exhausted"))
}

fn serialize(value: &impl serde::Serialize) -> Result<String, DeviceRuntimeError> {
    serde_json::to_string(value)
        .map_err(|error| DeviceRuntimeError::with_source("device_runtime_frame_invalid", error))
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
