'use strict';

const $ = id => document.getElementById(id);
const state = { snapshot: null, selectedId: null, detail: null, readRevisions: new Map(), polling: false, pickInFlight: false, actionInFlight: false };
const statusLabels = { queued: 'Queued', running: 'Transcribing', paused: 'Paused', failed: 'Failed', completed: 'Completed' };

function element(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function button(text, handler, className = 'button') {
  const item = element('button', text, className);
  item.type = 'button';
  item.addEventListener('click', handler);
  return item;
}

function duration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '–';
  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function progress(job) {
  const done = Number(job.processedSeconds) || 0;
  const total = Number(job.durationSeconds) || 0;
  if (!total) return job.status === 'completed' ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round(done / total * 100)));
}

function selectedJob() { return state.snapshot?.jobs?.find(job => job.id === state.selectedId) || null; }

function setLive(message, isError = false) {
  const live = $('liveStatus');
  live.textContent = message || '';
  live.classList.toggle('error', isError);
}

function renderEngine() {
  const engine = state.snapshot?.engine;
  const box = $('engineStatus');
  box.replaceChildren();
  if (!engine) {
    box.className = 'engine bad';
    box.append(element('span', '!', 'engine-icon'), element('span', 'The local speech engine is unavailable.'));
    return;
  }
  if (!engine.available) {
    box.className = 'engine bad';
    box.append(element('span', '!', 'engine-icon'), element('span', engine.reason || 'The local speech engine is unavailable.'));
    return;
  }
  box.className = 'engine';
  const busy = state.snapshot.dictationBusy ? ' A dictation is using it now.' : '';
  const detail = `Using GVoice’s current local model${engine.model ? `: ${engine.model}.` : '.'} Live dictation takes priority between short file sections.${busy}`;
  box.append(element('span', '●', 'engine-icon'), element('span', detail));
}

function renderJobs() {
  const list = $('jobList');
  list.replaceChildren();
  const jobs = state.snapshot?.jobs || [];
  if (!jobs.length) {
    list.append(element('p', 'Choose audio or video files to start a local transcription. They remain in their original folders.', 'queue-empty'));
    return;
  }
  for (const job of jobs) {
    const item = element('button', undefined, `job${job.id === state.selectedId ? ' selected' : ''}`);
    item.type = 'button';
    item.setAttribute('aria-pressed', String(job.id === state.selectedId));
    item.addEventListener('click', () => selectJob(job.id));
    item.append(element('div', job.name || 'Untitled file', 'job-name'));
    const meta = element('div', undefined, 'job-meta');
    meta.append(element('span', '', `dot ${job.status}`), element('span', statusLabels[job.status] || 'Waiting'), element('span', `${duration(job.processedSeconds)} / ${duration(job.durationSeconds)}`));
    item.append(meta);
    const track = element('div', undefined, 'mini-track');
    const fill = element('div', undefined, `fill ${job.status}`);
    fill.style.width = `${progress(job)}%`;
    track.append(fill); item.append(track); list.append(item);
  }
}

function transcriptText(detail) {
  if (!detail?.segments?.length) return '';
  return detail.segments.map(segment => String(segment.text || '').trim()).filter(Boolean).join('\n');
}

function renderDetail() {
  const host = $('detailContent');
  const previousScroll = host.querySelector('.transcript')?.scrollTop || 0;
  host.replaceChildren();
  const job = selectedJob();
  if (!job) {
    const empty = element('div', undefined, 'empty-state');
    empty.append(element('h2', 'Turn files into text'), element('p', 'Add one or more local audio or video files. Transcription stays on this computer, and the source files remain in place.'), button('Add files', pickFiles, 'button primary'));
    host.append(empty);
    return;
  }
  const top = element('div', undefined, 'file-top');
  const title = element('div'); title.append(element('h2', job.name || 'Untitled file', 'filename'));
  const status = element('div', undefined, 'status-line'); status.append(element('span', '', `dot ${job.status}`), element('span', statusLabels[job.status] || 'Waiting', 'status-word'));
  if (job.model) status.append(element('span', `· ${job.model}`));
  title.append(status); top.append(title, button('Add files', pickFiles, 'button'));
  host.append(top);
  const pct = progress(job);
  const track = element('div', undefined, 'track'); track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', `${job.name || 'File'} progress`); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100'); track.setAttribute('aria-valuenow', String(pct));
  const fill = element('div', undefined, `fill ${job.status}`); fill.style.width = `${pct}%`; track.append(fill); host.append(track);
  const label = element('div', undefined, 'progress-label'); label.append(element('span', `${duration(job.processedSeconds)} transcribed of ${duration(job.durationSeconds)}`), element('span', `${pct}%`)); host.append(label);
  const actions = element('div', undefined, 'actions');
  if (job.status === 'running' || job.status === 'queued') actions.append(button('Pause', () => runAction('pause', job.id)));
  if (job.status === 'paused' || job.status === 'failed') actions.append(button(job.status === 'failed' ? 'Retry' : 'Resume', () => runAction('resume', job.id), 'button primary'));
  actions.append(element('span', undefined, 'spacer'));
  if (job.hasText) actions.append(button('Copy text', () => runAction('copy', job.id), 'button'));
  host.append(actions);
  if (job.error) host.append(element('div', job.error || 'GVoice could not transcribe this file. You can retry it.', 'notice'));
  const card = element('section', undefined, 'card');
  const head = element('div', undefined, 'card-head'); head.append(element('h3', 'Transcript'), element('span', job.hasText ? 'Updates while it runs' : 'No text yet', 'muted')); card.append(head);
  const transcript = element('pre', transcriptText(state.detail), 'transcript');
  if (!transcript.textContent) { transcript.textContent = job.status === 'failed' ? 'No transcript was produced.' : 'The transcript will appear here as GVoice completes each section.'; transcript.classList.add('empty'); }
  card.append(transcript); host.append(card);
  transcript.scrollTop = previousScroll;
  if (job.hasText) {
    const exports = element('section', undefined, 'card'); exports.append(element('h3', 'Export a copy'));
    const hint = element('p', 'Save to a new filename. SRT timing covers short sections, not individual words. Partial transcripts contain only completed sections.', 'hint'); exports.append(hint);
    const row = element('div', undefined, 'export-row');
    for (const format of ['txt', 'srt', 'json']) row.append(button(format.toUpperCase(), () => runAction('export', job.id, format), 'button quiet'));
    exports.append(row); host.append(exports);
  }
}

async function selectJob(id) {
  if (state.selectedId === id) return;
  state.selectedId = id;
  state.detail = null;
  state.readRevisions.delete(id);
  render();
  await refreshDetail();
}

async function refreshDetail() {
  const job = selectedJob();
  if (!job || !job.hasText || state.readRevisions.get(job.id) === job.revision) return;
  try {
    const detail = await window.fileTranscription.read(job.id);
    if (state.selectedId !== job.id) return;
    state.detail = detail;
    state.readRevisions.set(job.id, detail.revision);
    renderDetail();
  } catch (error) { setLive(error.message || 'Could not read this transcript.', true); }
}

function render() { renderEngine(); renderJobs(); renderDetail(); }

async function applySnapshot(snapshot) {
  const next = snapshot || await window.fileTranscription.get();
  if (JSON.stringify(next) === JSON.stringify(state.snapshot)) return;
  state.snapshot = next;
  if (next.warning) setLive(next.warning, true);
  const jobs = state.snapshot.jobs || [];
  if (!state.selectedId || !jobs.some(job => job.id === state.selectedId)) state.selectedId = jobs[0]?.id || null;
  render();
  await refreshDetail();
}

async function pickFiles() {
  if (state.pickInFlight) return;
  state.pickInFlight = true; $('pickFiles').disabled = true; setLive('Opening the file picker…');
  try { const result = await window.fileTranscription.pick(); await applySnapshot(result); setLive(result.canceled ? 'No files added.' : 'Files added to the local queue.'); }
  catch (error) { setLive(error.message || 'Could not add those files.', true); }
  finally { state.pickInFlight = false; $('pickFiles').disabled = false; }
}

async function runAction(action, id, format) {
  if (state.actionInFlight) return;
  state.actionInFlight = true; setLive(action === 'copy' ? 'Copying transcript…' : 'Working…');
  try {
    const result = await window.fileTranscription.action(action, format ? { id, format } : { id });
    if (result?.jobs) await applySnapshot(result);
    else await applySnapshot();
    setLive(result?.canceled ? 'Save canceled.' : action === 'copy' ? 'Transcript copied.' : action === 'export' ? 'Saved.' : action === 'pause' ? 'Pausing after the current request finishes.' : 'Updated.');
  } catch (error) { setLive(error.message || 'That action could not be completed.', true); }
  finally { state.actionInFlight = false; }
}

async function poll() {
  if (state.polling) return;
  state.polling = true;
  try { await applySnapshot(); }
  catch (error) { setLive(error.message || 'Could not update the file queue.', true); }
  finally { state.polling = false; }
}

$('pickFiles').addEventListener('click', pickFiles);
poll();
setInterval(poll, 900);
