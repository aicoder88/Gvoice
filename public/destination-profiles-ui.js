(() => {
  const el = id => document.getElementById(id);
  let view, mappings = [], detected = null;
  const status = text => { el('outputStatus').textContent = text; };
  function describe() {
    el('outputDescription').textContent = view?.profiles.find(p => p.id === el('outputDefault').value)?.description || '';
  }
  function renderMappings() {
    const list = el('outputMappings'); list.replaceChildren();
    if (!mappings.length) list.textContent = 'No app rules. The default profile applies.';
    for (const rule of mappings) {
      const row = document.createElement('p'), label = document.createElement('span'), remove = document.createElement('button');
      label.textContent = `${rule.name}: ${view.profiles.find(p => p.id === rule.profile)?.label || rule.profile} `;
      remove.className = 'btn'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove profile for ${rule.name}`);
      remove.onclick = () => { mappings = mappings.filter(r => r.id !== rule.id); renderMappings(); status('Rule removed. Save profiles to keep this change.'); };
      row.append(label, remove); list.append(row);
    }
  }
  function render(next) {
    if (!next || next.error) throw new Error(next?.error || 'Profiles unavailable.');
    view = next; mappings = next.mappings.map(r => ({ ...r })); detected = next.lastDestination;
    for (const id of ['outputDefault', 'outputAppProfile']) {
      el(id).replaceChildren(...next.profiles.map(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; return o; }));
    }
    el('outputMode').value = next.mode; el('outputDefault').value = next.selectedProfile;
    el('detectOutputApp').disabled = !next.automaticSupported;
    el('outputCleanupNote').textContent = next.cleanupEnabled ? 'Formatting uses your configured AI cleanup provider and its existing timeout. If cleanup fails, the original transcript is kept.' : 'AI cleanup is off. Profiles are saved, but formatting starts only after you enable AI cleanup.';
    showDestination(); renderMappings(); describe();
  }
  function showDestination() {
    el('outputDestination').textContent = detected ? `Detected app: ${detected.name}` : 'No app detected. Automatic app detection currently requires macOS; manual profiles work everywhere.';
    el('addOutputApp').disabled = !detected;
  }
  window.loadOutputProfiles = async () => { try { render(await window.settingsBridge.profiles()); } catch (error) { status(error.message); } };
  el('outputDefault').onchange = describe;
  el('detectOutputApp').onclick = async () => {
    el('detectOutputApp').disabled = true; status('Switch to your destination app now. Detecting in 5 seconds…');
    try { const next = await window.settingsBridge.detectDestination(); detected = next?.lastDestination || null; showDestination(); status(detected ? 'App detected. Choose its profile and add a rule.' : 'Could not identify the app. Try again with an editable field focused.'); }
    catch (error) { status(error.message); }
    finally { el('detectOutputApp').disabled = !view?.automaticSupported; }
  };
  el('addOutputApp').onclick = () => {
    if (!detected) return;
    mappings = mappings.filter(r => r.id !== detected.id);
    mappings.push({ ...detected, profile: el('outputAppProfile').value }); renderMappings();
    el('outputMode').value = 'per-app'; status('Rule added. Save profiles to apply it.');
  };
  el('saveOutputProfiles').onclick = async () => {
    try { render(await window.settingsBridge.saveProfiles({ mode: el('outputMode').value, selectedProfile: el('outputDefault').value, mappings })); status('Saved. Applies to the next dictation; an active dictation keeps its starting profile.'); }
    catch (error) { status(error.message); }
  };
})();
