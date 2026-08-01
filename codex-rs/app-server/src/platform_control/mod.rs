#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "W1-09 Artifact adapter is harnessed before W1-10 composes consumers"
    )
)]
pub(crate) mod artifact_adapter;
mod authenticated_principal;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "W1-07 context adapter is harnessed before W1-10 composes consumers"
    )
)]
pub(crate) mod context_adapter;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "W1-10 credential adapter is composed before Provider consumers cut over"
    )
)]
pub(crate) mod credential_adapter;
mod durable_workspace_adapter;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "W2-05 dynamic tool router is harnessed before W2-08 production composition"
    )
)]
pub(crate) mod dynamic_tool_router;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "W1-08 policy adapter is harnessed before W1-10 composes execution consumers"
    )
)]
pub(crate) mod policy_adapter;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "P1c revocation listener is harnessed before WebSocket production composition"
    )
)]
pub(crate) mod principal_revocation_listener;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "P1c source client is composed only when principal-session auth is enabled"
    )
)]
mod principal_revocation_source_client;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "principal session exchange is composed only when identity source is enabled"
    )
)]
pub(crate) mod principal_session_exchange;
pub(crate) mod principal_session_production;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "W2-04 grant authority is harnessed before Provider processor composition"
    )
)]
mod provider_access_grant_authority;
mod provider_access_grant_provisioner;
pub(crate) mod provider_access_grant_scope;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "W2-04 Provider descriptor port is harnessed before production factory composition"
    )
)]
pub(crate) mod provider_connection_descriptor;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "W2-04 Provider processor is harnessed before startup and RPC composition"
    )
)]
mod provider_connection_processor;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "W2-04 production Provider factory is prepared before v2 RPC registration"
    )
)]
pub(crate) mod provider_connection_production;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "W2-04 projection adapter is harnessed before startup and RPC composition"
    )
)]
mod provider_connection_projection;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "W2-04 Provider startup runtime is composed before RPC registration"
    )
)]
pub(crate) mod provider_connection_startup;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "P2b-2 identity adapter is harnessed before Provider composition registration"
    )
)]
pub(crate) mod provider_identity_adapter;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "P2b-2 refresh adapter is harnessed before source client composition"
    )
)]
pub(crate) mod provider_identity_refresh;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "P2b-2 restart supervisor is harnessed before source client composition"
    )
)]
pub(crate) mod provider_identity_refresh_supervisor;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "P2b-2 source client adapter is composed only when identity source is enabled"
    )
)]
mod provider_identity_source_client;
mod provider_resource_binding_adapter;
mod provider_resource_binding_processor;
mod provider_resource_catalog;
mod provider_resource_processor;
mod request_identity;
pub(crate) mod thread_dynamic_tool_projection;
pub(crate) mod thread_dynamic_tool_server;
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "W2-08 Thread execution context adapter is harnessed before thread lifecycle composition"
    )
)]
pub(crate) mod thread_execution_context_adapter;
pub(crate) mod thread_execution_context_runtime;
mod workspace;

#[cfg(test)]
#[path = "authenticated_principal_tests.rs"]
mod authenticated_principal_tests;

#[cfg(test)]
#[path = "provider_identity_adapter_tests.rs"]
mod provider_identity_adapter_tests;

#[cfg(test)]
#[path = "provider_identity_refresh_tests.rs"]
mod provider_identity_refresh_tests;

#[cfg(test)]
#[path = "provider_identity_refresh_supervisor_tests.rs"]
mod provider_identity_refresh_supervisor_tests;

#[cfg(test)]
#[path = "provider_connection_production_tests.rs"]
mod provider_connection_production_tests;

#[cfg(test)]
#[path = "provider_connection_processor_tests.rs"]
mod provider_connection_processor_tests;

#[cfg(test)]
#[path = "provider_connection_projection_tests.rs"]
mod provider_connection_projection_tests;

#[cfg(test)]
#[path = "provider_connection_startup_tests.rs"]
mod provider_connection_startup_tests;

#[cfg(test)]
#[path = "provider_connection_rpc_tests.rs"]
mod provider_connection_rpc_tests;
#[cfg(test)]
#[path = "provider_resource_catalog_tests.rs"]
mod provider_resource_catalog_tests;

#[cfg(test)]
#[path = "provider_resource_binding_adapter_tests.rs"]
mod provider_resource_binding_adapter_tests;

#[cfg(test)]
#[path = "provider_resource_binding_processor_tests.rs"]
mod provider_resource_binding_processor_tests;

#[cfg(test)]
#[path = "provider_access_grant_provisioner_tests.rs"]
mod provider_access_grant_provisioner_tests;

#[cfg(test)]
#[path = "provider_access_grant_authority_tests.rs"]
mod provider_access_grant_authority_tests;

#[cfg(test)]
#[path = "durable_workspace_adapter_tests.rs"]
mod durable_workspace_adapter_tests;

#[cfg(test)]
#[path = "dynamic_tool_router_tests.rs"]
mod dynamic_tool_router_tests;

#[cfg(test)]
#[path = "dynamic_tool_dispatch_tests.rs"]
mod dynamic_tool_dispatch_tests;
#[cfg(test)]
#[path = "dynamic_tool_execution_tests.rs"]
mod dynamic_tool_execution_tests;
#[cfg(test)]
#[path = "dynamic_tool_state_journal_tests.rs"]
mod dynamic_tool_state_journal_tests;

#[cfg(test)]
#[path = "principal_revocation_listener_tests.rs"]
mod principal_revocation_listener_tests;

#[cfg(test)]
#[path = "wave1_gate_tests.rs"]
mod wave1_gate_tests;

#[cfg(test)]
#[path = "wave2_gate_tests.rs"]
mod wave2_gate_tests;

#[cfg(test)]
#[path = "thread_execution_context_adapter_tests.rs"]
mod thread_execution_context_adapter_tests;

#[cfg(test)]
#[path = "thread_execution_context_runtime_tests.rs"]
mod thread_execution_context_runtime_tests;

#[cfg(test)]
#[path = "thread_dynamic_tool_projection_tests.rs"]
mod thread_dynamic_tool_projection_tests;

#[cfg(test)]
#[path = "thread_dynamic_tool_server_tests.rs"]
mod thread_dynamic_tool_server_tests;

pub(crate) use authenticated_principal::AuthenticatedPrincipal;
pub(crate) use authenticated_principal::AuthenticatedPrincipalError;
#[cfg(test)]
pub(crate) use provider_identity_adapter_tests::authenticated_identity_in_space;
pub(crate) use provider_resource_binding_processor::unbind_resource_binding;
pub(crate) use request_identity::ConnectionRequestIdentity;
pub use request_identity::RequestIdentity;
pub(crate) use workspace::WorkspaceRegistry;
pub(crate) use workspace::WorkspaceRootCatalog;
