use super::CHANNEL_CAPACITY;
use super::ConnectionOrigin;
use super::TransportAuthentication;
use super::TransportEvent;
use super::auth::WebsocketAuthPolicy;
use super::auth::authorize_upgrade;
use super::auth::is_unauthenticated_non_loopback_listener;
use super::auth::principal_session_subprotocol;
use super::forward_incoming_message;
use super::next_connection_id;
use super::principal_revocation::PrincipalRevocationGuard;
use super::principal_revocation::PrincipalRevocationSubscriptionState;
use super::principal_revocation::TransportPrincipalRevocationRegistry;
use super::principal_session_exchange::PrincipalSessionExchangeError;
use super::principal_session_exchange::PrincipalSessionExchangeErrorResponse;
use super::principal_session_exchange::PrincipalSessionExchangeRequest;
use super::principal_session_exchange::PrincipalSessionExchangeResponse;
use super::principal_session_exchange::PrincipalSessionExchangeService;
use super::serialize_outgoing_message;
use crate::outgoing_message::ConnectionId;
use crate::outgoing_message::QueuedOutgoingMessage;
use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::body::Bytes;
use axum::extract::ConnectInfo;
use axum::extract::DefaultBodyLimit;
use axum::extract::State;
use axum::extract::rejection::JsonRejection;
use axum::extract::ws::Message as AxumWebSocketMessage;
use axum::extract::ws::WebSocketUpgrade;
use axum::http::HeaderMap;
use axum::http::Request;
use axum::http::StatusCode;
use axum::http::header::CACHE_CONTROL;
use axum::http::header::ORIGIN;
use axum::http::header::PRAGMA;
use axum::middleware;
use axum::middleware::Next;
use axum::response::IntoResponse;
use axum::response::Response;
use axum::routing::any;
use axum::routing::get;
use axum::routing::post;
use futures::SinkExt;
use futures::StreamExt;
use owo_colors::OwoColorize;
use owo_colors::Stream;
use owo_colors::Style;
use std::io::Result as IoResult;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message as TungsteniteWebSocketMessage;
use tokio_util::sync::CancellationToken;
use tracing::error;
use tracing::info;
use tracing::warn;

/// WebSocket clients can briefly lag behind normal turn output bursts while the
/// writer task is healthy, so give them more headroom than internal channels.
const WEBSOCKET_OUTBOUND_CHANNEL_CAPACITY: usize = 32 * 1024;
const PRINCIPAL_SESSION_EXCHANGE_BODY_LIMIT: usize = 16 * 1024;
const _: () = assert!(WEBSOCKET_OUTBOUND_CHANNEL_CAPACITY > CHANNEL_CAPACITY);

fn colorize(text: &str, style: Style) -> String {
    text.if_supports_color(Stream::Stderr, |value| value.style(style))
        .to_string()
}

#[allow(clippy::print_stderr)]
fn print_websocket_startup_banner(addr: SocketAddr) {
    let title = colorize("crewon-app-server (WebSockets)", Style::new().bold().cyan());
    let listening_label = colorize("listening on:", Style::new().dimmed());
    let listen_url = colorize(&format!("ws://{addr}"), Style::new().green());
    let ready_label = colorize("readyz:", Style::new().dimmed());
    let ready_url = colorize(&format!("http://{addr}/readyz"), Style::new().green());
    let health_label = colorize("healthz:", Style::new().dimmed());
    let health_url = colorize(&format!("http://{addr}/healthz"), Style::new().green());
    let note_label = colorize("note:", Style::new().dimmed());
    eprintln!("{title}");
    eprintln!("  {listening_label} {listen_url}");
    eprintln!("  {ready_label} {ready_url}");
    eprintln!("  {health_label} {health_url}");
    if addr.ip().is_loopback() {
        eprintln!(
            "  {note_label} binds localhost only (use SSH port-forwarding for remote access)"
        );
    } else {
        eprintln!("  {note_label} websocket auth is required for non-localhost listeners");
    }
}

#[derive(Clone)]
struct WebSocketListenerState {
    transport_event_tx: mpsc::Sender<TransportEvent>,
    auth_policy: Arc<WebsocketAuthPolicy>,
    principal_revocations: TransportPrincipalRevocationRegistry,
    principal_session_exchange: Option<PrincipalSessionExchangeService>,
}

async fn health_check_handler() -> StatusCode {
    StatusCode::OK
}

async fn principal_session_exchange_handler(
    State(state): State<WebSocketListenerState>,
    payload: Result<Json<PrincipalSessionExchangeRequest>, JsonRejection>,
) -> Response {
    let Some(exchange) = state.principal_session_exchange else {
        return principal_session_exchange_error(StatusCode::NOT_FOUND, "notFound");
    };
    let Ok(Json(request)) = payload else {
        return principal_session_exchange_error(StatusCode::BAD_REQUEST, "invalid");
    };
    match exchange.exchange(request.into_token()).await {
        Ok(result) => (
            [(CACHE_CONTROL, "no-store"), (PRAGMA, "no-cache")],
            Json(PrincipalSessionExchangeResponse::from(result)),
        )
            .into_response(),
        Err(PrincipalSessionExchangeError::Invalid) => {
            principal_session_exchange_error(StatusCode::BAD_REQUEST, "invalid")
        }
        Err(PrincipalSessionExchangeError::Unauthorized) => {
            principal_session_exchange_error(StatusCode::UNAUTHORIZED, "unauthorized")
        }
        Err(PrincipalSessionExchangeError::Conflict) => {
            principal_session_exchange_error(StatusCode::CONFLICT, "conflict")
        }
        Err(PrincipalSessionExchangeError::Unavailable) => {
            principal_session_exchange_error(StatusCode::SERVICE_UNAVAILABLE, "unavailable")
        }
    }
}

fn principal_session_exchange_error(status: StatusCode, code: &'static str) -> Response {
    (
        status,
        [(CACHE_CONTROL, "no-store"), (PRAGMA, "no-cache")],
        Json(PrincipalSessionExchangeErrorResponse::new(code)),
    )
        .into_response()
}

async fn reject_requests_with_origin_header(
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    if request.headers().contains_key(ORIGIN) {
        warn!(
            method = %request.method(),
            uri = %request.uri(),
            "rejecting websocket listener request with Origin header"
        );
        Err(StatusCode::FORBIDDEN)
    } else {
        Ok(next.run(request).await)
    }
}

async fn websocket_upgrade_handler(
    websocket: WebSocketUpgrade,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    State(state): State<WebSocketListenerState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let authentication = match authorize_upgrade(&headers, state.auth_policy.as_ref()) {
        Ok(authentication) => authentication,
        Err(err) => {
            warn!(
                %peer_addr,
                message = err.message(),
                "rejecting websocket client during upgrade"
            );
            return (err.status_code(), err.message()).into_response();
        }
    };
    let websocket = match principal_session_subprotocol(state.auth_policy.as_ref()) {
        Some(protocol) => websocket.protocols([protocol]),
        None => websocket,
    };
    let principal_revocation = match state.principal_revocations.subscribe(&authentication) {
        PrincipalRevocationSubscriptionState::NotApplicable => {
            PrincipalRevocationGuard::NotApplicable
        }
        PrincipalRevocationSubscriptionState::Revoked => {
            warn!(%peer_addr, "rejecting websocket client with revoked authenticated principal");
            return (StatusCode::UNAUTHORIZED, "revoked websocket principal").into_response();
        }
        PrincipalRevocationSubscriptionState::Active(subscription) => {
            PrincipalRevocationGuard::Active(subscription)
        }
    };
    info!(%peer_addr, "websocket client connected");
    websocket
        .on_upgrade(move |stream| async move {
            let (websocket_writer, websocket_reader) = stream.split();
            run_websocket_connection(
                websocket_writer,
                websocket_reader,
                state.transport_event_tx,
                authentication,
                principal_revocation,
            )
            .await;
        })
        .into_response()
}

pub async fn start_websocket_acceptor(
    bind_address: SocketAddr,
    transport_event_tx: mpsc::Sender<TransportEvent>,
    shutdown_token: CancellationToken,
    auth_policy: WebsocketAuthPolicy,
) -> IoResult<JoinHandle<()>> {
    start_websocket_acceptor_with_principal_revocation(
        bind_address,
        transport_event_tx,
        shutdown_token,
        auth_policy,
        TransportPrincipalRevocationRegistry::new(),
    )
    .await
}

/// Starts a websocket listener backed by an externally populated principal
/// revocation registry.
///
/// Callers must publish only events from a trusted identity-provider or logout
/// source, preload its authoritative unexpired snapshot before starting the
/// listener, and call [`TransportPrincipalRevocationRegistry::mark_freshness_unknown`]
/// if feed freshness is lost. The compatibility
/// [`start_websocket_acceptor`] entry uses an empty registry because the CLI
/// currently has no external revocation feed.
pub async fn start_websocket_acceptor_with_principal_revocation(
    bind_address: SocketAddr,
    transport_event_tx: mpsc::Sender<TransportEvent>,
    shutdown_token: CancellationToken,
    auth_policy: WebsocketAuthPolicy,
    principal_revocations: TransportPrincipalRevocationRegistry,
) -> IoResult<JoinHandle<()>> {
    start_websocket_acceptor_with_principal_services(
        bind_address,
        transport_event_tx,
        shutdown_token,
        auth_policy,
        principal_revocations,
        None,
    )
    .await
}

/// Starts the supervised principal-session WebSocket and bootstrap exchange boundary.
pub async fn start_websocket_acceptor_with_principal_services(
    bind_address: SocketAddr,
    transport_event_tx: mpsc::Sender<TransportEvent>,
    shutdown_token: CancellationToken,
    auth_policy: WebsocketAuthPolicy,
    principal_revocations: TransportPrincipalRevocationRegistry,
    principal_session_exchange: Option<PrincipalSessionExchangeService>,
) -> IoResult<JoinHandle<()>> {
    if is_unauthenticated_non_loopback_listener(bind_address, &auth_policy) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "refusing to start non-loopback websocket listener {bind_address} without auth; configure `--ws-auth capability-token` or `--ws-auth signed-bearer-token`"
            ),
        ));
    }
    let listener = TcpListener::bind(bind_address).await?;
    let local_addr = listener.local_addr()?;
    print_websocket_startup_banner(local_addr);
    info!("app-server websocket listening on ws://{local_addr}");

    let exchange_enabled = principal_session_exchange.is_some();
    let state = WebSocketListenerState {
        transport_event_tx,
        auth_policy: Arc::new(auth_policy),
        principal_revocations,
        principal_session_exchange,
    };
    let mut router = Router::new()
        .route("/readyz", get(health_check_handler))
        .route("/healthz", get(health_check_handler));
    if exchange_enabled {
        router = router.route(
            "/principal-session/exchange",
            post(principal_session_exchange_handler),
        );
    }
    let router = router
        .fallback(any(websocket_upgrade_handler))
        .layer(DefaultBodyLimit::max(PRINCIPAL_SESSION_EXCHANGE_BODY_LIMIT))
        .layer(middleware::from_fn(reject_requests_with_origin_header))
        .with_state(state);
    let server = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_token.cancelled().await;
    });
    Ok(tokio::spawn(async move {
        if let Err(err) = server.await {
            error!("websocket acceptor failed: {err}");
        }
        info!("websocket acceptor shutting down");
    }))
}

pub(crate) async fn run_websocket_connection<M, SinkError, StreamError>(
    websocket_writer: impl futures::sink::Sink<M, Error = SinkError> + Send + 'static,
    websocket_reader: impl futures::stream::Stream<Item = Result<M, StreamError>> + Send + 'static,
    transport_event_tx: mpsc::Sender<TransportEvent>,
    authentication: TransportAuthentication,
    principal_revocation: PrincipalRevocationGuard,
) where
    M: AppServerWebSocketMessage + Send + 'static,
    SinkError: Send + 'static,
    StreamError: std::fmt::Display + Send + 'static,
{
    let connection_id = next_connection_id();
    let (writer_tx, writer_rx) =
        mpsc::channel::<QueuedOutgoingMessage>(WEBSOCKET_OUTBOUND_CHANNEL_CAPACITY);
    let writer_tx_for_reader = writer_tx.clone();
    let disconnect_token = CancellationToken::new();
    let authentication_deadline = authentication.expires_at().map(|expires_at| {
        u64::try_from(expires_at)
            .ok()
            .and_then(|seconds| UNIX_EPOCH.checked_add(Duration::from_secs(seconds)))
            .unwrap_or(UNIX_EPOCH)
    });
    if authentication_deadline.is_some_and(|deadline| deadline <= SystemTime::now()) {
        return;
    }
    if principal_revocation.is_revoked() {
        return;
    }
    if transport_event_tx
        .send(TransportEvent::ConnectionOpened {
            connection_id,
            origin: ConnectionOrigin::WebSocket,
            authentication,
            writer: writer_tx,
            disconnect_sender: Some(disconnect_token.clone()),
        })
        .await
        .is_err()
    {
        return;
    }

    let (writer_control_tx, writer_control_rx) = mpsc::channel::<M>(CHANNEL_CAPACITY);
    let mut outbound_task = tokio::spawn(run_websocket_outbound_loop(
        websocket_writer,
        writer_rx,
        writer_control_rx,
        disconnect_token.clone(),
    ));
    let mut inbound_task = tokio::spawn(run_websocket_inbound_loop(
        websocket_reader,
        transport_event_tx.clone(),
        writer_tx_for_reader,
        writer_control_tx,
        connection_id,
        disconnect_token.clone(),
    ));
    let expiry_wait = async move {
        let Some(deadline) = authentication_deadline else {
            std::future::pending::<()>().await;
            return;
        };
        let wait_for = deadline
            .duration_since(SystemTime::now())
            .unwrap_or_default();
        tokio::time::sleep(wait_for).await;
    };
    tokio::pin!(expiry_wait);
    let revocation_wait = principal_revocation.wait_until_revoked();
    tokio::pin!(revocation_wait);

    tokio::select! {
        _ = &mut outbound_task => {
            disconnect_token.cancel();
            inbound_task.abort();
        }
        _ = &mut inbound_task => {
            disconnect_token.cancel();
            outbound_task.abort();
        }
        _ = &mut expiry_wait => {
            info!(?connection_id, "disconnecting websocket client because its authenticated principal expired");
            disconnect_token.cancel();
            outbound_task.abort();
            inbound_task.abort();
        }
        _ = &mut revocation_wait => {
            info!(?connection_id, "disconnecting websocket client because its authenticated principal was revoked");
            disconnect_token.cancel();
            outbound_task.abort();
            inbound_task.abort();
        }
    }

    let _ = transport_event_tx
        .send(TransportEvent::ConnectionClosed { connection_id })
        .await;
}

pub(crate) enum IncomingWebSocketMessage {
    Text(String),
    Binary,
    Ping(Bytes),
    Pong,
    Close,
}

/// Converts concrete WebSocket message types into the small message surface the
/// app-server transport needs, and constructs the only outbound frames it
/// sends directly.
pub(crate) trait AppServerWebSocketMessage: Sized {
    fn text(text: String) -> Self;
    fn pong(payload: Bytes) -> Self;
    fn into_incoming(self) -> Option<IncomingWebSocketMessage>;
}

impl AppServerWebSocketMessage for AxumWebSocketMessage {
    fn text(text: String) -> Self {
        Self::Text(text.into())
    }

    fn pong(payload: Bytes) -> Self {
        Self::Pong(payload)
    }

    fn into_incoming(self) -> Option<IncomingWebSocketMessage> {
        Some(match self {
            Self::Text(text) => IncomingWebSocketMessage::Text(text.to_string()),
            Self::Binary(_) => IncomingWebSocketMessage::Binary,
            Self::Ping(payload) => IncomingWebSocketMessage::Ping(payload),
            Self::Pong(_) => IncomingWebSocketMessage::Pong,
            Self::Close(_) => IncomingWebSocketMessage::Close,
        })
    }
}

impl AppServerWebSocketMessage for TungsteniteWebSocketMessage {
    fn text(text: String) -> Self {
        Self::Text(text.into())
    }

    fn pong(payload: Bytes) -> Self {
        Self::Pong(payload)
    }

    fn into_incoming(self) -> Option<IncomingWebSocketMessage> {
        Some(match self {
            Self::Text(text) => IncomingWebSocketMessage::Text(text.to_string()),
            Self::Binary(_) => IncomingWebSocketMessage::Binary,
            Self::Ping(payload) => IncomingWebSocketMessage::Ping(payload),
            Self::Pong(_) => IncomingWebSocketMessage::Pong,
            Self::Close(_) => IncomingWebSocketMessage::Close,
            Self::Frame(_) => return None,
        })
    }
}

async fn run_websocket_outbound_loop<M, SinkError>(
    websocket_writer: impl futures::sink::Sink<M, Error = SinkError> + Send + 'static,
    mut writer_rx: mpsc::Receiver<QueuedOutgoingMessage>,
    mut writer_control_rx: mpsc::Receiver<M>,
    disconnect_token: CancellationToken,
) where
    M: AppServerWebSocketMessage + Send + 'static,
    SinkError: Send + 'static,
{
    tokio::pin!(websocket_writer);
    loop {
        tokio::select! {
            _ = disconnect_token.cancelled() => {
                break;
            }
            message = writer_control_rx.recv() => {
                let Some(message) = message else {
                    break;
                };
                if websocket_writer.send(message).await.is_err() {
                    break;
                }
            }
            queued_message = writer_rx.recv() => {
                let Some(queued_message) = queued_message else {
                    break;
                };
                let Some(json) = serialize_outgoing_message(queued_message.message) else {
                    continue;
                };
                if websocket_writer.send(M::text(json)).await.is_err() {
                    break;
                }
                if let Some(write_complete_tx) = queued_message.write_complete_tx {
                    let _ = write_complete_tx.send(());
                }
            }
        }
    }
}

async fn run_websocket_inbound_loop<M, StreamError>(
    websocket_reader: impl futures::stream::Stream<Item = Result<M, StreamError>> + Send + 'static,
    transport_event_tx: mpsc::Sender<TransportEvent>,
    writer_tx_for_reader: mpsc::Sender<QueuedOutgoingMessage>,
    writer_control_tx: mpsc::Sender<M>,
    connection_id: ConnectionId,
    disconnect_token: CancellationToken,
) where
    M: AppServerWebSocketMessage + Send + 'static,
    StreamError: std::fmt::Display + Send + 'static,
{
    tokio::pin!(websocket_reader);
    loop {
        tokio::select! {
            _ = disconnect_token.cancelled() => {
                break;
            }
            incoming_message = websocket_reader.next() => {
                match incoming_message {
                    Some(Ok(message)) => match message.into_incoming() {
                        Some(IncomingWebSocketMessage::Text(text))
                            if !forward_incoming_message(
                                &transport_event_tx,
                                &writer_tx_for_reader,
                                connection_id,
                                &text,
                            )
                            .await
                        => {
                            break;
                        }
                        Some(IncomingWebSocketMessage::Text(_)) => {}
                        Some(IncomingWebSocketMessage::Ping(payload)) => {
                            match writer_control_tx.try_send(M::pong(payload)) {
                                Ok(()) => {}
                                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => break,
                                Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                                    warn!("websocket control queue full while replying to ping; closing connection");
                                    break;
                                }
                            }
                        }
                        Some(IncomingWebSocketMessage::Pong) => {}
                        Some(IncomingWebSocketMessage::Close) => break,
                        Some(IncomingWebSocketMessage::Binary) => {
                            warn!("dropping unsupported binary websocket message");
                        }
                        None => {}
                    },
                    None => break,
                    Some(Err(err)) => {
                        warn!("websocket receive error: {err}");
                        break;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "websocket_revocation_tests.rs"]
mod revocation_tests;

#[cfg(test)]
#[path = "websocket_exchange_tests.rs"]
mod exchange_tests;
