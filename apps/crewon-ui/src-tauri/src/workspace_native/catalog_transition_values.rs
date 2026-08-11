enum WorkspaceAuthorityMutation {
    Select(CanonicalWorkspace),
    Clear,
}

impl WorkspaceAuthorityMutation {
    fn intent(&self) -> WorkspaceAuthorityIntent {
        match self {
            Self::Select(_) => WorkspaceAuthorityIntent::Select,
            Self::Clear => WorkspaceAuthorityIntent::Clear,
        }
    }
}
