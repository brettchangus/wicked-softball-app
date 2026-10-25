// Shared directory and tournament association editor. Uses admin.html's existing controls/colors.
(() => {
  let entries = [], matchTeam = null, editingId = null, mode = 'existing', requestSeq = 0, editingOpponentId = null;
  const panel = document.getElementById('directoryCard');
  const labels = { confirmed:'Confirmed by you', tournament:'Saved tournament link', provider:'Matched by provider identity',
    alias:'Matched by known name', ambiguous:'Multiple directory matches', unmatched:'Unmatched' };
  const currentPeriod = () => STATE?.directoryPeriod || `${new Date().getFullYear()}-fall`;
  const activeContext = () => contextQuery();

  function matchLabel(id) {
    const match = STATE?.directoryMatches?.[id];
    return match ? `<div class="opp-meta">${esc(labels[match.basis] || '')}${match.name ? ` · ${esc(match.name)}` : ''}</div>` : '';
  }
  window.directoryMatchLabel = matchLabel;

  const periodLabel = period => {
    const match = /^(\d{4})-(spring|summer|fall)$/.exec(period);
    return match ? `${match[2][0].toUpperCase()}${match[2].slice(1)} ${match[1]}` : period;
  };
  function profilePeriods(entry, selected) {
    const year = Number(selected.slice(0, 4)) || new Date().getFullYear();
    const periods = new Set([selected, ...Object.keys(entry.profiles || {}),
      ...entries.flatMap(row => Object.keys(row.profiles || {}))]);
    for (const y of [year - 1, year, year + 1])
      for (const season of ['spring', 'summer', 'fall']) periods.add(`${y}-${season}`);
    const order = { spring:0, summer:1, fall:2 };
    return [...periods].sort((a, b) => Number(b.slice(0, 4)) - Number(a.slice(0, 4))
      || order[b.slice(5)] - order[a.slice(5)]);
  }
  function render() {
    const search = $('#directoryFilter').value.trim().toLowerCase();
    const rows = entries.filter(row => [row.name, row.coach, row.city, ...(row.aliases || [])].join(' ').toLowerCase().includes(search));
    $('#directoryCollapsedSummary').textContent = `${entries.length} team${entries.length === 1 ? '' : 's'}`;
    $('#directoryCount').textContent = `${entries.length} teams · shared across all tournaments and dashboard teams`;
    $('#directoryTeams').innerHTML = rows.length ? `<table class="opp-table"><thead><tr><th>Team</th><th>Aliases</th><th>GameChanger</th><th></th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${esc(row.name)}</strong><div class="opp-meta">${esc([row.age && `${row.age}U`, row.coach, row.city, row.state].filter(Boolean).join(' · '))}</div></td><td>${(row.aliases || []).map(esc).join('<br>')}</td><td>${Object.entries(row.profiles || {}).map(([period, url]) => url ? `<a class="opp-linked" href="${esc(url)}" target="_blank" rel="noopener">${esc(periodLabel(period))} ↗</a>` : `${esc(periodLabel(period))}: no link`).join('<br>')}</td><td><button class="ghost" data-directory-edit="${esc(row.id)}">Edit</button></td></tr>`).join('')}</tbody></table>` : '<p class="note">No directory teams found.</p>';
  }
  async function load() {
    const seq = ++requestSeq, context = activeContext();
    const result = await api('getTeamDirectory');
    if (seq !== requestSeq || context !== activeContext()) return;
    entries = result.entries || []; render();
  }
  window.loadTeamDirectory = load;
  window.closeDirectoryEditors = () => { closeMatchEditor(); closeTeamEditor(); };

  let formSerial = 0;
  function labelFields(container) {
    const prefix = 'directory-form-' + (++formSerial);
    container.querySelectorAll('label').forEach((label, i) => {
      const control = label.nextElementSibling;
      if (control?.matches('input, select, textarea')) { if (!control.id) control.id = `${prefix}-${i}`; label.htmlFor = control.id; }
    });
  }
  function fields(entry = {}, period = currentPeriod()) {
    return `<div class="row"><div class="grow"><label>Directory team name</label><input data-dir-field="name" value="${esc(entry.name || '')}" required maxlength="160"></div><div class="grow"><label>Coach</label><input data-dir-field="coach" value="${esc(entry.coach || '')}" maxlength="160"></div></div>
      <div class="row"><div class="grow"><label>Age</label><input data-dir-field="age" value="${esc(entry.age || '')}" inputmode="numeric" placeholder="10U"></div><div class="grow"><label>City</label><input data-dir-field="city" value="${esc(entry.city || '')}" maxlength="160"></div><div class="grow"><label>State</label><input data-dir-field="state" value="${esc(entry.state || '')}" maxlength="160"></div></div>
      <label>Aliases · one per line</label><textarea data-dir-field="aliases">${esc((entry.aliases || []).join('\n'))}</textarea>
      <label>Season</label><select data-dir-field="period">${profilePeriods(entry, period).map(value => `<option value="${esc(value)}" ${value === period ? 'selected' : ''}>${esc(periodLabel(value))}</option>`).join('')}</select>
      <label>GameChanger team URL</label><input data-dir-field="url" type="url" value="${esc(entry.profiles?.[period] || '')}" placeholder="https://web.gc.com/teams/…"><p class="note">Saving updates only the selected season’s GameChanger link.</p>`;
  }
  function values(container) {
    const get = key => container.querySelector(`[data-dir-field="${key}"]`).value.trim();
    return { name:get('name'), coach:get('coach'), age:get('age'), city:get('city'), state:get('state'),
      aliases:get('aliases').split('\n').map(value => value.trim()).filter(Boolean),
      period:get('period'), url:get('url') };
  }
  function setMode(next) {
    mode = next;
    const container = $('#directoryMatchFields');
    document.querySelectorAll('[data-directory-mode]').forEach(button => {
      const selected = button.dataset.directoryMode === mode;
      button.className = selected ? '' : 'ghost'; button.setAttribute('aria-pressed', String(selected));
    });
    if (mode === 'create') {
      container.innerHTML = fields({ name:matchTeam.providerName || matchTeam.name,
        coach:matchTeam.coach, city:matchTeam.city, state:matchTeam.state,
        age:STATE?.team?.agePrefix, aliases:[matchTeam.providerName || matchTeam.name] });
      // A tournament match always uses the tournament's season, not an arbitrary selected year.
      container.querySelector('[data-dir-field="period"]').disabled = true;
      $('#directoryMatchHelp').textContent = 'Creates a separate directory entry. The previously matched team and its profile stay unchanged.';
    } else if (mode === 'existing') {
      const recommended = STATE?.directoryMatches?.[matchTeam.teamId]?.candidates || [];
      container.innerHTML = `<label for="directoryMatchSelect">Directory team</label><select id="directoryMatchSelect"><option value="">Choose a team…</option>${[...entries].sort((a, b) => Number(recommended.includes(b.id)) - Number(recommended.includes(a.id))).map(entry => `<option value="${esc(entry.id)}">${esc(entry.name)}${entry.coach ? ` · ${esc(entry.coach)}` : ''}${entry.age ? ` · ${entry.age}U` : ''}${entry.profiles?.[currentPeriod()] ? '' : ' · no profile this season'}</option>`).join('')}</select><p class="note" id="directorySelectedProfile"></p>`;
      $('#directoryMatchSelect').onchange = () => {
        const entry = entries.find(row => row.id === $('#directoryMatchSelect').value);
        $('#directorySelectedProfile').textContent = entry?.profiles?.[currentPeriod()] || 'No profile saved for this tournament’s season. You can add one in Team directory.';
      };
      $('#directoryMatchHelp').textContent = 'The tournament name will be remembered as an alias. If a name identifies multiple teams, future matches will require review.';
    } else {
      container.innerHTML = '';
      $('#directoryMatchHelp').textContent = 'Removes the association and inherited link. Automatic matching stays off for this tournament entry until you choose a team.';
    }
    labelFields(container);
    $('#directoryMatchSave').textContent = mode === 'create' ? 'Create team & match' : mode === 'unmatched' ? 'Leave unmatched' : 'Save match';
  }
  let matchTrigger = null;
  function closeMatchEditor() {
    if (!$('#directoryMatchPanel').classList.contains('show')) return;
    $('#directoryMatchPanel').classList.remove('show');
    $('#app').inert = false;
    matchTeam = null;
    if (matchTrigger?.isConnected) matchTrigger.focus();
    matchTrigger = null;
  }
  window.openDirectoryMatch = async id => {
    matchTrigger = document.activeElement;
    const context = activeContext();
    try {
      await load();
      if (context !== activeContext()) return;
      matchTeam = opponents().find(row => row.teamId === id);
      if (!matchTeam) return;
      $('#directoryMatchTitle').textContent = `Match: ${matchTeam.providerName || matchTeam.name}`;
      $('#directoryMatchContext').textContent = `${STATE?.meta?.name || ''} · ${periodLabel(currentPeriod())}`;
      setMode('existing');
      $('#directoryMatchPanel').classList.add('show');
      $('#app').inert = true;
      $('#directoryMatchPanel').querySelector('button').focus();
    } catch (error) { toast(error.message, 'err'); }
  };
  document.querySelectorAll('[data-directory-mode]').forEach(button => button.onclick = () => setMode(button.dataset.directoryMode));
  $('#directoryMatchCancel').onclick = closeMatchEditor;
  $('#directoryMatchSave').onclick = async () => {
    if (!matchTeam) return;
    const button = $('#directoryMatchSave'), payload = { teamId:matchTeam.teamId, mode };
    if (mode === 'create') payload.entry = values($('#directoryMatchFields'));
    if (mode === 'existing') payload.entryId = $('#directoryMatchSelect').value;
    if (mode === 'existing' && !payload.entryId) return toast('Choose a directory team.', 'err');
    if (mode === 'create' && !payload.entry.name) return toast('Enter a directory team name.', 'err');
    button.disabled = true;
    try { await api('matchDirectoryTeam', payload); await loadAll(); toast('Tournament match saved'); }
    catch (error) { toast(error.message, 'err'); }
    finally { button.disabled = false; }
  };
  let editorTrigger = null;
  function closeTeamEditor() {
    if (!$('#directoryEditPanel').classList.contains('show')) return;
    $('#directoryEditPanel').classList.remove('show');
    $('#app').inert = false;
    if (editorTrigger?.isConnected) editorTrigger.focus();
    editorTrigger = null;
  }
  function wireModal(id, saveId, close) {
    const modal = $('#' + id);
    modal.addEventListener('click', event => {
      if (event.target === modal && !$('#' + saveId).disabled) close();
    });
    modal.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !$('#' + saveId).disabled) { event.preventDefault(); close(); }
      if (event.key !== 'Tab') return;
      const controls = [...modal.querySelectorAll('input, select, textarea, button')].filter(control => !control.disabled);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
  }
  wireModal('directoryMatchPanel', 'directoryMatchSave', closeMatchEditor);
  wireModal('directoryEditPanel', 'directoryEditSave', closeTeamEditor);
  function edit(id, opponentId = null) {
    const opponent = opponentId === null ? null : opponents().find(row => row.teamId === opponentId);
    if (opponentId !== null && !opponent) return toast('The opponent is no longer available. Reload and try again.', 'err');
    const entry = entries.find(row => row.id === id);
    if (id !== null && !entry) return toast('The directory team is no longer available. Reload and try again.', 'err');
    editingOpponentId = opponent?.teamId || null;
    editorTrigger = document.activeElement;
    editingId = id;
    $('#directoryEditTitle').textContent = entry ? 'Team Settings' : 'Add directory team';
    $('#directoryDelete').hidden = !entry;
    $('#directoryEditFields').innerHTML = fields(entry);
    labelFields($('#directoryEditFields'));
    $('#directoryOpponentFields').hidden = !opponent;
    $('#directoryOpponentFields').innerHTML = opponent ? '<label for="directoryOpponentLevel">Class (this tournament)</label><select id="directoryOpponentLevel"><option value="">' + esc(opponent.defaults.level ? 'Calculated · ' + opponent.defaults.level : 'None (not calculated)') + '</option>' + (STATE.opponentLevels || []).map(level => '<option value="' + esc(level) + '">' + esc(level) + '</option>').join('') + '</select>' : '';
    if (opponent) $('#directoryOpponentLevel').value = opponent.override.level || '';
    $('#directoryEditPanel').classList.add('show');
    $('#app').inert = true;
    $('#directoryEditFields').querySelector('input').focus();
    const updateUrl = () => {
      const container = $('#directoryEditFields');
      const period = container.querySelector('[data-dir-field="period"]').value;
      container.querySelector('[data-dir-field="url"]').value = entry?.profiles?.[period] || '';
    };
    $('#directoryEditFields').querySelector('[data-dir-field="period"]').onchange = updateUrl;
    return true;
  }
  window.openLinkedDirectoryTeam = async teamId => {
    const requestedContext = activeContext(), trigger = document.activeElement;
    try {
      await load();
      if (requestedContext !== activeContext()) return;
      const entryId = STATE?.directoryMatches?.[teamId]?.entryId;
      if (!entryId || !entries.some(row => row.id === entryId)) return toast('The directory match changed. Reload and try again.', 'err');
      if (edit(entryId, teamId)) editorTrigger = trigger;
    } catch (error) { toast(error.message, 'err'); }
  };
  $('#directoryTeams').onclick = event => { const button = event.target.closest('[data-directory-edit]'); if (button) edit(button.dataset.directoryEdit); };
  $('#directoryAdd').onclick = () => edit(null);
  $('#directoryEditCancel').onclick = closeTeamEditor;
  $('#directoryEditSave').onclick = async () => {
    const entry = values($('#directoryEditFields'));
    if (!entry.name) return toast('Enter a directory team name.', 'err');
    const payload = { entryId:editingId, entry };
    if (editingOpponentId !== null) {
      // edit() only renders the class control for an opponent it found; the server rechecks the match.
      const level = $('#directoryOpponentLevel');
      if (!level) return toast('The opponent is no longer available. Reload and try again.', 'err');
      payload.teamId = editingOpponentId; payload.level = level.value;
    }
    const button = $('#directoryEditSave'); button.disabled = true; $('#directoryDelete').disabled = true;
    try { await api('saveDirectoryTeam', payload); await loadAll(); toast('Directory team saved'); }
    catch (error) { toast(error.message, 'err'); }
    finally { button.disabled = false; $('#directoryDelete').disabled = false; }
  };
  $('#directoryDelete').onclick = async () => {
    const entry = entries.find(row => row.id === editingId);
    if (!entry) return;
    // confirmAction covers the open editor and returns focus to Delete when cancelled.
    if (!await confirmAction('Delete directory team', `Delete ${entry.name} from the team directory?\n\nDirectory matches will be cleared. Tournament games and scores will be kept.`, 'Delete', true)) return;
    closeTeamEditor();
    const button = $('#directoryDelete'); button.disabled = true;
    try {
      const result = await api('deleteDirectoryTeam', { entryId:entry.id });
      entries = result.entries || []; render(); await loadAll(); toast('Directory team deleted');
    } catch (error) { toast(error.message, 'err'); }
    finally { button.disabled = false; }
  };
  $('#directoryFilter').oninput = render;
  if (STATE) { renderOpponents(); load().catch(error => toast(error.message, 'err')); }
  panel.addEventListener('toggle', () => { if (panel.open) load().catch(error => toast(error.message, 'err')); });
})();
