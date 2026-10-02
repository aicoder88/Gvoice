# GVoice reliability and English dictation

Goal: GVoice responds visibly to every recording request, recovers from a failed component, and gains useful competitor features without losing its existing safeguards. English only.

Status: original failure remains undiagnosed; this broader plan is not executed. Owner selected the narrower [GVoice consolidation](gvoice-consolidation.md), now implemented and installed. Evidence and limits: [comparison report](../reports/transcriber-comparison-2026-09-27.md). Execute only on an explicit instruction to run this plan. This plan uses the tier skill's portable model tags; no agents have been dispatched.

| Outcome | Where it belongs |
| --- | --- |
| Recording readiness, indicator recovery, diagnostics | `main.js`, `preload*.cjs`, `public/dictation.js`, `public/pill.html`, focused recovery helpers/tests |
| Local model choice and optional speech detection | `src/providers`, `src/model-download.js`, existing benchmark and Settings |
| Shortcuts, optional sounds, local cleanup | `src/hotkey*`, preferences, cleanup and Settings |
| Verification and safe install | `scripts/electron`, report, installed GVoice only after approval |

1. Reproduce the missing response before changing its cause. [opus/high]
   Add content-free, bounded evidence for press receipt, recorder acknowledgement, first audio frame, indicator acknowledgement, display bounds and native visibility where available. Exercise alive-but-stalled pages and visible-but-unpainted indicators; retain the eight accepted presses as counterevidence to a blanket dead-hotkey diagnosis.
   -> verify: failed cases reproduce on a running isolated app; healthy quiet audio and short taps do not cause false recovery.

2. Recover the failed component and give a visible, truthful answer. [opus/high]
   Use session-owned deadlines and bounded component restart; preserve recoverable audio and never restart into a stale paste. Keep the tray usable if the indicator fails. Extend keyboard health monitoring beyond the first event as a separate regression case.
   -> verify: sleep/wake, device changes, frozen and killed pages, repeated failures, Escape, mouse-button overlap, mic selection across restart, and visible tray/menu. The real incident remains unverified until its scenario is reproduced.

3. Compare English recognition before adding a new default. [sonnet/medium]
   Finish Handy's approved permission setup, compare matching synthetic and explicitly approved local benchmark clips, then add a local Parakeet adapter only if the measured trade-off warrants it. Reuse compatible models; keep small English Whisper available.
   -> verify: equal audio, repetitions, warm/cold timing, numbers/names/negation, error rate, cancellation and no private audio upload. Report uncertainty, not a winner from three clips.

4. Add the useful controls in small increments. [sonnet/medium]
   Add configurable hold/toggle shortcuts, optional readiness sounds, clearer model management, and optional local cleanup with raw-text fallback. Evaluate speech detection without truncating quiet or trailing words. Preserve defaults, dictionary, profiles, editing, recording retention and clipboard restoration.
   -> verify: each increment works in the running app; no shortcut conflict, changed numbers/negation, stale result, lost beginning/end, or clipboard overwrite.

5. Review and prepare the installed update. [opus/medium]
   Run focused and required project checks, build, and verify the actual app. Copy the installed bundle aside first. Replacing `/Applications/GVoice.app` and restarting it runs only after Drago says yes; name the backup and expected interruption before approval.
   -> verify: installed build identity matches reviewed source; tray opens, physical recording and paste work, selected mic persists, and documented failure cases recover.

Traps: star counts are popularity; support remnants are not installations; a passed simulated crash test does not explain tonight; model names do not make different file formats interchangeable; a Tauri rewrite is not required; no Croatian, meeting assistant, cloning, dubbing, or automatic command execution in this scope.

Reverse if: a proposed model/control worsens measured English accuracy, latency, recovery, or clipboard behavior; keep the current working path and narrow the change.

/tier /Users/macmini/dev/voice/docs/plans/gvoice-reliability-and-english-dictation.md
