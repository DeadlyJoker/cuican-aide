use std::time::Duration;

use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::to_response;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::SceneId;
use crewon_app_server_protocol::SceneInteractionMode;
use crewon_app_server_protocol::SceneListParams;
use crewon_app_server_protocol::SceneListResponse;
use pretty_assertions::assert_eq;
use tempfile::TempDir;
use tokio::time::timeout;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

#[tokio::test]
async fn scene_list_returns_canonical_presets_with_pagination() -> Result<()> {
    let codex_home = TempDir::new()?;
    let mut app_server = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_TIMEOUT, app_server.initialize()).await??;

    let first_request_id = app_server
        .send_scene_list_request(SceneListParams {
            cursor: None,
            limit: Some(2),
        })
        .await?;
    let first_response: JSONRPCResponse = timeout(
        DEFAULT_TIMEOUT,
        app_server.read_stream_until_response_message(RequestId::Integer(first_request_id)),
    )
    .await??;
    let first = to_response::<SceneListResponse>(first_response)?;
    assert_eq!(
        first
            .data
            .iter()
            .map(|item| item.scene_id)
            .collect::<Vec<_>>(),
        vec![SceneId::Office, SceneId::Code]
    );
    assert_eq!(first.next_cursor, Some("2".to_string()));
    assert_eq!(first.data[0].default_mode, SceneInteractionMode::Auto);

    let second_request_id = app_server
        .send_scene_list_request(SceneListParams {
            cursor: first.next_cursor,
            limit: Some(2),
        })
        .await?;
    let second_response: JSONRPCResponse = timeout(
        DEFAULT_TIMEOUT,
        app_server.read_stream_until_response_message(RequestId::Integer(second_request_id)),
    )
    .await??;
    let second = to_response::<SceneListResponse>(second_response)?;
    assert_eq!(
        second
            .data
            .iter()
            .map(|item| item.scene_id)
            .collect::<Vec<_>>(),
        vec![SceneId::Design]
    );
    assert_eq!(second.next_cursor, None);
    Ok(())
}
