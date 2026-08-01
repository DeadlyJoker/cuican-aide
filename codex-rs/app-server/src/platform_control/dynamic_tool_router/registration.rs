use std::collections::BTreeMap;
use std::fmt;

use crewon_policy::SideEffect;
use crewon_state::ProviderResourceBindingMode;
use crewon_state::ProviderResourceBindingRecord;
use crewon_state::ProviderResourceBindingStatus;
use crewon_state::ProviderResourceExecutionLocation;
use crewon_state::ProviderResourceKind;
use serde_json::Value as JsonValue;

const BINDING_ID_PREFIX: &str = "resource-binding:";
pub(crate) const NAMESPACE_PREFIX: &str = "crewon_binding_";
const MAX_DYNAMIC_TOOL_REGISTRATIONS: usize = 64;
const MAX_CALL_ID_BYTES: usize = 255;
const MAX_ARGUMENT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DynamicToolOperation {
    Call,
    Search,
}

impl DynamicToolOperation {
    fn tool_name(self) -> &'static str {
        match self {
            Self::Call => "call",
            Self::Search => "search",
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum DynamicToolExecutionTarget {
    Provider {
        connection_id: String,
        resource_id: String,
    },
}

impl fmt::Debug for DynamicToolExecutionTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Provider { .. } => {
                formatter.write_str("DynamicToolExecutionTarget::Provider([REDACTED])")
            }
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct DynamicToolRegistration {
    namespace: String,
    tool_name: &'static str,
    operation: DynamicToolOperation,
    side_effect: SideEffect,
    binding: ProviderResourceBindingRecord,
    target: DynamicToolExecutionTarget,
}

impl DynamicToolRegistration {
    pub(crate) fn from_binding(
        binding: ProviderResourceBindingRecord,
        side_effect: SideEffect,
    ) -> Result<Self, DynamicToolRouteError> {
        binding
            .validate()
            .map_err(|_| DynamicToolRouteError::InvalidBinding)?;
        if binding.status != ProviderResourceBindingStatus::Active {
            return Err(DynamicToolRouteError::InactiveBinding);
        }

        let operation = match binding.resource_kind {
            ProviderResourceKind::McpTool => DynamicToolOperation::Call,
            ProviderResourceKind::KnowledgeBase if side_effect == SideEffect::ReadOnly => {
                DynamicToolOperation::Search
            }
            ProviderResourceKind::KnowledgeBase => {
                return Err(DynamicToolRouteError::IncompatibleBinding);
            }
            ProviderResourceKind::Agent
            | ProviderResourceKind::Skill
            | ProviderResourceKind::McpServer
            | ProviderResourceKind::Workflow => {
                return Err(DynamicToolRouteError::IncompatibleBinding);
            }
        };
        let target = match (binding.binding_mode, binding.execution_location) {
            (
                ProviderResourceBindingMode::RemoteReference
                | ProviderResourceBindingMode::ProviderManaged,
                ProviderResourceExecutionLocation::Provider,
            ) => DynamicToolExecutionTarget::Provider {
                connection_id: binding.connection_id.clone(),
                resource_id: binding.resource_id.clone(),
            },
            _ => return Err(DynamicToolRouteError::IncompatibleBinding),
        };
        let namespace = namespace_for_binding(&binding.binding_id)?;
        Ok(Self {
            namespace,
            tool_name: operation.tool_name(),
            operation,
            side_effect,
            binding,
            target,
        })
    }

    pub(crate) fn namespace(&self) -> &str {
        &self.namespace
    }

    pub(crate) fn tool_name(&self) -> &str {
        self.tool_name
    }

    pub(crate) fn operation(&self) -> DynamicToolOperation {
        self.operation
    }

    pub(crate) fn side_effect(&self) -> SideEffect {
        self.side_effect
    }

    pub(crate) fn binding(&self) -> &ProviderResourceBindingRecord {
        &self.binding
    }

    pub(crate) fn target(&self) -> &DynamicToolExecutionTarget {
        &self.target
    }

    fn matches_current_binding(&self, current: &ProviderResourceBindingRecord) -> bool {
        current.status == ProviderResourceBindingStatus::Active && self.binding == *current
    }
}

impl fmt::Debug for DynamicToolRegistration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DynamicToolRegistration")
            .field("namespace", &self.namespace)
            .field("tool_name", &self.tool_name)
            .field("operation", &self.operation)
            .field("side_effect", &self.side_effect)
            .field("binding_id", &self.binding.binding_id)
            .field("binding_revision", &self.binding.revision)
            .field("target", &self.target)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DynamicToolInvocation {
    call_id: String,
    namespace: String,
    tool_name: String,
    arguments: JsonValue,
}

impl DynamicToolInvocation {
    pub(crate) fn new(
        call_id: impl Into<String>,
        namespace: impl Into<String>,
        tool_name: impl Into<String>,
        arguments: JsonValue,
    ) -> Result<Self, DynamicToolRouteError> {
        let call_id = call_id.into();
        let namespace = namespace.into();
        let tool_name = tool_name.into();
        validate_opaque_id(&call_id, MAX_CALL_ID_BYTES)?;
        validate_identifier(&namespace)?;
        validate_identifier(&tool_name)?;
        let argument_bytes =
            serde_json::to_vec(&arguments).map_err(|_| DynamicToolRouteError::InvalidInvocation)?;
        if argument_bytes.len() > MAX_ARGUMENT_BYTES {
            return Err(DynamicToolRouteError::ArgumentsTooLarge);
        }
        Ok(Self {
            call_id,
            namespace,
            tool_name,
            arguments,
        })
    }

    pub(crate) fn call_id(&self) -> &str {
        &self.call_id
    }

    pub(crate) fn arguments(&self) -> &JsonValue {
        &self.arguments
    }
}

#[derive(Debug, Default)]
pub(crate) struct DynamicToolRegistry {
    registrations: BTreeMap<(String, String), DynamicToolRegistration>,
}

impl DynamicToolRegistry {
    pub(crate) fn from_registrations(
        registrations: impl IntoIterator<Item = DynamicToolRegistration>,
    ) -> Result<Self, DynamicToolRouteError> {
        let mut registry = Self::default();
        for registration in registrations {
            if registry.registrations.len() >= MAX_DYNAMIC_TOOL_REGISTRATIONS {
                return Err(DynamicToolRouteError::RegistrationLimitExceeded);
            }
            let key = (
                registration.namespace.clone(),
                registration.tool_name.to_string(),
            );
            if registry.registrations.insert(key, registration).is_some() {
                return Err(DynamicToolRouteError::RegistrationConflict);
            }
        }
        Ok(registry)
    }

    pub(crate) fn resolve<'a>(
        &'a self,
        invocation: &DynamicToolInvocation,
        current_binding: &ProviderResourceBindingRecord,
    ) -> Result<&'a DynamicToolRegistration, DynamicToolRouteError> {
        let registration = self
            .registrations
            .get(&(invocation.namespace.clone(), invocation.tool_name.clone()))
            .ok_or(DynamicToolRouteError::UnknownTool)?;
        if !registration.matches_current_binding(current_binding) {
            return Err(DynamicToolRouteError::BindingDrift);
        }
        Ok(registration)
    }

    pub(super) fn registration(
        &self,
        invocation: &DynamicToolInvocation,
    ) -> Result<&DynamicToolRegistration, DynamicToolRouteError> {
        self.registrations
            .get(&(invocation.namespace.clone(), invocation.tool_name.clone()))
            .ok_or(DynamicToolRouteError::UnknownTool)
    }

    pub(crate) fn len(&self) -> usize {
        self.registrations.len()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum DynamicToolRouteError {
    #[error("dynamic tool binding record is invalid")]
    InvalidBinding,
    #[error("dynamic tool binding is inactive")]
    InactiveBinding,
    #[error("dynamic tool binding is incompatible")]
    IncompatibleBinding,
    #[error("dynamic tool invocation is invalid")]
    InvalidInvocation,
    #[error("dynamic tool arguments exceed the hard limit")]
    ArgumentsTooLarge,
    #[error("dynamic tool registration limit was exceeded")]
    RegistrationLimitExceeded,
    #[error("dynamic tool registration conflicts with another binding")]
    RegistrationConflict,
    #[error("dynamic tool is not registered")]
    UnknownTool,
    #[error("dynamic tool binding changed after registration")]
    BindingDrift,
}

pub(crate) fn namespace_for_binding(binding_id: &str) -> Result<String, DynamicToolRouteError> {
    let raw = binding_id
        .strip_prefix(BINDING_ID_PREFIX)
        .ok_or(DynamicToolRouteError::InvalidBinding)?;
    let namespace = format!("{NAMESPACE_PREFIX}{}", raw.replace('-', ""));
    validate_identifier(&namespace)?;
    Ok(namespace)
}

pub(crate) fn is_provider_dynamic_tool_namespace(namespace: Option<&str>) -> bool {
    namespace.is_some_and(|namespace| namespace.starts_with(NAMESPACE_PREFIX))
}

fn validate_opaque_id(value: &str, max_bytes: usize) -> Result<(), DynamicToolRouteError> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > max_bytes
        || value.chars().any(char::is_control)
    {
        return Err(DynamicToolRouteError::InvalidInvocation);
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), DynamicToolRouteError> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(DynamicToolRouteError::InvalidInvocation);
    }
    Ok(())
}
