import test from 'node:test';
import assert from 'node:assert/strict';
import { MyWhoosh, verify, identity, oldestWorkout } from '../src/api.js';
import { compile, toMyWhoosh } from '../src/workout.js';
const token = `x.${Buffer.from(JSON.stringify({ userId: 'test-user', exp: 4102444800 })).toString('base64url')}.x`;
const workout = compile({
  version: 1,
  name: 'API test',
  ftp_watts: 200,
  steps: [{ seconds: 120, watts: 160 }]
});
const saved = { ...toMyWhoosh(workout), WorkoutId: 123 };
/**
 * Build a JSON HTTP response for the mocked API.
 * @param {*} data - Response body to serialize.
 * @param {number} [status] - HTTP status, defaulting to 200.
 * @returns {Response}
 */
const response = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
test('upload preflight, exact payload, and readback', async () => {
  const calls = [];
  const client = new MyWhoosh(token, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('my-workouts')) {
      return response({ data: calls.length === 1 ? [] : [saved] });
    }
    if (url.endsWith('my-credits')) {
      return response({ data: { CurrentCredits: 5 } });
    }
    const body = JSON.parse(options.body);
    assert.equal(body.UserId, 'test-user');
    assert.deepEqual(body.WorkoutsData, [toMyWhoosh(workout)]);
    assert.equal(options.redirect, 'error');
    return response({ status: true });
  });
  assert.equal((await client.upload(workout)).status, 'uploaded');
  assert.equal(calls.filter((c) => c.options.method === 'POST').length, 1);
});
test('same workout is not posted again', async () => {
  let calls = 0;
  const client = new MyWhoosh(token, async () => {
    calls++;
    return response({ data: [saved] });
  });
  assert.equal((await client.upload(workout)).status, 'already_exists');
  assert.equal(calls, 1);
});
test('name conflicts and zero credits fail before POST', async () => {
  const conflict = new MyWhoosh(token, async () =>
    response({
      data: [
        { Name: workout.name, WorkoutId: 1, Description: 'Different workout' }
      ]
    })
  );
  await assert.rejects(conflict.upload(workout), { code: 'WORKOUT_CONFLICT' });
  const noCredits = new MyWhoosh(token, async (url, options) => {
    assert.equal(options.method, 'GET');
    return response(
      url.endsWith('my-workouts')
        ? { data: [] }
        : { data: { CurrentCredits: 0 } }
    );
  });
  await assert.rejects(noCredits.upload(workout), { code: 'NO_CREDITS' });
});
test('expired and malformed sessions fail locally', () => {
  assert.throws(() => identity('bad'), { code: 'AUTH_INVALID' });
  assert.throws(
    () =>
      identity(
        `x.${Buffer.from(JSON.stringify({ userId: 'test', exp: 1 })).toString('base64url')}.x`
      ),
    { code: 'AUTH_EXPIRED' }
  );
});
test('server failures are not mistaken for a successful upload', async () => {
  const auth = new MyWhoosh(token, async () => response({}, 401));
  await assert.rejects(auth.list(), { code: 'AUTH_REQUIRED' });
  const malformed = new MyWhoosh(token, async () => response({ data: {} }));
  await assert.rejects(malformed.list(), { code: 'API_CHANGED' });
  const rejected = new MyWhoosh(token, async () =>
    response({ status: false, message: 'Rejected' })
  );
  await assert.rejects(rejected.list(), { code: 'API_REJECTED' });
});
test('lost upload responses are never retried automatically', async () => {
  let posts = 0;
  const client = new MyWhoosh(token, async (url, options) => {
    if (options.method === 'POST') {
      posts++;
      throw new Error('connection reset');
    }
    return response(
      url.endsWith('my-workouts')
        ? { data: [] }
        : { data: { CurrentCredits: 2 } }
    );
  });
  await assert.rejects(client.upload(workout), { code: 'UPLOAD_UNKNOWN' });
  assert.equal(posts, 1);
});
test('verification detects power changes and tolerates float32 representation', () => {
  const good = structuredClone(saved);
  good.WorkoutStepsArray[0].Power = Math.fround(
    good.WorkoutStepsArray[0].Power
  );
  verify(good, toMyWhoosh(workout));
  good.WorkoutStepsArray[0].Power = 0.5;
  assert.throws(() => verify(good, toMyWhoosh(workout)), {
    code: 'VERIFY_FAILED'
  });
});

const old = {
  WorkoutId: 900,
  Name: 'Oldest',
  SportsModeType: 0,
  createdAt: '2025-01-01T00:00:00Z'
};
const newer = {
  WorkoutId: 1,
  Name: 'Newer',
  SportsModeType: 0,
  createdAt: '2026-01-01T00:00:00Z'
};
test('oldest uses creation time, not ID, array order, or update time', () => {
  const workouts = [newer, { ...old, updatedAt: '2026-10-02T00:00:00Z' }];
  assert.equal(oldestWorkout(workouts).WorkoutId, old.WorkoutId);
  assert.equal(workouts[0], newer);
  assert.equal(oldestWorkout([{ ...old, SportsModeType: 1 }, newer]), newer);
  for (const createdAt of [undefined, null, 'bad']) {
    assert.throws(() => oldestWorkout([newer, { ...old, createdAt }]), {
      code: 'API_CHANGED'
    });
  }
  assert.throws(() => oldestWorkout([]), { code: 'NO_CREDITS' });
});

test('full account deletes only the oldest, verifies refund, then uploads', async () => {
  let library = [newer, old],
    credits = 0;
  const calls = [];
  const client = new MyWhoosh(token, async (url, options) => {
    const path = new URL(url).pathname.replace('/api/v2', '');
    calls.push(`${options.method} ${path}`);
    if (options.method === 'DELETE') {
      assert.equal(path, '/client/custom-workout-upload/0/900');
      assert.equal(options.body, undefined);
      library = [newer];
      credits = 1;
      return response({ status: true });
    }
    if (options.method === 'POST') {
      assert.equal(credits, 1);
      library.push(saved);
      return response({ status: true });
    }
    return response(
      path.endsWith('my-workouts')
        ? { data: library }
        : { data: { CurrentCredits: credits } }
    );
  });
  const result = await client.upload(workout);
  assert.equal(result.status, 'uploaded');
  assert.equal(result.credits_before, 0);
  assert.deepEqual(result.deleted_workout, {
    id: 900,
    name: 'Oldest',
    created_at: old.createdAt
  });
  assert.deepEqual(calls, [
    'GET /workout-builder/my-workouts',
    'GET /client/my-credits',
    'DELETE /client/custom-workout-upload/0/900',
    'GET /workout-builder/my-workouts',
    'GET /client/my-credits',
    'POST /client/custom-workout-upload',
    'GET /workout-builder/my-workouts'
  ]);
});

test('duplicates and name conflicts never reclaim a slot', async () => {
  for (const record of [saved, { ...old, Name: workout.name }]) {
    let calls = 0;
    const client = new MyWhoosh(token, async (url, options) => {
      calls++;
      assert.equal(options.method, 'GET');
      return response({ data: [record] });
    });
    if (record === saved) {
      assert.equal((await client.upload(workout)).status, 'already_exists');
    } else {
      await assert.rejects(client.upload(workout), {
        code: 'WORKOUT_CONFLICT'
      });
    }
    assert.equal(calls, 1);
  }
});

test('blocked, rejected, malformed and lost deletion responses stop without retries', async () => {
  const cases = [
    [
      () => response({ error: true, data: [{ name: 'Plan' }] }),
      'WORKOUT_IN_USE'
    ],
    [
      () => response({ status: false, message: 'Rejected' }, 400),
      'API_REJECTED'
    ],
    [() => response({}, 401), 'AUTH_REQUIRED'],
    [() => response({}), 'DELETE_UNKNOWN'],
    [() => response(null), 'DELETE_UNKNOWN'],
    [() => new Response('bad json'), 'DELETE_UNKNOWN'],
    [
      () => {
        throw new Error('lost');
      },
      'DELETE_UNKNOWN'
    ]
  ];
  for (const [reply, code] of cases) {
    let deletes = 0;
    const client = new MyWhoosh(token, async (url, options) => {
      assert.notEqual(options.method, 'POST');
      if (options.method === 'DELETE') {
        deletes++;
        return reply();
      }
      return response(
        url.endsWith('my-workouts')
          ? { data: [newer, old] }
          : { data: { CurrentCredits: 0 } }
      );
    });
    await assert.rejects(
      client.upload(workout),
      (e) => e.code === code && e.deletion_attempt.id === 900
    );
    assert.equal(deletes, 1);
  }
});

test('accepted deletion must disappear before an upload', async () => {
  let deletes = 0;
  const client = new MyWhoosh(token, async (url, options) => {
    assert.notEqual(options.method, 'POST');
    if (options.method === 'DELETE') {
      deletes++;
      return response({ status: true });
    }
    return response(
      url.endsWith('my-workouts')
        ? { data: [old] }
        : { data: { CurrentCredits: 0 } }
    );
  });
  await assert.rejects(client.upload(workout), { code: 'DELETE_UNVERIFIED' });
  assert.equal(deletes, 1);
});

test('no refund stops after one deletion and reports what was removed', async () => {
  let deletes = 0;
  const client = new MyWhoosh(token, async (url, options) => {
    assert.notEqual(options.method, 'POST');
    if (options.method === 'DELETE') {
      deletes++;
      return response({ status: true });
    }
    return response(
      url.endsWith('my-workouts')
        ? { data: deletes ? [newer] : [old, newer] }
        : { data: { CurrentCredits: 0 } }
    );
  });
  await assert.rejects(
    client.upload(workout),
    (e) => e.code === 'NO_CREDITS' && e.deleted_workout.id === 900
  );
  assert.equal(deletes, 1);
});

test('upload failure after reclamation reports the removed workout', async () => {
  let deletes = 0,
    posts = 0;
  const client = new MyWhoosh(token, async (url, options) => {
    if (options.method === 'DELETE') {
      deletes++;
      return response({ error: false });
    }
    if (options.method === 'POST') {
      posts++;
      throw new Error('lost');
    }
    return response(
      url.endsWith('my-workouts')
        ? { data: deletes ? [] : [old] }
        : { data: { CurrentCredits: deletes } }
    );
  });
  await assert.rejects(
    client.upload(workout),
    (e) => e.code === 'UPLOAD_UNKNOWN' && e.deleted_workout.id === 900
  );
  assert.equal(deletes, 1);
  assert.equal(posts, 1);
});

test('manual deletion validates identifiers and confirms absence', async () => {
  const client = new MyWhoosh(token, async (url, options) =>
    response(options.method === 'DELETE' ? { status: true } : { data: [] })
  );
  for (const record of [
    { ...old, WorkoutId: '../other' },
    { ...old, SportsModeType: 1 }
  ]) {
    await assert.rejects(client.deleteWorkout(record), { code: 'API_CHANGED' });
  }
  assert.equal((await client.deleteWorkout(old)).id, 900);
});
