use super::TransportAuthenticatedPrincipal;
use super::TransportAuthenticatedPrincipalSource;
use super::TransportAuthentication;
use super::TransportPrincipalBinding;
use super::authenticated_principal::TransportAuthenticatedPrincipalSpec;
use super::principal_revocation::MAX_ACTIVE_REVOCATIONS;
use super::principal_revocation::PrincipalRevocationSubscriptionState;
use super::principal_revocation::TransportPrincipalRevocation;
use super::principal_revocation::TransportPrincipalRevocationError;
use super::principal_revocation::TransportPrincipalRevocationRegistry;
use super::principal_revocation::TransportPrincipalRevocationSpec;
use pretty_assertions::assert_eq;
use std::time::Duration;
use time::OffsetDateTime;

fn principal(issuer: &str, token_id: &str) -> TransportAuthenticatedPrincipal {
    let now = OffsetDateTime::now_utc().unix_timestamp();
    TransportAuthenticatedPrincipal::new(TransportAuthenticatedPrincipalSpec {
        source: TransportAuthenticatedPrincipalSource::WebSocketSignedBearer,
        issuer: issuer.to_string(),
        audience: "crewon-app-server".to_string(),
        subject: "user-1".to_string(),
        tenant_id: "tenant-1".to_string(),
        space_id: "space-1".to_string(),
        token_id: token_id.to_string(),
        issued_at: now,
        expires_at: now + 60,
        binding: super::TransportPrincipalBinding::LegacyUnbound,
    })
    .expect("test principal should be valid")
}

#[test]
fn authenticated_principal_source_and_binding_cannot_be_cross_wired() {
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let spec =
        |source, binding| super::authenticated_principal::TransportAuthenticatedPrincipalSpec {
            source,
            issuer: "issuer-a".to_string(),
            audience: "crewon-app-server".to_string(),
            subject: "user:42".to_string(),
            tenant_id: "7".to_string(),
            space_id: "11".to_string(),
            token_id: "019f6f00-0000-7000-8000-000000000002".to_string(),
            issued_at: now,
            expires_at: now + 60,
            binding,
        };
    let agent_platform_binding = TransportPrincipalBinding::AgentPlatform {
        actor_id: "principal:6f7900eaed3218b4c15249cad129ed96bf1bde4d0524fa4b6fad1ba325e8ef3f"
            .to_string(),
        source_binding_id: "019f6f00-0000-7000-8000-000000000001".to_string(),
        source_revision: 1,
    };

    assert!(
        TransportAuthenticatedPrincipal::new(spec(
            TransportAuthenticatedPrincipalSource::WebSocketSignedBearer,
            agent_platform_binding,
        ))
        .is_err()
    );
    assert!(
        TransportAuthenticatedPrincipal::new(spec(
            TransportAuthenticatedPrincipalSource::WebSocketPrincipalSessionRs256,
            TransportPrincipalBinding::LegacyUnbound,
        ))
        .is_err()
    );
}

fn active_subscription(
    registry: &TransportPrincipalRevocationRegistry,
    principal: &TransportAuthenticatedPrincipal,
) -> super::principal_revocation::TransportPrincipalRevocationSubscription {
    match registry.subscribe(&TransportAuthentication::AuthenticatedPrincipal(Box::new(
        principal.clone(),
    ))) {
        PrincipalRevocationSubscriptionState::Active(subscription) => subscription,
        state => panic!("expected active subscription, got {state:?}"),
    }
}

#[tokio::test]
async fn revocation_is_exact_idempotent_and_visible_before_subscribe() {
    let registry = TransportPrincipalRevocationRegistry::new();
    let target = principal("issuer-a", "token-a");
    let other_token = principal("issuer-a", "token-b");
    let other_issuer = principal("issuer-b", "token-a");
    let target_subscription = active_subscription(&registry, &target);
    let other_token_subscription = active_subscription(&registry, &other_token);
    let other_issuer_subscription = active_subscription(&registry, &other_issuer);

    let revocation = TransportPrincipalRevocation::for_verified_principal(&target);
    registry
        .revoke(revocation.clone())
        .expect("revocation should be accepted");
    registry
        .revoke(revocation)
        .expect("duplicate revocation should be idempotent");

    tokio::time::timeout(
        Duration::from_secs(1),
        target_subscription.wait_until_revoked(),
    )
    .await
    .expect("target subscription should observe revocation");
    assert!(!other_token_subscription.is_revoked());
    assert!(!other_issuer_subscription.is_revoked());
    assert!(matches!(
        registry.subscribe(&TransportAuthentication::AuthenticatedPrincipal(Box::new(
            target,
        ))),
        PrincipalRevocationSubscriptionState::Revoked
    ));
    assert!(matches!(
        registry.subscribe(&TransportAuthentication::ConnectionScoped),
        PrincipalRevocationSubscriptionState::NotApplicable
    ));
}

#[tokio::test]
async fn lagged_subscriber_recovers_from_bounded_snapshot() {
    let registry = TransportPrincipalRevocationRegistry::new();
    let target = principal("issuer-a", "target");
    let subscription = active_subscription(&registry, &target);

    for index in 0..200 {
        let unrelated = principal("issuer-a", &format!("unrelated-{index}"));
        registry
            .revoke(TransportPrincipalRevocation::for_verified_principal(
                &unrelated,
            ))
            .expect("unrelated revocation should be accepted");
    }
    registry
        .revoke(TransportPrincipalRevocation::for_verified_principal(
            &target,
        ))
        .expect("target revocation should be accepted");

    tokio::time::timeout(Duration::from_secs(1), subscription.wait_until_revoked())
        .await
        .expect("lagged subscription should recover from the current snapshot");
}

#[tokio::test]
async fn freshness_loss_permanently_fails_closed_and_wakes_active_subscribers() {
    let registry = TransportPrincipalRevocationRegistry::new();
    let target = principal("issuer-a", "freshness-target");
    let subscription = active_subscription(&registry, &target);

    registry.mark_freshness_unknown();
    assert!(registry.is_freshness_unknown());

    tokio::time::timeout(Duration::from_secs(1), subscription.wait_until_revoked())
        .await
        .expect("freshness loss should wake active authenticated connections");
    assert!(matches!(
        registry.subscribe(&TransportAuthentication::AuthenticatedPrincipal(Box::new(
            target,
        ))),
        PrincipalRevocationSubscriptionState::Revoked
    ));
    assert!(matches!(
        registry.subscribe(&TransportAuthentication::ConnectionScoped),
        PrincipalRevocationSubscriptionState::NotApplicable
    ));
}

#[test]
fn capacity_exhaustion_fails_closed_without_leaking_claims() {
    let registry = TransportPrincipalRevocationRegistry::new();
    let target = principal("target-issuer", "target-token");
    let target_subscription = active_subscription(&registry, &target);

    for index in 0..=MAX_ACTIVE_REVOCATIONS {
        let revoked = principal("overflow-issuer", &format!("overflow-{index}"));
        registry
            .revoke(TransportPrincipalRevocation::for_verified_principal(
                &revoked,
            ))
            .expect("bounded overflow should fail closed, not reject the event");
    }

    assert!(target_subscription.is_revoked());
    assert!(matches!(
        registry.subscribe(&TransportAuthentication::AuthenticatedPrincipal(Box::new(
            target.clone(),
        ))),
        PrincipalRevocationSubscriptionState::Revoked
    ));
    let debug = format!(
        "{:?}",
        TransportPrincipalRevocation::for_verified_principal(&target)
    );
    assert_eq!(
        debug,
        "TransportPrincipalRevocation { source: WebSocketSignedBearer, issuer: \"[REDACTED]\", token_id: \"[REDACTED]\", expires_at: \"[REDACTED]\" }"
    );
    assert!(!debug.contains("target-issuer"));
    assert!(!debug.contains("target-token"));
}

#[test]
fn external_revocation_input_is_bounded_and_time_limited() {
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let invalid = TransportPrincipalRevocation::new(TransportPrincipalRevocationSpec {
        source: TransportAuthenticatedPrincipalSource::WebSocketSignedBearer,
        issuer: "issuer-a\n".to_string(),
        token_id: "token-a".to_string(),
        expires_at: now + 60,
    })
    .expect_err("control characters should be rejected");
    assert_eq!(invalid, TransportPrincipalRevocationError::Invalid);

    let invalid_now = TransportPrincipalRevocation::new(TransportPrincipalRevocationSpec {
        source: TransportAuthenticatedPrincipalSource::WebSocketSignedBearer,
        issuer: "issuer-a".to_string(),
        token_id: "token-a".to_string(),
        expires_at: 100,
    })
    .expect("the event shape should be valid");
    assert_eq!(
        TransportPrincipalRevocationRegistry::new()
            .revoke_at(invalid_now, /*now*/ -1)
            .expect_err("negative source time should be rejected"),
        TransportPrincipalRevocationError::Invalid
    );

    let registry = TransportPrincipalRevocationRegistry::new();
    let overlong = TransportPrincipalRevocation::new(TransportPrincipalRevocationSpec {
        source: TransportAuthenticatedPrincipalSource::WebSocketSignedBearer,
        issuer: "issuer-a".to_string(),
        token_id: "token-a".to_string(),
        expires_at: now + 4_000,
    })
    .expect("the event shape should be valid before freshness validation");
    assert_eq!(
        registry
            .revoke(overlong)
            .expect_err("unbounded retention should be rejected"),
        TransportPrincipalRevocationError::RetentionTooLong
    );
}

#[test]
fn expired_revocations_are_removed_from_the_authoritative_snapshot() {
    let registry = TransportPrincipalRevocationRegistry::new();
    let target = principal("issuer-a", "expires-at-100");
    let authentication = TransportAuthentication::AuthenticatedPrincipal(Box::new(target));
    let revocation = TransportPrincipalRevocation::new(TransportPrincipalRevocationSpec {
        source: TransportAuthenticatedPrincipalSource::WebSocketSignedBearer,
        issuer: "issuer-a".to_string(),
        token_id: "expires-at-100".to_string(),
        expires_at: 100,
    })
    .expect("fixed-time revocation should be valid");
    registry
        .revoke_at(revocation, /*now*/ 50)
        .expect("unexpired revocation should be recorded");

    assert!(matches!(
        registry.subscribe_at(&authentication, /*now*/ 99),
        PrincipalRevocationSubscriptionState::Revoked
    ));
    assert!(matches!(
        registry.subscribe_at(&authentication, /*now*/ 100),
        PrincipalRevocationSubscriptionState::Active(_)
    ));
}
