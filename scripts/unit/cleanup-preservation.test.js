import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatRawFallback, preservesSpeakerWords } from "../../src/cleanup.js";
import * as vocab from "../../src/vocab.js";

/** Point the dictionary at a throwaway file holding `terms`, so the name tests
 *  below cannot be changed by whatever the user happens to have saved. Cleanup
 *  leaves the store pointed at an empty file rather than calling init(""),
 *  which vocab.init ignores — an empty path is not a reset, so that would have
 *  left the module reading a directory this helper had just deleted. */
function freshVocab(terms) {
  const dir = mkdtempSync(join(tmpdir(), "gvoice-cleanup-vocab-"));
  const path = join(dir, "custom-vocab.json");
  writeFileSync(path, JSON.stringify({ terms, dismissed: [] }));
  vocab.init(path);
  return {
    path,
    cleanup: () => {
      writeFileSync(path, JSON.stringify({ terms: [], dismissed: [] }));
      vocab.init(path);
      assert.deepEqual(vocab.getTerms(), []); // the reset really happened
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("accepts punctuation, capitalization, and paragraph layout", () => {
  assert.equal(preservesSpeakerWords(
    "this uses what was the best model but now it feels wonky",
    "This uses what was the best model. But now it feels wonky."
  ), true);
  assert.equal(preservesSpeakerWords(
    "first paragraph stays here second topic starts here",
    "First paragraph stays here.\n\nSecond topic starts here."
  ), true);
});

test("accepts only clear filler and stutter removal", () => {
  assert.equal(preservesSpeakerWords("um I I need this uh today", "I need this today."), true);
  assert.equal(preservesSpeakerWords("I like this idea", "I this idea."), false);
  assert.equal(preservesSpeakerWords("you know the answer", "The answer."), false);
});

test("rejects added, replaced, translated, or reordered words", () => {
  assert.equal(preservesSpeakerWords("send the file", "Please send the file."), false);
  assert.equal(preservesSpeakerWords("send the file", "Send the document."), false);
  assert.equal(preservesSpeakerWords("send the file today", "Send today the file."), false);
  assert.equal(preservesSpeakerWords("pošalji datoteku", "Send the file."), false);
  assert.equal(preservesSpeakerWords("write a prompt to fix this", "A prompt should be written to fix this."), false);
});

test("accepts explicit numbered-list markers but protects ordinary counts", () => {
  assert.equal(preservesSpeakerWords(
    "we need one speed two accuracy three polish",
    "We need:\n\n1. speed\n2. accuracy\n3. polish"
  ), true);
  assert.equal(preservesSpeakerWords(
    "first call John second send the file third wait",
    "1. call John\n2. send the file\n3. wait"
  ), true);
  assert.equal(preservesSpeakerWords(
    "I have one dog and two cats",
    "I have:\n\n1. dog\n2. cats"
  ), false);
});

test("accepts bounded spoken corrections", () => {
  assert.equal(preservesSpeakerWords("buy milk no wait buy water", "Buy water."), true);
  assert.equal(preservesSpeakerWords("tell John actually tell Sarah", "Tell Sarah."), true);
  assert.equal(preservesSpeakerWords("the price is fifty no wait sixty dollars", "The price is sixty dollars."), true);
  assert.equal(preservesSpeakerWords("meet at three sorry four", "Meet at four."), true);
});

test("does not mistake ordinary cue words for corrections", () => {
  assert.equal(preservesSpeakerWords("I actually agree with that", "I agree with that."), false);
  assert.equal(preservesSpeakerWords("I'm sorry for the delay", "I'm for the delay."), false);
  assert.equal(preservesSpeakerWords("the answer is no", "The answer is."), false);
});

test("rejects destructive correction handling", () => {
  assert.equal(preservesSpeakerWords(
    "send the report to John no wait Sarah and include the figures",
    "Sarah and include the figures."
  ), false);
  assert.equal(preservesSpeakerWords(
    "send the report to John no wait Sarah and include the figures",
    "Send the report to Sarah and include the figures."
  ), true);
  assert.equal(preservesSpeakerWords(
    "send the report to John no wait Sarah and include the figures",
    "Send Sarah the figures."
  ), false);
});

test("self-correction switch can forbid all content-word removal", () => {
  assert.equal(preservesSpeakerWords("buy milk no wait buy water", "Buy water.", false), false);
});

test("unsafe cleanup still gets a word-preserving minimum polish", () => {
  assert.equal(formatRawFallback("  send the file  "), "Send the file.");
  assert.equal(formatRawFallback("does this work?"), "Does this work?");
  assert.equal(formatRawFallback("pošalji datoteku:"), "Pošalji datoteku.");
});

// --- dictionary names may replace the words they were misheard as ------------
// Until 2026-09-12 the guard discarded every one of these. The cleanup model
// made the correct fix, the word-for-word check saw a replaced word, and the
// mishearing was restored on every dictation. Measured that day: "purify" for
// Purrify and "anchor" for Anker on all six engines tested.

test("accepts a saved dictionary name in place of the word it was misheard as", () => {
  const { cleanup } = freshVocab(["Purrify", "Anker", "PowerConf", "GVoice", "Deepgram"]);
  try {
    // one word swapped whole, including a real English word
    assert.equal(preservesSpeakerWords(
      "the purify order number is 4821",
      "The Purrify order number is 4821."
    ), true);
    assert.equal(preservesSpeakerWords(
      "the anchor microphone keeps dropping out",
      "The Anker microphone keeps dropping out."
    ), true);
    // a name whisper broke in two, rejoined
    assert.equal(preservesSpeakerWords(
      "ask deep gram support why it drops",
      "Ask Deepgram support why it drops."
    ), true);
    assert.equal(preservesSpeakerWords(
      "the anchor power conf sits on the desk",
      "The Anker PowerConf sits on the desk."
    ), true);
  } finally {
    cleanup();
  }
});

test("a dictionary name never swallows the speaker's next word", () => {
  const { cleanup } = freshVocab(["GVoice"]);
  try {
    // "g voice hot" is within three edits of "gvoice", so a greedy match ate
    // "hot" and lost a word the speaker said. The run must rejoin near-exactly.
    assert.equal(preservesSpeakerWords(
      "the g voice hot is the right option key",
      "The GVoice Hot is the right option key."
    ), true);
    assert.equal(preservesSpeakerWords(
      "the g voice hot is the right option key",
      "The GVoice is the right option key."
    ), false);
  } finally {
    cleanup();
  }
});

test("the exemption reaches only saved terms, never ordinary rewrites", () => {
  const { cleanup } = freshVocab(["Purrify", "Anker"]);
  try {
    // not a dictionary term, so still a rewrite
    assert.equal(preservesSpeakerWords("send the file", "Send the document."), false);
    // right shape, but the replacement is not in the dictionary
    assert.equal(preservesSpeakerWords("the anchor microphone", "The Shure microphone."), false);
    // a term cannot stand in for a word that sounds nothing like it
    assert.equal(preservesSpeakerWords("the monitor is on", "The Anker is on."), false);
    // and it cannot be used to delete words
    assert.equal(preservesSpeakerWords("the anchor microphone is here", "The Anker microphone."), false);
  } finally {
    cleanup();
  }
});

test("with an empty dictionary the guard is exactly as strict as before", () => {
  const { cleanup } = freshVocab([]);
  try {
    assert.equal(preservesSpeakerWords("the purify order number", "The Purrify order number."), false);
    assert.equal(preservesSpeakerWords("the anchor microphone", "The Anker microphone."), false);
  } finally {
    cleanup();
  }
});

test("accepts spoken symbols and joined words written the coding way", () => {
  assert.equal(preservesSpeakerWords("open main dot js", "Open main.js."), true);
  assert.equal(preservesSpeakerWords("run git push dash dash force", "Run git push --force."), true);
  assert.equal(preservesSpeakerWords("email john at example dot com", "Email john@example.com."), true);
  assert.equal(preservesSpeakerWords("send me an e-mail", "Send me an email."), true);
  // A sentence's own period is not a spoken "dot", so the word must stay.
  assert.equal(preservesSpeakerWords("I drew a dot here", "I drew a here."), false);
  // A joined word still has to be the same letters.
  assert.equal(preservesSpeakerWords("send me an e mail", "Send me an emails."), false);
});
