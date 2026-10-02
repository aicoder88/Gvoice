# GVoice consolidation

Goal: one GVoice app for live English dictation and file transcription, sharing the installed speech engine and models. Preserve the existing apps/data until replacement is proven. Owner authorized execution with "do it" after the consolidation recommendation, 2026-09-27.

Status: implemented, packaged and installed. File workflow verified; native tray visual check remains unverified (CUA exposed windows but not the status menu). Original freeze and personal-audio comparison remain open. Main writer: root. Existing prior-turn changes belong to this chat. No unmerged branches at start.

| Deliverable | Location |
| --- | --- |
| File queue and shared speech scheduling | GVoice src modules and existing local provider |
| File transcription window and exports | GVoice public files, preload and main integration |
| Runtime verification and storage recommendation | GVoice tests and docs/reports |

1. Inspect Transcribe's existing file workflow and define preservation requirements. [sonnet/medium]
   Read only; inspect code, never transcript content or credentials. Identify upload, progress, cancellation/resume, translation and output behavior to retain.
   -> verify: source-backed checklist and compatible engine boundary, no assumption that model formats interchange.

2. Build shared local inference scheduling and a persistent file queue. [opus/high]
   Reuse the existing whisper.cpp process/model. Decode files in bounded chunks; prioritize live recording/inference over queued file work. Persist progress and outputs, recover interrupted jobs, support cancellation/resume, and avoid whole-file memory loading. Keep existing provider defaults and dictation behavior.
   -> verify: real synthetic audio and meaningful tests for priority, cancellation, recovery, invalid files and export; no private audio uploaded.

3. Add Transcribe files to GVoice. [sonnet/medium]
   Use a dedicated sandboxed window with trusted file selection, visible progress, stop/resume, history and explicit exports. Reuse existing colors and typography. Keep dictionary, profiles, editing, mouse controls and clipboard unchanged.
   -> verify: running desktop app imports/transcribes/exports a file; tray menu opens and existing dictation checks pass.

4. Review, build, and verify the combined app. [opus/high]
   Review integration, run required tests and isolated desktop scenarios, inspect rendered window, check failure paths and packaged build. Record measured storage candidates without deleting originals.
   -> verify: app bundle built and checked; distinguish injected fault coverage from the unresolved original incident. Owner’s "do it" authorizes the reversible GVoice update after preserving its prior bundle. Per-path deletion of older apps/models remains a separate approval gate.

No new model downloads, Croatian support, runtime rewrite, copied FluidVoice code, or cloud processing. FluidVoice remains preserved while useful behavior is incorporated through the existing local dictation path. The original reliability investigation remains open until its real failure is reproduced; consolidation alone does not resolve it.

Execution lanes: step 1 planned/actual gpt-5.6-terra medium; step 2 root Astra high; step 3 Terra medium where safely isolated; step 4 Astra high. No substitutions planned.

Execution evidence: Transcribe workflow audit complete; UI integrated from its isolated working copy, then that copy archived through Codex. Root reviewed and fixed benchmark/file interference, transcript-size failure, cached selection, and MOV support. `pnpm test` passed 423 unit checks and 3 parity checks (3 external-provider checks skipped); the added oversized-result check also passed separately. Seven file-specific checks pass. Real desktop synthetic recording: 45.925 seconds, three saved sections, six expected repeated phrases retained. Pause/resume, restart, priority, protected outputs, TXT/SRT/JSON and reopening passed. Five forced window-failure checks passed. Light/dark screenshots inspected. Native file picker opened and canceled in CUA.

`pnpm build` succeeded; deep strict code signature verified. Packaged file flow worked through Settings > Activity with real local synthetic inference and no test controller or secret files. Installed bundle matched the tested bundle byte for byte and showed Ready after restart; its startup digest and warm local engine were verified. Existing history and dictionary hashes were unchanged. Backup location is recorded in machine memory. No old model, app, user audio or transcript was deleted; no large disk saving is claimed. $0 external spending.

Limitations: English only, no translation/speaker labels/URL import. SRT times cover sections. Real personal-recording accuracy and physical hotkey/paste in the installed copy were not exercised in this change. The original incident is unresolved.

/tier /Users/macmini/dev/voice/docs/plans/gvoice-consolidation.md
