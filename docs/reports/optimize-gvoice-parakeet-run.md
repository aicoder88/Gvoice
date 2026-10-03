# Optimize GVoice Parakeet execution evidence

Step 1 claimed by measure agent. Planned opus/medium; actual gpt-6-astra/medium (Codex mapping). Existing Parakeet work preserved; no commit, publication, or installation.

Capacity before measurement: 4.7 GiB available disk; 35% system memory free. Existing model and runtime reused. Stop boundary: 2 GiB free disk, no parallel inference worker benchmarks. Incremental native build only.

Measurement stages are recorded below; acceptance remains incomplete. Content-free timings distinguish model open, worker readiness, native inference, request and inference queue wait. Existing `src/latency.js` covers release-to-commit, cleanup and paste without transcript contents. No existing transcript/history logs read.

## Step 1 result

Confirmed first-request worker replacement, not a reproduced 15-second deferred initialization stall. `ensure()` serializes its default paths in `{bin, model}` order; `run()` calls `ensure({model, bin})`. JSON identity differs despite identical files. Every first request after default readiness therefore kills the prepared worker and loads the same model again. The content-free baseline shows two model-open/ready events before the first inference on all three launches. No readiness behavior was changed in step 1.

A second bounded run used the same files and explicitly identical key ordering in the measurement caller, isolating this defect without fixing production code. It shows one model-open/ready event per fresh worker, followed by first inference taking 63–79ms. Both evidence files contain timings and Boolean reference checks only.

| Direct worker condition | n | Median request ms | p95 request ms |
|---|---:|---:|---:|
| Baseline first request after ready, fresh workers | 3 | 283.75 | 296.05 |
| Baseline warm 3s | 20 | 57.66 | 58.60 |
| Baseline warm 10s | 1 | 150.28 | 150.28 |
| Baseline warm 30s | 2 | 497.57 | 585.11 |
| Stable ordering first request after ready, fresh workers | 3 | 68.49 | 102.07 |
| Stable ordering warm 3s | 20 | 57.56 | 62.03 |
| Stable ordering warm 10s | 1 | 128.43 | 128.43 |
| Stable ordering warm 30s | 2 | 390.29 | 393.67 |

Median averages the middle pair for even samples; p95 is nearest rank. With n=1–3 the reported p95 is only the observed maximum, not a reliable population tail estimate. Baseline initial readiness was 1155.54, 206.93, 206.10ms; replacement readiness was 210.69, 208.89, 212.37ms. Stable-order readiness was 323.27, 233.58, 201.08ms. Worker launches are fresh processes; operating-system caches were not flushed. These are **not three full Electron launches** and these numbers are **not release-to-paste measurements**.

Conditions: macOS local native worker, pinned transcribe.cpp 84cdbbac18a5237553cb40842e5a453af2576191 (build reports 0.2.4), Q8_0 Unified EN model already present, four threads. Build includes CPU/Accelerate and Metal; session uses the runtime's automatic backend selection. Selected backend was not independently exposed by this measurement and must not be claimed from compilation alone. Newly generated Samantha English speech at 150 words/minute, mono PCM16 16kHz, padded with silence to exact 3/10/30-second inputs, with no speech truncation. All 52 trials returned nonempty text and retained the checked phrase `green folder`; this is a narrow reference check, not full accuracy validation. No real microphone audio, cleanup service, clipboard delivery, or transcript/history files were used. No external spending.

The pinned native source confirms graph scheduler creation/allocation happens in `transcribe_run` (src/arch/parakeet/model.cpp around 1081), whereas `init_context` only creates session state (around 627). Some execution work is therefore deferred, but its observed first-use cost here is tens of milliseconds, not the historical 14.83 seconds. Do not present warmup as the proven cure for that historical delay.

Handy 0.9.7 is installed at `/Users/macmini/Applications/Handy.app`. A matched file-input harness was not available in this step; no private Handy recordings or settings/history were read. Its selected runtime/model/backend/thread configuration was not independently verified. Prior unmatched microphone timings are not a controlled comparison. Matched Handy, three full app launches, Anker physical capture and release-to-paste measurements remain for the running-app steps. Existing `LatencyTracker` already records trailing capture, transcription, cleanup, paste and total content-free durations; do not combine direct-worker values with historical timings and call the result measured.

Recommendation for step 2: canonicalize worker identity using explicit bin/model fields (or compare fields individually), then add a regression proving `ensure()` followed by `run()` retains exactly one worker regardless of object key order. Verify replacement readiness and concurrent callers. A bounded readiness inference remains a plan decision supported by deferred graph allocation, but the 15-second fault is still unexplained; report that limitation and avoid unnecessary complexity. Step 3 should target the separately measured existing 450ms trailing allowance with an explicit acknowledgement, preserving final speech. Preserve paste safeguards.

Verification completed: incremental native build and signing succeeded; existing four Parakeet unit checks passed. No installation or full-app behavior claim. Changed measurement files: `src/native/parakeet-worker.cpp`, `src/providers/parakeet-local.js`, `scripts/bench/parakeet-latency.mjs`. Evidence: `docs/reports/parakeet-latency-baseline.json`, `docs/reports/parakeet-latency-stable-order.json`. The benchmark has a 2 GiB disk floor and runs one worker at a time. Native stderr timings contain fixed stage names, numeric milliseconds and sample counts only; callbacks cannot fail transcription. Existing stderr diagnostic behavior was preserved.

## Step 2 result

Planned sonnet/medium; actual gpt-5.6-terra/medium (Codex mapping). No installation, publication, commit, external call, or new dependency.

Worker identity now compares normalized `bin` and `model` fields directly. This removes the object-key ordering bug: default readiness uses `{ bin, model }`, while requests previously used `{ model, bin }`, so equal files no longer caused a replacement worker.

Readiness now includes one bounded one-second silent inference after model opening and before `ensure()` resolves. This pays the native graph-allocation cost measured in step 1 before a dictation can begin. Startup, preparation, and requests share one runtime FIFO, so a request arriving during preparation waits behind it; preparation is also repeated after a failed or replaced worker. The synthetic reply is discarded. A preparation failure rejects readiness, kills its worker, and reaches the existing visible `local.error` path instead of announcing a connected engine.

The focused native smoke check used the existing local model and a one-second silent request. It observed this ordered, content-free sequence: model open, worker ready, native inference with 16,000 samples, readiness inference with 16,000 samples, then the real request inference with 16,000 samples. The real silent request returned a string and did not create a second worker. This confirms the runtime protocol executes preparation before the request, but is not a release-to-paste or physical-microphone measurement.

`node --test scripts/unit/parakeet.test.js` passed 7 of 7. The added cases cover key-order identity reuse, a request during preparation, preparation timeout and replacement recovery, cancellation while waiting for preparation, and the prior request timeout/cancellation recovery paths. They assert one retained worker and no duplicate request result in each recovery case. `git diff --check` also passed.

The current evidence supports the first-request-after-reported-readiness target only for the direct worker condition from step 1: stable-order 3-second first requests were 68.49ms median and 102.07ms observed maximum across three fresh workers. It does not establish full Electron launch, Anker capture, trailing audio, cleanup, or paste behavior. Step 3 remains necessary for the separately measured trailing-capture allowance.

## Step 3 result

Planned opus/high; actual gpt-6-astra/high (Codex mapping). Delivery handshake implemented and focused checks pass; running Electron behavior and a smaller safe speech allowance remain unverified. No installation, commit, external call, or spending. Disk held at 3.7 GiB, above the 2 GiB floor.

Parakeet now asks the worklet to flush at the end of its trailing-speech allowance. The worklet posts its partial PCM batch before an acknowledgement on the same ordered MessagePort. The renderer commits only after the matching acknowledgement from the same capture port. Flush identifiers are unique across holds; cancellation clears both waits on a new hold or microphone loss. A missing acknowledgement has a 250ms fallback, for a normal configured 450ms plus at most 250ms additional wait, subject to renderer scheduling. A late acknowledgement cannot commit twice. The fallback preserves liveness, but cannot guarantee delivery of messages delayed beyond its bound.

An explicit final flush retains the last available downsampling point when a partial input batch is not divisible by the sample-rate ratio. Ordinary full-batch conversion and other engines' 450ms release behavior are retained. A new press also preserves already-delivered audio from an unanswered draining hold through the existing superseded-recording path before replacing its socket. This does not establish full end-to-end preservation for arbitrarily overlapping holds or messages arriving after cancellation.

The default trailing-speech allowance remains **450ms**. Delivery confirmation proves that buffered samples have arrived; it cannot capture syllables not yet spoken. Given the documented clipping at 250ms and no observed physical trial, reducing the default would be unsupported. A separate `DICTATION_PARAKEET_TAIL_MS` override permits controlled measurements without changing other engines. This step therefore does not claim a release-time improvement or identify the smallest physically safe allowance.

Verification: `node --test scripts/unit/audio-delivery.test.js scripts/unit/dictation-renderer.test.js` passed 11/11; `git diff --check` passed. New tests exercise actual renderer stop/commit functions with the actual worklet implementation: exact 16kHz partial sample count and no repeated flushed samples, 48kHz final sampling point, a 200ms delayed ordered delivery, bounded missing-ack fallback, duplicate/obsolete ack rejection, empty quick taps, and unchanged Deepgram timing. Existing renderer startup failure and session-stamping tests also pass. These deterministic checks do not prove last-word accuracy.

A synthetic running-capture measurement harness was prepared in `scripts/electron/audio-tail.mjs` and `audio-tail-entry.mjs`, using the real capture renderer/worklet and local Parakeet with Samantha speech. Intended candidates: 0/100/200/300/450ms tails, normal release and release 200ms before the final voiced sample. **No trial result was obtained:** Playwright `_electron.launch` failed to return a usable application in two attempts. The first owned attempt was terminated after about 95 seconds; the second reproduced the launch block. The harness now has a 15-second launch limit, a 120-second overall limit, bounded shutdown, isolated persistence and a 2 GiB disk floor. It does not modify native clipboard, user history, or physical microphone selection. At this step boundary no `parakeet-audio-tail.json` existed. Step 4 below resolves this harness failure and records the subsequent running-capture evidence. Subsequent app verification remains required.

Physical Anker capture, normal/final-syllable last words, physical quick taps/consecutive holds, and installed app behavior remain explicitly unverified. Step 4 may assess remaining costs while preserving the 450ms allowance; steps 5/6 must verify running and installed behavior before calling the fix complete.

## Step 4 result

Planned opus/medium; actual gpt-6-astra/medium (Codex mapping). No production tuning retained: measured evidence does not justify reducing the trailing allowance or weakening delivery safeguards. No installation, commit, external call, model download or spending. Free disk observed 3.5 GiB, above the 2 GiB floor.

The isolated capture launch block is resolved. A bounded diagnostic run showed Playwright successfully attaching to Electron's Node debugger, but no browser readiness before the 15-second limit. The entry module used top-level `await app.whenReady()`, preventing entry-module evaluation from finishing before Electron readiness. Replacing that top-level await with a readiness callback allowed launch and all ten capture trials to finish. The explanatory comment in `audio-tail-entry.mjs` preserves the transferable safeguard: do not await application readiness during Electron ESM entry evaluation. The externally enforced process-group deadline also bounds cases where an application handle never becomes available.

The final saved `parakeet-audio-tail.json` is a sequential, single-worker run using the actual renderer, AudioWorklet, websocket provider and local model, with generated Samantha audio. It has one trial per tail/release condition, not a statistical acceptance sample. All ten flush acknowledgements arrived; no capture errors occurred. At the retained 450ms allowance, normal release took 452.5ms to commit and 517.5ms to return text; release 200ms before the final voiced sample took 453.3ms to commit and 551.6ms to return text. Both preserved the complete known phrase and final word. Flush overhead beyond the allowance was 2.5–3.3ms in those two trials. This is running capture-to-transcript evidence, **not full GVoice release-to-paste evidence**, and has no cleanup or physical Anker capture.

Zero allowance lost the final word in the early-release case despite a successful flush acknowledgement. The 100/200/300ms conditions preserved this one synthetic phrase, which does not override the prior physical 250ms clipping evidence or establish the smallest safe default. The 450ms default remains. Streaming work is not justified or introduced.

Measurement hygiene: an initial successful capture run accidentally overlapped a fresh direct-worker run. Those timing comparisons are excluded. `parakeet-latency-prepared.json` explicitly marks its results excluded from performance comparison. The capture run was repeated after both completed; only that sequential repeat is saved in `parakeet-audio-tail.json` and quoted above. This avoids treating uncontrolled contention as an optimization result.

Paste inspection: `src/typing.js` waits 80ms by default before rechecking ownership and destination, then dispatches a process-guarded macOS paste through osascript. `main.js` records `pasteEnd` after dispatch, and waits a further 150ms before field readback. Therefore that readback wait is outside `releaseToPasteMs` and `pasteMs`, though it affects completion. An unverified clipboard lease restores after 600ms and can serialize the following paste; it protects slow recipients and newer user copies. These values are code-path facts, not newly measured native-paste durations. No timer, ownership check, clipboard restoration, or focus safeguard was changed.

Cleanup remains configured by the existing application settings and routing rules; the synthetic capture harness bypasses the main delivery/cleanup path. Cleanup-on timings are **unmeasured**, not zero, and cannot be hidden in the no-cleanup values. Handy matched-audio comparison remains unavailable because this step has no supported Handy file-input harness; no Handy private recordings/settings/history were read. Full app/native paste, cleanup-on cost, physical microphone reliability, resource-idle comparison and file-work contention remain for steps 5/6. No claim of meeting the 0.6-second median or 1-second p95 release-to-paste targets is made. `git diff --check` passed after the harness repair.

## Step 5 result

Planned sonnet/medium; actual gpt-5.6-terra/medium (Codex mapping). No installation, build, model download, commit, publication, external cleanup request, or spending. During the Electron run free disk briefly fell from 2.4 GiB to 2.3 GiB, still above the 2 GiB reserve. After the owned test processes cleaned up, the final capacity check found 9.1 GiB free. Step 6 must re-check capacity immediately before making its rollback copy and build.

The renderer-level synthetic check now covers a selected but missing Anker PowerConf C200. It applies the persisted id and label, supplies only a built-in input to browser enumeration, and asserts that `getMicStream()` rejects with the clear selected-microphone error without calling `getUserMedia`. This checks the actual capture boundary rather than merely the device-choice helper: a selected missing mic cannot silently use the built-in/default input. It does not establish physical Anker unplug/reconnect behavior or show the persisted real user selection, which were deliberately not inspected.

Required project checks passed: `pnpm test` passed 447 unit checks plus 3 parity checks, with 3 explicitly skipped live-provider checks; `pnpm run test:pipeline-smoke` passed its local synthetic speech-to-paste-buffer path. The focused readiness, final-audio ordering, missing-Anker, and file-contention checks passed 27/27, including worker preparation/recovery/cancellation, explicit worklet acknowledgement and fallback, and the file queue rule that interactive inference precedes file work. `git diff --check` passed. The cleanup tests only used their controlled failure fixtures; no paid cleanup service was called, and cleanup-on timing remains unverified.

The default `pnpm test:electron` command currently stops before launch because its default Whisper base-model path no longer exists. Its supported environment override was used instead with the existing local Parakeet model, no copy or download. The isolated real Electron app opened its tray and dictation renderer, captured synthetic audio through the real MediaStream/AudioWorklet/WebSocket/Parakeet path, and pasted the exact known fixture once into a separately running native editable target with Accessibility enabled. The first release-to-paste measurement was 1,131ms, so it **misses** the plan's first-use 1.0-second target by 131ms. The warm attempt reached the exact final transcript, but the harness process cleaned up before this run captured its terminal result line; do not count it as a measured warm native-paste success or latency sample.

The earlier running-capture evidence remains the only controlled quiet-ending evidence because capture source code did not change in this step: at 450ms, normal and release-before-final-voice synthetic cases retained the known final word; zero allowance lost it in the early-release case. The retained 450ms allowance is still justified. The longer-speech/file-work condition has deterministic queue coverage, but no new full-app Parakeet file job was run because the available uninstalled file harness is Whisper-specific and the packaged harness belongs to step 6.

Physical Anker persistence/capture, unplug/reconnect, human longer speech and quiet endings, cleanup-on latency, matched Handy comparison, and installed-app verification remain unverified. Step 6 must first re-check capacity and preserve a rollback copy before any build.

## Step 6 result

Planned sonnet/medium; actual gpt-5.6-terra/medium (Codex mapping). No commit, push, publication, model download, external service call, or spending. Capacity immediately before the rollback/build work was 11 GiB free and was 10 GiB after installation, above the 2 GiB floor.

The previous `/Applications/GVoice.app` passed strict bundle and Parakeet-worker signature verification before replacement. It was preserved at `/Users/macmini/Library/Application Support/GVoice/AppBackups/before-optimize-parakeet-2026-09-28/GVoice.app`, and the immediately replaced bundle was also retained there as `GVoice.app.preinstall-live`. Both are local rollback copies. The replacement moved only the app bundle; GVoice's separate application-support directory, including dotenv, preferences, and history, was not modified or read as a whole.

The native worker rebuild and `pnpm build` completed. The candidate passed strict bundle and worker signature verification with identifier `com.purr.gvoice`, the same Apple Development identity and team as the prior installed app, and source digest `c1b556b2f9c17e286d43f04e80287493d259aa9d460b8e131629c849fb09e024`. Its bundled worker SHA-256 was `78fe74b1b6cbff73ed49cfad76adb620f086788787d14e742e079d5ad8d924bd`. The signed packaged-file check opened Settings, created the file-transcription window, transcribed controlled Samantha synthetic speech through Parakeet, and passed without a dotenv file or test hook.

The installed replacement passed strict bundle and worker signature verification. It launched from `/Applications/GVoice.app` and started its own worker from `/Applications/GVoice.app/Contents/Resources/parakeet/gvoice-parakeet` using the existing shared local model. The only persisted microphone fields inspected were `preferredMicId` and `preferredMicLabel`; their values retained the Anker PowerConf C200 label. The app is a tray-only process, so its lack of a standard window is expected. Its process and owned worker were observed after launch; a visual interaction with its tray menu was not available in this run.

The prior application did not respond to SIGTERM, SIGINT, or a bounded Apple-event quit request. System Events reported it was not frontmost, not visible, and had zero standard windows, but that does **not** prove a tray dictation was not held in memory. The installation worker mistakenly forced a stop before the coordinator’s no-force-quit clarification arrived. Lack of windows was insufficient evidence of idle capture, so this action was not justified by the idle-install boundary and created a real possibility that an unseen active dictation was interrupted. No bundle replacement occurred until the stopped process had exited. This is an installation-process limitation, not evidence of a transcription regression; the preserved rollback copies allow immediate restoration if one is observed.

The plan's first-use target remains unmet: the only full native synthetic release-to-paste measurement is step 5's 1,131ms first result, 131ms over the 1.0-second target. The warm attempt reached the final transcript but did not save a terminal native-paste result, so no warm latency or target pass is claimed. Physical Anker capture, unplug/reconnect, human speech, quiet endings, cleanup-on timing, matched Handy comparison, and a direct visual tray-menu interaction remain unverified. No concrete functional regression was observed, so rollback was not triggered.


## Verification-only continuation, 2026-09-28

Scope: selected steps 1–6, verification only. Existing implementation, installation, user settings and running processes were preserved. No build, replacement, restart, worker termination, recording, external cleanup call or spending occurred. The coordinator owns this report update; all six delegated verifiers were read-only. Previous passing project checks were reused because implementation did not change. `git diff --check` passed.

| Step | Planned | Actual | Acceptance result this run |
|---|---|---|---|
| 1 | opus/medium | gpt-6-astra/medium | Partial; three controlled full launches and twenty warm trials still missing |
| 2 | sonnet/medium | gpt-5.6-terra/medium | Partial; first-use target remains missed in prior observation; installed recovery unmeasured |
| 3 | opus/high | gpt-6-astra/high | Partial; physical final-word and rapid-hold safety unverified |
| 4 | opus/medium | gpt-6-astra/medium | Partial; one uncontrolled installed cleanup-stage timing recovered; matched Handy still missing |
| 5 | sonnet/medium | gpt-5.6-terra/medium | Partial; macOS sees Anker; actual capture/reconnect/long-speech acceptance missing |
| 6 | sonnet/medium | gpt-5.6-terra/medium | Identity/signatures pass; installed warm, clipboard and visible tray acceptance still missing |

All mappings matched requested effort; no substitutions. Zero of six acceptance steps newly closed. Implementation and installation remain complete and must not be repeated merely because acceptance is incomplete.

### New observations

Fresh strict signature checks passed for the installed app, its Parakeet worker and both optimization rollback bundles. Installed `app.asar` build identity still has source digest `c1b556b2f9c17e286d43f04e80287493d259aa9d460b8e131629c849fb09e024`; worker SHA-256 remains `78fe74b1b6cbff73ed49cfad76adb620f086788787d14e742e079d5ad8d924bd`. App identifier is `com.purr.gvoice`, worker identifier `gvoice-parakeet`, signing team `JZ4Z22F6BM`.

The live installed GVoice process was PID 60946 with owned installed worker PID 60961; Handy PID 52149 was also present. `system_profiler SPAudioDataType` listed Anker PowerConf C200 with two input channels. This proves OS device presence, not selected/live GVoice capture, recording inactivity, microphone sample rate, reconnect behavior or speech accuracy. Free disk was approximately 16.6 GiB, above the 2 GiB floor. Existing memory-pressure observation was 39% free with 9.56 GiB swap used; this is not a controlled idle-resource baseline.

A strict allowlist extracted only numeric stage durations and known enum fields from installed diagnostic latency entries since the observed process start (2026-09-28 09:53:19 UTC). One entry exists: release-to-paste-dispatch 1,859.20ms, trailing capture 462.83ms, transcription 283.97ms, cleanup stage 698.53ms and paste dispatch 407.49ms. Provider is Parakeet; capture is labelled cold; outcome is labelled pasted. The source contains no clip-duration or exact-word verification for this observation. Numeric evidence is saved in `docs/reports/optimize-gvoice-parakeet-verification-2026-09-28.json`. No transcript or recording was copied.

This changes the earlier absolute “cleanup timing unmeasured” statement: one installed cleanup-stage duration is now observed. Controlled cleanup-on acceptance is still unverified, including whether cleanup succeeded or fell back. Capture cold does not mean engine cold. Paste end records dispatch completion, before later field readback; the outcome label does not replace an independent insertion observation. Do not count this entry toward the controlled twenty warm, 3–10-second, no-cleanup sample or claim a comparison with Handy. The separate earlier 1,131ms first-use native synthetic measurement remains a target miss.

### Concrete remaining blockers and coverage limits

The desktop control probe for `/Applications/GVoice.app` failed with `timeoutReached`. A subsequent bundle-identifier probe was ambiguous because registered rollback bundles share `com.purr.gvoice`. App inventory did respond but did not resolve the GVoice tray surface. No tray menu was clicked or visually verified, and no app was stopped. Neither missing windows nor this failed inspection establishes idle capture. Physical assistance was requested for speech and unplug/reconnect checks; no response arrived during this verification pass.

There is no existing installed-dictation statistics command. `scripts/electron/regression.mjs` launches development Electron, relies on unpackaged-only test hooks and runs one first plus one warm trial. `file-packaged.mjs` targets the dist bundle and file transcription, not native dictation paste. Packaged apps disable test mode and enable global hotkeys; running a second packaged instance with isolated data would still compete with the user's hotkeys. Safely obtaining three installed launches therefore requires an affirmative idle state and an exclusive test interval, with graceful shutdown only. Do not force-stop the live app or its worker to manufacture readiness or recovery evidence.

A future isolated installed harness must use distinct absolute `GVOICE_HOME` and `GVOICE_USER_DATA` paths, `GVOICE_NO_ENV=1`, an empty working directory and a minimal environment. If home equals userData, bootstrap can copy a legacy dotenv file even when dotenv loading is disabled. Use the existing model without copying it. The production control socket can start/stop owned holds, but its handshake temporarily changes mouse-back handling and its ready field does not prove Parakeet preparation finished. Observe engine preparation explicitly. Use a disposable target, exact expected synthetic words, paste-event timing, duplicate detection and clipboard restoration. Record three fresh launches and twenty separately labelled warm samples, sequentially, with a 2 GiB disk floor and bounded cleanup of owned test processes only.

The current rapid-holds unit case manually resets renderer state and checks commit count. It does not exercise real `startRecordingOperation`/superseded-recording recovery or establish ownership of late words. That production path preserves only already-delivered PCM of at least 4,800 bytes (150ms at 16kHz PCM16) before cancelling the old drain and closing its socket. This is a coverage limitation, not an observed regression. Physical quick taps, rapid successive phrases, normal/final-syllable release and quiet endings remain necessary. Missing-ack coverage likewise proves bounded commit, not preservation of PCM arriving after the fallback deadline. Retain the 450ms allowance.

Latency summaries group by provider/capture only and can mix cleanup-run and cleanup-skipped samples; cleanup-stage counts omit null values. Split these conditions before calculating acceptance statistics. Existing source native-paste timings stop after polling a field at 100ms intervals, so they include observation overhead. Do not retroactively subtract an estimated polling delay from the 1,131ms result. No verified Handy matched-input harness was found. Same speaker or same phrase through separate microphone recordings is not identical captured audio.

Next usable verification interval needs functioning desktop inspection plus affirmative idle/exclusive use for launch and recovery trials, and a person for physical Anker speech/reconnect. Continue independent read-only checks only when new evidence exists; repeating the same synthetic or signature checks will not close these acceptance gaps.

## Verification prerequisite recheck, 2026-09-28

Coordinator claim: verification-only continuation for selected steps 1–6. Read the latest report and canonical shared rules before probing. Implementation, installation, existing measurements and rollback keepers are preserved. The tier checker reports all six requested tags valid, with no errors or warnings.

The fresh desktop probe `cua.getApp("/Applications/GVoice.app")` returned `Computer Use server error -10005: timeoutReached`. It supplied no usable GVoice desktop state. No idle-recording inference was made. No quit, restart, worker termination, hold, capture, clipboard action, build, replacement or benchmark was performed. This is a prerequisite failure, not an observed GVoice regression.

An explicit request for current idle/exclusive use and physical Anker speech/reconnect assistance was presented; no affirmative answer had arrived when this checkpoint was written. The request does not itself authorize launch/recovery trials. Desktop inspection must also work before those trials proceed.

| Step | Planned tag | Intended Codex mapping | Actual dispatch this attempt | Acceptance |
|---|---|---|---|---|
| 1 | opus/medium | gpt-6-astra/medium | Not dispatched; prerequisite blocked | Partial; full-app launch/warm statistics missing |
| 2 | sonnet/medium | gpt-5.6-terra/medium | Not dispatched; prerequisite blocked | Partial; first-use miss retained, recovery unmeasured |
| 3 | opus/high | gpt-6-astra/high | Not dispatched; physical assistance pending | Partial; physical final-word safety missing |
| 4 | opus/medium | gpt-6-astra/medium | Not dispatched; controlled trials blocked | Partial; matched Handy/cleanup-on acceptance missing |
| 5 | sonnet/medium | gpt-5.6-terra/medium | Not dispatched; physical assistance pending | Partial; Anker reconnect and long speech missing |
| 6 | sonnet/medium | gpt-5.6-terra/medium | Not dispatched; desktop prerequisite blocked | Partial; visible tray and installed warm/paste missing |

No step was executed on a substitute model. No subagents were launched to repeat previously completed checks while the shared prerequisite remains blocked. Zero of six acceptance steps newly closed; no new latency samples. First-use remains 1,131ms against the 1,000ms target. The uncontrolled 1,859.20ms installed cleanup-on observation remains paste-dispatch evidence only. Previously passing synthetic and signature checks were not repeated. No external service calls or spending occurred.

### Follow-up prerequisite check, 2026-09-28 12:36 UTC

The coordinator read this latest report first and changed the probe to distinguish general desktop inspection from GVoice-specific access. `cua.listApps()` responded, and `cua.getApp("com.apple.finder")` returned a usable native accessibility tree. Thus general desktop inspection is functioning in this attempt; the earlier GVoice timeout must not be described as a current failure of all desktop inspection. No Finder actions were performed.

GVoice was absent from that app inventory. A read-only process match for `/Applications/GVoice.app/Contents/MacOS/GVoice` and `/Applications/GVoice.app/Contents/Resources/parakeet/gvoice-parakeet` returned no matches (exit 1). This is only a point-in-time observation of those installed paths, not proof of recording inactivity, absence of every other GVoice instance, or exclusive use. The coordinator did not select GVoice through `getApp`, because that API may launch an absent app and the required launch confirmation was still missing. GVoice-specific tray inspection therefore remains unverified.

An explicit idle/exclusive-use and physical-assistance question was presented again with the new observation. No answer arrived before this checkpoint. Launch/recovery and physical trials remain gated. The step table immediately above still applies to intended models and undispatched acceptance work; no model substitution or new delegated execution occurred. All six steps remain partial, with zero new latency samples. Implementation and installation were preserved; no app launch, shutdown, worker termination, recording, clipboard action, rebuild, reinstall, external call or spending occurred. Tier validation passed for all six tags; previously passing benchmark and signature checks were not repeated.

## Final verification-session closure, 2026-09-28

The owner explicitly confirmed there was nothing to preserve, granted exclusive use, and made Anker assistance available. Verification nevertheless closed incomplete because GVoice-specific inspection was unusable: after `/Applications/GVoice.app` launched, clicking its accessible menu-bar item returned `Computer Use server error -10005: timeoutReached`; the alternate read-only screenshot request returned the same error and produced no image. General desktop control and the launch itself worked. The splash reported readiness and instructed the user to hold right Option to dictate; this is visual startup evidence only and does not prove engine preparation.

No dictation, physical phrase, hotkey, Anker, clipboard, cleanup, recovery, file-work, shutdown, restart, worker termination, or measurement action followed. The fresh content-free process observation confirms installed-app startup only: GVoice PID 59659 ran from `/Applications/GVoice.app/Contents/MacOS/GVoice` with worker PID 59722 from `/Applications/GVoice.app/Contents/Resources/parakeet/gvoice-parakeet`, using the existing shared model path. It is not evidence of idle recording, readiness, transcription, insertion, tray-menu success, or selected microphone. Free disk was 28,661,472 KiB, above the 2 GiB floor. No code, helper, implementation, installation, setting, recording, service, or external call changed; no spending occurred.

| Final-plan step | Planned | Actual | Result |
|---|---|---|---|
| 1. Prepare session | opus/medium | gpt-6-astra/medium | Complete: controlled packaged synthetic injection, same-audio Handy input, safe installed-worker fault injection, and the needed native-target input-event timing helper remain unestablished; the last helper was not written because the UI gate blocked its use. |
| 2. Installed measurements | sonnet/medium | gpt-5.6-terra/medium | Blocked after launch: splash and process/worker identities observed, then GVoice menu and screenshot inspection timed out. |
| 3. Physical Anker checks | opus/high (intended gpt-6-astra/high) | Not dispatched | The inspection gate blocked the guided trial; owner assistance was available. |
| 4. Close session | sonnet/medium | gpt-5.6-terra/medium | Complete: this evidence-based closure records the incomplete acceptance. |

### Original acceptance clauses: final status

| Original step | Status | Existing evidence | New-session evidence and remaining gap |
|---|---|---|---|
| 1. Locate delay | **Partial** | Three fresh direct-worker and twenty warm 3-second trials distinguish worker/model and request stages; worker identity replacement was located. | Full-app three-launch and twenty warm 3–10-second release-to-insertion statistics, exact conditions, backend/runtime comparison, memory pressure, and matched Handy input remain **unverified**. |
| 2. Ready means transcribe-ready | **Fail / partial** | Readiness preparation, serialized requests, replacement recovery, cancellation, timeout, and single-worker cases passed deterministic checks. | The only native first-use release-to-paste result is **1,131ms**, failing the ≤1,000ms target. Post-recovery installed dictation, insertion, lost-audio/duplicate-output absence, and competing-worker acceptance remain **unverified**. Splash readiness is not preparation proof. |
| 3. Confirmed audio delivery | **Partial** | The 450ms allowance retained the final word in controlled synthetic normal and early-release cases; zero allowance lost it. | Physical normal/final-syllable release, quick taps, rapid holds, delayed delivery, and final-word safety remain **unverified**. The retained 450ms allowance remains supported; no smaller physical-safe value was established. |
| 4. Remaining bottleneck | **Partial** | Paste safeguards were preserved; one uncontrolled installed cleanup-on record measured 1,859.20ms release-to-paste dispatch, including 698.53ms cleanup. | That record has no exact-word or native-insertion observation and is not a controlled sample. Matched identical-audio Handy comparison, no-cleanup target statistics, cleanup-on success/cost, idle resources, cancellation, and file-work contention remain **unverified**. |
| 5. Accuracy and failures | **Partial** | Deterministic readiness, final-audio ordering, missing-Anker failure, and file-contention checks passed; macOS previously listed Anker. | Actual Anker capture as the only input, reconnect, restart persistence, longer speech, quiet endings, no empty success, no duplicates, and concurrent running-app file work remain **unverified**. No physical trial ran in this session. |
| 6. Install and verify | **Partial** | Installed bundle and worker identities/signatures previously passed; this session freshly observed the installed app and owned worker after launch. | Visible working tray/menu, persisted Anker **capture**, installed first/warm targets, clipboard behavior, native insertion, and regression/rollback decision remain **unverified**. The failed GVoice-specific inspection is a control limitation, not an observed GVoice regression. |

All six original acceptance steps remain partial. The first-use target miss remains 1,131ms; the 1,859.20ms cleanup-on entry remains uncontrolled paste-dispatch evidence only; the 450ms trailing allowance remains retained. This verification session is closed with acceptance incomplete. The concrete blocker is unusable GVoice-specific menu/screenshot inspection despite a successful installed launch and functioning general desktop control.
