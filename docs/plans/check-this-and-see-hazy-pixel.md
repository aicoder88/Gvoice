# Should GVoice, Meetily and Natively share models to save space? No. Delete the dead files instead.

Checked 6 September 2026 on this Mac against the audit written the day before.

## Context

Drago asked whether the three apps' models can or should be merged to save disk space.
The audit from 5 September said: keep the apps separate, there is no duplicated big model,
and the savings are in installers and leftover files. I re-checked every number on the
real disk. The audit's conclusion holds. Two of its numbers are already stale.

### What I verified today (read-only)

- Free space is now **36 GiB**, not 4.6 GiB. Something big was already cleared since yesterday.
- GVoice's speech server is running and loads the small English model (181 MiB). Confirmed
  from the live process, not the code.
- The 1.43 GiB medium model in `models/` is not referenced by any code, script, `.env`
  value or settings file in this repo. It is ignored by git, was downloaded 8 August, and
  nothing loads it. It is dead weight.
- Meetily's model folder is 3.2 GiB: Qwen 2.6 GiB, Parakeet 0.64 GiB. Both are the
  formats Meetily's own engine needs. GVoice cannot load either one.
- Natively has no downloaded models in its user data at all (under 1 MiB total).
- The 2.9 GiB Hugging Face cache belongs to the Ulix and Fearvanai transcription scripts,
  not to any of the three apps. Out of scope here.
- Two audit candidates no longer exist: the GVoice `dist` build output and Meetily's
  `.next/cache`. Nothing to delete there.
- Trash is empty and there is one local snapshot, so deletions will show up as free space.

### Why merging models saves nothing

The three apps use three different model formats that cannot read each other's files:

| App | Speech model format | Text model |
| --- | --- | --- |
| GVoice | whisper.cpp GGML (`.bin`) | Cloud (Groq), no local file |
| Meetily | Parakeet ONNX (`.onnx`) | Qwen GGUF, 2.6 GiB |
| Natively | Transformers.js ONNX, none downloaded | Codex CLI, no local file |

There is no file that exists twice. A symlink between folders would not work because the
engines expect different weights. Making them share one engine means rewriting working
dictation to save 181 MiB. Not worth it.

The only realistic sharing is one shared local text service running the Qwen file, which
would let GVoice clean up text offline. That is a capability project, not a space saving,
and it costs RAM on a 16 GiB machine. Decision for Drago, listed under `NEEDS YOU`.

## Recommendation

Do not merge. Delete the four dead files below. Total recovered: **about 3.2 GiB**.
Every deletion is a hard gate: show path and size, delete only on a per-item "yes".

## Dependencies

Steps 1 to 4 are independent and touch different files. Step 5 depends on 1 to 4.
No step edits any app, model in use, setting or source file.

## Steps

### 1. Delete the unused GVoice medium speech model DONE 2026-09-06 [haiku/low]

Path: `/Users/macmini/dev/voice/models/ggml-medium.en.bin`, 1,462.7 MiB.
Not loaded by the running server, not referenced anywhere, ignored by git. If Drago ever
wants to compare it again, it re-downloads from the whisper.cpp model page.

-> verify: `ls /Users/macmini/dev/voice/models/` shows only `ggml-small.en-q5_1.bin` and `vocab.txt`; dictation still works on the running app after one test phrase.

### 2. Delete the Natively Windows installer DONE 2026-09-06 [haiku/low]

Path: `/Users/macmini/dev/epso/natively/Natively-Setup-2.8.8-x64.exe`, 849.5 MiB.
A Windows file on a Mac. Cannot run here.

-> verify: `ls /Users/macmini/dev/epso/natively/*.exe` returns nothing.

### 3. Delete the Natively Mac installer DONE 2026-09-06 [haiku/low]

Path: `/Users/macmini/dev/epso/natively/Natively-2.8.8-arm64.dmg`, 970.6 MiB.
The app is already installed. Reinstall would need a fresh download or rebuild from source.

-> verify: `ls /Users/macmini/dev/epso/natively/*.dmg` returns nothing; `/Applications/Natively.app` still opens.

### 4. Delete the Meetily installer DONE 2026-09-06 [haiku/low]

Path: `/Users/macmini/dev/epso/meetily/meetily_0.4.0_aarch64.dmg`, 46.8 MiB.
The app is already installed.

-> verify: `ls /Users/macmini/dev/epso/meetily/*.dmg` returns nothing; Meetily still opens.

### 5. Confirm the space landed — DONE 2026-09-06, 3.26 GiB recovered [haiku/low]

Run `df -h /System/Volumes/Data` before step 1 and after step 4. Report the difference.
Free space should rise by roughly 3.2 GiB.

-> verify: the "Avail" column increased by at least 3.0 GiB.

## Not in scope (letters, not steps)

- a. Shared local text service for all three apps. Capability project, not a space saving.
  Only start it if Drago wants offline cleanup in GVoice and accepts the RAM cost.
- b. Natively source-map trimming (0.62 GiB inside the installed app). Needs a proper
  rebuild of that app, and its license limits what can be redistributed.
- c. The 2.9 GiB Hugging Face cache used by Ulix and Fearvanai scripts. Different projects.
- d. Full app merger. Saves about 273 MiB of shared framework for months of work.

## Verification

After step 4, on the running GVoice app: hold the hotkey, say one sentence, release,
confirm it pastes. Open Meetily and Natively once each and confirm they launch.

/tier /Users/macmini/dev/voice/docs/plans/check-this-and-see-hazy-pixel.md
