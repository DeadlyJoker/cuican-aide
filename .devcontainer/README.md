# Containerized Development

`devcontainer.json` provides a lightweight Crewon contributor environment for
working on this repository. Legacy containers that installed the old terminal
shell have been removed; local development should use the Rust backend and the
PC/Web/Mobile clients directly.

## Docker

To build the contributor image locally for x64 and then run it with the repo mounted under `/workspace`:

```shell
CREWON_DOCKER_IMAGE_NAME=crewon-linux-dev
docker build --platform=linux/amd64 -t "$CREWON_DOCKER_IMAGE_NAME" ./.devcontainer
docker run --platform=linux/amd64 --rm -it -e CARGO_TARGET_DIR=/workspace/codex-rs/target-amd64 -v "$PWD":/workspace -w /workspace/codex-rs "$CREWON_DOCKER_IMAGE_NAME"
```

Note that `/workspace/target` will contain the binaries built for your host platform, so we include `-e CARGO_TARGET_DIR=/workspace/codex-rs/target-amd64` in the `docker run` command so that the binaries built inside your container are written to a separate directory.

For arm64, specify `--platform=linux/arm64` instead for both `docker build` and `docker run`.

Currently, the contributor `Dockerfile` works for both x64 and arm64 Linux, though you need to run `rustup target add x86_64-unknown-linux-musl` yourself to install the musl toolchain for x64.
