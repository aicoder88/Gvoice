// Content-free rolling latency measurements. Durations use a monotonic clock.
export class LatencyTracker {
  constructor({ now = () => performance.now(), limit = 500 } = {}) {
    this.now = now;
    this.limit = limit;
    this.active = new Map();
    this.samples = [];
  }
  start(id, provider) {
    this.active.set(id, { id, provider, capture: "unknown", started: this.now(), marks: {} });
    while (this.active.size > this.limit) this.active.delete(this.active.keys().next().value);
  }
  mark(id, stage, metadata = {}) {
    const entry = this.active.get(id);
    if (!entry) return;
    if (["warm", "cold"].includes(metadata.capture)) entry.capture = metadata.capture;
    if (["terminal", "released", "captureReady", "committed", "transcript", "cleanupStart", "cleanupEnd", "pasteStart", "pasteEnd"].includes(stage) && entry.marks[stage] == null) entry.marks[stage] = this.now();
  }
  finish(id, outcome) {
    const entry = this.active.get(id);
    if (!entry) return;
    this.active.delete(id);
    const m = entry.marks;
    const delta = (a, b) => m[a] == null || m[b] == null ? null : Math.max(0, m[b] - m[a]);
    const sample = { provider: entry.provider, capture: entry.capture, outcome,
      releaseToPasteMs: delta("released", "pasteEnd"),
      releaseToTerminalMs: delta("released", "terminal") ?? delta("released", "transcript"),
      tailMs: delta("released", "committed"),
      transcriptionMs: delta("committed", "transcript"),
      cleanupMs: delta("cleanupStart", "cleanupEnd"),
      pasteMs: delta("pasteStart", "pasteEnd"),
      totalMs: Math.max(0, this.now() - entry.started) };
    this.samples.push(sample);
    if (this.samples.length > this.limit) this.samples.shift();
    return sample;
  }
  summary() { return summarizeLatency(this.samples); }
}

export function summarizeLatency(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.provider}/${sample.capture}`;
    if (!groups.has(key)) groups.set(key, { provider: sample.provider, capture: sample.capture, samples: [] });
    groups.get(key).samples.push(sample);
  }
  return [...groups.values()].map(({ provider, capture, samples: rows }) => {
    const stats = (key) => {
      const values = rows.filter(r => r.outcome === "pasted").map(r => r[key]).filter(Number.isFinite).sort((a, b) => a - b);
      return { count: values.length, median: values.length ? Math.round((values[Math.floor((values.length - 1) / 2)] + values[Math.ceil((values.length - 1) / 2)]) / 2) : null,
        p95: values.length ? Math.round(values[Math.ceil(values.length * 0.95) - 1]) : null };
    };
    return { provider, capture, attempts: rows.length, delivered: rows.filter(r => r.outcome === "pasted").length,
      releaseToPasteMs: stats("releaseToPasteMs"), tailMs: stats("tailMs"), transcriptionMs: stats("transcriptionMs"), cleanupMs: stats("cleanupMs"), pasteMs: stats("pasteMs") };
  });
}
