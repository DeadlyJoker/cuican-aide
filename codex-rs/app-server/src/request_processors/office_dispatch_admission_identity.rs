use sha2::Digest as _;
use sha2::Sha256;

const ADMISSION_IDENTITY_VERSION: u8 = 1;
const CLIENT_ID_PREFIX: &str = "office-dispatch-v1-";
const MAX_CLIENT_ID_BYTES: usize = 256;

/// Canonical Office dispatch fields used to derive a durable core admission identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct OfficeDispatchAdmissionFields<'a> {
    pub(crate) record_id: &'a str,
    pub(crate) intent_id: &'a str,
    pub(crate) source_thread_id: &'a str,
    pub(crate) source_turn_id: &'a str,
    pub(crate) target_thread_id: &'a str,
    pub(crate) run_id: &'a str,
    pub(crate) dispatch_kind: &'a str,
    pub(crate) subject_id: &'a str,
    pub(crate) prompt: &'a str,
}

/// Bounded client identity and payload fingerprint accepted by core durable admission.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OfficeDispatchAdmissionIdentity {
    pub(crate) client_id: String,
    pub(crate) payload_hash: String,
}

pub(crate) fn derive_office_dispatch_admission_identity(
    fields: OfficeDispatchAdmissionFields<'_>,
) -> OfficeDispatchAdmissionIdentity {
    let version = ADMISSION_IDENTITY_VERSION.to_string();
    let client_digest = digest_fields([
        ("version", version.as_str()),
        ("recordId", fields.record_id),
        ("intentId", fields.intent_id),
    ]);
    let client_id = format!("{CLIENT_ID_PREFIX}{client_digest}");
    debug_assert!(client_id.len() <= MAX_CLIENT_ID_BYTES);

    let payload_hash = digest_fields([
        ("version", version.as_str()),
        ("recordId", fields.record_id),
        ("intentId", fields.intent_id),
        ("sourceThreadId", fields.source_thread_id),
        ("sourceTurnId", fields.source_turn_id),
        ("targetThreadId", fields.target_thread_id),
        ("runId", fields.run_id),
        ("dispatchKind", fields.dispatch_kind),
        ("subjectId", fields.subject_id),
        ("prompt", fields.prompt),
    ]);

    OfficeDispatchAdmissionIdentity {
        client_id,
        payload_hash,
    }
}

fn digest_fields<const N: usize>(fields: [(&str, &str); N]) -> String {
    let mut hasher = Sha256::new();
    for (name, value) in fields {
        update_length_prefixed(&mut hasher, name.as_bytes());
        update_length_prefixed(&mut hasher, value.as_bytes());
    }
    let digest = hasher.finalize();
    format!("{digest:x}")
}

fn update_length_prefixed(hasher: &mut Sha256, value: &[u8]) {
    let length = value.len() as u64;
    hasher.update(length.to_be_bytes());
    hasher.update(value);
}

#[cfg(test)]
#[path = "office_dispatch_admission_identity_tests.rs"]
mod tests;
