//! Sigils for tool/plugin mentions in plaintext (shared across Crewon crates).

/// Default plaintext sigil for tools.
pub const TOOL_MENTION_SIGIL: char = '$';

/// Plugins use `@` in linked plaintext outside rich clients.
pub const PLUGIN_TEXT_MENTION_SIGIL: char = '@';
