use crate::ProviderIdentityBindingRecordError;
use crate::ProviderIdentityBindingRecordErrorKind;

pub(crate) fn validate_text(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), ProviderIdentityBindingRecordError> {
    if value.is_empty() || value.trim() != value || value.chars().any(char::is_control) {
        return Err(error(field, ProviderIdentityBindingRecordErrorKind::Empty));
    }
    if value.len() > max_bytes {
        return Err(error(
            field,
            ProviderIdentityBindingRecordErrorKind::TooLong,
        ));
    }
    Ok(())
}

pub(crate) fn validate_revision(
    value: u64,
    field: &'static str,
) -> Result<(), ProviderIdentityBindingRecordError> {
    if value == 0 || i64::try_from(value).is_err() {
        return Err(error(
            field,
            ProviderIdentityBindingRecordErrorKind::OutOfRange,
        ));
    }
    Ok(())
}

pub(crate) fn error(
    field: &'static str,
    kind: ProviderIdentityBindingRecordErrorKind,
) -> ProviderIdentityBindingRecordError {
    ProviderIdentityBindingRecordError { field, kind }
}
