// Unit tests for the over-punctuation routing gate (looksOverPunctuated).
// The streaming engine puts a period wherever the speaker pauses, so one
// sentence arrives chopped into two or three. This gate is what sends such a
// transcript to the cleanup pass instead of pasting it as spoken-with-periods.
// The strings below are real dictations taken from the app's own history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksOverPunctuated } from "../../src/cleanup.js";

test("flags real chopped dictations", () => {
  const chopped = [
    "Install AutovotKey and set up. The Mac Apple copy, paste, move shortcuts.",
    "Also set up the other keyboard short cuts I have on my Mac. Like IPT. Paste. My email address fully.",
    "Using alt c and v instead of Ctrl plus. The other thing.",
    "I was thinking. About the report you sent.",
    "We should ship it today. Because the client is waiting."
  ];
  for (const s of chopped) assert.equal(looksOverPunctuated(s), true, `should flag: ${s}`);
});

test("leaves ordinary dictations alone", () => {
  const fine = [
    "Hi there.",
    "Testing.",
    "Send the invoice today. I will call him tomorrow.",
    "The order shipped this morning. Tracking goes out tonight.",
    "Can you check the price? I think it went up."
  ];
  for (const s of fine) assert.equal(looksOverPunctuated(s), false, `should NOT flag: ${s}`);
});

test("ignores junk input", () => {
  assert.equal(looksOverPunctuated(""), false);
  assert.equal(looksOverPunctuated(null), false);
  assert.equal(looksOverPunctuated(undefined), false);
  assert.equal(looksOverPunctuated(42), false);
});
