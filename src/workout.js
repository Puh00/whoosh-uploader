import { createHash } from 'node:crypto';

export class WhooshError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = message => { throw new WhooshError('INVALID_INPUT', message); };
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const number = (x, lo, hi) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
const keys = (o, allowed, at) => {
  if (!object(o)) fail(`${at} must be an object`);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${at}: unknown field ${k}`);
};
const string = (x, max, at) => {
  if (typeof x !== 'string' || x.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(x)) fail(`${at} must be text of at most ${max} characters`);
};
const round = x => Number(x.toFixed(8));
export function compile(input) {
  keys(input, ['version','name','description','author','ftp_watts','range_policy','steps'], 'workout');
  if (input.version !== 1) fail('version must be 1');
  string(input.name, 120, 'name');
  if (!input.name.trim()) fail('name cannot be empty');
  if (!number(input.ftp_watts, 1, 1000)) fail('ftp_watts must be between 1 and 1000');
  for (const key of ['description','author']) if (input[key] !== undefined) string(input[key], key === 'author' ? 120 : 2000, key);
  const policy = input.range_policy ?? 'midpoint';
  if (!['midpoint','lower','upper'].includes(policy)) fail('range_policy must be midpoint, lower or upper');
  const steps = [], warnings = [];
  function expand(items, depth = 0, at = 'steps') {
    if (depth > 5) fail('repeat nesting exceeds 5 levels');
    if (!Array.isArray(items) || !items.length || items.length > 1000) fail(`${at} must contain 1 to 1000 steps`);
    items.forEach((s, i) => {
      const path = `${at}[${i}]`;
      if (object(s) && 'repeat' in s) {
        keys(s, ['repeat','steps'], path);
        if (!Number.isInteger(s.repeat) || !number(s.repeat, 1, 100)) fail(`${path}.repeat must be an integer from 1 to 100`);
        for (let j = 0; j < s.repeat; j++) expand(s.steps, depth + 1, `${path}.steps`);
        return;
      }
      keys(s, ['seconds','watts','ramp_watts','free_ride','cadence','text'], path);
      if (!Number.isInteger(s.seconds) || !number(s.seconds, 1, 86400)) fail(`${path}.seconds must be a positive integer, at most 86400`);
      if (['watts','ramp_watts','free_ride'].filter(k => k in s).length !== 1) fail(`${path}: specify exactly one of watts, ramp_watts or free_ride`);
      if (s.cadence !== undefined && (!Number.isInteger(s.cadence) || !number(s.cadence, 1, 250))) fail(`${path}.cadence must be an integer from 1 to 250`);
      if (s.text !== undefined) string(s.text, 500, `${path}.text`);
      const out = { seconds: s.seconds, cadence: s.cadence ?? 0, text: s.text ?? '' };
      const watts = (v, p) => { if (!number(v, 0, 3000)) fail(`${p} must be watts between 0 and 3000`); return v; };
      if ('free_ride' in s) {
        if (s.free_ride !== true) fail(`${path}.free_ride must be true`);
        out.kind = 'free';
      } else if ('ramp_watts' in s) {
        if (!Array.isArray(s.ramp_watts) || s.ramp_watts.length !== 2) fail(`${path}.ramp_watts must be [start, end]`);
        out.kind = 'ramp';
        [out.start_watts, out.end_watts] = s.ramp_watts.map(v => watts(v, path));
      } else {
        out.kind = 'steady';
        if (Array.isArray(s.watts)) {
          if (s.watts.length !== 2 || s.watts[0] > s.watts[1]) fail(`${path}.watts range must be [lower, upper]`);
          const [low, high] = s.watts.map(v => watts(v, path));
          out.watts = policy === 'lower' ? low : policy === 'upper' ? high : (low + high) / 2;
          warnings.push(`${path}: ${low}-${high} W resolved to ${out.watts} W using ${policy}`);
        } else out.watts = watts(s.watts, `${path}.watts`);
      }
      steps.push(out);
      if (steps.length > 30) fail('More than 30 expanded steps. This CLI follows the current MyWhoosh editor limit; split the session.');
    });
  }
  expand(input.steps);
  const seconds = steps.reduce((n, s) => n + s.seconds, 0);
  if (seconds > 86400) fail('Workout exceeds 24 hours');
  const normalized = {version:1, name:input.name.trim(), description:input.description ?? '', author:input.author ?? 'whoosh-cli', ftp_watts:input.ftp_watts, steps};
  const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  const id = 1 + Number(BigInt(`0x${hash.slice(0,12)}`) % 9999999n);
  return {...normalized, seconds, hash, id, warnings:[...new Set(warnings)]};
}
const xml = s => String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
export function toZwo(w) {
  const lines = ['<workout_file>',`  <author>${xml(w.author)}</author>`,`  <name>${xml(w.name)}</name>`,`  <description>${xml(w.description)}</description>`, '  <sportType>bike</sportType>', '  <durationType>time</durationType>', '  <tags/>', '  <workout>'];
  for (const s of w.steps) {
    const tag = s.kind === 'steady' ? 'SteadyState' : s.kind === 'free' ? 'FreeRide' : s.start_watts > s.end_watts ? 'Cooldown' : 'Warmup';
    let attrs = `Duration="${s.seconds}"`;
    if (s.kind === 'steady') attrs += ` Power="${round(s.watts / w.ftp_watts)}"`;
    if (s.kind === 'ramp') attrs += ` PowerLow="${round(s.start_watts / w.ftp_watts)}" PowerHigh="${round(s.end_watts / w.ftp_watts)}"`;
    if (s.kind === 'free') attrs += ' FlatRoad="0"';
    if (s.cadence) attrs += ` Cadence="${s.cadence}"`;
    lines.push(s.text ? `    <${tag} ${attrs}><textevent timeoffset="0" message="${xml(s.text)}"/></${tag}>` : `    <${tag} ${attrs}/>`);
  }
  return [...lines, '  </workout>', '</workout_file>', ''].join('\n');
}
export function summary(w) {
  return {name:w.name, duration_seconds:w.seconds, duration_minutes:w.seconds/60, step_count:w.steps.length, ftp_watts:w.ftp_watts, workout_id:w.id, fingerprint:w.hash, warnings:w.warnings};
}
export function toMyWhoosh(w) {
  const workoutSteps = w.steps.map((s, i) => ({
    IntervalId:0, StepType:s.kind === 'steady' ? 'E_Normal' : s.kind === 'free' ? 'E_FreeRide' : s.start_watts > s.end_watts ? 'E_CoolDown' : 'E_WarmUp',
    Id:i+1, WorkoutMessage:s.text ? [{Id:1,Time:0,Message:s.text}] : [], Rpm:s.cadence,
    Power:s.kind === 'steady' ? round(s.watts / w.ftp_watts) : 0, Pace:0,
    StartPower:s.kind === 'ramp' ? round(s.start_watts / w.ftp_watts) : 0,
    EndPower:s.kind === 'ramp' ? round(s.end_watts / w.ftp_watts) : 0,
    Time:s.seconds, IsManualGrade:false, ManualGradeValue:0, ShowAveragePower:true, FlatRoad:0
  }));
  // Match the editor's 1 Hz samples and 30-second rolling power estimate.
  // Free ride uses 70% FTP for the estimate only; the trainer gets no target.
  const samples = w.steps.flatMap(s => Array.from({length:s.seconds}, (_, i) => s.kind === 'free' ? 0.7 * w.ftp_watts : s.kind === 'steady' ? s.watts : s.start_watts + (s.end_watts-s.start_watts)*i/s.seconds));
  let rolling = 0, fourth = 0, count = 0;
  samples.forEach((p,i) => {rolling += p; if (i >= 30) rolling -= samples[i-30]; if (i >= 29) {fourth += (rolling/30)**4; count++;}});
  const np = count ? (fourth/count)**0.25 : samples.reduce((a,b)=>a+b,0)/samples.length;
  const intensity = np/w.ftp_watts;
  const kj = w.steps.reduce((n,s)=>n+s.seconds*(s.kind==='free'?0.7*w.ftp_watts:s.kind==='steady'?s.watts:(s.start_watts+s.end_watts)/2)/1000,0);
  return {Id:w.id, Name:w.name, Description:`${w.description}\n[whoosh-cli:${w.hash}]`.trim(), Mode:'E_Ride', ERGMode:'E_OFF', IsRecovery:false, IsIntervals:false, FTPMode:'E_NoFTP', IsTT:false, IsTSS:false, IsIF:false, FTPMultiplier:1, StressPoint:0, Time:w.seconds, CustomTagDescription:'2', CategoryId:200000000, SubcategoryId:1, Type:'E_Normal', DisplayType:'E_byWatts', StepCount:workoutSteps.length, IsFavorite:false, CompletedCount:0, WorkoutSteps:[], AuthorName:w.author, WokoutAssociationId:0, IF:Number(intensity.toFixed(3)), TSS:Number((w.seconds/3600*intensity**2*100).toFixed(2)), KJ:Number(kj.toFixed(4)), WorkoutStepsArray:workoutSteps};
}
