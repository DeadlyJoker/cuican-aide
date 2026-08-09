use std::collections::HashMap;

use chrono::DateTime;
use chrono::Duration;
use chrono::Utc;
use crewon_device_protocol::DeviceExecutionCommand;
use crewon_device_protocol::MAX_DEVICE_COMMAND_BYTES;
use crewon_device_protocol::MAX_DEVICE_EVENT_BYTES;
use crewon_device_protocol::parse_device_execution_command;
use crewon_device_protocol::parse_device_gateway_welcome;
use crewon_device_protocol::verify_device_command_authorization;
use ed25519_dalek::VerifyingKey;
use ed25519_dalek::pkcs8::DecodePublicKey as _;
use serde_json::Value;
use thiserror::Error;

use crate::AcceptedGatewayConnection;
use crate::ConnectionEpochFence;
use crate::ConnectionEpochFenceError;

const MAX_TRUSTED_COMMAND_KEYS: usize = 32;
const MAX_PUBLIC_KEY_PEM_BYTES: usize = 16 * 1024;

/// One trusted Control Plane command-signing key at the Native boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedDeviceCommandKey {
    pub key_id: String,
    pub public_key_pem: String,
}

/// Strict Ed25519 command verification owned by the Native execution boundary.
#[derive(Debug)]
pub struct DeviceCommandAuthorizer {
    keys: HashMap<String, VerifyingKey>,
    max_clock_skew: Duration,
}

impl DeviceCommandAuthorizer {
    pub fn new(
        registrations: impl IntoIterator<Item = TrustedDeviceCommandKey>,
        max_clock_skew: Duration,
    ) -> Result<Self, NativeDeviceAdmissionError> {
        if !(0..=3_600_000).contains(&max_clock_skew.num_milliseconds()) {
            return Err(NativeDeviceAdmissionError::new(
                "device_authorization_clock_skew_invalid",
            ));
        }
        let mut keys = HashMap::new();
        for registration in registrations {
            require_opaque_id(&registration.key_id, "device_authorization_key_invalid")?;
            if registration.public_key_pem.is_empty()
                || registration.public_key_pem.len() > MAX_PUBLIC_KEY_PEM_BYTES
                || keys.contains_key(&registration.key_id)
            {
                return Err(NativeDeviceAdmissionError::new(
                    "device_authorization_key_config_invalid",
                ));
            }
            let key = VerifyingKey::from_public_key_pem(&registration.public_key_pem).map_err(
                |error| {
                    NativeDeviceAdmissionError::with_source(
                        "device_authorization_key_config_invalid",
                        error,
                    )
                },
            )?;
            keys.insert(registration.key_id, key);
            if keys.len() > MAX_TRUSTED_COMMAND_KEYS {
                return Err(NativeDeviceAdmissionError::new(
                    "device_authorization_key_config_invalid",
                ));
            }
        }
        if keys.is_empty() {
            return Err(NativeDeviceAdmissionError::new(
                "device_authorization_key_config_invalid",
            ));
        }
        Ok(Self {
            keys,
            max_clock_skew,
        })
    }

    fn parse_and_verify(
        &self,
        frame: &[u8],
        now: DateTime<Utc>,
    ) -> Result<DeviceExecutionCommand, NativeDeviceAdmissionError> {
        let value = parse_bounded_json(
            frame,
            MAX_DEVICE_COMMAND_BYTES,
            "device_command_invalid",
            "device_command_too_large",
        )?;
        let command = parse_device_execution_command(value)
            .map_err(NativeDeviceAdmissionError::from_protocol)?;
        self.verify(&command, now)?;
        Ok(command)
    }

    fn verify(
        &self,
        command: &DeviceExecutionCommand,
        now: DateTime<Utc>,
    ) -> Result<(), NativeDeviceAdmissionError> {
        let Some(key) = self.keys.get(&command.authorization.key_id) else {
            return Err(NativeDeviceAdmissionError::new(
                "device_authorization_key_unknown",
            ));
        };
        verify_device_command_authorization(
            command,
            &command.authorization.key_id,
            key,
            now,
            self.max_clock_skew,
        )
        .map_err(NativeDeviceAdmissionError::from_protocol)
    }
}

/// One authenticated Gateway socket admitted by the Native epoch authority.
#[derive(Debug)]
pub struct NativeDeviceConnection<'a> {
    fence: &'a ConnectionEpochFence,
    authorizer: &'a DeviceCommandAuthorizer,
    accepted: AcceptedGatewayConnection,
}

impl<'a> NativeDeviceConnection<'a> {
    pub fn establish(
        fence: &'a ConnectionEpochFence,
        authorizer: &'a DeviceCommandAuthorizer,
        welcome_frame: &[u8],
        now: DateTime<Utc>,
    ) -> Result<Self, NativeDeviceAdmissionError> {
        let value = parse_bounded_json(
            welcome_frame,
            MAX_DEVICE_EVENT_BYTES,
            "device_welcome_invalid",
            "device_welcome_too_large",
        )?;
        let welcome = parse_device_gateway_welcome(value)
            .map_err(NativeDeviceAdmissionError::from_protocol)?;
        let accepted = fence
            .accept_welcome(&welcome, now)
            .map_err(NativeDeviceAdmissionError::from_fence)?;
        Ok(Self {
            fence,
            authorizer,
            accepted,
        })
    }

    pub fn accepted_connection(&self) -> &AcceptedGatewayConnection {
        &self.accepted
    }

    /// Parses and cryptographically verifies a bounded command frame.
    ///
    /// Capability, workspace and platform checks may inspect the returned
    /// command before calling [`Self::start_command`].
    pub fn verify_command(
        &self,
        command_frame: &[u8],
        now: DateTime<Utc>,
    ) -> Result<VerifiedDeviceCommand, NativeDeviceAdmissionError> {
        let command = self.authorizer.parse_and_verify(command_frame, now)?;
        if command.device_id != self.accepted.device_id {
            return Err(NativeDeviceAdmissionError::new(
                "device_connection_command_identity_mismatch",
            ));
        }
        Ok(VerifiedDeviceCommand {
            connection: self.accepted.clone(),
            command,
        })
    }

    /// Revalidates time and epoch, then starts one irreversible native action.
    ///
    /// The callback must synchronously cross the side-effect admission point;
    /// returning an unpolled future would release the epoch permit too early.
    pub fn start_command<T>(
        &self,
        verified: VerifiedDeviceCommand,
        now: DateTime<Utc>,
        start: impl FnOnce(&DeviceExecutionCommand) -> T,
    ) -> Result<T, NativeDeviceAdmissionError> {
        if verified.connection != self.accepted {
            return Err(NativeDeviceAdmissionError::new(
                "device_connection_epoch_stale",
            ));
        }
        self.authorizer.verify(&verified.command, now)?;
        let permit = self
            .fence
            .authorize_command(&self.accepted, &verified.command)
            .map_err(NativeDeviceAdmissionError::from_fence)?;
        let result = start(&verified.command);
        drop(permit);
        Ok(result)
    }
}

/// A parsed and signed command awaiting capability checks and epoch admission.
#[derive(Debug)]
#[must_use = "validate capability and call NativeDeviceConnection::start_command"]
pub struct VerifiedDeviceCommand {
    connection: AcceptedGatewayConnection,
    command: DeviceExecutionCommand,
}

impl VerifiedDeviceCommand {
    pub fn command(&self) -> &DeviceExecutionCommand {
        &self.command
    }
}

/// Content-free admission failure safe for a Native protocol response.
#[derive(Debug, Error)]
#[error("{code}")]
pub struct NativeDeviceAdmissionError {
    pub code: &'static str,
    #[source]
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl NativeDeviceAdmissionError {
    fn new(code: &'static str) -> Self {
        Self { code, source: None }
    }

    fn with_source(
        code: &'static str,
        source: impl std::error::Error + Send + Sync + 'static,
    ) -> Self {
        Self {
            code,
            source: Some(Box::new(source)),
        }
    }

    fn from_protocol(error: crewon_device_protocol::DeviceProtocolError) -> Self {
        Self::with_source(error.code, error)
    }

    fn from_fence(error: ConnectionEpochFenceError) -> Self {
        Self::with_source(error.code, error)
    }
}

fn parse_bounded_json(
    frame: &[u8],
    max_bytes: usize,
    invalid_code: &'static str,
    too_large_code: &'static str,
) -> Result<Value, NativeDeviceAdmissionError> {
    if frame.is_empty() {
        return Err(NativeDeviceAdmissionError::new(invalid_code));
    }
    if frame.len() > max_bytes {
        return Err(NativeDeviceAdmissionError::new(too_large_code));
    }
    serde_json::from_slice(frame)
        .map_err(|error| NativeDeviceAdmissionError::with_source(invalid_code, error))
}

fn require_opaque_id(value: &str, code: &'static str) -> Result<(), NativeDeviceAdmissionError> {
    let mut bytes = value.bytes();
    if value.len() > 512
        || !bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        || !bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(NativeDeviceAdmissionError::new(code));
    }
    Ok(())
}

#[cfg(test)]
#[path = "native_connection_tests.rs"]
mod tests;
