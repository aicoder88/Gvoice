// Private stdin/stdout transport: no HTTP listener, files, or microphone access.
// Input: u32 LE sample count followed by that many float32 LE samples at 16 kHz.
// Output: u32 LE status, u32 LE UTF-8 byte count, UTF-8 text. Startup sends (0,0).
#include "transcribe.h"
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <vector>
#include <chrono>

static bool read_exact(void * data, size_t length) {
    return std::fread(data, 1, length, stdin) == length;
}
static uint32_t read_u32(const unsigned char * p) {
    return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
static void write_u32(uint32_t n) {
    unsigned char b[4] = { (unsigned char)n, (unsigned char)(n >> 8), (unsigned char)(n >> 16), (unsigned char)(n >> 24) };
    std::fwrite(b, 1, 4, stdout);
}
static void reply(uint32_t status, const char * text) {
    if (!text) text = "";
    const size_t n = std::strlen(text);
    write_u32(status); write_u32((uint32_t)n);
    std::fwrite(text, 1, n, stdout); std::fflush(stdout);
}
int main(int argc, char ** argv) {
    if (argc != 2) return 2;
    transcribe_session * session = nullptr;
    transcribe_session_params params;
    transcribe_session_params_init(&params);
    params.n_threads = 4;
    const auto open_at = std::chrono::steady_clock::now();
    auto status = transcribe_open(argv[1], nullptr, &params, &session);
    std::fprintf(stderr, "GVOICE_TIMING model_open %.3f 0\n", std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - open_at).count());
    if (status != TRANSCRIBE_OK) { reply(1, transcribe_status_string(status)); return 1; }
    // Refuse a different model accidentally selected through a path override.
    const char * variant = transcribe_model_variant_string(transcribe_get_model(session));
    if (!variant || std::strcmp(variant, "unified-en-0.6b") != 0 ||
        std::strcmp(transcribe_model_arch_string(transcribe_get_model(session)), "parakeet") != 0) {
        reply(1, "Choose the Parakeet Unified EN 0.6B GGUF model.");
        transcribe_close(session); return 1;
    }
    reply(0, "");
    unsigned char header[4];
    while (read_exact(header, 4)) {
        const uint32_t n = read_u32(header);
        if (n == 0 || n > 16000 * 120) break;
        std::vector<unsigned char> bytes(size_t(n) * 4);
        if (!read_exact(bytes.data(), bytes.size())) break;
        std::vector<float> pcm(n);
        bool valid = true;
        for (uint32_t i = 0; i < n; ++i) {
            uint32_t bits = read_u32(bytes.data() + i * 4);
            std::memcpy(&pcm[i], &bits, 4);
            if (!std::isfinite(pcm[i]) || std::fabs(pcm[i]) > 1.0f) valid = false;
        }
        if (!valid) { reply(1, "Invalid audio samples."); continue; }
        const auto run_at = std::chrono::steady_clock::now();
        status = transcribe_run(session, pcm.data(), (int)n, nullptr);
        std::fprintf(stderr, "GVOICE_TIMING inference %.3f %u\n", std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - run_at).count(), n);
        if (status != TRANSCRIBE_OK) reply(1, transcribe_status_string(status));
        else if (transcribe_was_truncated(session)) reply(1, "Parakeet stopped before finishing the recording.");
        else reply(0, transcribe_full_text(session));
    }
    transcribe_close(session);
    return 0;
}
