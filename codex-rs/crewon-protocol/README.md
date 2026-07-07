# crewon-protocol

This crate defines the protocol types shared by Crewon backend components,
including internal core messages and external app-server payloads.

This crate should have minimal dependencies.

Ideally, we should avoid "material business logic" in this crate, as we can always introduce `Ext`-style traits to add functionality to types in other crates.
