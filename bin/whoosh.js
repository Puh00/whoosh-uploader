#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { compile, summary, toZwo, toMyWhoosh, WhooshError } from '../src/workout.js';
import { MyWhoosh, identity } from '../src/api.js';
import { getToken, saveToken, clearToken, login } from '../src/auth.js';
import { helpFor } from '../src/help.js';

async function stdin() {let s='';for await(const chunk of process.stdin) {s+=chunk; if(s.length>1024*1024) throw new WhooshError('INPUT_TOO_LARGE','Input exceeds 1 MiB');}return s;}
async function outputFile(file, content) {const p=resolve(file);await mkdir(dirname(p),{recursive:true});await writeFile(p,content,'utf8');return p;}
function usage(message) {throw new WhooshError('USAGE',message);}
async function main() {
  const {values,positionals}=parseArgs({allowPositionals:true,options:{help:{type:'boolean',short:'h'},out:{type:'string'},format:{type:'string'},'dry-run':{type:'boolean'},channel:{type:'string'}}});
  if(positionals[0]==='help') {process.stdout.write(helpFor(positionals.slice(1)));return;}
  if(values.help || !positionals.length) {
    const topics=positionals.slice(0,positionals[0]==='auth'?2:1);
    process.stdout.write(helpFor(topics));return;
  }
  const [command,input,...extra]=positionals;
  const options={validate:[],build:['out','format'],upload:['dry-run'],list:[],delete:[],auth:['channel']}[command];
  if(!options) usage(`Unknown command ${command}`);
  for(const k of Object.keys(values)) if(!options.includes(k)) usage(`--${k} is not supported by ${command}`);
  if(extra.length) usage('Unexpected positional arguments');
  let result;
  if(command==='auth') {
    if(values.channel && input!=='login') usage('--channel is only valid for auth login');
    if(values.channel && !['msedge','chrome','chromium'].includes(values.channel)) usage('Unsupported browser channel');
    if(input==='login') result=await login(values.channel);
    else if(input==='import') {
      if(process.stdin.isTTY) usage('auth import requires a token piped through stdin. Use auth login for interactive sign-in.');
      result={status:'signed_in',session_file:await saveToken((await stdin()).trim())};
    } else if(input==='status') {identity(await getToken());result={status:'session_present',note:'Token shape and expiry checked locally; server access is checked by list.'};}
    else if(input==='clear') {await clearToken();result={status:'local_session_removed'};}
    else usage('Expected auth login, import, status, or clear');
  } else if(command==='list') {
    if(input) usage('list takes no input');
    const workouts=await new MyWhoosh(await getToken()).list();
    result={workouts:workouts.map(w=>({id:w.WorkoutId,name:w.Name,duration_seconds:w.Time,step_count:w.StepCount,created_at:w.createdAt}))};
  } else if(command==='delete') {
    if(!input || !/^\d+$/.test(input)) usage('delete requires a numeric workout ID from list');
    const client=new MyWhoosh(await getToken());
    const workout=(await client.list()).find(w=>String(w.WorkoutId)===input);
    if(!workout) throw new WhooshError('WORKOUT_NOT_FOUND','Workout ID is not in My Workouts. No deletion attempted.');
    result={status:'deleted',deleted_workout:await client.deleteWorkout(workout),verified:true};
  } else {
    if(!input) usage('A workout JSON path or - for stdin is required');
    if(command==='build' && !values.out) usage('build requires --out');
    if(command==='build' && values.format && !['zwo','mywhoosh'].includes(values.format)) usage('--format must be zwo or mywhoosh');
    const source=input==='-'?await stdin():await readFile(input,'utf8');
    if(source.length>1024*1024) throw new WhooshError('INPUT_TOO_LARGE','Input exceeds 1 MiB');
    let parsed;try{parsed=JSON.parse(source.replace(/^\uFEFF/,''));}catch{throw new WhooshError('INVALID_JSON','Input must be valid JSON.');}
    const w=compile(parsed);
    if(command==='validate') result={status:'valid',...summary(w)};
    else if(command==='build') {
      const format=values.format??'zwo';
      result={status:'built',...summary(w),file:await outputFile(values.out,format==='zwo'?toZwo(w):JSON.stringify(toMyWhoosh(w),null,2)+'\n'),format};
    } else if(values['dry-run']) result={status:'dry_run',...summary(w),payload:toMyWhoosh(w)};
    else result=await new MyWhoosh(await getToken()).upload(w);
  }
  process.stdout.write(JSON.stringify(result)+'\n');
}
main().catch(e=>{
  const code=e.code??'ERROR';
  const message=e instanceof WhooshError?e.message:['ENOENT','EACCES','EPERM'].includes(code)?`File operation failed: ${code}`:e.code?.startsWith('ERR_PARSE_ARGS')?'Invalid command arguments. Run whoosh-uploader --help.':'Command failed. Check installation, input files, and permissions.';
  process.stderr.write(JSON.stringify({error:{code,message,...(e.deletion_attempt?{deletion_attempt:e.deletion_attempt}:{}),...(e.deleted_workout?{deleted_workout:e.deleted_workout}:{})}})+'\n');
  process.exitCode=['INVALID_INPUT','INVALID_JSON','USAGE','INPUT_TOO_LARGE'].includes(code)?2:code.startsWith('AUTH')?3:4;
});
