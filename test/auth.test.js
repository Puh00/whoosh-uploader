import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveToken, getToken, clearToken, authPath } from '../src/auth.js';
test('session storage roundtrip, protection, environment override, and removal',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'whoosh-auth-test-'));
  const oldDir=process.env.WHOOSH_CONFIG_DIR,oldToken=process.env.MYWHOOSH_TOKEN;
  process.env.WHOOSH_CONFIG_DIR=dir;delete process.env.MYWHOOSH_TOKEN;
  const token=`x.${Buffer.from(JSON.stringify({userId:'synthetic-test',exp:4102444800})).toString('base64url')}.x`;
  try {
    await saveToken(token);assert.equal(await getToken(),token);
    const stored=await readFile(authPath(),'utf8');
    if(process.platform==='win32') {assert.equal(JSON.parse(stored).encoding,'dpapi');assert.ok(!stored.includes(token));}
    else assert.equal((await stat(authPath())).mode & 0o777,0o600);
    process.env.MYWHOOSH_TOKEN=token;assert.equal(await getToken(),token);delete process.env.MYWHOOSH_TOKEN;
    await clearToken();await assert.rejects(getToken(),{code:'AUTH_REQUIRED'});
  } finally {
    if(oldDir===undefined) delete process.env.WHOOSH_CONFIG_DIR;else process.env.WHOOSH_CONFIG_DIR=oldDir;
    if(oldToken===undefined) delete process.env.MYWHOOSH_TOKEN;else process.env.MYWHOOSH_TOKEN=oldToken;
    await unlink(join(dir,'session.auth.json')).catch(e=>{if(e.code!=='ENOENT') throw e;});
    await rmdir(dir);
  }
});
