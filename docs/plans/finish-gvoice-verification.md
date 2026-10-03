# Finish GVoice verification

Goal: complete one coordinated verification session against the existing installed GVoice, then give a definitive acceptance result for each of the six original steps. Preserve implementation, installation, user settings and rollback keepers. This plan replaces repeated prerequisite-only dispatches; it does not declare failed or untested requirements passed. Read `docs/reports/optimize-gvoice-parakeet-run.md` and the original `docs/plans/optimize-gvoice-parakeet.md` first.

Known evidence: first-use native insertion was 1,131ms, above the 1,000ms target. The uncontrolled 1,859.20ms cleanup-on record measures paste dispatch. Finder inspection works; GVoice-specific inspection remains unverified. No new benchmark or signature checks are needed merely to repeat existing passes.

Owner participation: once the test setup is ready, confirm no dictation/file work needs preserving and grant an uninterrupted exclusive interval; read supplied neutral English phrases, make a few specified hotkey holds, and unplug/reconnect the Anker when prompted. The agent prepares fixtures, runs measurements, checks results and writes the report. Owner assistance is not a substitute for machine-observed insertion timing.

| Where things end up | Purpose |
|---|---|
| `scripts/electron`, `scripts/bench` | Only narrowly necessary verification helpers; no application changes |
| `docs/reports/optimize-gvoice-parakeet-run.md` | Single acceptance record mapped to original steps 1–6 |
| `docs/reports` | Content-free conditions, timings and reference-match results |

Run sequentially with one desktop controller and one report writer. Read-only preparation may be delegated at the tagged tier; never run competing desktop or inference trials.

1. Prepare the complete test session before requesting physical actions. [opus/medium]
   Reuse evidence and inspect the existing helpers; prepare any missing bounded measurement helper and disposable native target without launching GVoice or accessing private history. Establish whether installed dictation can receive controlled synthetic input and whether Handy has an identical-audio route. Confirm general desktop inspection; do not select an absent GVoice through an API that would launch it before the exclusive-use gate. Resolve measurement feasibility before consuming owner time.
   -> verify: a concrete trial matrix covers original steps 1–6; distinguish insertion from dispatch and cleanup-on from cleanup-skipped; exact expected words, sample counts, resource limits and owned-process cleanup are defined. If installed synthetic injection or matched Handy input is unsupported, record that specific limitation and use physical trials where valid, never call separate microphone recordings identical audio.

2. Run installed launch, warm, cleanup and recovery measurements in one exclusive interval. [sonnet/medium]
   GATED: runs only after the owner affirmatively confirms idle/exclusive use and general desktop inspection works. Launch the existing installed app, verify its tray/menu and Anker selection, and stop if GVoice inspection is still unusable. Run three fresh app launches and twenty warm 3–10s trials with separately identified cleanup conditions, plus separate 30s and cleanup-on cases. Use the production configuration unchanged for physical trials; isolated synthetic conditions must be labelled and cannot prove physical Anker capture. Test readiness, cancellation, timeout/recovery and file-work contention only through safe supported controls; fault injection may affect only an explicitly owned isolated test instance, never the live user worker. If no safe recovery mechanism exists, mark that requirement unverified.
   -> verify: observed native insertion, exact reference checks, no duplicates, restored clipboard/focus, preparation before readiness, single-worker ownership, and idle-resource observations. Report n, median and nearest-rank p95 by condition; no-cleanup warm targets are median ≤600ms and p95 ≤1,000ms, first-use ≤1,000ms. Preserve unmet targets. Compare Handy only using a verified identical-input route; unsupported comparison remains a named limitation.

3. Finish the physical Anker checks in one guided batch. [opus/high]
   GATED: owner available for speech, hotkey use and unplug/reconnect. Use supplied neutral phrases for normal release, release during a final syllable, quiet final words, quick taps, rapid consecutive phrases and longer speech; inspect the result after each. Confirm missing Anker gives a clear failure without another microphone, reconnect restores Anker capture, and selection/capture persist after a graceful restart. Reuse passing deterministic delayed-delivery checks and label their coverage separately.
   -> verify: every reference word and final word survives in the relevant cases; no successful empty result, duplicate or cross-phrase paste; actual Anker capture is established. Retain the 450ms allowance. Report any failure with its exact condition rather than changing implementation during this verification-only run.

4. Close the verification session with one evidence-based decision. [sonnet/medium]
   Restore test-owned temporary state, leave the installed app usable as agreed, and update the single report with planned/actual model routing and a pass, fail or unverified result for every original acceptance clause. Reuse previous project checks unless a verification-helper change needs focused validation. No rebuild, replacement or automatic rollback is part of this plan; a confirmed regression gets a concrete recovery recommendation preserving both keepers.
   -> verify: each original step 1–6 has evidence and an explicit result; no missing samples counted as passes; no implementation/install edits; final report identifies any unmet target or necessary repair without another generic continuation loop. Verification can finish with failures; successful optimization acceptance requires those failures to be resolved or the owner explicitly to revise the requirements.

Safeguards: never infer idle from missing windows/processes; never force-stop the live app or worker. Graceful quit refusal ends that trial. Use distinct absolute `GVOICE_HOME` and `GVOICE_USER_DATA`, `GVOICE_NO_ENV=1`, empty working directory and minimal environment for isolated instances; never run a second packaged instance alongside the user app because of competing hotkeys. Reuse the model, keep at least 2 GiB disk free, and preserve clipboard/focus protections. No private transcripts, history or credentials in reports. No synthetic proof presented as physical proof. External cleanup use requires known pricing and the shared cumulative US$1 task cap; an unknown safe spend boundary blocks that subset only. No publication or spending beyond the cap.

Decision: approve this verification plan and affirm the exclusive interval when available. A request to execute without that affirmation authorizes preparation only; do not repeatedly ask or probe an unchanged blocked state. Physical checks wait for the owner. A failed test produces a specific finding, not an automatic code change.

/tier /Users/macmini/dev/voice/docs/plans/finish-gvoice-verification.md
