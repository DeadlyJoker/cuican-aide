use super::ContextualUserFragment;
use crewon_protocol::scene::SceneExecutionTargetProfile;

const EXECUTION_TARGET_CONTEXT_OPEN_TAG: &str = "<crewon_execution_target_context>";
const EXECUTION_TARGET_CONTEXT_CLOSE_TAG: &str = "</crewon_execution_target_context>";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExecutionTargetContextFragment {
    profile: SceneExecutionTargetProfile,
}

impl ExecutionTargetContextFragment {
    pub(crate) fn new(profile: SceneExecutionTargetProfile) -> Self {
        Self { profile }
    }
}

impl ContextualUserFragment for ExecutionTargetContextFragment {
    fn role(&self) -> &'static str {
        "developer"
    }

    fn markers(&self) -> (&'static str, &'static str) {
        Self::type_markers()
    }

    fn type_markers() -> (&'static str, &'static str) {
        (
            EXECUTION_TARGET_CONTEXT_OPEN_TAG,
            EXECUTION_TARGET_CONTEXT_CLOSE_TAG,
        )
    }

    fn body(&self) -> String {
        let profile = match serde_json::to_string(&self.profile) {
            Ok(profile) => profile,
            Err(_) => "{\"serializationError\":true}".to_string(),
        };
        format!(
            "Use the following user-selected execution-target definition for identity, role, and bounded delegation. Do not infer additional members or capabilities beyond this profile.\n{profile}"
        )
    }
}

#[cfg(test)]
#[path = "execution_target_context_tests.rs"]
mod tests;
