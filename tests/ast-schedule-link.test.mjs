import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAstMeta} from '../netlify/functions/lib/ast.js';
test('AST retains regional schedule links that point directly to a division',()=>{
  const url='https://tourneymachine.com/Public/Results/Division.aspx?IDTournament=example&IDDivision=other-age';
  const meta=parseAstMeta('<title>Example Cup 10-10-2026 | AST</title><h3>Oct 10th – 11th</h3><a href="'+url+'">Example Region</a>');
  assert.deepEqual(meta.scheduleLinks,[{region:'Example Region',url}]);
});
