import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('opponents can only be edited when they have a directory identity, even without a GameChanger link', () => {
  const source = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
  const renderer = source.slice(source.indexOf('function renderOpponents() {'),
    source.indexOf("$('#oppTeams').addEventListener('click', event =>"));
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); };
  vm.runInNewContext(renderer + '\nrenderOpponents();', {
    $, STATE:{ directoryMatches:{ matched:{ entryId:'directory-team' }, unmatched:{ entryId:null } } },
    SNAP:null, cfg:() => ({}), gcLinks:() => ({ unmatched:'https://web.gc.com/teams/legacy' }),
    opponents:() => [{ teamId:'matched', name:'Directory team' }, { teamId:'unmatched', name:'Tournament team' }],
    gcReview:() => null, window:{}, esc:String,
  });
  assert.equal($('#opponentsCollapsedSummary').textContent, '2 opponents');
  const html = $('#oppTeams').innerHTML;
  const matched = /<tr data-team-id="matched">([\s\S]*?)<\/tr>/.exec(html)[1];
  const unmatched = /<tr data-team-id="unmatched">([\s\S]*?)<\/tr>/.exec(html)[1];
  assert.match(matched, />Change match<\/button>/);
  assert.match(matched, /class="ghost oppEdit"/);
  assert.match(unmatched, />Match<\/button>/);
  assert.doesNotMatch(unmatched, /oppEdit|>Change match<\/button>/);
});

test('a disappearing opponent cannot open a directory editor with stale opponent state', () => {
  const source = fs.readFileSync(new URL('../assets/team-directory-admin.js', import.meta.url), 'utf8');
  const editor = source.slice(source.indexOf('  function edit(id, opponentId = null) {'),
    source.indexOf('  window.openLinkedDirectoryTeam'));
  const messages = [];
  const sandbox = { opponents:() => [], toast:message => messages.push(message), entries:[],
    editingOpponentId:null, $:() => { throw new Error('The modal should not be changed.'); } };
  vm.runInNewContext(editor + '\nedit("directory-team", "missing");', sandbox);
  assert.equal(sandbox.editingOpponentId, null);
  assert.match(messages[0], /opponent.*no longer available.*Reload/);
});

test('Save rejects missing opponent controls before disabling buttons or calling the API', async () => {
  const source = fs.readFileSync(new URL('../assets/team-directory-admin.js', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf("  $('#directoryEditSave').onclick = async () => {"),
    source.indexOf("  $('#directoryDelete').onclick = async () => {"));
  const save = { disabled:false }, remove = { disabled:false }, messages = [];
  const elements = { '#directoryEditSave':save, '#directoryDelete':remove, '#directoryOpponentLevel':null };
  vm.runInNewContext(handler, { $:id => elements[id], values:() => ({ name:'Valid team' }),
    editingId:'directory-team', editingOpponentId:'missing', opponents:() => [],
    toast:message => messages.push(message), api:() => { throw new Error('Unexpected API call'); } });
  await save.onclick();
  assert.equal(save.disabled, false);
  assert.equal(remove.disabled, false);
  assert.match(messages[0], /Reload/);
});

test('confirm dialogs cover an open editor, trap focus, cancel on Escape and restore focus', async () => {
  const source = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function confirmAction('), source.indexOf('// ---------- unlock ----------'));
  const document = { activeElement:null };
  const element = (id, extra = {}) => {
    const classes = new Set(extra.classes || []), listeners = new Map();
    return { id, inert:false, textContent:'', isConnected:true, focus() { document.activeElement = this; },
      classList:{ add:name => classes.add(name), remove:name => classes.delete(name), contains:name => classes.has(name) },
      addEventListener:(type, fn) => listeners.set(type, fn), removeEventListener:type => listeners.delete(type),
      dispatch:(type, event) => listeners.get(type)?.(event), listeners };
  };
  const bg = element('modalBg', { classes:['modal-bg'] }), editor = element('editor', { classes:['modal-bg', 'show'] });
  const elements = { '#modalBg':bg, '#modalOk':element('modalOk'), '#modalCancel':element('modalCancel'),
    '#modalTitle':element('modalTitle'), '#modalMsg':element('modalMsg') };
  const opener = element('opener'); opener.focus();
  document.querySelectorAll = () => [editor, ...(bg.classList.contains('show') ? [bg] : [])];
  const sandbox = { $:id => elements[id], document };
  vm.runInNewContext(code, sandbox);
  const key = (key, shiftKey = false) => { let prevented = false;
    bg.dispatch('keydown', { key, shiftKey, preventDefault:() => { prevented = true; } }); return prevented; };
  const pending = sandbox.confirmAction('Delete', 'Sure?', 'Delete', true);
  assert.equal(editor.inert, true);
  assert.equal(document.activeElement.id, 'modalCancel');
  assert.equal(key('Tab', true), true); assert.equal(document.activeElement.id, 'modalOk');
  assert.equal(key('Tab'), true); assert.equal(document.activeElement.id, 'modalCancel');
  key('Escape');
  assert.equal(await pending, false);
  assert.equal(bg.classList.contains('show'), false);
  assert.equal(editor.inert, false);
  assert.equal(bg.listeners.size, 0);
  assert.equal(document.activeElement, opener);
});
