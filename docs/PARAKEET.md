# Local Parakeet

`parakeet-local` uses Parakeet Unified EN 0.6B Q8_0 for English dictation and file
transcription. It reuses the model downloaded by Handy without copying it.
Selection is `STT_PROVIDER=parakeet-local`; the Settings speech-engine list also
includes Local Parakeet. AI cleanup remains a separate existing preference.

Build the worker with `pnpm build:parakeet`, then the app with `pnpm build`.
The worker links transcribe.cpp revision
`84cdbbac18a5237553cb40842e5a453af2576191`; its MIT license and ggml license ship
beside the worker. The model is not bundled or downloaded by this build.
The model's metadata identifies NVIDIA's Open Model License.

The optional `PARAKEET_MODEL` and `PARAKEET_BIN` variables override discovery.
Otherwise the model is found in the app's models directory, then Hugging Face's
local model storage (`HF_HUB_CACHE`, `HF_HOME`, or the normal home directory).
Missing files produce an explicit error; there is no cloud fallback.

GVoice records Parakeet input as mono PCM16 at 16 kHz. The parent converts it to
float32 for a persistent native worker. The private pipe protocol uses a
four-byte little-endian sample count followed by float32 samples. Responses are
a four-byte status, four-byte UTF-8 length, and text. Startup emits a zero-length
success response. Audio is bounded to two minutes per dictation; longer files
use the existing file window and twenty-second sections. A timeout or canceled
request terminates only this worker; the next request starts a new one.

Verification: `node scripts/bench/parakeet-smoke.mjs` tests real inference on
synthetic English, cold and warm. `GVOICE_TEST_PROVIDER=parakeet-local` selects
Parakeet in the existing Electron regression and packaged-file checks. These
use separate test data and do not transcribe user history.
