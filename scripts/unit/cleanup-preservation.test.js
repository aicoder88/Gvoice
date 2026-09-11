import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRawFallback, preservesSpeakerWords } from "../../src/cleanup.js";

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
