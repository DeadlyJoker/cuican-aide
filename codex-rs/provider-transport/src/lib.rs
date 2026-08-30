//! Shared, fail-closed transport policy for external Provider HTTP calls.
//!
//! The crate owns endpoint validation, DNS pinning, redirect policy, request timeouts, and bounded
//! response reads. Provider-specific wire formats and authorization remain in adapter crates.

mod endpoint_policy;
mod http_guard;

pub use endpoint_policy::EndpointResolver;
pub use endpoint_policy::ProviderEndpointPolicy;
pub use endpoint_policy::ProviderEndpointPolicyError;
pub use endpoint_policy::ProviderRedirect;
pub use endpoint_policy::SystemEndpointResolver;
pub use endpoint_policy::ValidatedProviderEndpoint;
pub use http_guard::PinnedProviderClient;
pub use http_guard::classify_request_error;
