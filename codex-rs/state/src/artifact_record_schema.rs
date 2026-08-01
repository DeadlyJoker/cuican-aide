use crate::ArtifactRecordError;
use crate::ArtifactRecordErrorKind;
use serde_json::Map;
use serde_json::Value;
use std::collections::BTreeSet;

const MAX_METADATA_STRING_BYTES: usize = 1_024;

pub(crate) fn validate_manifest_schema(value: &Value) -> Result<(), ArtifactRecordError> {
    let object = object(value, "manifestJson")?;
    exact_keys(
        object,
        &[
            "approval",
            "artifactRef",
            "createdAt",
            "execution",
            "kind",
            "payload",
            "producer",
            "resource",
            "retention",
            "schemaVersion",
            "trace",
            "verification",
            "workspace",
        ],
        "manifestJson",
    )?;
    positive_integer(
        member(object, "schemaVersion", "manifestJson")?,
        "manifestJson",
    )?;
    validate_artifact_ref(
        member(object, "artifactRef", "manifestJson")?,
        "manifestJson",
    )?;
    one_of_string(
        member(object, "kind", "manifestJson")?,
        &[
            "report",
            "document",
            "image",
            "dataset",
            "codePatch",
            "structuredResult",
            "evidenceBundle",
        ],
        "manifestJson",
    )?;
    validate_payload_ref(member(object, "payload", "manifestJson")?, "manifestJson")?;
    validate_actor(member(object, "producer", "manifestJson")?, "manifestJson")?;
    validate_workspace(member(object, "workspace", "manifestJson")?, "manifestJson")?;
    validate_execution(member(object, "execution", "manifestJson")?, "manifestJson")?;
    validate_resource(member(object, "resource", "manifestJson")?, "manifestJson")?;
    validate_approval(member(object, "approval", "manifestJson")?, "manifestJson")?;
    validate_trace(member(object, "trace", "manifestJson")?, "manifestJson")?;
    one_of_string(
        member(object, "verification", "manifestJson")?,
        &["unverified", "verified", "rejected"],
        "manifestJson",
    )?;
    validate_retention(member(object, "retention", "manifestJson")?, "manifestJson")?;
    non_negative_integer(member(object, "createdAt", "manifestJson")?, "manifestJson")
}

pub(crate) fn validate_audit_schema(value: &Value) -> Result<(), ArtifactRecordError> {
    let object = object(value, "metadataJson")?;
    exact_keys(
        object,
        &[
            "action",
            "approval",
            "actor",
            "artifacts",
            "cost",
            "eventId",
            "execution",
            "idempotencyKey",
            "occurredAt",
            "outcome",
            "payload",
            "resource",
            "schemaVersion",
            "trace",
            "workspace",
        ],
        "metadataJson",
    )?;
    positive_integer(
        member(object, "schemaVersion", "metadataJson")?,
        "metadataJson",
    )?;
    bounded_string(member(object, "eventId", "metadataJson")?, "metadataJson")?;
    bounded_string(
        member(object, "idempotencyKey", "metadataJson")?,
        "metadataJson",
    )?;
    validate_actor(member(object, "actor", "metadataJson")?, "metadataJson")?;
    validate_workspace(member(object, "workspace", "metadataJson")?, "metadataJson")?;
    validate_execution(member(object, "execution", "metadataJson")?, "metadataJson")?;
    one_of_string(
        member(object, "action", "metadataJson")?,
        &[
            "artifactCreated",
            "artifactRead",
            "payloadDeleted",
            "retentionExpired",
            "policyEvaluated",
            "approvalDecided",
            "externalAction",
        ],
        "metadataJson",
    )?;
    validate_outcome(member(object, "outcome", "metadataJson")?, "metadataJson")?;
    validate_trace(member(object, "trace", "metadataJson")?, "metadataJson")?;
    validate_cost(member(object, "cost", "metadataJson")?, "metadataJson")?;
    validate_resource(member(object, "resource", "metadataJson")?, "metadataJson")?;
    validate_approval(member(object, "approval", "metadataJson")?, "metadataJson")?;
    let artifacts = member(object, "artifacts", "metadataJson")?
        .as_array()
        .ok_or_else(|| invalid("metadataJson"))?;
    if artifacts.len() > 16 {
        return Err(invalid("metadataJson"));
    }
    let mut artifact_keys = BTreeSet::new();
    for artifact in artifacts {
        validate_artifact_ref(artifact, "metadataJson")?;
        let artifact = artifact
            .as_object()
            .ok_or_else(|| invalid("metadataJson"))?;
        let key = (
            member(artifact, "artifactId", "metadataJson")?
                .as_str()
                .ok_or_else(|| invalid("metadataJson"))?,
            member(artifact, "revision", "metadataJson")?
                .as_u64()
                .ok_or_else(|| invalid("metadataJson"))?,
        );
        if !artifact_keys.insert(key) {
            return Err(invalid("metadataJson"));
        }
    }
    validate_payload_link(member(object, "payload", "metadataJson")?, "metadataJson")?;
    non_negative_integer(
        member(object, "occurredAt", "metadataJson")?,
        "metadataJson",
    )
}

fn validate_actor(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    let object = object(value, field)?;
    exact_keys(object, &["actorId", "spaceId", "tenantId"], field)?;
    bounded_string(member(object, "actorId", field)?, field)?;
    optional_string(member(object, "tenantId", field)?, field)?;
    optional_string(member(object, "spaceId", field)?, field)?;
    if !member(object, "spaceId", field)?.is_null() && member(object, "tenantId", field)?.is_null()
    {
        return Err(invalid(field));
    }
    Ok(())
}

fn validate_workspace(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    let object = object(value, field)?;
    exact_keys(
        object,
        &["bindingId", "scope", "scopeId", "workspaceKey"],
        field,
    )?;
    bounded_string(member(object, "bindingId", field)?, field)?;
    bounded_string(member(object, "scopeId", field)?, field)?;
    bounded_string(member(object, "workspaceKey", field)?, field)?;
    one_of_string(
        member(object, "scope", field)?,
        &["conversation", "office", "workflow", "automation"],
        field,
    )
}

fn validate_execution(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    let object = object(value, field)?;
    match discriminator(object, field)? {
        "conversation" => {
            exact_keys(object, &["threadId", "turnId", "type"], field)?;
            bounded_string(member(object, "threadId", field)?, field)?;
            bounded_string(member(object, "turnId", field)?, field)
        }
        "task" => {
            exact_keys(object, &["attemptId", "runId", "taskId", "type"], field)?;
            bounded_string(member(object, "attemptId", field)?, field)?;
            bounded_string(member(object, "runId", field)?, field)?;
            bounded_string(member(object, "taskId", field)?, field)
        }
        _ => Err(invalid(field)),
    }
}

fn validate_resource(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    let object = object(value, field)?;
    match discriminator(object, field)? {
        "none" => exact_keys(object, &["type"], field),
        "provider" => {
            exact_keys(object, &["provider", "type"], field)?;
            validate_provider_ref(member(object, "provider", field)?, field)
        }
        "resource" => {
            exact_keys(object, &["resource", "type"], field)?;
            validate_resource_ref(member(object, "resource", field)?, field)
        }
        _ => Err(invalid(field)),
    }
}

fn validate_approval(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    let object = object(value, field)?;
    match discriminator(object, field)? {
        "none" => exact_keys(object, &["type"], field),
        "decision" => {
            exact_keys(
                object,
                &["accessDecisionId", "actionDigest", "approvalId", "type"],
                field,
            )?;
            bounded_string(member(object, "accessDecisionId", field)?, field)?;
            canonical_digest(member(object, "actionDigest", field)?, field)?;
            bounded_string(member(object, "approvalId", field)?, field)
        }
        _ => Err(invalid(field)),
    }
}

fn validate_trace(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    let object = object(value, field)?;
    exact_keys(object, &["parentSpanId", "spanId", "traceId"], field)?;
    bounded_string(member(object, "traceId", field)?, field)?;
    let span_id = member(object, "spanId", field)?;
    bounded_string(span_id, field)?;
    let parent = member(object, "parentSpanId", field)?;
    optional_string(parent, field)?;
    if parent
        .as_str()
        .is_some_and(|parent| Some(parent) == span_id.as_str())
    {
        return Err(invalid(field));
    }
    Ok(())
}

fn validate_retention(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    let object = object(value, field)?;
    match discriminator(object, field)? {
        "userManaged" => exact_keys(object, &["type"], field),
        "session" | "task" | "compliance" => {
            exact_keys(object, &["expiresAt", "type"], field)?;
            non_negative_integer(member(object, "expiresAt", field)?, field)
        }
        _ => Err(invalid(field)),
    }
}

fn validate_outcome(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    let object = object(value, field)?;
    match discriminator(object, field)? {
        "succeeded" => exact_keys(object, &["type"], field),
        "failed" | "denied" | "cancelled" | "unknown" => {
            exact_keys(object, &["errorCode", "type"], field)?;
            bounded_string(member(object, "errorCode", field)?, field)
        }
        _ => Err(invalid(field)),
    }
}

fn validate_cost(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    let correlation = object(value, field)?;
    match discriminator(correlation, field)? {
        "none" => exact_keys(correlation, &["type"], field),
        "usage" => {
            exact_keys(correlation, &["cost", "type"], field)?;
            let cost = object(member(correlation, "cost", field)?, field)?;
            exact_keys(
                cost,
                &[
                    "amountMicros",
                    "currency",
                    "inputTokens",
                    "outputTokens",
                    "toolCalls",
                ],
                field,
            )?;
            non_negative_integer(member(cost, "inputTokens", field)?, field)?;
            non_negative_integer(member(cost, "outputTokens", field)?, field)?;
            non_negative_integer(member(cost, "toolCalls", field)?, field)?;
            non_negative_integer(member(cost, "amountMicros", field)?, field)?;
            bounded_string(member(cost, "currency", field)?, field)
        }
        _ => Err(invalid(field)),
    }
}

fn validate_payload_link(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    let object = object(value, field)?;
    match discriminator(object, field)? {
        "none" => exact_keys(object, &["type"], field),
        "payload" => {
            exact_keys(object, &["payload", "type"], field)?;
            validate_payload_ref(member(object, "payload", field)?, field)
        }
        _ => Err(invalid(field)),
    }
}

fn validate_artifact_ref(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    let object = object(value, field)?;
    exact_keys(object, &["artifactId", "revision"], field)?;
    bounded_string(member(object, "artifactId", field)?, field)?;
    positive_integer(member(object, "revision", field)?, field)
}

fn validate_payload_ref(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    let object = object(value, field)?;
    exact_keys(
        object,
        &["byteLen", "digest", "mediaType", "payloadId", "sensitivity"],
        field,
    )?;
    bounded_string(member(object, "payloadId", field)?, field)?;
    canonical_digest(member(object, "digest", field)?, field)?;
    let byte_len = member(object, "byteLen", field)?
        .as_u64()
        .ok_or_else(|| invalid(field))?;
    if byte_len > 8 * 1024 * 1024 {
        return Err(invalid(field));
    }
    bounded_string(member(object, "mediaType", field)?, field)?;
    one_of_string(
        member(object, "sensitivity", field)?,
        &["public", "internal", "workspaceSensitive"],
        field,
    )
}

fn validate_provider_ref(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    let object = object(value, field)?;
    exact_keys(object, &["protocolVersion", "providerId"], field)?;
    bounded_string(member(object, "providerId", field)?, field)?;
    bounded_string(member(object, "protocolVersion", field)?, field)
}

fn validate_resource_ref(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    let object = object(value, field)?;
    exact_keys(
        object,
        &["kind", "provider", "resourceId", "revision"],
        field,
    )?;
    validate_provider_ref(member(object, "provider", field)?, field)?;
    one_of_string(
        member(object, "kind", field)?,
        &[
            "agent",
            "skill",
            "mcpServer",
            "mcpTool",
            "knowledgeBase",
            "workflow",
        ],
        field,
    )?;
    bounded_string(member(object, "resourceId", field)?, field)?;
    bounded_string(member(object, "revision", field)?, field)
}

fn exact_keys(
    object: &Map<String, Value>,
    expected: &[&str],
    field: &'static str,
) -> Result<(), ArtifactRecordError> {
    let actual = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    if actual != expected {
        return Err(invalid(field));
    }
    Ok(())
}

fn object<'a>(
    value: &'a Value,
    field: &'static str,
) -> Result<&'a Map<String, Value>, ArtifactRecordError> {
    value.as_object().ok_or_else(|| invalid(field))
}

fn member<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    field: &'static str,
) -> Result<&'a Value, ArtifactRecordError> {
    object.get(key).ok_or_else(|| invalid(field))
}

fn discriminator<'a>(
    object: &'a Map<String, Value>,
    field: &'static str,
) -> Result<&'a str, ArtifactRecordError> {
    member(object, "type", field)?
        .as_str()
        .ok_or_else(|| invalid(field))
}

fn bounded_string(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    let value = value.as_str().ok_or_else(|| invalid(field))?;
    if value.trim().is_empty()
        || value.len() > MAX_METADATA_STRING_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(invalid(field));
    }
    Ok(())
}

fn optional_string(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    if value.is_null() {
        Ok(())
    } else {
        bounded_string(value, field)
    }
}

fn one_of_string(
    value: &Value,
    accepted: &[&str],
    field: &'static str,
) -> Result<(), ArtifactRecordError> {
    let value = value.as_str().ok_or_else(|| invalid(field))?;
    if accepted.contains(&value) {
        Ok(())
    } else {
        Err(invalid(field))
    }
}

fn non_negative_integer(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    if value.as_u64().is_some() {
        Ok(())
    } else {
        Err(invalid(field))
    }
}

fn positive_integer(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    if value.as_u64().is_some_and(|value| value > 0) {
        Ok(())
    } else {
        Err(invalid(field))
    }
}

fn canonical_digest(value: &Value, field: &'static str) -> Result<(), ArtifactRecordError> {
    let value = value.as_str().ok_or_else(|| invalid(field))?;
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(invalid(field));
    };
    if hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(invalid(field))
    }
}

fn invalid(field: &'static str) -> ArtifactRecordError {
    ArtifactRecordError::new(field, ArtifactRecordErrorKind::InconsistentFields)
}
