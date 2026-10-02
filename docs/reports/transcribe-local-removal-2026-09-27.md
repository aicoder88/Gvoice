# Transcribe local removal

Owner request: "remove the repo and model from my local drive".

Removed the local Transcribe checkout code and Git directory from `/Users/macmini/dev/Transcribe`, and removed `/Users/macmini/.cache/huggingface/hub/models--Systran--faster-whisper-large-v3`. GitHub was not changed. No running process held either directory. GVoice remains running with its separate `/Users/macmini/dev/voice/models/ggml-small.en-q5_1.bin`.

Measured available space increased from 19.325 GiB to 22.228 GiB, a 2.902 GiB machine-wide change during removal. This is the measured disk delta, not the sum of folder sizes.

Recovery: a verified 4.2 MiB local source archive preserves all Git refs, including one unpushed documentation commit and the untracked improvement note. Exact archive path and manifest are in machine memory. No source was pushed or uploaded.

Remaining: `uploads` (114 MiB) and `outputs` (1.2 MiB) are held pending the owner’s choice to preserve or delete personal recordings/transcripts. The 253-byte immutable `.env` remains protected by the shared secrets rule. The old directory is therefore no longer a repository but is not yet empty. No credential or transcript contents were read or exposed.

Ulix copies of the transcription code also reference the removed large-v3 model; that old workflow may need a fresh model download if used again. No other model folder was removed.
