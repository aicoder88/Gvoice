# Destination profiles and personal speech benchmark

Scope: original recommendations 5 and 6. Preserve the local 1-4 implementation.

1. Add explicit plain, email, chat, and coding-prompt profiles, saved defaults and per-app mappings, capture the chosen profile at utterance start, and preserve meaning during formatting. [gpt-6-astra/high]
   Verify: routing/persistence tests and running-app profile selection with restart. No automatic selected-text collection.
2. Add an opt-in local benchmark library with audio import, human-approved reference transcripts, coverage tags, engine/model result import, reproducible accuracy/meaning-risk/latency scoring, and comparison reports. [gpt-6-astra/high]
   Verify: consent/reference gates, protected numbers/negation/self-correction cases, isolated fixture corpus, and running-app review/approval flow. No existing recording import or cloud submission without explicit selection.
3. Integrate both features, run unit/build and focused Electron checks, document scope and remaining hardware/live-provider limits. [gpt-6-astra/high]
   Verify: actual app UI, persistence, tray/menu, report. Retain the known existing paste-helper timeout as a separate unresolved check.

Status: steps 1-3 complete locally. 240 unit tests and focused real-Electron
verification pass, including actual local Whisper and restart persistence.
The user's personal corpus awaits user-selected recordings and human reference
approval; no real data or approvals were fabricated. See
[verification report](../verification/destination-profiles-and-personal-benchmark.md).
No install, push, or deployment. The earlier paste-helper timeout remains separate.

/tier /Users/macpro/dev/voice/docs/plans/destination-profiles-and-personal-benchmark.md
