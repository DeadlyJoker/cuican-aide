use crewon_protocol::dynamic_tools::DynamicToolSpec;
use pretty_assertions::assert_eq;
use serde_json::json;

use super::thread_dynamic_tool_projection::merge_provider_dynamic_tools;

#[test]
fn provider_projection_replaces_only_server_owned_namespaces() {
    let generic = tool(Some("client"), "generic");
    let old_provider = tool(
        Some("crewon_binding_018f0d8e7e6a7cb28b347b2ca4d5c001"),
        "call",
    );
    let next_provider = tool(
        Some("crewon_binding_018f0d8e7e6a7cb28b347b2ca4d5c002"),
        "search",
    );

    assert_eq!(
        merge_provider_dynamic_tools(
            vec![generic.clone(), old_provider],
            vec![next_provider.clone()],
        ),
        vec![generic, next_provider]
    );
}

fn tool(namespace: Option<&str>, name: &str) -> DynamicToolSpec {
    DynamicToolSpec {
        namespace: namespace.map(str::to_string),
        name: name.to_string(),
        description: "test".to_string(),
        input_schema: json!({"type": "object"}),
        defer_loading: false,
    }
}
