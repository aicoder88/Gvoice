# GVoice reliability and free transcription comparison

Checked 27 September 2026 on this Mac. English only, as requested. This is an investigation and implementation recommendation, not a claim that tonight's fault has been repaired.

## Recommendation

Keep GVoice while repairing the failure that makes it appear unresponsive. Trial Handy alongside it. Borrow its useful controls and model handling incrementally; do not rewrite GVoice or replace its speech model on popularity alone. Keep existing clipboard restoration, destination checks, cancellation, dictionary, history, and mouse-button integration.

## Tonight's incident

Source: locally inspected operational events in `~/Library/Application Support/GVoice/debug.log`, numerical recording statistics, and macOS runningboardd events. Transcript/history content was not returned or uploaded.

- At 21:32:10 through 21:32:36 Croatia time, GVoice accepted eight presses: six from its hotkey path and two from its tray. Each reached the local speech engine and produced an empty final result. Audio packets reached the engine, so this was not a completely dead shortcut listener or absent recording process.
- The holds were brief, approximately 0.15 to 1.24 seconds before the recording tail. Waveform statistics show nonzero audio; that establishes samples existed, not whether intelligible speech was present.
- The restart was logged at 21:33:09. The successful longer dictation began at 21:33:32 and ended in a paste at 21:34:11. Its release-to-paste time was 4.69 seconds. No text from it is included here.
- No renderer-death or missing-pill recovery event was recorded for the failure window. macOS did report some GVoice visibility transitions before the restart. Those are app-level observations and do not establish that the recording indicator was visible when needed. They also prevent claiming that every GVoice window was absent throughout.
- The installed build identifies revision `dc03dbd`, built 15 September. The working tree is at `ba07e73`; later clipboard-restoration work is in the tree. A version label of 1.0.0 does not establish matching code.

**Unknown:** why the user saw no response. A stuck, hidden, or unpainted recording indicator is a hypothesis. A dead shortcut listener is contradicted for the eight logged attempts, although this does not prove every physical press was captured. The evidence does not justify attributing this incident to Whisper, permissions, microphone disconnection, or the earlier externally killed helper processes.

### Confirmed reliability gaps in code

`main.js` verifies the indicator once, after 150 ms, using Electron's visibility and crash flags. It does not confirm that the page processed the new state or painted a visible indicator. A process can be alive without answering, and an Electron visibility flag alone is not proof of screen presentation. The recording page's `unresponsive` handler logs the event but does not initiate bounded recovery. These are testable weaknesses, not proven causes of tonight's incident.

The keyboard monitor stops permanently after the first input event. It cannot catch a listener that fails later. This is a separate preventative improvement, not the diagnosis of tonight's accepted presses.

### Verification completed

Ran `node scripts/electron/dead-window-rebuild.mjs` on an isolated GVoice instance using fake audio and separate storage. All five cases passed: all helpers killed, indicator killed mid-recording, press during recorder reload, repeated crashes capped, and a window that silently fails to show. Only the test instance's process IDs were targeted. The installed GVoice was left running.

These checks prove the existing recovery paths work under their injected conditions. They do not reproduce or resolve tonight's fault.

## Which GitHub project has the most stars?

Live GitHub API counts, checked during this investigation; counts change. Search covered speech-to-text, dictation, and Whisper transcription, plus direct checks of the named projects. This is a scoped comparison, not an exhaustive ranking of every repository.

| Project | Stars | Relevant category |
| --- | ---: | --- |
| [OpenAI Whisper](https://github.com/openai/whisper) | 109,651 | Speech engine. GVoice uses its model family through whisper.cpp. |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | 53,957 | Local inference engine already installed and used by GVoice. |
| [VoiceStudio](https://github.com/debpalash/VoiceStudio) | 39,625 | Broad voice suite including dictation, transcription, cloning, dubbing, and audiobooks. |
| [Handy](https://github.com/cjpais/Handy) | 32,302 | Focused free offline desktop dictation; closest popular comparison. |
| [Meetily](https://github.com/Zackriya-Solutions/meetily) | 31,155 | Meeting capture and summaries. |
| [Buzz](https://github.com/chidiwilliams/buzz) | 21,706 | File/live transcription and subtitles. |
| [FluidVoice](https://github.com/altic-dev/FluidVoice) | 11,786 | Mac dictation with multiple engines and optional enhancement. |
| [OpenWhispr](https://github.com/OpenWhispr/openwhispr) | 8,689 | Dictation, notes, meetings, local/cloud processing. |
| [VoiceInk](https://github.com/Beingpax/VoiceInk) | 6,579 | Mac dictation. Open source does not by itself mean every distributed app is free. |

Therefore: Whisper leads the engines checked; VoiceStudio leads the broad desktop suites checked; Handy leads the focused, free dictation apps checked. Calling Handy the most-starred speech-to-text repository without those qualifications would be wrong.

## What is on this drive now

Application directories, Spotlight, development folders, and relevant support/model directories were checked. Old icons or support folders are not treated as proof that an app is still installed.

| Item | Verified current state |
| --- | --- |
| GVoice | Installed and running at `/Applications/GVoice.app`; about 292 MiB. Active server uses `models/ggml-small.en-q5_1.bin`, about 181 MiB. |
| Larger GVoice model | `models/ggml-large-v3-turbo-q5_0.bin`, about 547 MiB, is already present. |
| Transcribe | Project at `/Users/macmini/dev/Transcribe`; file upload/batch transcription and translation, using faster-whisper or cloud services. Its large-v3 model files occupy about 2.9 GiB. No fresh end-to-end test of that app was run. |
| Ispit / former Natively | `/Applications/Ispit.app`, version 2.8.8; source under `/Users/macmini/dev/epso/ispit`. Approximately 63 MiB of Whisper tiny English model data found. This is a broader assistant app, not a confirmed replacement for GVoice. |
| FluidVoice | Backup bundles for 1.6.0 and 1.6.2 under `~/Library/Application Support/Fluid/RollbackBackups/FluidVoice`, plus history/support remnants. No normal current installation found in Applications. A cached drag copy is not counted as an active installation. |
| Meetily | Support directory remains. The previously documented installed app, source checkout, and selected model were not found in their old locations. Do not rely on September 5's inventory as current. |
| Superwhisper / Whisper Transcription / WhisperDrop | Old icon-cache evidence only in the inspected locations; no current runnable installation established. |
| Handy | Installed during this investigation at `/Users/macmini/Applications/Handy.app`, version 0.9.7; about 41 MiB excluding models. |

Handy was downloaded from its official GitHub release, with SHA-256 checked against the release asset digest. `codesign --verify --deep --strict` passed and `spctl` identified a Notarized Developer ID. It launched successfully. A copy-on-write copy of the existing small English model was placed in Handy's models directory, avoiding a new model download and keeping GVoice's original independent of future Handy file removal.

At report preparation, Handy's onboarding requires microphone and Accessibility permissions. Approval was requested before granting new access. Installation/startup are verified; dictation and personal accuracy are not yet verified.

## What is worth bringing to GVoice

The comparisons below are source/documentation observations, not claims that another app is measurably faster or more reliable on this machine.

| Improvement | Evidence from other projects | GVoice status and implementation |
| --- | --- | --- |
| Confirm recording actually began | [VoiceStudio dictation](https://github.com/debpalash/VoiceStudio/blob/main/docs/features/dictation.md) describes listener receipt and microphone-start acceptance, with timeouts/errors. | Add session-bound acknowledgements for recorder readiness, first audio frames, and indicator state. Recover the failed component once within a bounded deadline; show failure independently in the tray. Never replay stale text or auto-paste during recovery. |
| Check microphone health before each take | [Handy audio manager, v0.9.7](https://github.com/cjpais/Handy/blob/v0.9.7/src-tauri/src/managers/audio.rs) checks whether capture needs reopening and re-resolves devices after an open failure. | GVoice already rebuilds after sleep, device changes and silent holds. Add first-frame freshness checks while preserving the user's selected microphone; distinguish quiet audio from no callbacks. |
| Better local engine/model choice | [Handy model manager](https://github.com/cjpais/Handy/blob/v0.9.7/src-tauri/src/managers/model.rs) supports catalog and custom models; its documentation covers Whisper and Parakeet. | Extend `src/providers` with an isolated local adapter, keeping the current event and cancellation contract. Offer plain-language speed/accuracy choices and reuse compatible existing weights. Benchmark English before switching defaults. |
| Configurable hold/toggle shortcuts and feedback | [Handy settings](https://github.com/cjpais/Handy/blob/v0.9.7/src-tauri/src/settings.rs) includes activation modes and audio feedback. | GVoice has fixed keyboard triggers plus tray and mouse behavior. Add per-trigger settings with conflict detection; optional start/stop sounds should indicate actual recorder readiness. Preserve right Option and Better Options as defaults. |
| Fully local optional cleanup | Handy supports custom local endpoints and Apple Intelligence on supported Macs. [FluidVoice](https://github.com/altic-dev/FluidVoice) documents its separate local Fluid Intelligence runtime. | GVoice's cleanup provider choices currently cover cloud services. Add a loopback text provider or platform adapter, retaining the timeout budget, raw-text fallback, and checks for changes to names, numbers and negation. Fluid Intelligence is separately maintained, so do not assume its implementation can be copied from FluidVoice. |
| Clear model installation and resource controls | Handy exposes model management/unload settings and local discovery. | Build on GVoice's existing model download and benchmark code. Show download size and model purpose, load/unload status, safe cancellation, integrity checking and a clear model-not-ready message. |
| Silence handling and live feedback | Handy documents Silero voice-activity detection. VoiceStudio offers recording pause/resume and streaming-capable models. | Evaluate speech detection against the current peak-based checks before adding it. Preserve quiet speech, the beginning/end of words, and cancellation. Live text and pause/resume should be separate optional work after reliability, with no repeated insertion while partial words change. |
| Existing-file transcription | VoiceStudio and OpenWhispr support file transcription; Transcribe already provides this locally. | Prefer reusing the existing Transcribe workflow if requested. Moving meetings, dubbing, cloning, or audiobooks into GVoice is outside this English dictation task. |
| Smaller app | Measured Handy bundle 41 MiB versus GVoice 292 MiB. Handy uses Tauri/Rust; GVoice uses Electron. | A runtime rewrite could reduce bundle size, but this measurement says nothing about RAM, accuracy or reliability. It is not a prerequisite for the useful features above. |

GVoice already has dictionary correction, history/recording recovery, destination profiles, selected-text editing, a personal benchmark, and protection against stale delivery. Those do not need to be rebuilt simply because competitors list similar features. Clipboard restoration in the newer source must remain intact.

Handy and OpenWhispr repositories identify MIT licensing. VoiceStudio identifies AGPL-3.0, and current FluidVoice identifies GPL-3.0; Fluid Intelligence is separate. Implement behavior against GVoice's existing architecture and examine actual source/model licenses before any code reuse or distribution. No competitor code was copied into GVoice.

## Small local model check

Three new, non-private English samples were synthesized using macOS Samantha: plain instructions, technical language, and numbers/negation. Each was transcribed once by the installed whisper-cli with the small English and larger turbo models, four threads, sequential fresh processes. Both preserved the expected wording/meaning on all three; both formatted spoken numbers as digits/currency.

Observed whole-command times, including model loading: small 1.600 / 1.078 / 1.073 seconds; turbo 2.583 / 1.577 / 2.083 seconds. The isolated window-recovery test ran concurrently, so these are illustrative observations, not a controlled speed ranking. GVoice normally keeps its engine loaded; these are not release-to-paste figures. Three synthetic samples cannot establish personal accuracy, accent handling, noisy-room performance, or a Handy-vs-GVoice winner.

Local evidence: `.verification/transcriber-comparison-2026-09-27/synthetic-results.json` and the three generated WAV files. No user recordings were sent to a provider. External usage charges: $0.

## Next verification

After permission approval, finish Handy's onboarding, select the existing English model, and test only newly generated audio in a scratch destination. A meaningful replacement decision needs equal English inputs, repeated warm/cold timing, actual hotkey/mouse behavior, same microphone, cancellation, sleep/wake, destination switching, and clipboard preservation. GVoice's existing Personal speech benchmark can later measure explicitly approved personal clips locally.

For the freeze, reproduce an alive-but-unresponsive page and a visible-but-unpainted/off-screen indicator in an isolated app. Confirm which path matches the incident before calling a change a fix. Current evidence is insufficient to promise the problem will never recur.

## Follow-up: smaller apps and consolidation

Re-measured after the owner's storage question on 27 September. Available space was about 18 GiB. Directory footprints below are rounded allocated sizes from `du`; APFS shared blocks and snapshots mean these are not guaranteed reclaimed-space totals.

- GVoice's Electron framework alone occupies 271 MiB of the 292 MiB app. Its own bundled archive is approximately 14 MiB. Handy's whole app is 41 MiB. Electron includes Chromium and Node; Tauri uses the operating system's webview. This explains most of the package difference, not an accuracy or reliability advantage. Sources: [Electron introduction](https://www.electronjs.org/docs/latest/) and [Tauri architecture](https://v2.tauri.app/concept/architecture/).
- Handy also has custom words, recording/history retention, cleanup, cancellation, clipboard handling, and an experimental receipt-based paste path. These are not exclusive GVoice advantages. Checked Handy's v0.9.7 settings, transcription, actions, paste, and registered-command code.
- GVoice-specific workflows worth preserving: direct Better Options mouse-button integration; selected-text editing with preview and guarded Undo; app-specific output profiles; correction suggestions from manual edits; and the personal speech benchmark. Equivalent complete workflows were not found in the Handy code reviewed. This is scoped evidence, not proof that no extension or newer version can offer them.

| Current storage | Measured footprint | Consequence of consolidation/removal |
| --- | ---: | --- |
| Transcribe large-v3 model, `~/.cache/huggingface/hub/models--Systran--faster-whisper-large-v3` | 2.9 GiB | Largest item here. Retire only after the shared engine passes representative file-transcription and existing translation checks. The stored model could be shared by other consumers; inspect those before removal. |
| GVoice models | 729 MiB combined | Small English 181 MiB plus turbo 547 MiB. Different quality/speed choices, not byte-identical duplicates. |
| GVoice `dist` | 293 MiB | Generated app build; installed app is separate. Rebuilding needs development dependencies. Confirm no process uses this copy before removal. |
| GVoice `node_modules` | 445 MiB | Development dependencies, not user recordings. Removing prevents development/build/test work until reinstalled. Keep while reliability work is pending. |
| FluidVoice rollback bundles | 171 MiB combined | 1.6.0: 59 MiB; 1.6.2: 112 MiB. Backup apps; removing loses those offline recovery copies. Not several gigabytes of confirmed duplicate models. |
| Transcribe project | 130 MiB | Approximately 114 MiB is uploaded user audio. These are user files, not disposable app bulk. |
| GVoice recent recordings | 20 MiB | User recordings; not a meaningful first storage target. |

The current Transcribe source loads faster-whisper with `compute_type="int8"`; its older CLAUDE.md says float32 and is stale on that detail. GVoice's GGML model files cannot simply be substituted as paths to faster-whisper's model format. A shared engine needs an adapter change, file chunking and existing progress/resume/output behavior preserved.

Architecture subsequently authorized with "do it" and implemented: one GVoice entry point for Dictate and Transcribe files, one local inference service, and one model directory. Let interactive dictation take priority over queued file chunks so a long upload cannot make the hotkey look frozen. Preserve existing history/recordings, original file outputs, destination protection and clipboard behavior. Borrow useful FluidVoice behavior without requiring its entire app or its separately maintained Fluid Intelligence runtime. No new local cleanup model download solely for consolidation.

Keep the present UI initially: changing away from Electron could remove roughly a quarter-gigabyte of app overhead, but replacing the separate large-v3 installation with an already-present model could avoid a much larger footprint if quality and file features survive. Do not count that saving until the replacement is proven and the old files are actually approved for removal. If a lighter long-term app is desired, compare porting the required GVoice workflows onto Handy's Tauri foundation against a native Mac-only rewrite; neither is a simple three-repository merge.

No files were removed, no apps were merged, and no model default was changed in this follow-up. The owner's proposal was evaluated, not treated as authorization for a new app or deletions.

## Consolidation implementation

GVoice now has a sandboxed Transcribe files window accessible from its tray and Settings > Activity. It imports local audio/video, runs bounded sections through the existing local Whisper server/model, saves text/progress, resumes interrupted jobs, and saves TXT/SRT/JSON to a new destination. Live dictation takes priority between file sections. Source media is referenced, not copied. No new model/runtime was downloaded for this integration; no FluidVoice source was copied.

Verified with a 45.925-second synthetic English recording: three sections, all six repetitions of the expected phrase preserved, TXT/SRT/JSON written, pause/resume and restart handled, and no secret files created in the isolated profile. The signed packaged app was tested separately through its real Settings entry and recognized a new synthetic clip. Unit/parity checks and all five existing window-recovery scenarios passed. This is workflow verification, not a personal-accuracy benchmark or a diagnosis of the earlier invisible-recording incident.

Installed at `/Applications/GVoice.app` after preserving the prior signed bundle. Code signature and byte-for-byte bundle comparison passed. The installed startup showed Ready and warmed the local model. Existing history/dictionary hashes were unchanged. Native file-window/picker rendering was observed; the status menu itself could not be captured through CUA, so its visual check remains unverified. Physical hotkey/paste and microphone choice in the installed copy were not changed or newly tested.

Storage: new app approximately 294 MiB logical versus 292 MiB previously. Electron remains. The former Transcribe 2.9 GiB model, the 547 MiB alternate GVoice model, FluidVoice backups and user recordings remain. No substantial reclaim is claimed. Model cleanup should follow representative personal English-file comparison and exact per-path approval. Rollback keeper is recorded in machine memory. No external spending.

Current limitations: English only, no translation, speaker labels or URL imports. SRT times describe sections, not individual words. Up to 20 imports per selection, six hours per file, 100 saved jobs, 4 MB per job. Closing the file window continues queued work; closing GVoice leaves it paused on the next launch.
