use pretty_assertions::assert_eq;
use serde_json::json;

use super::ThreadExecutionContext;
use super::ThreadExecutionContextCreateParams;
use super::ThreadExecutionContextUpdateParams;
use crate::ClientRequest;
use crate::ExperimentalApi;
use crate::RequestId;
use crate::ThreadForkParams;
use crate::ThreadStartParams;

#[test]
fn thread_execution_context_request_shapes_are_strict_and_camel_case() {
    let create: ThreadExecutionContextCreateParams = serde_json::from_value(json!({
        "workspaceKey": "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c201"
    }))
    .expect("deserialize create params");
    assert_eq!(
        create.workspace_key,
        "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c201"
    );

    let update: ThreadExecutionContextUpdateParams = serde_json::from_value(json!({
        "threadId": "018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c401",
        "workspaceBindingId": "binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c201",
        "resourceBindingIds": [],
        "executionBindingId": "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301",
        "expectedRevision": 3
    }))
    .expect("deserialize update params");
    assert_eq!(update.expected_revision, 3);
    assert_eq!(
        update.execution_binding_id.as_deref(),
        Some("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301")
    );

    let projection: ThreadExecutionContext = serde_json::from_value(json!({
        "threadId": "018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c401",
        "workspace": {
            "workspaceKey": "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c201",
            "bindingId": "binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c201",
            "scope": "conversation",
            "scopeId": "018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c401",
            "nodeId": "node-1",
            "environmentId": "local"
        },
        "resourceBindings": [{
            "bindingId": "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301",
            "revision": 7
        }],
        "executionBinding": {
            "bindingId": "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301",
            "revision": 7
        },
        "revision": 3,
        "createdAt": 100,
        "updatedAt": 110
    }))
    .expect("deserialize execution binding projection");
    assert_eq!(
        projection.execution_binding,
        projection.resource_bindings.first().cloned()
    );

    let unknown = serde_json::from_value::<ThreadExecutionContextCreateParams>(json!({
        "workspaceKey": "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c201",
        "ownerId": "forged"
    }));
    assert!(unknown.is_err());
}

#[test]
fn thread_execution_context_surfaces_require_explicit_experimental_opt_in() {
    let create = ThreadExecutionContextCreateParams {
        workspace_key: "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c201".to_string(),
    };
    let start = ClientRequest::ThreadStart {
        request_id: RequestId::Integer(1),
        params: ThreadStartParams {
            execution_context: Some(create.clone()),
            ..Default::default()
        },
    };
    assert_eq!(
        start.experimental_reason(),
        Some("thread/start.executionContext")
    );

    let fork = ClientRequest::ThreadFork {
        request_id: RequestId::Integer(2),
        params: ThreadForkParams {
            thread_id: "018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c401".to_string(),
            execution_context: Some(create),
            ..Default::default()
        },
    };
    assert_eq!(
        fork.experimental_reason(),
        Some("thread/fork.executionContext")
    );

    let update = ClientRequest::ThreadExecutionContextUpdate {
        request_id: RequestId::Integer(3),
        params: ThreadExecutionContextUpdateParams {
            thread_id: "018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c401".to_string(),
            workspace_binding_id: "binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c201".to_string(),
            resource_binding_ids: Vec::new(),
            execution_binding_id: None,
            expected_revision: 1,
        },
    };
    assert_eq!(
        update.experimental_reason(),
        Some("threadExecutionContext/update")
    );
    assert_eq!(
        update.serialization_scope(),
        Some(crate::ClientRequestSerializationScope::Thread {
            thread_id: "018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c401".to_string(),
        })
    );
}
