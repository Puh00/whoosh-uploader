import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { identity } from './api.js';
import { WhooshError } from './workout.js';

export function authPath() {
  const base = process.env.WHOOSH_CONFIG_DIR ?? (process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(homedir(),'AppData','Local'),'whoosh-cli') : join(process.env.XDG_CONFIG_HOME ?? join(homedir(),'.config'),'whoosh-cli'));
  return join(base,'session.auth.json');
}
function dpapi(value, decrypt = false) {
  const script = `Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $o=[Security.Cryptography.ProtectedData]::${decrypt?'Unprotect':'Protect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($o))`;
  return new Promise((resolve,reject)=>{
    const powershell=join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const child=spawn(powershell,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let out=''; child.stdout.on('data',x=>out+=x); child.stderr.resume();
    child.on('error',()=>reject(new WhooshError('AUTH_STORE','Could not start Windows DPAPI helper.')));
    child.on('close',code=>code===0?resolve(out.trim()):reject(new WhooshError('AUTH_STORE','Windows could not protect or read this session. Sign in again.')));
    child.stdin.on('error',()=>{}); child.stdin.end(value);
  });
}
export async function saveToken(token) {
  identity(token);
  const file=authPath();
  await mkdir(join(file,'..'),{recursive:true,mode:0o700});
  const encoding=process.platform==='win32'?'dpapi':'plain';
  const value=encoding==='dpapi'?await dpapi(Buffer.from(token).toString('base64')):token;
  await writeFile(file,JSON.stringify({encoding,value}),{mode:0o600});
  return file;
}
export async function getToken() {
  if (process.env.MYWHOOSH_TOKEN) {identity(process.env.MYWHOOSH_TOKEN); return process.env.MYWHOOSH_TOKEN;}
  let data;
  try {data=JSON.parse(await readFile(authPath(),'utf8'));} catch {throw new WhooshError('AUTH_REQUIRED','Run whoosh-uploader auth login, whoosh-uploader auth import, or set MYWHOOSH_TOKEN.');}
  let token;
  if (data.encoding==='dpapi' && process.platform==='win32') token=Buffer.from(await dpapi(data.value,true),'base64').toString();
  else if (data.encoding==='plain' && process.platform!=='win32') token=data.value;
  else throw new WhooshError('AUTH_STORE','This session belongs to a different OS. Sign in on this OS.');
  identity(token); return token;
}
export async function clearToken() {try {await unlink(authPath());} catch(e) {if(e.code!=='ENOENT') throw e;}}
export async function login(channel) {
  const { chromium } = await import('playwright');
  let browser;
  const selected=channel ?? 'chromium';
  try {browser=await chromium.launch({headless:false,...(selected==='chromium'?{}:{channel:selected})});}
  catch {throw new WhooshError('BROWSER_UNAVAILABLE','Run npx playwright@1.63.0 install chromium, or select an installed browser with --channel chrome or --channel msedge.');}
  try {
    const page=await browser.newPage();
    await page.goto('https://workout.mywhoosh.com/auth');
    process.stderr.write('Sign in to MyWhoosh in the opened browser. Complete any CAPTCHA yourself. The CLI will save the session token, not your password.\n');
    const deadline=Date.now()+300000;
    while(Date.now()<deadline) {
      if(page.isClosed()) throw new WhooshError('LOGIN_CANCELLED','Login browser closed.');
      if(new URL(page.url()).origin==='https://workout.mywhoosh.com') {
        const token=await page.evaluate(()=>localStorage.getItem('user_auth_token')).catch(()=>null);
        if(token) return {status:'signed_in',session_file:await saveToken(token)};
      }
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new WhooshError('LOGIN_TIMEOUT','Login timed out after five minutes.');
  } finally {await browser.close();}
}
