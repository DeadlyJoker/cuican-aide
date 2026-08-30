use crate::ActionIntent;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de;
use serde_json::Value as JsonValue;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::fmt;

const ACTION_DIGEST_DOMAIN: &[u8] = b"crewon.action-digest.v1\0";
const ARGUMENTS_DIGEST_DOMAIN: &[u8] = b"crewon.action-arguments.v1\0";
const MAX_ARGUMENT_BYTES: usize = 256 * 1024;
const MAX_ARGUMENT_DEPTH: usize = 32;
const MAX_ARGUMENT_NODES: usize = 4_096;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ArgumentsHash(String);

impl ArgumentsHash {
    pub(crate) fn compute(arguments: &JsonValue) -> Result<Self, PolicyModelError> {
        let mut nodes = 0;
        let mut estimated_bytes = 0;
        validate_arguments(
            arguments,
            /*depth*/ 0,
            &mut nodes,
            &mut estimated_bytes,
        )?;
        let bytes = canonical_json_bytes(arguments)?;
        if bytes.len() > MAX_ARGUMENT_BYTES {
            return Err(PolicyModelError::limit("arguments"));
        }
        Ok(Self(domain_hash(ARGUMENTS_DIGEST_DOMAIN, &bytes)))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ActionDigest(String);

impl ActionDigest {
    pub(crate) fn compute(action: &ActionIntent) -> Result<Self, PolicyModelError> {
        let bytes = canonical_json_bytes(action)?;
        Ok(Self(domain_hash(ACTION_DIGEST_DOMAIN, &bytes)))
    }

    pub fn parse(value: impl Into<String>) -> Result<Self, PolicyModelError> {
        let value = value.into();
        if valid_sha256(&value) {
            Ok(Self(value))
        } else {
            Err(PolicyModelError::invalid("actionDigest"))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for ActionDigest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyModelErrorKind {
    Invalid,
    LimitExceeded,
    Serialization,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyModelError {
    field: &'static str,
    kind: PolicyModelErrorKind,
}

impl PolicyModelError {
    pub(crate) fn invalid(field: &'static str) -> Self {
        Self {
            field,
            kind: PolicyModelErrorKind::Invalid,
        }
    }

    fn limit(field: &'static str) -> Self {
        Self {
            field,
            kind: PolicyModelErrorKind::LimitExceeded,
        }
    }

    fn serialization() -> Self {
        Self {
            field: "canonicalEncoding",
            kind: PolicyModelErrorKind::Serialization,
        }
    }

    pub fn field(&self) -> &'static str {
        self.field
    }

    pub fn kind(&self) -> PolicyModelErrorKind {
        self.kind
    }
}

impl fmt::Display for PolicyModelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid policy model field {}: {:?}",
            self.field, self.kind
        )
    }
}

impl std::error::Error for PolicyModelError {}

pub(crate) fn canonical_json_string(value: &impl Serialize) -> Result<String, PolicyModelError> {
    String::from_utf8(canonical_json_bytes(value)?).map_err(|_| PolicyModelError::serialization())
}

fn canonical_json_bytes(value: &impl Serialize) -> Result<Vec<u8>, PolicyModelError> {
    let value = serde_json::to_value(value).map_err(|_| PolicyModelError::serialization())?;
    serde_json::to_vec(&canonicalize_json(value)).map_err(|_| PolicyModelError::serialization())
}

fn canonicalize_json(value: JsonValue) -> JsonValue {
    match value {
        JsonValue::Array(values) => {
            JsonValue::Array(values.into_iter().map(canonicalize_json).collect())
        }
        JsonValue::Object(values) => JsonValue::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, canonicalize_json(value)))
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .collect(),
        ),
        scalar => scalar,
    }
}

fn domain_hash(domain: &[u8], bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

fn valid_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

pub(crate) fn validate_opaque_text(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), PolicyModelError> {
    if value.is_empty()
        || value.len() > max_bytes
        || value.chars().any(char::is_control)
        || value
            .chars()
            .any(|character| character.is_whitespace() || matches!(character, '/' | '\\'))
    {
        Err(PolicyModelError::invalid(field))
    } else {
        Ok(())
    }
}

fn validate_arguments(
    value: &JsonValue,
    depth: usize,
    nodes: &mut usize,
    estimated_bytes: &mut usize,
) -> Result<(), PolicyModelError> {
    *nodes = nodes.saturating_add(1);
    *estimated_bytes = estimated_bytes.saturating_add(match value {
        JsonValue::Null => 4,
        JsonValue::Bool(value) => usize::from(*value) + 4,
        JsonValue::Number(value) => value.to_string().len(),
        JsonValue::String(value) => value.len(),
        JsonValue::Array(_) | JsonValue::Object(_) => 2,
    });
    if depth > MAX_ARGUMENT_DEPTH
        || *nodes > MAX_ARGUMENT_NODES
        || *estimated_bytes > MAX_ARGUMENT_BYTES
    {
        return Err(PolicyModelError::limit("arguments"));
    }
    match value {
        JsonValue::Array(values) => {
            for value in values {
                validate_arguments(value, depth.saturating_add(1), nodes, estimated_bytes)?;
            }
        }
        JsonValue::Object(values) => {
            for (key, value) in values {
                *estimated_bytes = estimated_bytes.saturating_add(key.len());
                if *estimated_bytes > MAX_ARGUMENT_BYTES {
                    return Err(PolicyModelError::limit("arguments"));
                }
                validate_arguments(value, depth.saturating_add(1), nodes, estimated_bytes)?;
            }
        }
        JsonValue::Bool(_) | JsonValue::Null | JsonValue::Number(_) | JsonValue::String(_) => {}
    }
    Ok(())
}
