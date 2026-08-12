use std::collections::BTreeSet;

use serde::Deserialize;
use serde_json::Value;
use url::Host;
use url::Url;

const MAX_SERVERS: usize = 32;
const MAX_TOOLS_PER_SERVER: usize = 128;
const MAX_TOTAL_TOOLS: usize = 128;
const MAX_SCHEMA_BYTES: usize = 32 * 1024;
const MAX_SCHEMA_DEPTH: usize = 16;
const MAX_SCHEMA_NODES: usize = 4_096;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RemoteMcpProjection {
    schema_version: String,
    servers: Vec<RemoteMcpServer>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteMcpServer {
    server_id: String,
    server_binding_id: String,
    mode: RemoteMcpMode,
    endpoint: String,
    credential_binding_id: String,
    tools: Vec<RemoteMcpTool>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum RemoteMcpMode {
    Production,
    StandaloneLoopback,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RemoteMcpTool {
    descriptor: RemoteMcpDescriptor,
    policy: RemoteMcpPolicy,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteMcpDescriptor {
    name: String,
    description: String,
    input_schema: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoteMcpPolicy {
    effect: String,
    recovery: String,
    resource_binding_id: RequiredNullable,
    credential_binding_id: RequiredNullable,
    execution_target: ExecutionTarget,
    capability: String,
    approval_requirement: String,
    limits: ExecutionLimits,
}

#[derive(Deserialize)]
#[serde(transparent)]
struct RequiredNullable(Value);

impl RequiredNullable {
    fn as_str(&self) -> Result<Option<&str>, ()> {
        match &self.0 {
            Value::Null => Ok(None),
            Value::String(value) => Ok(Some(value)),
            _ => Err(()),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExecutionTarget {
    kind: String,
    binding_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExecutionLimits {
    timeout_ms: u64,
    max_output_bytes: u64,
    max_artifact_bytes: u64,
}

impl RemoteMcpProjection {
    pub(super) fn valid(&self) -> bool {
        if self.schema_version != "crewon.remote-mcp-runtime.v0"
            || self.servers.is_empty()
            || self.servers.len() > MAX_SERVERS
        {
            return false;
        }
        let mut server_ids = BTreeSet::new();
        let mut binding_ids = BTreeSet::new();
        let mut total_tools = 0;
        self.servers.iter().all(|server| {
            total_tools += server.tools.len();
            total_tools <= MAX_TOTAL_TOOLS
                && server_ids.insert(server.server_id.as_str())
                && binding_ids.insert(server.server_binding_id.as_str())
                && server.valid()
        })
    }

    pub(super) fn production_credential_ids(&self) -> BTreeSet<String> {
        self.servers
            .iter()
            .filter(|server| server.mode == RemoteMcpMode::Production)
            .map(|server| server.credential_binding_id.clone())
            .collect()
    }
}

impl RemoteMcpServer {
    fn valid(&self) -> bool {
        if !server_id(&self.server_id)
            || !opaque_id(&self.server_binding_id)
            || !opaque_id(&self.credential_binding_id)
            || !valid_endpoint(&self.endpoint, self.mode)
            || self.tools.is_empty()
            || self.tools.len() > MAX_TOOLS_PER_SERVER
        {
            return false;
        }
        let mut tool_names = BTreeSet::new();
        self.tools
            .iter()
            .all(|tool| tool_names.insert(tool.descriptor.name.as_str()) && tool.valid(self))
    }
}

impl RemoteMcpTool {
    fn valid(&self, server: &RemoteMcpServer) -> bool {
        let exposed_length = 5 + server.server_id.len() + 2 + self.descriptor.name.len();
        tool_name(&self.descriptor.name)
            && exposed_length <= 128
            && bounded(&self.descriptor.description, 2 * 1024)
            && matches!(&self.descriptor.input_schema, Value::Object(object) if object.get("type") == Some(&Value::String("object".to_string())))
            && valid_schema(&self.descriptor.input_schema)
            && self.policy.valid(server)
    }
}

impl RemoteMcpPolicy {
    fn valid(&self, server: &RemoteMcpServer) -> bool {
        self.effect == "mutation"
            && self.recovery == "reconcilable"
            && self
                .resource_binding_id
                .as_str()
                .is_ok_and(|value| value.is_none_or(opaque_id))
            && self.credential_binding_id.as_str()
                == Ok(Some(server.credential_binding_id.as_str()))
            && self.execution_target.kind == "remote"
            && self.execution_target.binding_id == server.server_binding_id
            && capability(&self.capability)
            && matches!(self.approval_requirement.as_str(), "none" | "perAction")
            && (1..=86_400_000).contains(&self.limits.timeout_ms)
            && (1..=1_048_576).contains(&self.limits.max_output_bytes)
            && (1..=1_073_741_824).contains(&self.limits.max_artifact_bytes)
    }
}

fn valid_endpoint(value: &str, mode: RemoteMcpMode) -> bool {
    if !bounded(value, 2_048) {
        return false;
    }
    if !match mode {
        RemoteMcpMode::Production => value.starts_with("https://"),
        RemoteMcpMode::StandaloneLoopback => value.starts_with("http://"),
    } {
        return false;
    }
    let Ok(parsed) = Url::parse(value) else {
        return false;
    };
    let raw_authority = value
        .split_once("://")
        .and_then(|(_, remainder)| remainder.split('/').next())
        .unwrap_or_default();
    let Some((raw_host, raw_port)) = raw_authority.rsplit_once(':') else {
        return false;
    };
    let valid_port = (1..=5).contains(&raw_port.len())
        && raw_port.bytes().all(|byte| byte.is_ascii_digit())
        && raw_port
            .parse::<u32>()
            .is_ok_and(|port| (1..=65_535).contains(&port));
    let loopback = matches!(parsed.host(), Some(Host::Ipv4(address)) if address.octets()[0] == 127)
        && raw_host.split('.').count() == 4
        && raw_host
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|address| address.octets()[0] == 127)
        && parsed.host_str() == Some(raw_host);
    parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.query().is_none()
        && parsed.fragment().is_none()
        && valid_port
        && match mode {
            RemoteMcpMode::Production => parsed.scheme() == "https",
            RemoteMcpMode::StandaloneLoopback => parsed.scheme() == "http" && loopback,
        }
}

fn valid_schema(value: &Value) -> bool {
    fn visit(value: &Value, depth: usize, nodes: &mut usize) -> bool {
        *nodes += 1;
        if *nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH {
            return false;
        }
        match value {
            Value::Array(values) => values.iter().all(|value| visit(value, depth + 1, nodes)),
            Value::Object(values) => values.values().all(|value| visit(value, depth + 1, nodes)),
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => true,
        }
    }
    let mut nodes = 0;
    visit(value, 0, &mut nodes)
        && serde_json::to_vec(value).is_ok_and(|serialized| serialized.len() <= MAX_SCHEMA_BYTES)
}

fn bounded(value: &str, maximum_bytes: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= maximum_bytes
        && !value.bytes().any(|byte| matches!(byte, b'\r' | b'\n' | 0))
}

fn opaque_id(value: &str) -> bool {
    bounded(value, 512)
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
}

fn server_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'_' | b'-'))
        })
}

fn tool_name(value: &str) -> bool {
    opaque_id(value) && value.len() <= 128
}

fn capability(value: &str) -> bool {
    if value.len() > 128 {
        return false;
    }
    let mut segments = value.split(['.', '_', ':', '-']);
    let Some(first) = segments.next() else {
        return false;
    };
    let rest: Vec<_> = segments.collect();
    !first.is_empty()
        && first
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase())
        && first
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && rest.len() <= 15
        && rest.iter().all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        })
}
