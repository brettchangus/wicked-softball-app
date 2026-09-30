import test from 'node:test';
import assert from 'node:assert/strict';
import { structureChanges } from '../netlify/functions/admin.js';

const poolGame=(key,no,extra={})=>({key,gameNo:no,time:'2026-08-01T09:00:00',field:'A',hid:'h',aid:'a',hn:'Home',an:'Away',...extra});
const frameGame=(no,extra={})=>({gameNo:no,time:'2026-08-02T09:00:00',field:'A',...extra});
const structure=({pools={},brackets=[]}={})=>({pools,brackets});

test('unchanged structure has an empty diff',()=>{
  const s=structure({pools:{A:{games:[poolGame('p1',1)]}}});
  assert.deepEqual(structureChanges(s,structuredClone(s)),{added:[],removed:[],changed:[],renumbered:false});
});
test('time, field, and opponent edits are reported as changes',()=>{
  const old=structure({pools:{A:{games:[poolGame('p1',1)]}}});
  for(const patch of [{time:'2026-08-01T10:00:00'},{field:'B'},{aid:'new',an:'New Opponent'}]){
    const next=structure({pools:{A:{games:[poolGame('p1',1,patch)]}}});
    assert.deepEqual(structureChanges(old,next).changed,['p1']);
  }
});
test('added and removed games are exact',()=>{
  const old=structure({pools:{A:{games:[poolGame('p1',1),poolGame('p2',2)]}}});
  const next=structure({pools:{A:{games:[poolGame('p2',2),poolGame('p3',3)]}}});
  const d=structureChanges(old,next); assert.deepEqual(d.added,['p3']); assert.deepEqual(d.removed,['p1']); assert.equal(d.renumbered,true);
});
test('new bracket assignments are reported as changes',()=>{
  const old=structure({brackets:[{level:'gold',frame:[frameGame(1)]}]});
  const next=structure({brackets:[{level:'gold',frame:[frameGame(1,{topId:'t1',topName:'Team One'})]}]});
  assert.deepEqual(structureChanges(old,next).changed,['bracket:gold:1']);
});
test('same keyless game number in different bracket levels remains distinct',()=>{
  const old=structure({brackets:[{level:'gold',frame:[frameGame(1)]},{level:'silver',frame:[frameGame(1)]}]});
  const next=structure({brackets:[{level:'gold',frame:[frameGame(1)]},{level:'silver',frame:[]}]});
  assert.deepEqual(structureChanges(old,next).removed,['bracket:silver:1']);
});
test('same keyless game number in different pools remains distinct',()=>{
  const old=structure({pools:{A:{games:[{gameNo:1}]},B:{games:[{gameNo:1}]}}});
  const next=structure({pools:{A:{games:[{gameNo:1}]},B:{games:[]}}});
  assert.deepEqual(structureChanges(old,next).removed,['pool:B:1']);
});
test('native provider keys win over fallback identities',()=>{
  const old=structure({brackets:[{level:'gold',frame:[frameGame(1,{key:'tm:event:B1'})]}]});
  const next=structure({brackets:[{level:'renamed',frame:[frameGame(1,{key:'tm:event:B1',field:'B'})]}]});
  const d=structureChanges(old,next); assert.deepEqual(d.changed,['tm:event:B1']); assert.deepEqual(d.added,[]); assert.deepEqual(d.removed,[]);
});
