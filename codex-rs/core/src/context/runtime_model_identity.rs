use super::ContextualUserFragment;

const MAX_MODEL_ID_CHARS: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeModelIdentity {
    model_id: String,
}

impl RuntimeModelIdentity {
    pub(crate) fn new(model_id: &str) -> Self {
        let model_id = model_id
            .chars()
            .take(MAX_MODEL_ID_CHARS)
            .map(|character| {
                if character.is_ascii_alphanumeric()
                    || matches!(character, '.' | '_' | ':' | '/' | '-')
                {
                    character
                } else {
                    '?'
                }
            })
            .collect();
        Self { model_id }
    }
}

impl ContextualUserFragment for RuntimeModelIdentity {
    fn role(&self) -> &'static str {
        "developer"
    }

    fn markers(&self) -> (&'static str, &'static str) {
        Self::type_markers()
    }

    fn type_markers() -> (&'static str, &'static str) {
        ("<runtime_model_identity>", "</runtime_model_identity>")
    }

    fn body(&self) -> String {
        format!(
            "\nThe active model identifier for this conversation is `{}`. If the user asks which model is running, state this identifier directly. Do not claim that the model identity is unavailable.\n",
            self.model_id
        )
    }
}

#[cfg(test)]
#[path = "runtime_model_identity_tests.rs"]
mod tests;
