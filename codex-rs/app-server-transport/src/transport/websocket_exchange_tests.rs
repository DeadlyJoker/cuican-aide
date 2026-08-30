use std::sync::Arc;

use axum::Json;
use axum::body::to_bytes;
use axum::extract::State;
use pretty_assertions::assert_eq;
use tokio::sync::mpsc;

use super::WebSocketListenerState;
use super::principal_session_exchange_handler;
use crate::PrincipalSessionExchangeError;
use crate::PrincipalSessionExchangeResult;
use crate::PrincipalSessionExchangeService;
use crate::TransportPrincipalRevocationRegistry;
use crate::transport::auth::WebsocketAuthPolicy;
use crate::transport::principal_session_exchange::PrincipalSessionExchangeRequest;

#[tokio::test]
async fn exchange_handler_returns_only_bounded_non_cacheable_session_material() {
    let service = PrincipalSessionExchangeService::new(|bootstrap| async move {
        assert_eq!(bootstrap, "signed-bootstrap");
        PrincipalSessionExchangeResult::new("signed-session", 1_900_000_000)
    });
    let request: PrincipalSessionExchangeRequest = serde_json::from_value(serde_json::json!({
        "bootstrapToken": "signed-bootstrap"
    }))
    .expect("request");

    let response =
        principal_session_exchange_handler(State(state(Some(service))), Ok(Json(request))).await;
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["pragma"], "no-cache");
    let body = to_bytes(response.into_body(), 16 * 1024)
        .await
        .expect("response body");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).expect("response JSON"),
        serde_json::json!({
            "token": "signed-session",
            "expiresAt": 1_900_000_000_i64
        })
    );
}

#[tokio::test]
async fn exchange_handler_maps_authorization_failure_without_echoing_bootstrap() {
    let service = PrincipalSessionExchangeService::new(|_bootstrap| async move {
        Err(PrincipalSessionExchangeError::Unauthorized)
    });
    let request: PrincipalSessionExchangeRequest = serde_json::from_value(serde_json::json!({
        "bootstrapToken": "must-not-be-echoed"
    }))
    .expect("request");

    let response =
        principal_session_exchange_handler(State(state(Some(service))), Ok(Json(request))).await;
    assert_eq!(response.status(), 401);
    let body = to_bytes(response.into_body(), 16 * 1024)
        .await
        .expect("response body");
    assert_eq!(body.as_ref(), br#"{"code":"unauthorized"}"#);
}

fn state(
    principal_session_exchange: Option<PrincipalSessionExchangeService>,
) -> WebSocketListenerState {
    let (transport_event_tx, _transport_event_rx) = mpsc::channel(/*buffer*/ 1);
    WebSocketListenerState {
        transport_event_tx,
        auth_policy: Arc::new(WebsocketAuthPolicy::default()),
        principal_revocations: TransportPrincipalRevocationRegistry::new(),
        principal_session_exchange,
    }
}
