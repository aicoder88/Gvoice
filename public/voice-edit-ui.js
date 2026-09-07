const el = id => document.getElementById(id);
function render(state) {
  if (!state) return;
  el('original').value = state.original;
  el('replacement').value = state.replacement;
  el('instruction').value = state.instruction;
  el('status').textContent = state.status;
  const editable = ['ready', 'preview', 'error'].includes(state.phase) && !!state.original;
  el('instruction').disabled = !editable;
  el('generate').disabled = !editable;
  el('speak').disabled = !editable && state.phase !== 'listening';
  el('speak').textContent = state.phase === 'listening' ? 'Stop recording' : 'Speak instruction';
  el('apply').disabled = state.phase !== 'preview';
  el('undo').disabled = state.phase !== 'applied';
  el('cancel').disabled = ['empty','applying','undoing','applied','undone'].includes(state.phase);
}
for (const action of ['speak','generate','cancel','apply','undo']) {
  el(action).addEventListener('click', async () => render(await window.voiceEdit.action(action, action === 'generate' ? el('instruction').value : undefined)));
}
window.voiceEdit.onState(render);
window.voiceEdit.get().then(render);
