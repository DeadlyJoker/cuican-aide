use std::sync::Arc;

use chrono::SecondsFormat;
use chrono::Utc;
use crewon_device_protocol::DeviceExecutionCancel;
use crewon_device_protocol::DeviceFilesystemReadAck;
use crewon_device_protocol::DeviceFilesystemReadEvent;
use crewon_device_protocol::DeviceHello;
use crewon_device_protocol::DeviceWorkspaceListEvent;
use crewon_device_protocol::parse_device_filesystem_read_event;
use crewon_device_protocol::parse_device_hello;
use crewon_device_protocol::parse_device_workspace_list_event;
use futures::SinkExt as _;
use futures::StreamExt as _;
use pretty_assertions::assert_eq;
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

use super::Outbound;
use super::build_hello;
use super::collect_replay_events;
use super::enqueue_replay_events;
use super::run_socket_with_ready;
use crate::runtime::MAX_SOCKET_MESSAGE_BYTES;
use crate::runtime::RuntimeEvent;
use crate::test_support::ServerPin;
use crate::test_support::accepted_event;
use crate::test_support::ack;
use crate::test_support::read_accepted_event;
use crate::test_support::read_completed_event;
use crate::test_support::runtime_fixture;
use crate::test_support::signed_command;
use crate::test_support::signed_read_command;
use crate::test_support::terminal_event;
use crate::test_support::welcome;

#[tokio::test]
async fn real_mtls_wss_sends_hello_then_accepted_terminal_and_survives_late_cancel() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind WSS listener");
    let url = Url::parse(&format!(
        "wss://localhost:{}/device/v1",
        listener.local_addr().expect("listener address").port()
    ))
    .expect("gateway URL");
    let fixture = runtime_fixture(url.clone(), ServerPin::Required).await;
    let command = signed_command(&fixture, 1);
    let server_config = Arc::clone(&fixture.server_config);
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.expect("accept TCP");
        let tls = TlsAcceptor::from(server_config)
            .accept(tcp)
            .await
            .expect("accept mTLS");
        let mut socket = accept_async(tls).await.expect("accept WSS");
        let hello = receive_hello(&mut socket).await;
        assert_eq!(
            hello.capabilities,
            vec!["workspace.list_top_level.v0", "workspace.read_file.v0"]
        );
        assert!(hello.last_acknowledged.is_empty());
        socket
            .send(Message::text(
                serde_json::to_string(&welcome(&hello, 1)).expect("serialize welcome"),
            ))
            .await
            .expect("send welcome");
        socket
            .send(Message::text(
                serde_json::to_string(&command).expect("serialize command"),
            ))
            .await
            .expect("send command");
        let accepted = receive_event(&mut socket).await;
        let terminal = receive_event(&mut socket).await;
        assert_eq!(event_sequence(&accepted), 1);
        assert_eq!(event_sequence(&terminal), 2);
        let serialized = serde_json::to_string(&[&accepted, &terminal]).expect("events JSON");
        assert!(!serialized.contains("workspace-secret"));
        socket
            .send(Message::text(
                serde_json::to_string(&ack(&terminal, 2)).expect("serialize ACK"),
            ))
            .await
            .expect("send ACK");
        let cancel = DeviceExecutionCancel {
            schema_version: "crewon.device-cancel.v0".to_string(),
            protocol_version: 1,
            device_id: command.device_id.clone(),
            execution_id: command.execution_id.clone(),
            lease_id: command.lease_id.clone(),
            lease_epoch: command.lease_epoch,
            reason_code: "user_requested".to_string(),
            requested_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        };
        let cancel = Message::text(serde_json::to_string(&cancel).expect("serialize cancel"));
        socket.send(cancel.clone()).await.expect("send late cancel");
        socket.send(cancel).await.expect("send duplicate cancel");
        socket
            .send(Message::Ping(vec![1, 2, 3].into()))
            .await
            .expect("send ping");
        loop {
            match socket.next().await.expect("pong frame").expect("read pong") {
                Message::Pong(payload) => {
                    assert_eq!(payload.as_ref(), &[1, 2, 3]);
                    break;
                }
                Message::Ping(_) | Message::Text(_) => {}
                other => panic!("unexpected frame before pong: {other:?}"),
            }
        }
        socket.close(None).await.expect("close WSS");
        (accepted, terminal)
    });

    let socket = fixture
        .runtime
        .connect_socket()
        .await
        .expect("connect mTLS WSS");
    let ready = std::sync::Mutex::new(Vec::new());
    run_socket_with_ready(Arc::clone(&fixture.runtime.state), socket, &|event| {
        ready.lock().expect("ready observer").push(event);
    })
    .await
    .expect("run Device session");
    assert_eq!(
        ready.into_inner().expect("ready events"),
        vec![crate::DeviceRuntimeReady {
            device_id: fixture.runtime.state.device_id.clone(),
            runtime_binding_id: fixture
                .runtime
                .state
                .runtime_binding
                .runtime_binding_id
                .clone(),
            connection_epoch: 1,
        }]
    );
    let (_accepted, terminal) = server.await.expect("server task");
    let execution = fixture
        .runtime
        .state
        .journal
        .get_workspace_list(event_execution_id(&terminal))
        .await
        .expect("load journal")
        .expect("journal execution");
    assert_eq!(execution.acknowledged_through, 2);
}

#[tokio::test]
async fn real_mtls_wss_executes_and_acknowledges_workspace_read_without_regressing_list() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind WSS listener");
    let url = Url::parse(&format!(
        "wss://localhost:{}/device/v1",
        listener.local_addr().expect("listener address").port()
    ))
    .expect("gateway URL");
    let fixture = runtime_fixture(url, ServerPin::Required).await;
    let command = signed_read_command(&fixture, 90);
    let server_config = Arc::clone(&fixture.server_config);
    let command_for_server = command.clone();
    let server = tokio::spawn(async move {
        let mut socket = accept_wss(&listener, server_config).await;
        let hello = receive_hello(&mut socket).await;
        assert_eq!(
            hello.capabilities,
            vec!["workspace.list_top_level.v0", "workspace.read_file.v0"]
        );
        socket
            .send(Message::text(
                serde_json::to_string(&welcome(&hello, 1)).expect("welcome"),
            ))
            .await
            .expect("send welcome");
        socket
            .send(Message::text(
                serde_json::to_string(&command_for_server.command).expect("read command"),
            ))
            .await
            .expect("send read");
        let accepted = receive_read_event(&mut socket).await;
        let terminal = receive_read_event(&mut socket).await;
        assert_eq!(read_sequence(&accepted), 1);
        assert_eq!(read_sequence(&terminal), 2);
        let DeviceFilesystemReadEvent::Completed { data, .. } = &terminal else {
            panic!("completed read required");
        };
        assert_eq!(data.result.content, "alpha");
        socket
            .send(Message::text(
                serde_json::to_string(&read_ack(&terminal, 2)).expect("read ACK"),
            ))
            .await
            .expect("send read ACK");
        socket
            .send(Message::Ping(vec![7].into()))
            .await
            .expect("send ping");
        while !matches!(
            socket.next().await.expect("pong").expect("read pong"),
            Message::Pong(_)
        ) {}
        socket.close(None).await.expect("close");
    });
    let socket = fixture.runtime.connect_socket().await.expect("connect");
    run_socket_with_ready(Arc::clone(&fixture.runtime.state), socket, &|_| {})
        .await
        .expect("run read session");
    server.await.expect("server");
    let execution = fixture
        .runtime
        .state
        .journal
        .get_filesystem_read(&command.command.execution_id)
        .await
        .expect("load read")
        .expect("read execution");
    assert_eq!(execution.acknowledged_through, 2);
}

#[tokio::test]
async fn read_crash_recovery_and_terminal_replay_never_reread_the_file() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind WSS listener");
    let url = Url::parse(&format!(
        "wss://localhost:{}/device/v1",
        listener.local_addr().expect("listener address").port()
    ))
    .expect("gateway URL");
    let fixture = runtime_fixture(url, ServerPin::Required).await;
    let crash_command = signed_read_command(&fixture, 91);
    let crash_accepted = read_accepted_event(&crash_command, 1);
    fixture
        .runtime
        .state
        .journal
        .prepare_filesystem_read(&crash_command, &crash_accepted)
        .await
        .expect("seed accepted-only read");
    let replay_command = signed_read_command(&fixture, 92);
    let replay_accepted = read_accepted_event(&replay_command, 1);
    let replay_terminal = read_completed_event(&replay_command, &replay_accepted, "journal-value");
    fixture
        .runtime
        .state
        .journal
        .prepare_filesystem_read(&replay_command, &replay_accepted)
        .await
        .expect("seed replay accepted");
    fixture
        .runtime
        .state
        .journal
        .record_filesystem_read_terminal(&replay_terminal)
        .await
        .expect("seed replay terminal");
    let server_config = Arc::clone(&fixture.server_config);
    let server_crash = crash_command.command.clone();
    let server_replay = replay_command.command.clone();
    let server = tokio::spawn(async move {
        let mut socket = accept_wss(&listener, server_config).await;
        let hello = receive_hello(&mut socket).await;
        socket
            .send(Message::text(
                serde_json::to_string(&welcome(&hello, 2)).expect("welcome"),
            ))
            .await
            .expect("send welcome");
        let _crash_replay = receive_read_event(&mut socket).await;
        let _terminal_accepted_replay = receive_read_event(&mut socket).await;
        let DeviceFilesystemReadEvent::Completed { data, .. } =
            receive_read_event(&mut socket).await
        else {
            panic!("completed reconnect replay required");
        };
        assert_eq!(data.result.content, "journal-value");
        socket
            .send(Message::text(
                serde_json::to_string(&server_crash).expect("crash command"),
            ))
            .await
            .expect("send crash command");
        let _accepted = receive_read_event(&mut socket).await;
        assert!(matches!(
            receive_read_event(&mut socket).await,
            DeviceFilesystemReadEvent::UnknownOutcome { .. }
        ));
        socket
            .send(Message::text(
                serde_json::to_string(&server_replay).expect("replay command"),
            ))
            .await
            .expect("send replay command");
        let _accepted = receive_read_event(&mut socket).await;
        let DeviceFilesystemReadEvent::Completed { data, .. } =
            receive_read_event(&mut socket).await
        else {
            panic!("completed replay required");
        };
        assert_eq!(data.result.content, "journal-value");
        socket.close(None).await.expect("close");
    });
    let socket = fixture.runtime.connect_socket().await.expect("connect");
    run_socket_with_ready(Arc::clone(&fixture.runtime.state), socket, &|_| {})
        .await
        .expect("run recovery session");
    server.await.expect("server");
}

#[tokio::test]
async fn disconnect_after_accepted_replays_durable_terminal_on_next_epoch() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind WSS listener");
    let url = Url::parse(&format!(
        "wss://localhost:{}/device/v1",
        listener.local_addr().expect("listener address").port()
    ))
    .expect("gateway URL");
    let fixture = runtime_fixture(url.clone(), ServerPin::Required).await;
    let command = signed_command(&fixture, 4);
    let server_config = Arc::clone(&fixture.server_config);
    let server = tokio::spawn(async move {
        let mut first = accept_wss(&listener, Arc::clone(&server_config)).await;
        let first_hello = receive_hello(&mut first).await;
        first
            .send(Message::text(
                serde_json::to_string(&welcome(&first_hello, 1)).expect("first welcome"),
            ))
            .await
            .expect("send first welcome");
        first
            .send(Message::text(
                serde_json::to_string(&command).expect("serialize command"),
            ))
            .await
            .expect("send command");
        let accepted = receive_event(&mut first).await;
        assert_eq!(event_sequence(&accepted), 1);
        first.close(None).await.expect("disconnect after accepted");

        let mut second = accept_wss(&listener, server_config).await;
        let second_hello = receive_hello(&mut second).await;
        second
            .send(Message::text(
                serde_json::to_string(&welcome(&second_hello, 2)).expect("second welcome"),
            ))
            .await
            .expect("send second welcome");
        let replayed_accepted = receive_event(&mut second).await;
        let replayed_terminal = receive_event(&mut second).await;
        assert_eq!(event_sequence(&replayed_accepted), 1);
        assert_eq!(event_sequence(&replayed_terminal), 2);
        second
            .send(Message::text(
                serde_json::to_string(&ack(&replayed_terminal, 2)).expect("serialize replay ACK"),
            ))
            .await
            .expect("send replay ACK");
        second
            .send(Message::Ping(vec![9].into()))
            .await
            .expect("send ordering ping");
        loop {
            if let Message::Pong(_) = second.next().await.expect("pong frame").expect("read pong") {
                break;
            }
        }
        second.close(None).await.expect("close second WSS");
    });

    let mut terminal_events = fixture.runtime.state.events.subscribe();
    let first_socket = connect(&fixture, &url).await;
    run_socket_with_ready(Arc::clone(&fixture.runtime.state), first_socket, &|_| {})
        .await
        .expect("run first session");
    loop {
        let event = terminal_events
            .recv()
            .await
            .expect("terminal journal event");
        if runtime_event_sequence(&event) == 2 {
            break;
        }
    }
    let second_socket = connect(&fixture, &url).await;
    run_socket_with_ready(Arc::clone(&fixture.runtime.state), second_socket, &|_| {})
        .await
        .expect("run second session");
    server.await.expect("reconnect server");
}

#[tokio::test]
async fn rejects_untrusted_server_certificate_and_wrong_welcome_connection() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind wrong-cert listener");
    let url = Url::parse(&format!(
        "wss://localhost:{}/device/v1",
        listener.local_addr().expect("listener address").port()
    ))
    .expect("gateway URL");
    let trusted = runtime_fixture(url.clone(), ServerPin::Required).await;
    let untrusted = runtime_fixture(url.clone(), ServerPin::Omitted).await;
    let untrusted_server = Arc::clone(&untrusted.server_config);
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.expect("accept wrong-cert TCP");
        assert!(
            TlsAcceptor::from(untrusted_server)
                .accept(tcp)
                .await
                .is_err()
        );
    });
    assert!(trusted.runtime.connect_socket().await.is_err());
    server.await.expect("wrong-cert server");

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind wrong-welcome listener");
    let url = Url::parse(&format!(
        "wss://localhost:{}/device/v1",
        listener.local_addr().expect("listener address").port()
    ))
    .expect("gateway URL");
    let fixture = runtime_fixture(url.clone(), ServerPin::Required).await;
    let config = Arc::clone(&fixture.server_config);
    let server = tokio::spawn(async move {
        let mut socket = accept_wss(&listener, config).await;
        let hello = receive_hello(&mut socket).await;
        let mut rejected = welcome(&hello, 1);
        rejected.connection_id = "different-connection".to_string();
        socket
            .send(Message::text(
                serde_json::to_string(&rejected).expect("wrong welcome"),
            ))
            .await
            .expect("send wrong welcome");
    });
    let socket = connect(&fixture, &url).await;
    assert_eq!(
        run_socket_with_ready(Arc::clone(&fixture.runtime.state), socket, &|_| {})
            .await
            .expect_err("reject wrong welcome")
            .code,
        "device_runtime_welcome_identity_mismatch"
    );
    server.await.expect("wrong-welcome server");
}

#[tokio::test]
async fn rejects_oversized_wss_message_before_protocol_dispatch() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind oversized listener");
    let url = Url::parse(&format!(
        "wss://localhost:{}/device/v1",
        listener.local_addr().expect("listener address").port()
    ))
    .expect("gateway URL");
    let fixture = runtime_fixture(url.clone(), ServerPin::Required).await;
    let config = Arc::clone(&fixture.server_config);
    let server = tokio::spawn(async move {
        let mut socket = accept_wss(&listener, config).await;
        let hello = receive_hello(&mut socket).await;
        socket
            .send(Message::text(
                serde_json::to_string(&welcome(&hello, 1)).expect("serialize welcome"),
            ))
            .await
            .expect("send welcome");
        socket
            .send(Message::text("x".repeat(MAX_SOCKET_MESSAGE_BYTES + 1)))
            .await
            .expect("send oversized message");
    });
    let socket = connect(&fixture, &url).await;
    assert_eq!(
        run_socket_with_ready(Arc::clone(&fixture.runtime.state), socket, &|_| {})
            .await
            .expect_err("reject oversized WSS message")
            .code,
        "device_runtime_socket_failed"
    );
    server.await.expect("oversized server");
}

#[tokio::test]
async fn subscribe_before_snapshot_delivers_terminal_committed_after_snapshot() {
    let url = Url::parse("wss://localhost/device/v1").expect("gateway URL");
    let fixture = runtime_fixture(url, ServerPin::Omitted).await;
    let command = signed_command(&fixture, 2);
    let accepted = accepted_event(&command, 1);
    fixture
        .runtime
        .state
        .journal
        .prepare_workspace_list(&command, &accepted)
        .await
        .expect("prepare accepted");

    let mut handoff = fixture.runtime.state.events.subscribe();
    let snapshot = collect_replay_events(&fixture.runtime.state)
        .await
        .expect("snapshot replay");
    assert_eq!(
        snapshot,
        vec![RuntimeEvent::WorkspaceList(accepted.clone())]
    );
    let (outbound, mut wire) = tokio::sync::mpsc::channel(4);
    enqueue_replay_events(&outbound, &snapshot)
        .await
        .expect("enqueue snapshot first");

    let terminal = terminal_event(&command, &accepted);
    fixture
        .runtime
        .state
        .journal
        .record_terminal(&terminal)
        .await
        .expect("commit late terminal");
    fixture
        .runtime
        .state
        .events
        .send(RuntimeEvent::WorkspaceList(terminal.clone()))
        .expect("publish late terminal");
    let handed_off = handoff.recv().await.expect("handoff terminal");
    assert_eq!(handed_off, RuntimeEvent::WorkspaceList(terminal));
    outbound
        .send(Outbound::Event(Box::new(handed_off)))
        .await
        .expect("enqueue queued notification second");
    let mut wire_sequences = Vec::new();
    for _ in 0..2 {
        let Outbound::Event(event) = wire.recv().await.expect("wire event") else {
            panic!("event required");
        };
        wire_sequences.push(runtime_event_sequence(&event));
    }
    assert_eq!(wire_sequences, vec![1, 2]);
}

#[tokio::test]
async fn hello_omits_zero_acknowledgements_and_fails_closed_above_total_cap() {
    let url = Url::parse("wss://localhost/device/v1").expect("gateway URL");
    let fixture = runtime_fixture(url, ServerPin::Omitted).await;
    let first_command = signed_command(&fixture, 10);
    let first_accepted = accepted_event(&first_command, 1);
    fixture
        .runtime
        .state
        .journal
        .prepare_workspace_list(&first_command, &first_accepted)
        .await
        .expect("prepare unacknowledged");
    let hello = build_hello(&fixture.runtime.state, "connection-zero")
        .await
        .expect("build Hello");
    assert!(hello.last_acknowledged.is_empty());

    fixture
        .runtime
        .state
        .journal
        .acknowledge_workspace_list(&ack(&first_accepted, 1))
        .await
        .expect("ack first");
    for suffix in 11..=266 {
        let command = signed_command(&fixture, suffix);
        let accepted = accepted_event(&command, 1);
        fixture
            .runtime
            .state
            .journal
            .prepare_workspace_list(&command, &accepted)
            .await
            .expect("prepare acknowledged");
        fixture
            .runtime
            .state
            .journal
            .acknowledge_workspace_list(&ack(&accepted, 1))
            .await
            .expect("ack execution");
    }
    assert_eq!(
        build_hello(&fixture.runtime.state, "connection-over-cap")
            .await
            .expect_err("reject oversized Hello authority")
            .code,
        "device_runtime_acknowledgement_capacity_exceeded"
    );
}

async fn receive_hello<Stream>(
    socket: &mut tokio_tungstenite::WebSocketStream<Stream>,
) -> DeviceHello
where
    Stream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let Message::Text(text) = socket
        .next()
        .await
        .expect("Hello frame")
        .expect("read Hello")
    else {
        panic!("text Hello required");
    };
    parse_device_hello(serde_json::from_str(text.as_str()).expect("Hello JSON"))
        .expect("parse Hello")
}

async fn accept_wss(
    listener: &TcpListener,
    server_config: Arc<rustls::ServerConfig>,
) -> tokio_tungstenite::WebSocketStream<tokio_rustls::server::TlsStream<tokio::net::TcpStream>> {
    let (tcp, _) = listener.accept().await.expect("accept TCP");
    let tls = TlsAcceptor::from(server_config)
        .accept(tcp)
        .await
        .expect("accept mTLS");
    accept_async(tls).await.expect("accept WSS")
}

async fn connect(
    fixture: &crate::test_support::RuntimeFixture,
    url: &Url,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    assert_eq!(fixture.runtime.state.gateway_url, *url);
    fixture
        .runtime
        .connect_socket()
        .await
        .expect("connect mTLS WSS")
}

async fn receive_event<Stream>(
    socket: &mut tokio_tungstenite::WebSocketStream<Stream>,
) -> DeviceWorkspaceListEvent
where
    Stream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let Message::Text(text) = socket
        .next()
        .await
        .expect("event frame")
        .expect("read event")
    else {
        panic!("text event required");
    };
    parse_device_workspace_list_event(serde_json::from_str(text.as_str()).expect("event JSON"))
        .expect("parse event")
}

async fn receive_read_event<Stream>(
    socket: &mut tokio_tungstenite::WebSocketStream<Stream>,
) -> DeviceFilesystemReadEvent
where
    Stream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let Message::Text(text) = socket
        .next()
        .await
        .expect("read event frame")
        .expect("read event")
    else {
        panic!("text event required");
    };
    parse_device_filesystem_read_event(
        serde_json::from_str(text.as_str()).expect("read event JSON"),
    )
    .expect("parse read event")
}

fn read_sequence(event: &DeviceFilesystemReadEvent) -> u64 {
    match event {
        DeviceFilesystemReadEvent::Accepted { envelope, .. }
        | DeviceFilesystemReadEvent::Completed { envelope, .. }
        | DeviceFilesystemReadEvent::Failed { envelope, .. }
        | DeviceFilesystemReadEvent::Canceled { envelope, .. }
        | DeviceFilesystemReadEvent::UnknownOutcome { envelope, .. } => envelope.sequence,
    }
}

fn read_ack(event: &DeviceFilesystemReadEvent, through_sequence: u64) -> DeviceFilesystemReadAck {
    let envelope = match event {
        DeviceFilesystemReadEvent::Accepted { envelope, .. }
        | DeviceFilesystemReadEvent::Completed { envelope, .. }
        | DeviceFilesystemReadEvent::Failed { envelope, .. }
        | DeviceFilesystemReadEvent::Canceled { envelope, .. }
        | DeviceFilesystemReadEvent::UnknownOutcome { envelope, .. } => envelope,
    };
    DeviceFilesystemReadAck {
        schema_version: "crewon.device-filesystem-read-ack.v0".to_string(),
        protocol_version: envelope.protocol_version,
        command_kind: envelope.command_kind.clone(),
        device_id: envelope.device_id.clone(),
        execution_id: envelope.execution_id.clone(),
        receipt_id: envelope.receipt_id.clone(),
        connection_epoch: envelope.connection_epoch,
        workspace_binding_id: envelope.workspace_binding_id.clone(),
        incarnation_id: envelope.incarnation_id.clone(),
        command_digest: envelope.command_digest.clone(),
        through_sequence,
        acknowledged_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    }
}

fn event_sequence(event: &DeviceWorkspaceListEvent) -> u64 {
    match event {
        DeviceWorkspaceListEvent::Accepted { envelope, .. }
        | DeviceWorkspaceListEvent::Completed { envelope, .. }
        | DeviceWorkspaceListEvent::Failed { envelope, .. }
        | DeviceWorkspaceListEvent::Canceled { envelope, .. }
        | DeviceWorkspaceListEvent::UnknownOutcome { envelope, .. } => envelope.sequence,
    }
}

fn runtime_event_sequence(event: &RuntimeEvent) -> u64 {
    match event {
        RuntimeEvent::WorkspaceList(event) => event_sequence(event),
        RuntimeEvent::FilesystemRead(event) => match event {
            crewon_device_protocol::DeviceFilesystemReadEvent::Accepted { envelope, .. }
            | crewon_device_protocol::DeviceFilesystemReadEvent::Completed { envelope, .. }
            | crewon_device_protocol::DeviceFilesystemReadEvent::Failed { envelope, .. }
            | crewon_device_protocol::DeviceFilesystemReadEvent::Canceled { envelope, .. }
            | crewon_device_protocol::DeviceFilesystemReadEvent::UnknownOutcome {
                envelope, ..
            } => envelope.sequence,
        },
    }
}

fn event_execution_id(event: &DeviceWorkspaceListEvent) -> &str {
    match event {
        DeviceWorkspaceListEvent::Accepted { envelope, .. }
        | DeviceWorkspaceListEvent::Completed { envelope, .. }
        | DeviceWorkspaceListEvent::Failed { envelope, .. }
        | DeviceWorkspaceListEvent::Canceled { envelope, .. }
        | DeviceWorkspaceListEvent::UnknownOutcome { envelope, .. } => &envelope.execution_id,
    }
}
