use pretty_assertions::assert_eq;
use serde_json::json;

use super::thread_dynamic_tool_server::ThreadDynamicToolServer;

#[tokio::test]
async fn provider_namespace_fails_closed_without_browser_passthrough() {
    let server = ThreadDynamicToolServer::new(/*provider*/ None);

    let generic = server
        .dispatch(
            "thread-1",
            "turn-1",
            "call-generic".to_string(),
            Some("client".to_string()),
            "tool".to_string(),
            json!({}),
        )
        .await;
    assert_eq!(generic, None);

    let provider = server
        .dispatch(
            "thread-1",
            "turn-1",
            "call-provider".to_string(),
            Some("crewon_binding_018f0d8e7e6a7cb28b347b2ca4d5c001".to_string()),
            "call".to_string(),
            json!({}),
        )
        .await
        .expect("Provider namespace is server-owned");
    assert!(!provider.success);
    assert_eq!(provider.content_items.len(), 1);
}
