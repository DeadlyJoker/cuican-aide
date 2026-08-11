use std::collections::BTreeSet;

use serde::Serialize;
use zeroize::Zeroizing;

const PRIVATE_CREDENTIAL_SCHEMA_VERSION: &str = "crewon.remote-mcp-private-credentials.v1";
const MAX_BINDINGS: usize = 32;
const MAX_BEARER_BYTES: usize = 4_096;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateCredentialBindings {
    schema_version: &'static str,
    authority: PrivateCredentialAuthority,
    bindings: Vec<PrivateCredentialBinding>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivateCredentialAuthority {
    tenant_id: String,
    workspace_binding_id: String,
    runtime_binding_id: String,
    agent_version_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PrivateCredentialBinding {
    credential_binding_id: String,
    bearer_token: Zeroizing<String>,
}

impl std::fmt::Debug for PrivateCredentialBindings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PrivateCredentialBindings([REDACTED])")
    }
}

impl PrivateCredentialBindings {
    pub fn new(
        tenant_id: String,
        workspace_binding_id: String,
        runtime_binding_id: String,
        agent_version_id: String,
        bindings: Vec<(String, Zeroizing<String>)>,
    ) -> Result<Self, ()> {
        if !valid_id(&tenant_id)
            || !valid_id(&workspace_binding_id)
            || !valid_id(&runtime_binding_id)
            || !valid_id(&agent_version_id)
            || bindings.is_empty()
            || bindings.len() > MAX_BINDINGS
        {
            return Err(());
        }
        let mut ids = BTreeSet::new();
        let mut parsed = Vec::with_capacity(bindings.len());
        for (credential_binding_id, bearer_token) in bindings {
            if !valid_id(&credential_binding_id)
                || bearer_token.is_empty()
                || bearer_token.len() > MAX_BEARER_BYTES
                || bearer_token
                    .bytes()
                    .any(|byte| !(0x21..=0x7e).contains(&byte))
                || !ids.insert(credential_binding_id.clone())
            {
                return Err(());
            }
            parsed.push(PrivateCredentialBinding {
                credential_binding_id,
                bearer_token,
            });
        }
        Ok(Self {
            schema_version: PRIVATE_CREDENTIAL_SCHEMA_VERSION,
            authority: PrivateCredentialAuthority {
                tenant_id,
                workspace_binding_id,
                runtime_binding_id,
                agent_version_id,
            },
            bindings: parsed,
        })
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
}
