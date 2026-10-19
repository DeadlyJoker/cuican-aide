# ComfyUI video workflow authoring

The short-drama authoring validator now has explicit
`validateComfyApiVideoGraph` and `renderComfyApiVideoGraph` entrypoints. They reuse
the existing bounded graph parser and require a `SaveVideo` output connected to
a declared `VIDEO` port. The existing `validateComfyApiGraph` path continues to
require `SaveImage`; a video cannot qualify an existing v1 image workflow.

This is authoring support, not execution registration, media admission, model
permission, generation, publication or acceptance of a supplier result. It does
not change the public image-generation/result protocol or install a new plugin
package. Other producer-node inputs still receive structural graph validation;
this validator does not establish model loading, reference-file existence or
whole-workflow runtime readiness.

## Current SaveVideo parameters

The saved service's read-only `SaveVideo` declaration uses
`COMFY_DYNAMICCOMBO_V3`. Its MP4/H.264 re-encoding request uses flattened keys:

```json
{
  "video": ["11", 0],
  "filename_prefix": "crewon-host-owned-operation",
  "format": "mp4",
  "format.codec": "h264",
  "format.codec.encoding": "re-encode",
  "format.codec.encoding.crf": 18
}
```

The illustrative wire requires an actual node 11 with VIDEO output; it is not an
executable workflow. The field layout follows the service's captured declaration
and ComfyUI's [dynamic input expansion](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_api/latest/_io.py).
The current [SaveVideo implementation](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_video.py)
defines nested container, codec and encoding choices.

Each selected branch must supply its required inputs. Optional encoding can be
omitted without injecting a default. Fields from an inactive branch, unknown
choices, wrong scalar types and out-of-range numbers are rejected. The hidden
legacy top-level `codec` alias is refused by this new authoring path to avoid two
competing codec selectors. Missing node declarations, IMAGE output presented as
VIDEO, malformed metadata, getters and Proxy declarations fail closed.

Metadata is captured as bounded JSON before inspecting its nested schema. Existing
graph limits, cycle/link checks and frozen output remain shared. Rendering changes
only the declared prompt and filename-prefix slots. Video composition graphs may
explicitly declare `prompt: null`; rendering then requires `values.prompt: null`
and rejects supplied text. Omitting the prompt slot is still rejected, and the
image authoring API still requires a connected prompt. Metadata is not injected into
model history and grants no capability.

## Verification and remaining delivery work

The seven video tests use a captured actual SaveVideo declaration with display-only
fields removed, and an explicitly named producer fixture. Combined with the 17
existing image authoring tests, all 24 pass. The short-drama Node TypeScript
project also passes. No GPU execution, model judgment or media output is implied
by these tests.

Read-only inspection of the saved service finds Wan/LTX diffusion-model choices,
Wan image-to-video and CreateVideo/SaveVideo nodes, and audio VAEs. Catalog entries
do not prove successful weight loading or Chinese speech generation. An audio
VAE is not a TTS service. The user has authorized this project to use the saved video/voice service without
a project expense cap; actual Native configuration and source authorization
still apply.

A real format-only probe submitted one bounded EmptyImage → CreateVideo →
SaveVideo graph through the pinned transport. The service returned a 2,126-byte
H.264 MP4 (64×64, 24 fps, 83.333 ms), and the production inspector decoded both
frames. Its history places MP4 references in `outputs[node].images`, with
`animated: [true]`; the array name does not establish image content. This probe
contains a solid color, has no audio or narrative generation, and does not count
as a project video candidate or lifecycle acceptance. Evidence is recorded in
`output/short-drama-rehearsal-20261015/comfy-video-protocol-probe-20261016.json`.

The actual project still needs a saved complete script and shot plan, a versioned
video execution/result contract with original operation and source pins, Native
approval/configuration, saved video/voice candidates, timeline composition,
real AI review/repair/re-review, playback and commercial usage evidence. The
current v1 result archive remains PNG-only; no MP4 is relabeled as an image.
