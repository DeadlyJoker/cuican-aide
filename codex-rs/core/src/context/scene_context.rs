use super::ContextualUserFragment;
use crewon_protocol::scene::SceneThreadMetadata;

const SCENE_CONTEXT_OPEN_TAG: &str = "<crewon_scene_context>";
const SCENE_CONTEXT_CLOSE_TAG: &str = "</crewon_scene_context>";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SceneContextFragment {
    metadata: SceneThreadMetadata,
}

impl SceneContextFragment {
    pub(crate) fn new(metadata: SceneThreadMetadata) -> Self {
        Self { metadata }
    }
}

impl ContextualUserFragment for SceneContextFragment {
    fn role(&self) -> &'static str {
        "developer"
    }

    fn markers(&self) -> (&'static str, &'static str) {
        Self::type_markers()
    }

    fn type_markers() -> (&'static str, &'static str) {
        (SCENE_CONTEXT_OPEN_TAG, SCENE_CONTEXT_CLOSE_TAG)
    }

    fn body(&self) -> String {
        crewon_scene_runtime::render_scene_instructions(&self.metadata)
    }
}
