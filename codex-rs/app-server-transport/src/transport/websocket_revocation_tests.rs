use super::AppServerWebSocketMessage;
use super::IncomingWebSocketMessage;
use super::run_websocket_connection;
use crate::TransportAuthenticatedPrincipal;
use crate::TransportAuthenticatedPrincipalSource;
use crate::TransportAuthentication;
use crate::TransportEvent;
use crate::TransportPrincipalRevocation;
use crate::TransportPrincipalRevocationRegistry;
use crate::transport::authenticated_principal::TransportAuthenticatedPrincipalSpec;
use crate::transport::principal_revocation::PrincipalRevocationGuard;
use crate::transport::principal_revocation::PrincipalRevocationSubscriptionState;
use axum::body::Bytes;
use pretty_assertions::assert_eq;
use std::collections::HashSet;
use std::convert::Infallible;
use std::time::Duration;
use time::OffsetDateTime;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

enum TestMessage {
    Text,
    Pong,
}

impl AppServerWebSocketMessage for TestMessage {
    fn text(_text: String) -> Self {
        Self::Text
    }

    fn pong(_payload: Bytes) -> Self {
        Self::Pong
    }

    fn into_incoming(self) -> Option<IncomingWebSocketMessage> {
        match self {
            Self::Text => Some(IncomingWebSocketMessage::Text(String::new())),
            Self::Pong => Some(IncomingWebSocketMessage::Pong),
        }
    }
}

fn principal(token_id: &str) -> TransportAuthenticatedPrincipal {
    let now = OffsetDateTime::now_utc().unix_timestamp();
    TransportAuthenticatedPrincipal::new(TransportAuthenticatedPrincipalSpec {
        source: TransportAuthenticatedPrincipalSource::WebSocketSignedBearer,
        issuer: "issuer-a".to_string(),
        audience: "crewon-app-server".to_string(),
        subject: "user-1".to_string(),
        tenant_id: "tenant-1".to_string(),
        space_id: "space-1".to_string(),
        token_id: token_id.to_string(),
        issued_at: now,
        expires_at: now + 60,
        binding: crate::TransportPrincipalBinding::LegacyUnbound,
    })
    .expect("test principal should be valid")
}

fn revocation_guard(
    registry: &TransportPrincipalRevocationRegistry,
    authentication: &TransportAuthentication,
) -> PrincipalRevocationGuard {
    match registry.subscribe(authentication) {
        PrincipalRevocationSubscriptionState::Active(subscription) => {
            PrincipalRevocationGuard::Active(subscription)
        }
        state => panic!("expected active subscription, got {state:?}"),
    }
}

async fn next_opened(
    events: &mut mpsc::Receiver<TransportEvent>,
) -> (crate::ConnectionId, CancellationToken) {
    match events.recv().await.expect("connection should open") {
        TransportEvent::ConnectionOpened {
            connection_id,
            disconnect_sender: Some(disconnect_sender),
            ..
        } => (connection_id, disconnect_sender),
        _ => panic!("expected connection opened event"),
    }
}

async fn next_closed(events: &mut mpsc::Receiver<TransportEvent>) -> crate::ConnectionId {
    match events.recv().await.expect("connection should close") {
        TransportEvent::ConnectionClosed { connection_id } => connection_id,
        _ => panic!("expected connection closed event"),
    }
}

#[tokio::test]
async fn revocation_disconnects_only_connections_with_the_exact_principal_key() {
    let registry = TransportPrincipalRevocationRegistry::new();
    let revoked_principal = principal("revoked-token");
    let other_principal = principal("other-token");
    let revoked_authentication =
        TransportAuthentication::AuthenticatedPrincipal(Box::new(revoked_principal.clone()));
    let other_authentication =
        TransportAuthentication::AuthenticatedPrincipal(Box::new(other_principal.clone()));
    let (transport_event_tx, mut transport_event_rx) = mpsc::channel(/*buffer*/ 8);

    let revoked_connection_a = tokio::spawn(run_websocket_connection(
        futures::sink::drain::<TestMessage>(),
        futures::stream::pending::<Result<TestMessage, Infallible>>(),
        transport_event_tx.clone(),
        revoked_authentication.clone(),
        revocation_guard(&registry, &revoked_authentication),
    ));
    let (revoked_connection_id_a, _) = next_opened(&mut transport_event_rx).await;

    let revoked_connection_b = tokio::spawn(run_websocket_connection(
        futures::sink::drain::<TestMessage>(),
        futures::stream::pending::<Result<TestMessage, Infallible>>(),
        transport_event_tx.clone(),
        revoked_authentication.clone(),
        revocation_guard(&registry, &revoked_authentication),
    ));
    let (revoked_connection_id_b, _) = next_opened(&mut transport_event_rx).await;

    let other_connection = tokio::spawn(run_websocket_connection(
        futures::sink::drain::<TestMessage>(),
        futures::stream::pending::<Result<TestMessage, Infallible>>(),
        transport_event_tx,
        other_authentication.clone(),
        revocation_guard(&registry, &other_authentication),
    ));
    let (other_connection_id, other_disconnect_sender) = next_opened(&mut transport_event_rx).await;

    registry
        .revoke(TransportPrincipalRevocation::for_verified_principal(
            &revoked_principal,
        ))
        .expect("revocation should be accepted");
    tokio::time::timeout(Duration::from_secs(1), revoked_connection_a)
        .await
        .expect("first revoked connection should stop")
        .expect("first revoked connection task should not panic");
    tokio::time::timeout(Duration::from_secs(1), revoked_connection_b)
        .await
        .expect("second revoked connection should stop")
        .expect("second revoked connection task should not panic");
    assert!(!other_connection.is_finished());
    let revoked_connection_ids = HashSet::from([
        next_closed(&mut transport_event_rx).await,
        next_closed(&mut transport_event_rx).await,
    ]);
    assert_eq!(
        revoked_connection_ids,
        HashSet::from([revoked_connection_id_a, revoked_connection_id_b])
    );

    other_disconnect_sender.cancel();
    tokio::time::timeout(Duration::from_secs(1), other_connection)
        .await
        .expect("other connection should stop when explicitly cancelled")
        .expect("other connection task should not panic");
    assert_eq!(
        next_closed(&mut transport_event_rx).await,
        other_connection_id
    );
}

#[tokio::test]
async fn revoke_between_subscription_and_connection_open_creates_no_session() {
    let registry = TransportPrincipalRevocationRegistry::new();
    let revoked_principal = principal("revoked-before-open");
    let authentication =
        TransportAuthentication::AuthenticatedPrincipal(Box::new(revoked_principal.clone()));
    let guard = revocation_guard(&registry, &authentication);
    registry
        .revoke(TransportPrincipalRevocation::for_verified_principal(
            &revoked_principal,
        ))
        .expect("revocation should be accepted");
    let (transport_event_tx, mut transport_event_rx) = mpsc::channel(/*buffer*/ 2);

    run_websocket_connection(
        futures::sink::drain::<TestMessage>(),
        futures::stream::pending::<Result<TestMessage, Infallible>>(),
        transport_event_tx,
        authentication,
        guard,
    )
    .await;

    assert!(matches!(
        transport_event_rx.try_recv(),
        Err(mpsc::error::TryRecvError::Disconnected)
    ));
}
