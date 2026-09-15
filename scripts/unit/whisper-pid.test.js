// Unit tests for the whisper-server ownership marker: where it lives and the
// three-field match that decides whether a running engine may be killed.
// Run: node --test scripts/unit/whisper-pid.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  pidFilePath,
  ownerUserData,
  parsePidRecord,
  buildPidRecord,
  ownsRecord,
  processStartTime,
  PID_RECORD_VERSION
} from "../../src/whisper-pid.js";

const INSTALLED = "/Users/someone/Library/Application Support/GVoice";
const DEV = "/Users/someone/dev/voice/.dev-userdata";

/** A marker as the installed app would have written it. */
const installedRecord = (over = {}) => ({
  v: PID_RECORD_VERSION,
  pid: 4242,
  startTime: "Wed Sep 10 08:15:01 2026",
  userData: INSTALLED,
  port: 51234,
  ...over
});

/** The live facts the reaper gathers for that same pid. */
const liveSelf = (over = {}) => ({
  pid: 4242,
  startTime: "Wed Sep 10 08:15:01 2026",
  userData: INSTALLED,
  ...over
});

test("marker lives inside the instance's own userData folder", () => {
  assert.equal(
    pidFilePath({ GVOICE_USER_DATA_RESOLVED: INSTALLED }),
    join(INSTALLED, "whisper-server.pid")
  );
  assert.equal(
    pidFilePath({ GVOICE_USER_DATA_RESOLVED: DEV }),
    join(DEV, "whisper-server.pid")
  );
  assert.notEqual(
    pidFilePath({ GVOICE_USER_DATA_RESOLVED: INSTALLED }),
    pidFilePath({ GVOICE_USER_DATA_RESOLVED: DEV })
  );
});

test("no userData (parity harness, plain node) keeps the historical shared marker", () => {
  assert.equal(pidFilePath({}), join(tmpdir(), "gvoice-whisper-server.pid"));
  // Its stand-in identity is stable, non-empty, and never a real userData path.
  assert.equal(ownerUserData({}), resolve(join(tmpdir(), "gvoice-no-userdata")));
  assert.notEqual(ownerUserData({}), ownerUserData({ GVOICE_USER_DATA_RESOLVED: INSTALLED }));
});

test("all three fields match: the server is ours, kill allowed", () => {
  assert.equal(ownsRecord(installedRecord(), liveSelf()), true);
});

test("pid mismatch: refuse", () => {
  assert.equal(ownsRecord(installedRecord({ pid: 9999 }), liveSelf()), false);
});

test("start time mismatch (recycled pid): refuse", () => {
  assert.equal(
    ownsRecord(installedRecord(), liveSelf({ startTime: "Wed Sep 10 09:40:00 2026" })),
    false
  );
});

test("userData mismatch: a dev launch never reaps the installed app's engine", () => {
  // The dev instance is looking at a marker written by the installed app.
  assert.equal(ownsRecord(installedRecord(), liveSelf({ userData: DEV })), false);
});

test("unreadable start time or missing userData is a mismatch, never a pass", () => {
  assert.equal(ownsRecord(installedRecord(), liveSelf({ startTime: "" })), false);
  assert.equal(ownsRecord(installedRecord({ startTime: "" }), liveSelf({ startTime: "" })), false);
  assert.equal(ownsRecord(installedRecord(), liveSelf({ userData: "" })), false);
  assert.equal(ownsRecord(installedRecord({ userData: "" }), liveSelf({ userData: "" })), false);
});

test("equivalent userData spellings still match", () => {
  assert.equal(
    ownsRecord(installedRecord({ userData: INSTALLED + "/" }), liveSelf()),
    true
  );
});

test("garbage, wrong version and the legacy bare-number marker parse to null", () => {
  assert.equal(parsePidRecord("not json"), null);
  assert.equal(parsePidRecord("4242"), null); // written by older builds
  assert.equal(parsePidRecord("[]"), null);
  assert.equal(parsePidRecord(JSON.stringify({ ...installedRecord(), v: 99 })), null);
  assert.equal(parsePidRecord(JSON.stringify({ ...installedRecord(), pid: 0 })), null);
  assert.equal(parsePidRecord(JSON.stringify({ ...installedRecord(), userData: 5 })), null);
});

test("a null record can never authorise a kill", () => {
  assert.equal(ownsRecord(null, liveSelf()), false);
  assert.equal(ownsRecord(parsePidRecord("4242"), liveSelf()), false);
});

test("a marker written now round-trips and matches its own live facts", () => {
  const record = buildPidRecord({
    pid: 4242,
    port: "51234",
    env: { GVOICE_USER_DATA_RESOLVED: DEV },
    startTime: "Wed Sep 10 08:15:01 2026"
  });
  const parsed = parsePidRecord(JSON.stringify(record));
  assert.deepEqual(parsed, {
    v: PID_RECORD_VERSION,
    pid: 4242,
    startTime: "Wed Sep 10 08:15:01 2026",
    userData: DEV,
    port: 51234
  });
  assert.equal(ownsRecord(parsed, { pid: 4242, startTime: record.startTime, userData: DEV }), true);
});

test("start time of this very process is readable and stable", () => {
  const first = processStartTime(process.pid);
  assert.ok(first.length > 0, "expected a start time for our own pid");
  assert.equal(processStartTime(process.pid), first);
  assert.equal(processStartTime(0), "");
  assert.equal(processStartTime(-1), "");
});
