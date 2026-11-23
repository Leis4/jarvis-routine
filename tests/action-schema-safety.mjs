import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

// Exercise the actual backend schema normalizer without a paid AITunnel call.
const source = readFileSync(new URL('../backend/src/worker.js', import.meta.url), 'utf8');
const slice = source.slice(source.indexOf('function safeProposals('), source.indexOf('function textContent('));
assert.ok(slice.startsWith('function safeProposals'), 'schema extraction failed');
const context = vm.createContext({
  validDate:s=>/^\d{4}-\d\d-\d\d$/.test(s||''),
  validTime:s=>/^([01]\d|2[0-3]):[0-5]\d$/.test(s||''),
  cleanText:(s,max=1000)=>typeof s==='string'?s.trim().slice(0,max):'',
});
vm.runInContext(slice, context);
const proposals = items => context.safeProposals(items);

test('valid task operations survive normalized proposals', () => {
  const [a,b,c] = proposals([
    {action:'complete',date:'2026-11-15',taskId:'p0_0_0'},
    {action:'update',date:'2026-11-15',taskId:'p0_0_1',updates:{name:'Новое имя',shell:'rm -rf'}},
    {action:'create_habit',name:'Читать каждый день',mode:'daily'}
  ]);
  assert.equal(a.action,'complete');
  assert.equal(b.updates.name,'Новое имя');
  assert.equal(b.updates.shell,undefined);
  assert.equal(c.action,'create_habit');
});

test('invalid and arbitrary operations rejected', () => {
  const r=proposals([
    {action:'shell',cmd:'echo secret',date:'2026-11-15'},
    {action:'delete',date:'2026-11-15'},
    {action:'move',date:'2026-11-15',taskId:'x',start:'28:92'},
    {action:'add',date:'2026-11-15',start:'18:00',title:''},
  ]);
  assert.equal(r.length,0);
});
