use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use super::RequestIdentityRef;

/// Trusted transport category that established the app-server connection.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub enum RequestIdentityTransport {
    Stdio,
    InProcess,
    WebSocket,
    RemoteControl,
}

/// Client capabilities declared during initialize.
///
/// These fields are negotiation metadata and must not be used as authority.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct RequestIdentityClientCapabilitiesRef {
    pub experimental_api: bool,
    pub request_attestation: bool,
}

/// Client metadata declared during initialize.
///
/// This metadata is intentionally separate from the server-derived identity.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct RequestIdentityClientRef {
    pub name: String,
    pub version: String,
    pub capabilities: RequestIdentityClientCapabilitiesRef,
}

/// Effective request identity returned by the experimental identity read API.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export_to = "v2/")]
pub struct IdentityReadResponse {
    pub identity: RequestIdentityRef,
    pub transport: RequestIdentityTransport,
    pub audit_subject: String,
    pub client: RequestIdentityClientRef,
}
