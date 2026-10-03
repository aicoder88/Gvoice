# Optimize GVoice Parakeet

Goal: bring everyday release-to-paste time close to Handy without losing words. The implementation changes and local installation are complete; acceptance verification remains partial across steps 1–6. The evidence and remaining limits are recorded in `docs/reports/optimize-gvoice-parakeet-run.md`. Existing uncommitted Parakeet work belongs to this conversation and must be preserved.

Checkpoint, 2026-09-28: the signed local candidate is installed at `/Applications/GVoice.app`, using source digest `c1b556b2f9c17e286d43f04e80287493d259aa9d460b8e131629c849fb09e024`. The installed rollback keeper is `/Users/macmini/Library/Application Support/GVoice/AppBackups/before-optimize-parakeet-2026-09-28/GVoice.app`; the immediately replaced bundle is also retained beside it as `GVoice.app.preinstall-live`. The worker launches from the installed bundle and the selected Anker label persisted. The source build and packaged synthetic file-transcription check passed. Native first-use paste remains 1,131ms from step 5, above the 1.0-second target; no measured warm installed native-paste result, physical Anker capture, or human-speech check exists. Do not claim those limits were met without new observations.

Verification continuation, 2026-09-28: fresh installed/worker/rollback signatures and identities pass; macOS sees Anker with two input channels. One uncontrolled installed cleanup-stage observation is now saved: 1,859ms release-to-paste dispatch, including 699ms cleanup. It is not a controlled warm/native-insertion acceptance sample. Desktop inspection timed out; the request for physical assistance received no reply during this pass. All six acceptance steps remain partial. See the report’s verification-only continuation and `docs/reports/optimize-gvoice-parakeet-verification-2026-09-28.json`.

Resume verification only: preserve completed implementation and installation. Step 1 still needs full-app launch/warm statistics; step 2 needs first-use/recovery latency acceptance; step 3 needs physical final-word safety; step 4 needs matched Handy and cleanup-on measurements; step 5 needs physical Anker/reconnect/long-speech checks; step 6 needs installed warm/paste and visible tray checks. Do not repeat builds or replacement unless new findings require changes.

Evidence: two installed-app trials took 15.78s and 1.09s after release; transcription accounted for 14.83s and 0.41s, trailing capture 0.46s each, paste 0.49s and 0.21s. Cleanup did not run. Both used Anker. Handy's recent stop/transcribe/paste totals were about 0.35–0.6s, but these were different recordings, not a controlled comparison. Deferred initialization is a hypothesis, not yet the proven cause of the first delay.

Targets for 3–10s English clips without cleanup: warm median ≤0.6s and p95 ≤1.0s; first dictation after reported readiness ≤1.0s. Measure longer clips separately. These are acceptance targets, not promised results.

| Where things end up | Purpose |
|---|---|
| `src/providers/parakeet-local.js`, `src/native/parakeet-worker.cpp`, `main.js` | Real readiness, measured inference, recovery |
| `public/dictation.js`, `public/audio-capture-worklet.js` | Faster release without clipped endings |
| `scripts/bench`, `scripts/electron`, `docs/reports` | Repeatable comparison and installed-app evidence |

1. Locate the actual delay before changing behavior. [opus/medium]
   Add content-free timings for worker startup, model loading, first inference, queue wait, trailing capture, cleanup and paste; compare identical public/synthetic 3s, 10s and 30s audio with Handy where feasible, checking runtime/backend/thread differences and memory pressure.
   -> verify: distinguish three fresh launches from 20 warm short-clip trials; report median, p95, sample counts and exact conditions, without claiming unmatched recordings are equivalent.

2. Make “ready” mean ready to transcribe. [sonnet/medium]
   If deferred initialization is confirmed, run a bounded synthetic inference before readiness, serialized with real requests; retain the worker and repeat preparation after worker replacement, with visible failure rather than silent readiness.
   -> verify: first dictation after launch and after worker recovery meets the target; dictation during preparation, cancellation and timeout recover without lost audio, duplicate output or competing workers.

3. Replace unnecessary trailing wait with confirmed audio delivery. [opus/high]
   Add an explicit worklet flush acknowledgement, then measure the smallest safe trailing-speech allowance for Parakeet; keep a bounded fallback when acknowledgement fails and preserve other engines' behavior.
   -> verify: no lost final samples or last words across normal release, release during the final syllable, quick taps, rapid consecutive holds and delayed message delivery; existing notes say 250ms previously clipped words, so reducing the timer alone is unacceptable.

4. Optimize only the remaining measured bottleneck. [opus/medium]
   Compare the now-warm engine against Handy using matched audio; tune confirmed backend or execution differences, inspect paste overhead while preserving clipboard/focus checks, and leave cleanup enabled as configured. Consider processing while speaking only if simpler fixes miss the targets, with a separate design decision before adding it.
   -> verify: each retained change improves matched trials without worse transcription, idle resource use, cancellation or file-transcription contention; show cleanup-on timings separately and never hide its cost in the no-cleanup numbers.

5. Test accuracy and failure paths together. [sonnet/medium]
   Extend existing meaningful checks for readiness and final-audio ordering, then exercise the running app with longer speech, quiet endings, Anker reconnect, restart and simultaneous file work.
   -> verify: same reference words survive, no empty successful result or duplicate paste, Anker remains the only input, and missing Anker produces a clear failure instead of switching microphones; run required project checks and record any physical-microphone checks still unverified.

6. Install and verify the measured improvement. [sonnet/medium]
   Preserve the current installed app as a rollback copy, build and verify the signed replacement, install locally when idle, and repeat launch/first-use/warm tests through the installed app; record results and structural decisions.
   -> verify: correct installed build and worker, visible working tray, persisted Anker capture, latency targets and clipboard behavior; restore the saved working app if regression checks fail, and report unmet targets honestly.

Traps: synthetic-only success does not establish real Anker reliability; capture marked “cold” does not prove the engine was cold; avoid content-bearing logs, uploaded recordings, extra model copies, or disabling cleanup and delivery safeguards to win a benchmark. Check available disk/memory before builds and retain a working reserve. No push or publication is included.

Decision: no preference change is needed to begin. Execution requires an explicit “run it” or the command below; this plan alone changes no app behavior.

/tier /Users/macmini/dev/voice/docs/plans/optimize-gvoice-parakeet.md
