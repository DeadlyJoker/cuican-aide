use super::*;
use crate::transport::TransportAuthenticatedPrincipalSource;
use crate::transport::TransportAuthentication;
use axum::http::HeaderValue;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::Hmac;
use hmac::Mac;
use pretty_assertions::assert_eq;
use serde_json::json;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

const SHARED_SECRET: &[u8] = b"0123456789abcdef0123456789abcdef";
const NOW: i64 = 1_000;

fn signed_token(claims: serde_json::Value) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).expect("serialize claims"));
    let payload = format!("{header}.{claims}");
    let mut mac = HmacSha256::new_from_slice(SHARED_SECRET).expect("create hmac");
    mac.update(payload.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{payload}.{signature}")
}

fn complete_claims() -> serde_json::Value {
    json!({
        "exp": NOW + 300,
        "iat": NOW,
        "iss": "crewon-enroller",
        "aud": "crewon-app-server",
        "sub": "user:42",
        "tenantId": "tenant-7",
        "spaceId": "space-9",
        "jti": "session-jti",
    })
}

fn verify_at(
    claims: serde_json::Value,
    issuer: Option<&str>,
    audience: Option<&str>,
) -> Result<TransportAuthentication, WebsocketAuthError> {
    verify_signed_bearer_token_at(
        &signed_token(claims),
        SHARED_SECRET,
        issuer,
        audience,
        /*max_clock_skew_seconds*/ 30,
        NOW,
    )
}

#[test]
fn complete_claims_produce_redacted_verified_principal() {
    let authentication = verify_at(
        complete_claims(),
        Some("crewon-enroller"),
        Some("crewon-app-server"),
    )
    .expect("complete claims should verify");
    let TransportAuthentication::AuthenticatedPrincipal(principal) = authentication else {
        panic!("complete claims should produce a principal");
    };

    assert_eq!(
        principal.source(),
        TransportAuthenticatedPrincipalSource::WebSocketSignedBearer
    );
    assert_eq!(principal.issuer(), "crewon-enroller");
    assert_eq!(principal.audience(), "crewon-app-server");
    assert_eq!(principal.subject(), "user:42");
    assert_eq!(principal.tenant_id(), "tenant-7");
    assert_eq!(principal.space_id(), "space-9");
    assert_eq!(principal.token_id(), "session-jti");
    assert_eq!(principal.issued_at(), NOW);
    assert_eq!(principal.expires_at(), NOW + 300);

    let debug = format!("{principal:?}");
    for sensitive in [
        "crewon-enroller",
        "crewon-app-server",
        "user:42",
        "tenant-7",
        "space-9",
        "session-jti",
    ] {
        assert!(!debug.contains(sensitive));
    }
}

#[test]
fn legacy_and_capability_tokens_remain_connection_scoped() {
    assert_eq!(
        authorize_upgrade(&HeaderMap::new(), &WebsocketAuthPolicy::default())
            .expect("loopback policy without auth should remain connection scoped"),
        TransportAuthentication::ConnectionScoped
    );
    assert_eq!(
        verify_at(
            json!({
                "exp": NOW + 300,
                "iss": "crewon-enroller",
                "aud": "crewon-app-server",
            }),
            Some("crewon-enroller"),
            Some("crewon-app-server"),
        )
        .expect("legacy token should verify"),
        TransportAuthentication::ConnectionScoped
    );

    let token = "capability-secret";
    let policy = WebsocketAuthPolicy {
        mode: Some(WebsocketAuthMode::CapabilityToken {
            token_sha256: sha256_digest(token.as_bytes()),
        }),
    };
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).expect("authorization header"),
    );
    assert_eq!(
        authorize_upgrade(&headers, &policy).expect("capability token should verify"),
        TransportAuthentication::ConnectionScoped
    );
}

#[test]
fn principal_session_subprotocol_carries_one_token_without_changing_legacy_auth() {
    let mut headers = HeaderMap::new();
    headers.insert(
        SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static("crewon.principal-session.v1, signed.session.token"),
    );
    assert_eq!(
        principal_session_token_from_headers(&headers).expect("subprotocol token"),
        "signed.session.token"
    );

    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_static("Bearer signed.session.token"),
    );
    let error = principal_session_token_from_headers(&headers)
        .expect_err("two credential transports must be rejected");
    assert_eq!(error.status_code(), StatusCode::UNAUTHORIZED);
}

#[test]
fn principal_session_subprotocol_is_not_advertised_for_legacy_policies() {
    assert_eq!(
        principal_session_subprotocol(&WebsocketAuthPolicy::default()),
        None
    );
    let policy = WebsocketAuthPolicy {
        mode: Some(WebsocketAuthMode::CapabilityToken {
            token_sha256: [0; 32],
        }),
    };
    assert_eq!(principal_session_subprotocol(&policy), None);
}

#[test]
fn authentication_policy_debug_exposes_only_the_mode() {
    let policy = WebsocketAuthPolicy {
        mode: Some(WebsocketAuthMode::SignedBearerToken {
            shared_secret: b"debug-must-not-leak-this-secret".to_vec(),
            issuer: Some("private-issuer".to_string()),
            audience: Some("private-audience".to_string()),
            max_clock_skew_seconds: 30,
        }),
    };
    let debug = format!("{policy:?}");

    assert_eq!(
        debug,
        "WebsocketAuthPolicy { mode: Some(\"signed-bearer-token\") }"
    );
}

#[test]
fn signed_bearer_clock_skew_has_a_hard_upper_bound() {
    let error = AppServerWebsocketAuthArgs {
        ws_auth: Some(WebsocketAuthCliMode::SignedBearerToken),
        ws_shared_secret_file: Some(PathBuf::from("/tmp/secret")),
        ws_max_clock_skew_seconds: Some(MAX_SIGNED_BEARER_CLOCK_SKEW_SECONDS + 1),
        ..Default::default()
    }
    .try_into_settings()
    .expect_err("oversized clock skew should fail closed");

    assert_eq!(
        error.to_string(),
        "websocket auth clock skew must not exceed 300 seconds"
    );

    let settings = AppServerWebsocketAuthSettings {
        config: Some(AppServerWebsocketAuthConfig::SignedBearerToken {
            shared_secret_file: AbsolutePathBuf::from_absolute_path("/missing/secret")
                .expect("absolute path"),
            issuer: Some("issuer-a".to_string()),
            audience: Some("crewon-app-server".to_string()),
            max_clock_skew_seconds: MAX_SIGNED_BEARER_CLOCK_SKEW_SECONDS + 1,
        }),
    };
    let error = policy_from_settings(&settings)
        .expect_err("direct settings construction should enforce the same hard bound");
    assert_eq!(error.kind(), ErrorKind::InvalidInput);
    assert_eq!(
        error.to_string(),
        "websocket auth clock skew must not exceed 300 seconds"
    );
}

#[test]
fn partial_or_null_principal_claims_fail_closed() {
    for claims in [
        json!({
            "exp": NOW + 300,
            "iss": "crewon-enroller",
            "aud": "crewon-app-server",
            "sub": "user:42",
        }),
        json!({
            "exp": NOW + 300,
            "iat": NOW,
            "iss": "crewon-enroller",
            "aud": "crewon-app-server",
            "sub": null,
            "tenantId": "tenant-7",
            "spaceId": "space-9",
            "jti": "session-jti",
        }),
    ] {
        let error = verify_at(claims, Some("crewon-enroller"), Some("crewon-app-server"))
            .expect_err("partial principal must fail");
        assert_eq!(error.status_code(), StatusCode::UNAUTHORIZED);
    }
}

#[test]
fn principal_requires_fixed_authority_and_valid_bounded_times() {
    let mut future_issued_at = complete_claims();
    future_issued_at["iat"] = json!(NOW + 31);
    let mut expired = complete_claims();
    expired["exp"] = json!(NOW);
    let mut overlong = complete_claims();
    overlong["exp"] = json!(NOW + 3_601);
    let mut oversized_subject = complete_claims();
    oversized_subject["sub"] = json!("x".repeat(256));

    for (claims, issuer, audience) in [
        (complete_claims(), None, Some("crewon-app-server")),
        (complete_claims(), Some("crewon-enroller"), None),
        (
            future_issued_at,
            Some("crewon-enroller"),
            Some("crewon-app-server"),
        ),
        (expired, Some("crewon-enroller"), Some("crewon-app-server")),
        (overlong, Some("crewon-enroller"), Some("crewon-app-server")),
        (
            oversized_subject,
            Some("crewon-enroller"),
            Some("crewon-app-server"),
        ),
    ] {
        let error = verify_at(claims, issuer, audience)
            .expect_err("invalid principal authority or lifetime must fail");
        assert_eq!(error.status_code(), StatusCode::UNAUTHORIZED);
    }
}
