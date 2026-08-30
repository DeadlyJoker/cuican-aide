use super::ConnectionRequestIdentity;
use super::authenticated_principal::AuthenticatedPrincipal;
use super::authenticated_principal::AuthenticatedPrincipalBinding;
use super::authenticated_principal::AuthenticatedPrincipalSource;
use super::authenticated_principal::AuthenticatedPrincipalSpec;
use super::credential_adapter::credential_owner;
use crate::transport::ConnectionOrigin;
use crewon_app_server_protocol::RequestIdentityClientCapabilitiesRef;
use crewon_app_server_protocol::RequestIdentityClientRef;
use pretty_assertions::assert_eq;

fn principal_spec() -> AuthenticatedPrincipalSpec {
    AuthenticatedPrincipalSpec {
        source: AuthenticatedPrincipalSource::WebSocketSignedBearer,
        issuer: "https://identity.example".to_string(),
        audience: "crewon-app-server".to_string(),
        subject: "user:42".to_string(),
        tenant_id: "tenant-7".to_string(),
        space_id: "space-9".to_string(),
        token_id: "token-jti-secret-value".to_string(),
        issued_at: 100,
        expires_at: 200,
        binding: AuthenticatedPrincipalBinding::LegacyUnbound,
    }
}

fn declared_client() -> RequestIdentityClientRef {
    RequestIdentityClientRef {
        name: "authenticated-client".to_string(),
        version: "1.0.0".to_string(),
        capabilities: RequestIdentityClientCapabilitiesRef {
            experimental_api: true,
            request_attestation: false,
        },
    }
}

#[test]
fn authenticated_principal_is_bounded_and_debug_redacted() {
    let principal = AuthenticatedPrincipal::new(principal_spec()).expect("valid principal");
    assert_eq!(
        principal.stable_actor_id(),
        "principal:48c265058c5608de636c528504c8b69cab32a92e75effe59170bdfb3929197f6"
    );
    let debug = format!("{principal:?}");

    for sensitive in [
        "https://identity.example",
        "crewon-app-server",
        "user:42",
        "tenant-7",
        "space-9",
        "token-jti-secret-value",
    ] {
        assert!(!debug.contains(sensitive));
    }

    let invalid_specs = [
        AuthenticatedPrincipalSpec {
            subject: String::new(),
            ..principal_spec()
        },
        AuthenticatedPrincipalSpec {
            tenant_id: "tenant\nforged".to_string(),
            ..principal_spec()
        },
        AuthenticatedPrincipalSpec {
            issued_at: -1,
            ..principal_spec()
        },
        AuthenticatedPrincipalSpec {
            expires_at: 100,
            ..principal_spec()
        },
        AuthenticatedPrincipalSpec {
            expires_at: 3_701,
            ..principal_spec()
        },
    ];
    assert!(
        invalid_specs
            .into_iter()
            .all(|spec| AuthenticatedPrincipal::new(spec).is_err())
    );
}

#[test]
fn agent_platform_binding_is_exact_and_debug_redacted() {
    let source_binding_id = "019f6f00-0000-7000-8000-000000000001";
    let binding = AuthenticatedPrincipalBinding::AgentPlatform {
        source_binding_id: source_binding_id.to_string(),
        source_revision: 7,
    };
    let principal = AuthenticatedPrincipal::new(AuthenticatedPrincipalSpec {
        source: AuthenticatedPrincipalSource::WebSocketPrincipalSessionRs256,
        binding: binding.clone(),
        ..principal_spec()
    })
    .expect("agent platform binding");

    assert_eq!(principal.binding(), &binding);
    assert!(!format!("{binding:?}").contains(source_binding_id));
    assert!(
        AuthenticatedPrincipal::new(AuthenticatedPrincipalSpec {
            source: AuthenticatedPrincipalSource::WebSocketPrincipalSessionRs256,
            binding: AuthenticatedPrincipalBinding::AgentPlatform {
                source_binding_id: "not-a-uuid".to_string(),
                source_revision: 7,
            },
            ..principal_spec()
        })
        .is_err()
    );
    assert!(
        AuthenticatedPrincipal::new(AuthenticatedPrincipalSpec {
            binding,
            ..principal_spec()
        })
        .is_err()
    );
}

#[test]
fn reconnect_preserves_principal_authority_but_rotates_connection_facts() {
    let principal = AuthenticatedPrincipal::new(principal_spec()).expect("valid principal");
    let first = ConnectionRequestIdentity::new_authenticated(
        ConnectionOrigin::WebSocket,
        principal.clone(),
    )
    .derive(declared_client(), "trace-1".to_string());
    let second =
        ConnectionRequestIdentity::new_authenticated(ConnectionOrigin::WebSocket, principal)
            .derive(declared_client(), "trace-2".to_string());

    assert!(first.authenticated_principal().is_some());
    assert!(second.authenticated_principal().is_some());
    assert_eq!(first.reference().actor_id, second.reference().actor_id);
    assert_eq!(first.reference().tenant_id, second.reference().tenant_id);
    assert_eq!(first.reference().space_id, second.reference().space_id);
    assert_eq!(
        first.policy_actor().expect("first actor"),
        second.policy_actor().expect("second actor")
    );
    assert_eq!(
        credential_owner(&first).expect("first owner"),
        credential_owner(&second).expect("second owner")
    );
    assert_ne!(first.reference().session_id, second.reference().session_id);
    assert_ne!(first.reference().trace_id, second.reference().trace_id);
    assert_ne!(first.audit_subject(), second.audit_subject());
}

#[test]
fn principal_or_scope_mix_up_cannot_reuse_durable_authority() {
    let original = AuthenticatedPrincipal::new(principal_spec()).expect("valid principal");
    let changed_subject = AuthenticatedPrincipal::new(AuthenticatedPrincipalSpec {
        subject: "user:other".to_string(),
        ..principal_spec()
    })
    .expect("changed subject");
    let changed_issuer = AuthenticatedPrincipal::new(AuthenticatedPrincipalSpec {
        issuer: "https://other-identity.example".to_string(),
        ..principal_spec()
    })
    .expect("changed issuer");
    let changed_scope = AuthenticatedPrincipal::new(AuthenticatedPrincipalSpec {
        space_id: "space-other".to_string(),
        ..principal_spec()
    })
    .expect("changed scope");

    let derive = |principal| {
        ConnectionRequestIdentity::new_authenticated(ConnectionOrigin::WebSocket, principal)
            .derive(declared_client(), "trace".to_string())
    };
    let original = derive(original);
    let changed_subject = derive(changed_subject);
    let changed_issuer = derive(changed_issuer);
    let changed_scope = derive(changed_scope);

    assert_ne!(
        original.reference().actor_id,
        changed_subject.reference().actor_id
    );
    assert_ne!(
        original.reference().actor_id,
        changed_issuer.reference().actor_id
    );
    assert_ne!(
        credential_owner(&original).expect("original owner"),
        credential_owner(&changed_scope).expect("changed owner")
    );
    assert_ne!(
        original.policy_actor().expect("original actor"),
        changed_scope.policy_actor().expect("changed actor")
    );
}

#[test]
fn identity_projection_does_not_expose_principal_claims_or_token_id() {
    let identity = ConnectionRequestIdentity::new_authenticated(
        ConnectionOrigin::WebSocket,
        AuthenticatedPrincipal::new(principal_spec()).expect("valid principal"),
    )
    .derive(declared_client(), "trace".to_string());
    let wire = serde_json::to_string(&identity.into_response()).expect("identity response");

    for hidden in [
        "https://identity.example",
        "user:42",
        "token-jti-secret-value",
    ] {
        assert!(!wire.contains(hidden));
    }
    assert!(wire.contains("tenant-7"));
    assert!(wire.contains("space-9"));
}
