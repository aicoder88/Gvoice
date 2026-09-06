# GVoice, Natively, and Meetily consolidation audit

Inspected 5 September 2026 on this Mac: Apple M4, 16 GiB RAM. The data volume reported approximately 4.6 GiB available. Sizes below use binary units: 1 GiB = 1,024 MiB.

**Recommendation:** keep the three app interfaces separate for now. Recover space from installers and generated files first. An optional shared local text service is a sensible integration boundary, but there is no duplicated large text-generation model across these installations to remove today. A full app merger would be a substantial feature and maintenance project with relatively modest savings from sharing the app framework.

This was an inspection. No application, model, setting, recording, or existing source file was changed; no inference requests, downloads, builds, or cleanup operations were run. This report is the only new file.

## What is actually installed and selected

| App | Installed app footprint | Speech recognition | Text generation / supporting models |
| --- | ---: | --- | --- |
| GVoice 1.0.0 | about 292 MiB | The running whisper-server loads `ggml-small.en-q5_1.bin`, 181.3 MiB, from this repository. | Both development and installed settings select Groq `openai/gpt-oss-120b` for cleanup. No local cleanup LLM is selected. |
| Meetily 0.4.0 | about 118 MiB | Saved selection is `parakeet-tdt-0.6b-v3-int8`; its model directory occupies about 644 MiB. | Saved selection is Built-in AI `qwen3.5:4b`; the existing `Qwen3.5-4B-Q4_K_M.gguf` is 2,614.0 MiB, about 2.55 GiB. |
| Natively 2.8.8 | about 2.4 GiB | No downloaded ASR model directory was found in its normal user-data location. Its source supports Transformers.js/ONNX speech models. This does not establish which speech provider is active. | Settings enable its Codex CLI connection, with saved main/fast model names. About 521 MiB of bundled resources support embeddings, reranking, classification, and turn detection; these are not a general-purpose chat LLM. |

GVoice also has `ggml-medium.en.bin`, 1,462.7 MiB, about 1.43 GiB. It is not the model loaded by the running GVoice speech server. That makes it a removal candidate if it is no longer wanted as an alternate model, not proof that it has no future value.

The inspected GVoice installed `main.js`, `src/cleanup.js`, and `src/providers/whisper-local.js` match the working repository byte for byte. The repository has pre-existing uncommitted cleanup work, which was left untouched. Natively's source and installation both report version 2.8.8, but that version number alone does not establish that every installed implementation matches the newer repository checkout.

The GVoice README describes language selection, but current `main.js` explicitly fixes dictation to English. The live model is also English-only. Any future transcription integration must establish its intended language behavior from the running app and code, rather than relying on the README.

## Concrete disk-space opportunities

| Candidate | Measured size | What removal would mean |
| --- | ---: | --- |
| `/Users/macmini/dev/epso/natively/Natively-2.8.8-arm64.dmg` | 970.6 MiB | Removes the downloaded Mac installer, leaving the installed app. Reinstallation would require obtaining an installer again. |
| `/Users/macmini/dev/epso/natively/Natively-Setup-2.8.8-x64.exe` | 849.5 MiB | Removes the downloaded Windows installer. It is not the app running on this Mac. |
| `/Users/macmini/dev/epso/meetily/meetily_0.4.0_aarch64.dmg` | 46.8 MiB | Removes the downloaded installer, leaving the installed app. |
| `/Users/macmini/dev/epso/meetily/frontend/.next/cache` | 505.4 MiB allocated | Removes generated frontend build caches. A later development build would recreate what it needs. Check for active development before removal. |
| `/Users/macmini/dev/voice/dist` | 292.5 MiB allocated | Removes generated app build output. The running app is under `/Applications/GVoice.app`. The build copy would need to be recreated if wanted again. |
| `/Users/macmini/dev/voice/models/ggml-medium.en.bin` | 1,462.7 MiB | Optional additional saving if the inactive alternate speech model is no longer wanted. Keep the active small model. |

The first five candidates total **about 2.60 GiB**. Including the inactive medium speech model gives **about 4.03 GiB**. These are candidate file footprints, not a promise of an identical increase in filesystem free space: APFS sharing and snapshots may affect the observed result. Nothing has been deleted. Moving files to Trash on the same volume alone does not reclaim their space.

Natively has a separate packaging opportunity: its installed archive contains **9,486 source-map debug files totaling 630.95 MiB**, about 0.62 GiB. Several generated JavaScript entry bundles are also approximately 21 MiB each, and their contents need a build-level duplication analysis. Excluding release source maps and investigating repeated bundles could reduce future installations without merging apps. This is an opportunity for a properly built and verified release; do not surgically edit the installed app archive or remove its model resources.

Other measured development footprints include approximately 1.8 GiB of Natively dependencies and a 632 MiB Git directory. They support development and repository recovery, so they are not included in the cleanup total. A separate 2.9 GiB Hugging Face faster-whisper cache exists, but ownership and use by other apps were not established; it is also excluded.

## Shared text generation: feasible, primarily a capability benefit

The useful target is one independently managed local text service loading the existing Qwen GGUF, with each app choosing it as an optional provider. This avoids distributing another copy of the model to GVoice or Natively.

| Client | Existing integration point | Remaining work or limit |
| --- | --- | --- |
| Meetily | Custom OpenAI-compatible endpoint; also supports an Ollama endpoint. | Select the shared endpoint instead of Built-in AI when using the shared service. Its current built-in helper uses stdin/stdout and app-owned lifecycle management, not a public HTTP service. |
| Natively | Ollama and custom-provider support in the source. | Configure and verify the installed app's custom-provider request and response mapping. Test text separately from any screenshot, vision, tool, or retrieval features. |
| GVoice | Cleanup already uses chat-completion requests for some providers. | Add a custom/local provider with an editable base URL and model, appropriate local authentication behavior, settings persistence, and controlled request failure. Current provider URLs are fixed; setting a model name alone cannot redirect requests locally. |

`llama-server` is a suitable candidate because it can load a model by file path and exposes an OpenAI-compatible chat endpoint. That would allow reuse of the existing GGUF without an intentional second model download. The precise installed Qwen file, runtime version, chat template, quality, and latency still need a bounded compatibility trial. No compatible standalone `llama-server` or Ollama executable was found in the inspected standard binary locations. See the [official llama.cpp server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).

Ollama is another supported integration option. Its [official import documentation](https://docs.ollama.com/import) describes importing GGUF files, but this audit has not verified the resulting storage allocation for this file. Importing is not evidence of zero-copy sharing. With the current free space, do not install or import a second model merely to find out.

Sharing a model file and sharing a running inference process are different. Two app-owned processes may use the same weights on disk and still allocate separate inference state in RAM. A common service should own startup, request limits, cancellation, and idle unloading; closing GVoice or Meetily should not terminate work requested by another app. Meetily's current built-in helper must not remain a second active owner when the shared service is selected.

GVoice currently limits cleanup to about 2.5 seconds and rejects changes that fail its wording-preservation checks. A meeting summary can be much longer than a dictation cleanup. A shared service therefore needs bounded concurrency and a way to keep long summary work from making every dictation wait. On this 16 GiB machine, memory and latency must be measured before making local cleanup the default. Retain the raw-transcript fallback and existing selectable providers; do not assume a local 4B model matches the present provider's output quality.

There is **no immediate multi-gigabyte LLM deduplication saving** here: Meetily already owns the only identified large local chat-model file among the three. The benefit would be extending offline/local text generation to the other apps while avoiding future duplication.

## Speech models: no direct file sharing in the current setup

- GVoice uses whisper.cpp GGML weights and manages its own `whisper-server` process. Although it reads a server URL for requests, its attach path still calls its own server startup routine. A genuinely external service requires explicit client-only lifecycle behavior; changing a URL alone is insufficient.
- Meetily currently uses its Parakeet TDT v3 ONNX encoder, decoder/joint, preprocessor, and vocabulary. Its alternate Whisper engine uses whisper.cpp-compatible weights, but its model catalog and selection behavior do not automatically accept GVoice's current small English quantized model.
- Natively's source uses Transformers.js/ONNX model layouts. Its Parakeet entry is CTC, which is a different model and decoding architecture from Meetily's TDT. A matching family name or `.onnx` extension does not establish compatible files.

Symlinking these model directories would not bridge their formats or inference APIs. Consolidation would require a common speech provider and changes to the clients, with tests for short dictation, long meeting capture, cancellation, language handling, and simultaneous use.

Retiring GVoice's *active* speech weights in favor of an already-installed shared speech engine would save only about **181 MiB** of additional model storage today. The 1.43 GiB inactive medium model can be considered independently of any integration. This weakens the case for rewriting working dictation solely to save disk space.

## Full app merger

GVoice and Natively both use Electron; Meetily uses Tauri with a Rust core. Moving all three workflows into one app would involve native audio capture, permissions, hotkeys, transcription events, meeting storage, UI integration, and release maintenance. Simply putting the repositories together would not eliminate those separate runtimes or models.

Removing one duplicate Electron framework through a real GVoice/Natively merger would save roughly 273 MiB of installed framework footprint. Meetily's entire app is only about 118 MiB. The measured cleanup and Natively packaging opportunities are larger and much less coupled to working features.

If a unified experience is later desired, GVoice can remain the tray entry point with separate dictation, meeting, and assistant actions that use common services. That does not require immediately absorbing both codebases or removing their own interfaces.

Natively's checked-in [license](/Users/macmini/dev/epso/natively/LICENSE) is a personal/non-commercial source license with restrictions on derivatives and redistribution. Meetily's checked-in license is MIT. Natively code and prompts should not be treated as permissively licensed building blocks for a distributable GVoice merger; intended distribution and licensing would need separate consideration. No code was copied between projects.

## Evidence and verification limits

Local evidence came from directory allocation measurements, file metadata, read-only settings/database queries restricted to provider and model fields, process inspection, and in-place reading of Electron archive headers and selected files. API keys, meeting contents, and recordings were not needed for this assessment. Full model hashing and inference were unnecessary for the identified distinct model formats and were not performed.

Source locations relevant to the recommendation:

- [GVoice cleanup providers and timeout](/Users/macmini/dev/voice/src/cleanup.js:29)
- [GVoice speech server ownership](/Users/macmini/dev/voice/src/providers/whisper-local.js:276)
- [GVoice current language invariant](/Users/macmini/dev/voice/main.js:948)
- [Meetily external text endpoints](/Users/macmini/dev/epso/meetily/frontend/src-tauri/src/summary/llm_client.rs:149)
- [Meetily built-in helper ownership](/Users/macmini/dev/epso/meetily/frontend/src-tauri/src/summary/summary_engine/sidecar.rs:279)
- [Meetily Parakeet model layout](/Users/macmini/dev/epso/meetily/frontend/src-tauri/src/parakeet_engine/model.rs:61)
- [Natively speech model catalog](/Users/macmini/dev/epso/natively/electron/audio/whisper/modelManager.ts:10)
- [Natively custom provider interface](/Users/macmini/dev/epso/natively/electron/llm/activeCustomProvider.ts:38)

Repository snapshots inspected: GVoice `86f5255` plus its existing working changes; Natively `2ca22d1e`; Meetily `0281737`. The Natively code-review graph tools requested by its repository guidance were not available in this session, so exact source inspection was used.

**Reviewed but not executed on macOS:** shared-service integration, app endpoint behavior, model compatibility, latency, and packaging improvements. Existing installed state and GVoice's active speech process were inspected directly; new behavior was not exercised.

**Reviewed but not executed on Windows:** existing GVoice `.exe` handling and Meetily helper spawn branches. A future implementation must use platform-appropriate data paths and service lifecycle handling and needs Windows verification as well as macOS verification. No application behavior changed in either platform branch.
