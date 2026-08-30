use super::auth::WebsocketAuthMode;
use super::auth::WebsocketAuthPolicy;
use std::fmt;

impl fmt::Debug for WebsocketAuthPolicy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mode = self.mode.as_ref().map(|mode| match mode {
            WebsocketAuthMode::CapabilityToken { .. } => "capability-token",
            WebsocketAuthMode::SignedBearerToken { .. } => "signed-bearer-token",
            WebsocketAuthMode::PrincipalSessionRs256 { .. } => "principal-session-rs256",
        });
        formatter
            .debug_struct("WebsocketAuthPolicy")
            .field("mode", &mode)
            .finish()
    }
}
