# Decisions

One entry per structural decision, newest first. Each carries the reason it was
made and the condition that would reverse it.

## 2026-09-12 – A saved dictionary name may replace the word it was misheard as

`preservesSpeakerWords` in `src/cleanup.js` compared the cleanup model's output
to the raw transcript word for word. Any replaced word meant a rewrite, and the
whole result was thrown away. That guard is right for ordinary words and wrong
for names: measured this day on six speech engines, every English error GVoice
made was a name ("purify" for Purrify, "anchor" for Anker, "Deep Gram" for
Deepgram), the cleanup model proposed the correct fix for all of them once the
terms were saved, and the guard reverted every one. The dictionary feature could
not work at all through this path.

The guard now lets a run of up to three transcript words collapse into a single
saved term, via `vocab.isTermSubstitution`. A rejoined split name must match
near-exactly; a single word swapped whole gets a looser bar, because the model
has already judged the sentence and the only thing it may insert is a term the
user typed themselves.

Verified end to end the same day: real clip, whisper small.en hears "The anchor
microphone", GVoice pastes "The Anker microphone".

**Reverse if:** the cleanup model starts swapping ordinary speech for dictionary
terms, for example a spoken "answer" arriving as "Anker". The exemption is
bounded by the saved term list, so the first repair is to prune the dictionary
to rare proper nouns. If that is not enough, tighten the single-word rule in
`isTermSubstitution` to require an exact rejoin, the same bar multi-word runs
already use, and accept that "anchor" for Anker goes back to being unfixable.

**Not changed:** `correctTranscript` still runs blind on every transcript and
keeps its strict rules. Loosening that one would rewrite ordinary speech with no
model reading the context.

**Known gap:** a term that also appears in `models/vocab.txt` is skipped by
`correctTranscript`, so "Purrify" gets no blind repair. The cleanup path now
covers it, so this is cosmetic rather than urgent.
