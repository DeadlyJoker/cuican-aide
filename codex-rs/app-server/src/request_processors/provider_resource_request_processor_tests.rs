use pretty_assertions::assert_eq;

use super::map_runtime_error;
use crate::platform_control::provider_connection_startup::ProviderResourceRuntimeError;

#[test]
fn resource_runtime_errors_map_to_stable_secret_free_json_rpc_errors() {
    let errors = [
        ProviderResourceRuntimeError::InvalidRequest,
        ProviderResourceRuntimeError::Unauthorized,
        ProviderResourceRuntimeError::NotFound,
        ProviderResourceRuntimeError::AuthorityChanged,
        ProviderResourceRuntimeError::CapacityExceeded,
        ProviderResourceRuntimeError::Conflict,
        ProviderResourceRuntimeError::Unavailable,
        ProviderResourceRuntimeError::Incompatible,
        ProviderResourceRuntimeError::InvalidResponse,
    ]
    .map(map_runtime_error)
    .map(|error| (error.code, error.message));

    assert_eq!(
        errors,
        [
            (-32602, "Provider resource request is invalid".to_string()),
            (
                -32600,
                "Provider resource request is not authorized".to_string(),
            ),
            (-32600, "Provider resource was not found".to_string()),
            (
                -32600,
                "Provider resource request is not authorized".to_string(),
            ),
            (
                -32600,
                "Provider resource binding capacity was exceeded".to_string(),
            ),
            (
                -32600,
                "Provider resource binding conflicts with current state".to_string(),
            ),
            (-32603, "Provider resource is unavailable".to_string()),
            (-32600, "Provider resource is incompatible".to_string()),
            (
                -32603,
                "Provider resource response is unavailable".to_string(),
            ),
        ]
    );
}
