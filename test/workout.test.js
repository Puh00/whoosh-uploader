import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile, toZwo, toMyWhoosh } from '../src/workout.js';
const example=JSON.parse(readFileSync(new URL('../examples/tempo-steps.json',import.meta.url)));
const basic=steps=>({version:1,name:'Test',ftp_watts:200,steps});
test('coach session preserves all durations and ranges',()=>{
  const w=compile(example);
  assert.equal(w.seconds,2760); assert.equal(w.steps.length,19);
  assert.deepEqual(w.steps.map(s=>s.watts),[165,170,175,180,185,127.5,165,170,175,180,185,127.5,165,170,175,180,185,125,110]);
  const n=toMyWhoosh(w); assert.equal(n.Time,2760); assert.equal(n.StepCount,19);
  n.WorkoutStepsArray.forEach((s,i)=>assert.ok(Math.abs(s.Power*210-w.steps[i].watts)<0.00001));
  assert.equal(n.KJ,431.4);
});
test('range policies do not create a ramp',()=>{
  for(const [range_policy,expected] of [['lower',100],['midpoint',110],['upper',120]]) {
    const w=compile({...basic([{seconds:60,watts:[100,120]}]),range_policy});
    assert.equal(w.steps[0].watts,expected);assert.equal(w.steps[0].kind,'steady');
  }
});
test('ramps, zero power, free ride, cadence, and XML escaping',()=>{
  const w=compile(basic([{seconds:60,ramp_watts:[0,200],cadence:80,text:'A < B & "C"'},{seconds:30,watts:0},{seconds:60,ramp_watts:[200,0]},{seconds:60,free_ride:true}]));
  const z=toZwo(w), n=toMyWhoosh(w);
  assert.match(z,/PowerLow="0" PowerHigh="1"/);assert.match(z,/A &lt; B &amp; &quot;C&quot;/);
  assert.match(z,/<Cooldown/);assert.match(z,/<FreeRide/);
  assert.deepEqual(n.WorkoutStepsArray.map(s=>s.StepType),['E_WarmUp','E_Normal','E_CoolDown','E_FreeRide']);
  assert.equal(n.WorkoutStepsArray[0].Rpm,80);assert.ok(Number.isFinite(n.TSS));
});
test('rejects ambiguous and mistyped coach instructions',()=>{
  for(const step of [{seconds:0,watts:150},{seconds:1.5,watts:150},{seconds:60,watts:'150'},{seconds:60,watts:[200,100]},{seconds:60,watts:[100]},{seconds:60,watts:100,ramp_watts:[100,200]},{seconds:60,watts:NaN},{seconds:60,free_ride:false},{seconds:60,watts:100,cadence:0},{seconds:60,watts:100,typo:1},{repeat:0,steps:[{seconds:60,watts:100}]}]) assert.throws(()=>compile(basic([step])));
  assert.throws(()=>compile({...basic([{seconds:60,watts:150}]),ftp_watts:0}));
  assert.throws(()=>compile({...basic([{seconds:60,watts:150}]),unexpected:true}));
});
test('bounded repeat expansion and total duration',()=>{
  assert.throws(()=>compile(basic([{repeat:31,steps:[{seconds:60,watts:100}]}])),/30 expanded/);
  assert.throws(()=>compile(basic([{repeat:2,steps:[{seconds:86400,watts:100}]}])),/24 hours/);
});
test('identity is stable across JSON formatting but changes with workout content',()=>{
  const a=compile(example), b=compile(JSON.parse(JSON.stringify(example)));
  assert.equal(a.hash,b.hash);assert.equal(a.id,b.id);
  assert.notEqual(a.hash,compile({...example,name:'Tomorrow'}).hash);
});
