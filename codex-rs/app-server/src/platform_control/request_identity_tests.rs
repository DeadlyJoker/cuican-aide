use super::*;
use crewon_app_server_protocol::RequestIdentityClientCapabilitiesRef;
use pretty_assertions::assert_eq;

fn declared_client() -> RequestIdentityClientRef {
    RequestIdentityClientRef {
        name: "declared-client".to_string(),
        version: "1.0.0".to_string(),
        capabilities: RequestIdentityClientCapabilitiesRef {
            experimental_api: true,
            request_attestation: false,
        },
    }
}

#[test]
fn connection_identity_classifies_transport_without_inventing_tenant_or_space() {
    let cases = [
        (
            ConnectionOrigin::Stdio,
            RequestIdentityTransport::Stdio,
            "localProcess:stdio",
        ),
        (
            ConnectionOrigin::InProcess,
            RequestIdentityTransport::InProcess,
            "localProcess:inProcess",
        ),
        (
            ConnectionOrigin::WebSocket,
            RequestIdentityTransport::WebSocket,
            "remoteConnection:webSocket",
        ),
        (
            ConnectionOrigin::RemoteControl,
            RequestIdentityTransport::RemoteControl,
            "remoteConnection:remoteControl",
        ),
    ];

    let actual = cases
        .iter()
        .map(|(origin, _, _)| {
            let identity = ConnectionRequestIdentity::new(*origin)
                .derive(declared_client(), "trace-id".to_string());
            (
                identity.transport,
                identity.audit_subject.clone(),
                identity.reference.session_id.clone(),
                identity.reference.tenant_id,
                identity.reference.space_id,
            )
        })
        .collect::<Vec<_>>();
    let expected = cases
        .into_iter()
        .zip(actual.iter())
        .map(
            |((_, transport, audit_subject_prefix), (_, _, session_id, _, _))| {
                (
                    transport,
                    format!("{audit_subject_prefix}:{session_id}"),
                    session_id.clone(),
                    None,
                    None,
                )
            },
        )
        .collect::<Vec<_>>();

    assert_eq!(actual, expected);
}

#[test]
fn reconnect_creates_a_new_connection_actor_and_session() {
    let first = ConnectionRequestIdentity::new(ConnectionOrigin::Stdio)
        .derive(declared_client(), "trace-1".to_string());
    let second = ConnectionRequestIdentity::new(ConnectionOrigin::Stdio)
        .derive(declared_client(), "trace-2".to_string());

    assert_ne!(first.reference.actor_id, second.reference.actor_id);
    assert_ne!(first.reference.session_id, second.reference.session_id);
}
