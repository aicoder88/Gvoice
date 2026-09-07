# Destination profiles and personal benchmark verification

Local macOS Apple Silicon verification, 2026-09-05. This adds original
recommendations 5 and 6 to the existing uncommitted 1-4 implementation.
No installation, push, deployment, secret-file write, or existing recording import.

## Destination profiles

Settings offers Plain, Email, Chat and Coding, a manual default, and explicit
per-app mappings. App identity detection uses macOS executable identity only;
other platforms retain manual profiles. No page content, window title, URL, or
selected text is collected. Rules persist in nonsecret local JSON. The profile
is frozen at utterance start so later settings changes cannot alter in-flight work.

Non-Plain profiles add conservative formatting instructions to the existing cleanup
request and share its provider, fallback and timeout. They require AI cleanup to be
enabled. Plain leaves the prior cleanup prompt unchanged. This is formatting,
not a promise of perfect model meaning preservation.

## Personal benchmark

The corpus starts empty. An explicit per-file picker and consent action adds a
local copy; the user writes and approves each reference before scoring. Tags cover
Croatian, English, mixed language, brands, numbers, negation, corrections, and noise.
Reference changes revoke approval and invalidate earlier scores.

The window runs installed local Whisper on approved WAV clips without downloads
or network requests. Runs can be cancelled and are bounded per clip and overall.
Other engine and cleanup outputs can be imported as results JSON. References never
enter engine prompts. Comparisons show normalized WER/CER, timing, coverage,
heuristic critical-change flags, and separate human meaning reviews. No automatic
winner is selected. The corpus has its own explicit removal controls.

## Verification

- 240 unit tests passed, including profile routing/persistence, prompt integration,
  approval/revision gates, metric cases, cancellation and atomic write failures.
- `pnpm test:profiles-benchmark` passed in a real Electron app with a separate
  editable target and isolated persistence. It checked UI save, exact native app
  identity, mapped/default cleanup requests with offline response fixtures, immutable
  active profiles, import/approve/compare/review, and persistence after app restart.
- The same test clicked the local Whisper button and transcribed the repository's
  synthetic quick-fox recording with the installed engine. Exact output, WER 0;
  one observed cold CLI run took 697 ms including model loading. This single fixture
  measurement is not a performance guarantee or evidence about the user's speech.
  The generated result correctly remained pending human review after restart.
- GVoice's native tray icon and open menu were visually inspected.
- `pnpm build` passed; unsigned local output is `dist/mac-arm64/GVoice.app`.
- `git diff --check` passed.

See [profiles screenshot](output-profiles.png), [benchmark screenshot](personal-benchmark.png),
and [benchmark usage and scoring guide](../benchmark.md).

## Remaining limits

No real personal speech corpus or human approvals have been fabricated. The user's
own clips and reference review are still needed to obtain personalized results.
No live cleanup-model quality evaluation was run; profile request integration used
offline responses. Automatic identity is macOS-only; Windows and physical microphone
behavior were not exercised. Browser tabs cannot have separate app rules.

The earlier full dictation desktop suite's macOS paste-helper timeout remains
unresolved. These feature checks do not claim to fix or reverify that failure.
