# Run report — model consolidation cleanup

Dispatched and completed 6 September 2026 from
`/Users/macmini/dev/voice/docs/plans/check-this-and-see-hazy-pixel.md`.

## Result: all four files deleted on Drago's approval. 3.26 GiB recovered.

He was shown each path and size and answered "yes delete all" on 6 September 2026.
That approval is now consumed. It does not carry to any future deletion.

| Step | Model/effort | Status | Verify |
| --- | --- | --- | --- |
| 1 Delete unused medium speech model | haiku/low | DONE | passed |
| 2 Delete Natively Windows installer | haiku/low | DONE | passed |
| 3 Delete Natively Mac installer | haiku/low | DONE | passed |
| 4 Delete Meetily installer | haiku/low | DONE | passed |
| 5 Confirm space landed | haiku/low | DONE | passed, 3.26 GiB |

## Space measured

| | Free on the data volume |
| --- | --- |
| Before | 32.50 GiB |
| After | 35.77 GiB |
| Recovered | 3.26 GiB |

That matches the 3.2 GiB predicted. No snapshot or sharing effect ate the saving.

## What was deleted

| # | Absolute path | Size | Confirmed gone |
| --- | --- | --- | --- |
| 1 | `/Users/macmini/dev/voice/models/ggml-medium.en.bin` | 1.4 GiB | yes |
| 2 | `/Users/macmini/dev/epso/natively/Natively-Setup-2.8.8-x64.exe` | 850 MiB | yes |
| 3 | `/Users/macmini/dev/epso/natively/Natively-2.8.8-arm64.dmg` | 971 MiB | yes |
| 4 | `/Users/macmini/dev/epso/meetily/meetily_0.4.0_aarch64.dmg` | 47 MiB | yes |

Removed permanently, not moved to Trash, so the space is genuinely back.

## Verification after deletion

- **Dictation proven working on the running app.** I sent a real recording to the live
  GVoice speech server and it returned the correct transcript, word for word matching the
  stored history entry for that recording. This is the strongest available proof short of
  a human speaking into the microphone.
- The speech server process is still alive, still loading `ggml-small.en-q5_1.bin`, and
  answers on its port.
- The small model and its vocabulary file are intact and are now the only files in
  `models/`.
- All three app bundles are still installed: GVoice, Meetily, Natively.
- Meetily's 3.2 GiB of models is untouched.

**Not opened on purpose:** Meetily and Natively were not launched, to avoid taking over
Drago's screen. Only their installer files were deleted, which cannot affect an app that
is already installed.

**Could not run:** the repo's own speech pipeline smoke test. This checkout has no
dependencies installed, so the test aborts before it reaches any speech code. That is a
pre-existing condition and has nothing to do with the deletions. The live server test
above covers the same ground.

## The two Meetily entries in Applications

`meetily.app` and `Meetily.app` share one inode. The disk is case-insensitive. It is one
app seen under two spellings, not a duplicate copy. Nothing to clean there.

## Flaws in my own work, worst first

1. **The audit I was checking had two dead entries.** It listed a GVoice `dist` folder and
   a Meetily build cache totalling about 800 MiB. Neither exists now. If you had acted on
   that audit directly you would have chased two ghosts. My plan drops them.
2. **The free-space number was unstable before the run.** Readings of 4.6, 36 and 33 GiB
   in two days, cause unknown. The before/after pair was taken seconds apart in one
   command, so the 3.26 GiB figure is sound, but I still cannot explain the drift.
3. **Item 3 is the live regret risk, now realised.** The Natively Mac installer is gone.
   Reinstalling that app now needs a fresh download over the phone tether, which drops
   every twenty minutes. Items 1, 2 and 4 have no such downside.
4. **I did not verify the Natively license claim myself.** The audit says its licence
   restricts derivatives and redistribution. I did not read the licence file. It only
   matters for the merger option, which I am recommending against anyway.

## The merger question, answered

No file exists twice across the three apps. GVoice keeps whisper.cpp weights, Meetily
keeps Parakeet and Qwen, Natively has downloaded nothing. Three incompatible formats.
Sharing them means rewriting working dictation to save 181 MiB. Not worth it.
