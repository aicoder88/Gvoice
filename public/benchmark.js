'use strict';
let state;
const byId = id => document.getElementById(id);
function node(tag, text, className) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; }
function button(text, handler, className) { const item = node('button', text, className); item.addEventListener('click', handler); return item; }
async function action(name, value) {
  byId('status').textContent = name === 'runLocal' ? 'Running your approved WAV clips locally. This includes model loading and may take a few minutes. Close the window to cancel.' : 'Working…';
  document.querySelectorAll('button').forEach(button => { button.disabled = true; });
  if (name === 'runLocal') { byId('cancel').hidden = false; byId('cancel').disabled = false; }
  try { state = await window.benchmark.action(name, value); render(); byId('status').textContent = 'Saved locally.'; }
  catch (error) { byId('status').textContent = error.message; }
  finally { byId('cancel').hidden = true; document.querySelectorAll('.toolbar > button').forEach(button => { button.disabled = false; }); if (state) render(); }
}
function field(container, caption, tag, value) {
  const label = node('label', caption), control = node(tag); control.value = value; control.maxLength = 2000; label.append(control); container.append(label); return control;
}
function render() {
  const corpus = byId('corpus'); corpus.replaceChildren();
  if (!state.clips.length) corpus.append(node('p', 'Your corpus is empty. Add a recording you explicitly choose, then write and approve its reference.', 'empty'));
  for (const clip of state.clips) {
    const panel = node('section', undefined, 'panel');
    panel.append(node('h3', clip.name), node('p', `Clip ID: ${clip.id} · referenceRevision: ${clip.revision}`, 'id'), node('p', clip.approvedAt ? 'Human-approved reference' : 'Draft reference - excluded from scoring', clip.approvedAt ? 'badge' : 'warning'));
    const audio = node('audio'); audio.controls = true; audio.preload = 'none';
    panel.append(button('Load audio for listening', async () => { try { audio.src = await window.benchmark.audio(clip.id); } catch (error) { byId('status').textContent = error.message; } }), audio);
    const reference = field(panel, 'Human reference (what the transcript should say)', 'textarea', clip.reference);
    const translation = field(panel, 'English translation (optional, not scored)', 'textarea', clip.translation);
    const terms = field(panel, 'Protected names or phrases (comma-separated)', 'input', clip.protectedTerms.join(', ')); terms.type = 'text';
    const tags = node('div', undefined, 'tags'); const checks = [];
    for (const tag of state.tags) { const label = node('label', tag), check = node('input'); check.type = 'checkbox'; check.checked = clip.tags.includes(tag); check.value = tag; checks.push(check); label.prepend(check); tags.append(label); }
    panel.append(tags);
    const controls = node('div', undefined, 'toolbar');
    const save = button('Save reference', () => action('update', { id: clip.id, patch: { reference: reference.value, translation: translation.value, protectedTerms: terms.value.split(',').map(t => t.trim()).filter(Boolean), tags: checks.filter(c => c.checked).map(c => c.value) } }));
    const approve = button('I reviewed this reference - approve for scoring', () => action('approve', { id: clip.id, revision: clip.revision, humanConfirmed: true }), 'primary'); approve.disabled = !!clip.approvedAt;
    for (const input of [reference, translation, terms, ...checks]) input.addEventListener('input', () => { approve.disabled = true; byId('status').textContent = 'Save your changes before approving. Saving invalidates earlier approval and results for this clip.'; });
    controls.append(save, approve, button('Remove local copy', () => { if (confirm('Remove this benchmark copy, reference and its results? The original file is kept.')) action('remove', { id: clip.id }); }, 'danger')); panel.append(controls); corpus.append(panel);
  }
  const comparison = byId('comparison'); comparison.replaceChildren();
  if (!state.comparison.groups.length) comparison.append(node('p', 'No scored results. Approve a reference, run an engine, then import results.', 'empty'));
  else {
    const table = node('table'), head = node('tr');
    for (const name of ['Engine / cleanup / run', 'Coverage', 'Mean time', 'WER', 'CER', 'Risk flags', 'Human review']) head.append(node('th', name));
    table.append(head);
    for (const group of state.comparison.groups) {
      const row = node('tr');
      const coverage = `${group.uniqueClips} clips / ${group.count} results`;
      for (const value of [`${group.engine} / ${group.cleanupModel} / ${group.runLabel}`, coverage, `${Math.round(group.meanMs)} ms`, `${(group.wer * 100).toFixed(1)}%`, `${(group.cer * 100).toFixed(1)}%`, `${group.flagged}/${group.count}`, `${group.reviewed}/${group.count} reviewed; ${group.meaningChanged} changed`]) row.append(node('td', value));
      row.children[1].title = group.clipIds.join('\n'); table.append(row);
    }
    comparison.append(node('p', state.comparison.comparisonNote, state.comparison.equalClipCoverage ? 'muted' : 'warning'), table);
  }
  const reviews = byId('reviews'); reviews.replaceChildren();
  for (const result of state.comparison.details) {
    const panel = node('details', undefined, 'panel'); panel.append(node('summary', `${result.engine} / ${result.cleanupModel} / ${result.runLabel} · ${result.humanReview}`));
    panel.append(node('p', `Clip: ${result.clipId}`, 'id'), node('strong', 'Reference'), node('pre', result.reference));
    if (result.translation) panel.append(node('strong', 'English translation'), node('pre', result.translation));
    panel.append(node('strong', 'Output'), node('pre', result.output || '(empty output)'), node('p', result.flags.length ? result.flags.join('; ') : 'No heuristic flags. Human review is still required.', result.flags.length ? 'warning' : 'muted'));
    const select = field(panel, 'Your meaning assessment', 'select', '');
    for (const [value, label] of [['pending', 'Pending review'], ['preserved', 'Meaning preserved'], ['changed', 'Meaning changed']]) { const option = node('option', label); option.value = value; select.append(option); } select.value = result.humanReview;
    const note = field(panel, 'Review notes', 'textarea', result.reviewNote || ''); panel.append(button('Save human review', () => action('review', { id: result.id, verdict: select.value, note: note.value }))); reviews.append(panel);
  }
}
byId('cancel').onclick = () => { window.benchmark.cancel().catch(error => { byId('status').textContent = error.message; }); byId('status').textContent = 'Cancelling local run…'; }; byId('local').onclick = () => action('runLocal'); byId('import').onclick = () => action('importAudio'); byId('results').onclick = () => action('importResults'); byId('export').onclick = () => action('exportManifest');
window.benchmark.get().then(value => { state = value; render(); }).catch(error => { byId('status').textContent = error.message; });
