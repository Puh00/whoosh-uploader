import { WhooshError, toMyWhoosh, summary } from './workout.js';
export const API = 'https://coaching.mywhoosh.com/api/v2';
export function identity(token) {
  try {
    const data = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (!data.userId) throw new Error();
    if (typeof data.exp === 'number' && data.exp * 1000 <= Date.now()) throw new WhooshError('AUTH_EXPIRED', 'Session expired. Run whoosh-uploader auth login again.');
    return data.userId;
  } catch (e) {
    if (e instanceof WhooshError) throw e;
    throw new WhooshError('AUTH_INVALID', 'Expected a MyWhoosh workout-builder session token.');
  }
}
export class MyWhoosh {
  constructor(token, fetcher = fetch) { this.userId = identity(token); this.token = token; this.fetcher = fetcher; }
  async request(path, body, method = body ? 'POST' : 'GET') {
    const unknown = method === 'DELETE' ? 'DELETE_UNKNOWN' : 'UPLOAD_UNKNOWN';
    let response;
    try {
      response = await this.fetcher(`${API}${path}`, {
        method, redirect:'error', signal:AbortSignal.timeout(30000),
        headers: {'Content-Type':'application/json', Authorization:`Bearer ${this.token}`},
        ...(body ? {body:JSON.stringify(body)} : {})
      });
    } catch {
      throw new WhooshError(method === 'GET' ? 'NETWORK_ERROR' : unknown, method === 'GET' ? 'Cannot reach MyWhoosh. Check the network and retry.' : `${method} response was lost. No automatic retry. Run list and check MyWhoosh before trying again.`);
    }
    if ([401,403].includes(response.status)) throw new WhooshError('AUTH_REQUIRED', `MyWhoosh returned HTTP ${response.status}. Sign in again or check account access.`);
    let data;
    try { data = await response.json(); } catch { throw new WhooshError(method === 'GET' ? 'API_CHANGED' : unknown, `MyWhoosh returned non-JSON data, HTTP ${response.status}.`); }
    if (method === 'DELETE' && response.ok && data?.error === true && Array.isArray(data.data) && data.data.length) throw new WhooshError('WORKOUT_IN_USE','MyWhoosh reports that this workout is used in training plans. No further deletion or upload attempted.');
    if (!data || typeof data !== 'object') throw new WhooshError(method === 'GET' ? 'API_CHANGED' : unknown,'Unexpected MyWhoosh response.');
    if (!response.ok || data.status === false) throw new WhooshError('API_REJECTED', `MyWhoosh rejected the request, HTTP ${response.status}. ${typeof data.message==='string' ? data.message.slice(0,300).replaceAll(this.token,'[redacted]') : 'Check your account and slot credits.'}`);
    return data;
  }
  async list() {
    const data = await this.request('/workout-builder/my-workouts');
    if (!Array.isArray(data.data)) throw new WhooshError('API_CHANGED','Unexpected My Workouts response. No upload attempted.');
    return data.data;
  }
  async credits() {
    const data = await this.request('/client/my-credits');
    const n = data.data?.CurrentCredits;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new WhooshError('API_CHANGED','Unexpected slot-credit response. No upload attempted.');
    return n;
  }
  async deleteWorkout(workout) {
    if (!/^\d+$/.test(String(workout.WorkoutId)) || workout.SportsModeType !== 0) throw new WhooshError('API_CHANGED','Expected a cycling workout with a numeric WorkoutId. No deletion attempted.');
    const deleted = {id:workout.WorkoutId,name:workout.Name,created_at:workout.createdAt};
    try {
      const result = await this.request(`/client/custom-workout-upload/0/${workout.WorkoutId}`, undefined, 'DELETE');
      if (result.error === true || (result.status !== true && result.status !== 1 && result.error !== false)) throw new WhooshError('DELETE_UNKNOWN','Unexpected deletion response. Check My Workouts before trying again.');
      for (let attempt=0; attempt<3; attempt++) {
        if (attempt) await new Promise(resolve=>setTimeout(resolve,1000));
        let remaining;
        try { remaining = await this.list(); } catch { throw new WhooshError('DELETE_UNVERIFIED','Deletion was accepted but readback failed. Check My Workouts before trying again.'); }
        if (!remaining.some(x => String(x.WorkoutId) === String(workout.WorkoutId))) return deleted;
      }
      throw new WhooshError('DELETE_UNVERIFIED','Deletion was accepted but the workout is still listed. No upload attempted. Check My Workouts before trying again.');
    } catch (error) {
      error.deletion_attempt = deleted;
      throw error;
    }
  }
  async upload(w) {
    const payload = toMyWhoosh(w);
    const marker = `[whoosh-cli:${w.hash}]`;
    const before = await this.list();
    const existing = before.find(x => typeof x.Description === 'string' && x.Description.includes(marker));
    if (existing) { verify(existing, payload); return {...summary(w), status:'already_exists', remote_id:existing.WorkoutId, verified:true}; }
    // Never reuse an unrelated ID or silently overwrite an existing named session.
    if (before.some(x => String(x.WorkoutId) === String(w.id) || x.Name === w.name)) throw new WhooshError('WORKOUT_CONFLICT','A different workout already has this name or ID. Choose a new session name. No upload attempted.');
    const credits = await this.credits();
    let deleted;
    try {
      if (credits <= 0) {
        deleted = await this.deleteWorkout(oldestWorkout(before));
        let available = 0;
        for (let attempt=0; attempt<3; attempt++) {
          if (attempt) await new Promise(resolve=>setTimeout(resolve,1000));
          available = await this.credits();
          if (available > 0) break;
        }
        if (available <= 0) throw new WhooshError('NO_CREDITS','The oldest workout was deleted, but no slot credit became available. No further deletion or upload attempted.');
      }
      const result = await this.request('/client/custom-workout-upload', {UserId:this.userId, SportsModeType:0, WorkoutsData:[payload]});
      if (result.status !== true && result.status !== 1) throw new WhooshError('UPLOAD_UNKNOWN','Upload returned an unexpected status. Inspect My Workouts before trying again.');
      for (let attempt=0; attempt<3; attempt++) {
        if (attempt) await new Promise(resolve=>setTimeout(resolve,1000));
        let after;
        try { after = await this.list(); } catch { throw new WhooshError('UPLOAD_UNVERIFIED','MyWhoosh accepted the upload, but the follow-up list failed. Check My Workouts before retrying.'); }
        const saved = after.find(x => x.Description?.includes(marker)) ?? after.find(x => x.Name === w.name && !before.some(b=>b.WorkoutId===x.WorkoutId));
        if (saved) {verify(saved,payload); return {...summary(w),status:'uploaded',remote_id:saved.WorkoutId,verified:true,credits_before:credits,...(deleted ? {deleted_workout:deleted} : {})};}
      }
      throw new WhooshError('UPLOAD_UNVERIFIED','MyWhoosh accepted the upload, but it is not visible in My Workouts yet. Run list before retrying.');
    } catch (error) {
      if (deleted) error.deleted_workout = deleted;
      throw error;
    }
  }
}
export function oldestWorkout(workouts) {
  const candidates = workouts.filter(x => x.SportsModeType === 0);
  if (!candidates.length) throw new WhooshError('NO_CREDITS','No slot credits remain and no custom cycling workout is available to delete.');
  if (candidates.some(x => typeof x.createdAt !== 'string' || !Number.isFinite(Date.parse(x.createdAt)) || !/^\d+$/.test(String(x.WorkoutId)))) throw new WhooshError('API_CHANGED','Cannot determine the oldest workout from MyWhoosh metadata. No deletion attempted.');
  return [...candidates].sort((a,b) => Date.parse(a.createdAt)-Date.parse(b.createdAt) || String(a.WorkoutId).localeCompare(String(b.WorkoutId)))[0];
}
export function verify(actual, expected) {
  const mismatch = field => {throw new WhooshError('VERIFY_FAILED',`Uploaded workout differs at ${field}. Inspect My Workouts before retrying.`);};
  for (const k of ['Name','Time','StepCount']) if (actual[k] !== expected[k]) mismatch(k);
  const steps = actual.WorkoutStepsArray;
  if (!Array.isArray(steps) || steps.length !== expected.WorkoutStepsArray.length) mismatch('steps');
  for (let i=0;i<steps.length;i++) {
    const a=steps[i], e=expected.WorkoutStepsArray[i];
    for (const k of ['StepType','Time','Rpm']) if (a[k] !== e[k]) mismatch(`step ${i+1}.${k}`);
    for (const k of ['Power','StartPower','EndPower']) if (!Number.isFinite(a[k]) || Math.abs(a[k]-e[k])>1e-6) mismatch(`step ${i+1}.${k}`);
    if (JSON.stringify(a.WorkoutMessage ?? []) !== JSON.stringify(e.WorkoutMessage)) mismatch(`step ${i+1}.WorkoutMessage`);
  }
}
