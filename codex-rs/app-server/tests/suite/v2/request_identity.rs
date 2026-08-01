use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::to_response;
use crewon_app_server_protocol::ClientInfo;
use crewon_app_server_protocol::IdentityReadResponse;
use crewon_app_server_protocol::JSONRPCError;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::RequestIdentityTransport;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;

async fn read_identity(app: &mut TestAppServer) -> Result<IdentityReadResponse> {
    let request_id = app.send_identity_read_request(/*params*/ None).await?;
    let response: JSONRPCResponse = app
        .read_stream_until_response_message(RequestId::Integer(request_id))
        .await?;
    to_response(response)
}

#[tokio::test]
async fn request_identity_is_server_derived_and_connection_scoped() -> Result<()> {
    let home_a = TempDir::new()?;
    let home_b = TempDir::new()?;
    let mut app_a = TestAppServer::new(home_a.path()).await?;
    let mut app_b = TestAppServer::new(home_b.path()).await?;
    app_a
        .initialize_with_client_info(ClientInfo {
            name: "identity-client-a".to_string(),
            title: None,
            version: "1.2.3".to_string(),
        })
        .await?;
    app_b
        .initialize_with_client_info(ClientInfo {
            name: "identity-client-b".to_string(),
            title: None,
            version: "4.5.6".to_string(),
        })
        .await?;

    let first_a = read_identity(&mut app_a).await?;
    let second_a = read_identity(&mut app_a).await?;
    let first_b = read_identity(&mut app_b).await?;

    assert_eq!(first_a.transport, RequestIdentityTransport::Stdio);
    assert_eq!(first_a.identity.tenant_id, None);
    assert_eq!(first_a.identity.space_id, None);
    assert_eq!(first_a.client.name, "identity-client-a");
    assert_eq!(first_a.client.version, "1.2.3");
    assert!(first_a.client.capabilities.experimental_api);

    let mut expected_second_a = first_a.clone();
    expected_second_a.identity.trace_id = second_a.identity.trace_id.clone();
    assert_eq!(second_a, expected_second_a);
    assert!(!first_a.identity.trace_id.is_empty());
    assert_ne!(first_a.identity.session_id, first_b.identity.session_id);
    assert_ne!(first_a.identity.actor_id, first_b.identity.actor_id);

    Ok(())
}

#[tokio::test]
async fn request_identity_rejects_client_authority_fields_without_mutating_identity() -> Result<()>
{
    let codex_home = TempDir::new()?;
    let mut app = TestAppServer::new(codex_home.path()).await?;
    app.initialize().await?;
    let before = read_identity(&mut app).await?;

    let request_id = app
        .send_identity_read_request(Some(json!({
            "actorId": "forged-actor",
            "tenantId": "forged-tenant",
            "spaceId": "forged-space",
            "memberId": "forged-member"
        })))
        .await?;
    let JSONRPCError { error, .. } = app
        .read_stream_until_error_message(RequestId::Integer(request_id))
        .await?;
    assert_eq!(
        error,
        JSONRPCErrorError {
            code: -32600,
            message: "Invalid request: invalid type: map, expected unit".to_string(),
            data: None,
        }
    );

    let after = read_identity(&mut app).await?;
    let mut expected_after = before;
    expected_after.identity.trace_id = after.identity.trace_id.clone();
    assert_eq!(after, expected_after);

    Ok(())
}
