# GVoice reliability and voice editing

Authorized scope: implement recommendations 1-3, followed by 4. Preserve provider keys and unrelated work. No push or deployment requested.

1. Audit and repair utterance ownership, terminal-event deduplication, clipboard ownership, and bounded completion. [opus/high]
   Verify: reproduce each defect with a failing regression, then pass focused tests and exercise the running Electron app.
2. Add an isolated real-Electron regression runner with actual editable targets and explicit fixture/provider coverage. [sonnet/medium]
   Verify: run it without silent skips; report hardware and platform scenarios separately.
3. Measure release-to-delivery and stage latency, with median/p95 grouped by provider and warm/cold capture; remove confirmed avoidable delay without shortening speech capture. [opus/medium]
   Verify: deterministic metric tests, running-app timing samples, and no content in latency records.
4. Add explicit selection-based voice editing with preview, apply, and undo. [opus/high]
   Verify: bounded model requests, cancel/error behavior, preview before mutation, target validation, actual app apply/undo.

Status: steps 1-4 implemented locally. 220 unit tests and the macOS build pass.
Native typed and spoken selection editing, partial Apply, and Undo passed in a
separate running app. The complete desktop regression remains failing at the
macOS paste helper timeout, so full verification is incomplete. See
[verification report](../verification/reliability-and-voice-editing.md) for evidence
and limits. No push or deployment performed.

/tier /Users/macpro/dev/voice/docs/plans/gvoice-reliability-and-voice-editing.md
