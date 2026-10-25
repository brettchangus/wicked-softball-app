import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
const renderer = source.slice(source.indexOf('function renderScoutingAdmin(){'), source.indexOf('async function runScoutingBatch'));
const batch = source.slice(source.indexOf('async function runScoutingBatch'), source.indexOf("$('#scoutGenerate').onclick"));
const opponents = [{ id:'one', name:'First team', role:'Confirmed opponent' },
  { id:'two', name:'Second team', role:'Possible bracket opponent' }];

test('scouting admin shows missing opponents and saved reports in one escaped list', () => {
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); };
  vm.runInNewContext(renderer + '\nrenderScoutingAdmin();', {
    $, STATE:{ activeEventKey:'event', scouting:{ opponents,
      reports:[{ id:'two', name:'Second team', generatedAt:'created', refreshedAt:'updated', stale:true },
        { id:'past', name:'<Past team>', generatedAt:'old' }], bracketsSet:false } },
    SCOUT_ADMIN_BUSY:false, scoutDate:value => value,
    esc:value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),
  });
  assert.equal($('#scoutAdminSummary').textContent, '2 saved · 1 to generate');
  assert.equal($('#scoutCollapsedSummary').textContent, '2 saved · 1 ready · 1 needs refresh · 1 missing');
  assert.equal($('#scoutGenerate').textContent, 'Generate missing (1)');
  assert.equal($('#scoutRefreshAll').textContent, 'Refresh upcoming (1)');
  const html = $('#scoutAdminReports').innerHTML;
  assert.match(html, /data-scout-action="generate" data-id="one"/);
  assert.match(html, /Needs refresh/);
  assert.match(html, /Updated updated/);
  assert.match(html, /Created created · Refreshed updated/);
  assert.match(html, /&lt;Past team&gt;/);
  assert.match(html, /Past opponent/);
});

test('generating a single missing scouting report targets only that opponent', async () => {
  let message;
  const sandbox = { STATE:{ scouting:{ opponents, reports:[] } }, SCOUT_ADMIN_BUSY:false,
    confirmAction:async (_title, text) => { message = text; return false; } };
  vm.runInNewContext(batch, sandbox);
  await sandbox.runScoutingBatch('generateScoutingReports', 'two');
  assert.match(message, /Second team/);
  assert.doesNotMatch(message, /First team/);
});

test('bulk refresh excludes reports for past-only opponents', async () => {
  let message;
  const sandbox = { STATE:{ scouting:{ opponents, reports:[{ id:'one' },{ id:'past', name:'Past team' }] } },
    SCOUT_ADMIN_BUSY:false, confirmAction:async (_title, text) => { message = text; return false; } };
  vm.runInNewContext(batch, sandbox);
  await sandbox.runScoutingBatch('refreshScoutingReports');
  assert.match(message, /First team/);
  assert.doesNotMatch(message, /Past team|Second team/);
});
