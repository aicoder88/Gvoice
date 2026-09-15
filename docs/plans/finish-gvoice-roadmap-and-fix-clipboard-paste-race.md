# Finish GVoice roadmap and fix clipboard paste race

## Objective

Finish recommendations 7–10 after repairing the reported failure where a dictation disappears and the previous clipboard contents are pasted into the destination. Preserve the work already completed for lifecycle reliability, desktop regression coverage, latency, selected-text editing, destination profiles, and the personal benchmark.

## Current evidence - 2026-09-08

- Repository HEAD is `43568bbe8ccba0f1662dfd8d26a17d80dec91537` from 2026-09-07. The working tree was clean before this plan was added.
- `/Applications/GVoice.app` was modified on 2026-08-30 and has been running since 2026-09-04. The repository build in `dist/mac-arm64/GVoice.app` is newer, from 2026-09-05. The live debug log lacks the `sourcePid` and `ownership` fields emitted by current source, so the installed app is stale. Confidence: high.
- Current source writes the dictation to the clipboard, sends Cmd+V, and normally restores the previous clipboard about 250 ms after dispatch. Terminal-like targets, including cmux, skip Accessibility readback and are treated as successful. A target that consumes the paste after restoration can therefore receive the previous clipboard value. This matches the reported symptom, but the exact event has not yet been captured. Confidence: moderate.
- Existing recovery is a 50-entry tray submenu plus `history.json`. Existing vocabulary includes a manual dictionary, post-transcription correction, and correction suggestions. These are foundations for recommendations 8 and 9, not blank-slate work.

## Product decisions

Execution checkpoint, 2026-09-08: **Step 1 PARTIAL / named-app acceptance pending; steps 2-6 PENDING.** The clipboard repair, build identity, 400 delayed Electron fixture attempts, seven clipboard boundary checks, 29 focused tests, 260 unit tests, profiles/benchmark desktop suite, and macOS build passed locally. The native Electron speech/paste/edit suite **passed on a coordinated rerun**. Its first run safely refused after focus changed; the user confirmed they were using the computer during that test. No source change was needed for the rerun. Separate TextEdit/Chrome/Terminal/cmux acceptance remains outstanding; the desktop tool denied Terminal automation. No installation or push occurred; the installed app remains stale. An asynchronous question asks whether the user wants these named-app checks deferred to the required final installation gate so steps 2-5 can proceed. Do not assume that deferral without an answer. Full evidence: [verification report](../verification/finish-gvoice-roadmap-and-fix-clipboard-paste-race.md).

- Delivery correctness outranks restoring the user's previous clipboard. GVoice may restore it only after exact delivery confirmation. When a target cannot be read back, keep the dictation on the clipboard until another app or the user changes it. Never restore old clipboard text on a timer while a paste remains unverified.
- Processing intent and destination formatting are separate choices. A user can dictate faithfully into an email profile or deliberately rewrite plain text.
- Vocabulary changes require an explicit accept action and remain removable. GVoice may suggest a correction but may not silently learn from user typing.
- Voice commands run only after explicit command-mode activation. Ordinary dictation is never interpreted as a command.
- Store no clipboard contents in logs or history. Do not add cloud sync, arbitrary shell commands, automatic benchmark imports, or background capture of surrounding document text.

## Dependency order

Run steps sequentially: `1 -> 2 -> 3 -> 4 -> 5 -> 6`. Steps 2–5 all touch the dictation result model, settings, `main.js`, and desktop UI integration, so parallel writers would create unnecessary conflicts. Each step must leave focused tests passing before the next begins.

1. Reproduce and eliminate the lost-dictation clipboard race. [gpt-6-astra/high]

   Add a deterministic paste target that can delay clipboard consumption beyond 250 ms, plus a repeated real-target scenario for TextEdit, a Chromium text field, Terminal, and cmux. Each run starts with unique `DICTATION-*` and `OLD-CLIPBOARD-*` sentinels and records timestamps and clipboard change counts without logging either value. Compare the stale installed app with a fresh source build to distinguish already-fixed behavior from the remaining lease flaw.

   Replace timer-based correctness with explicit delivery states: `verified`, `sent-unverified`, `refused`, `failed`, and `superseded`. Restore the previous clipboard only after exact readable-field confirmation. For terminal or otherwise unreadable targets, retain the dictation on the clipboard and report `sent-unverified`; if focus ownership changes, refuse the paste and retain the dictation. Never overwrite a clipboard the user or another app changed after GVoice acquired it. Add a content-free build identifier to startup logs so installed-artifact drift is visible immediately.

   Verify: first capture a failing regression or a conclusive stale-build reproduction. Then run at least 100 delayed-consumption attempts per fixture target under CPU pressure with zero old-clipboard insertions, zero lost dictations, and exact-once delivery where the target accepts paste. Verify user clipboard changes still win, focus changes refuse safely, consecutive dictations cannot restore one another's saved clipboard, and every non-verified result is recoverable from the clipboard and history. Run the focused unit tests and observe the scenarios in a running Electron app.

2. Separate faithful dictation from deliberate rewriting. [gpt-6-astra/high]

   Add an explicit processing mode, captured at key-down independently of the destination profile:

   - **Faithful** may correct approved vocabulary plus punctuation and casing, but cannot delete, add, reorder, summarize, or rephrase spoken words.
   - **Clean** retains today's filler and self-correction cleanup while preserving meaning.
   - **Rewrite** may deliberately reshape the text for the chosen destination profile and must be visibly selected before recording begins.

   Keep the current mode visible in the tray, Settings, and recording pill. Persist the user's default, but snapshot it per utterance so a mid-flight change cannot alter the result. Reuse the benchmark meaning-risk checks for numerals, negation, and protected terms; if Clean or Rewrite changes a protected fact, retain the safe version and show a concise warning. Record the chosen mode with the history entry.

   Verify: deterministic fixtures for English, Croatian, mixed language, brands, numbers, negation, quotations, filler, and self-correction; provider timeout/failure fallback; restart persistence; mode changes during an in-flight transcript; and actual running-app output in plain, email, chat, and coding profiles. Faithful fixtures must preserve the spoken word sequence exactly after documented token normalization.

3. Replace the tray-only recovery list with a searchable local history panel. [gpt-6-astra/medium]

   Migrate the existing history format without losing old entries. Give entries stable IDs and store final text, timestamp, delivery state, processing mode, destination profile, provider/engine label, and recording path when recording was already enabled. Do not begin retaining raw transcripts, selected text, prior clipboard content, or audio under a new policy.

   Add a dedicated history window with local in-memory search, delivery/date/profile filters, clear delivery labels, full-text view, Copy, Play recording, Transcribe again, delete-one, and confirmed clear-all. Put failed and `sent-unverified` results at the top of the recovery view. Keep the compact tray submenu for the latest entries and link it to the full panel. File writes remain atomic and serialized.

   Verify: migrate current and malformed fixtures, restart persistence, Unicode and multiline search, filtering, all item actions, missing recordings, deletion confirmation, empty state, keyboard navigation, and recovery of the exact dictation from a simulated failed or delayed paste. Inspect the actual panel at narrow and normal sizes and confirm no action steals focus and pastes unexpectedly.

4. Make vocabulary learning contextual, explicit, and reversible. [gpt-6-astra/high]

   Extend the existing dictionary instead of replacing it. Turn likely manual corrections into pending suggestions linked to language and, when useful, application or output-profile scope. Show the evidence as a minimal before/after pair without collecting surrounding document text. Applying a suggestion requires an explicit accept action; dismiss, undo last accepted item, edit scope/casing, remove, and reset are available from the dictionary manager and relevant history entry.

   Keep one deterministic conflict resolver for global versus scoped terms. Feed only the applicable approved terms to transcription and post-correction. Prevent common-word and brand-name collisions, avoid recursive correction, cap prompt size, and migrate existing global terms and dismissals unchanged. Never infer acceptance from silence or repeated occurrence.

   Verify: unit fixtures for casing, punctuation, Croatian diacritics, mixed language, near-homophones, common-word collisions, competing scopes, undo/remove/reset, migration, corrupt-store recovery, and atomic persistence. In the running app, accept one suggestion, verify it affects the intended destination, restart, undo it, and verify the original behavior returns.

5. Add an explicit, allowlisted voice-command mode. [gpt-6-astra/high]

   Add a separate command-mode activation path and unmistakable recording-pill state. Parse commands into a closed enum before execution; never send raw model output to Electron APIs, a shell, AppleScript, PowerShell, or an arbitrary URL. Start with reversible local actions that match existing GVoice controls: switch processing mode, switch output profile, open history, open dictionary, open the benchmark, copy the last dictation, and cancel command mode. Add undo-last-GVoice-insertion only when the target identity and exact inserted text can still be verified; otherwise refuse it.

   Unknown, ambiguous, or low-confidence speech executes nothing and remains available for review or copy. A command phrase is not pasted as dictation. Command mode automatically ends after one result unless the user explicitly chooses a persistent session, and the visible state must survive neither restart nor an app crash.

   Verify: exact and near-match command fixtures, ordinary sentences containing command words, noisy transcripts, focus changes, stale target identities, unsupported platforms, cancellation, timeout, and restart. Exercise every allowed command in the running app and prove that the same utterances in normal dictation mode are pasted as text rather than executed.

6. Integrate, verify, install, and preserve rollback. [gpt-6-astra/high]

   Run `pnpm test`, provider parity checks, focused clipboard/history/vocabulary/command tests, `pnpm test:electron`, and `pnpm test:profiles-benchmark` with explicit failures for missing prerequisites. Build the macOS app, launch the fresh artifact, and repeat the reported sentinel scenario in TextEdit, a browser field, Terminal, and cmux. Confirm selection editing, processing/profile snapshots, history recovery, vocabulary undo, and command-mode isolation still work together.

   After all source-build checks pass, quit the stale installed GVoice, preserve a dated rollback copy, replace `/Applications/GVoice.app` with the verified build, and relaunch it. Confirm the startup build identifier matches repository HEAD, the tray icon appears and its menu opens, the saved microphone remains selected after restart and actually captures audio, and a real spoken dictation reaches each observable target with the expected text. Keep the rollback until the installed build completes these checks. No push, release upload, deployment, provider-key change, or paid API expansion is included.

   Verify: record commands, test counts, build identity, running-app observations, and remaining hardware/provider limits in `docs/verification/finish-gvoice-roadmap-and-fix-clipboard-paste-race.md`. Do not mark the plan complete while the installed app is stale, the reported scenario is only simulated, any target receives `OLD-CLIPBOARD-*`, or an unverified delivery is unrecoverable.

/tier /Users/macpro/dev/voice/docs/plans/finish-gvoice-roadmap-and-fix-clipboard-paste-race.md
