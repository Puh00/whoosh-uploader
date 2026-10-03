import { WhooshError, toMyWhoosh, summary } from './workout.js';
export const API = 'https://coaching.mywhoosh.com/api/v2';
/**
 * Read the user ID and check expiry in a session token, without verifying its signature.
 * @param {string} token - MyWhoosh session JWT.
 * @returns {*} User ID carried by the token.
 * @throws {WhooshError} AUTH_INVALID or AUTH_EXPIRED for unusable tokens.
 */
export function identity(token) {
  try {
    const data = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString()
    );
    if (!data.userId) {
      throw new Error();
    }
    if (typeof data.exp === 'number' && data.exp * 1000 <= Date.now()) {
      throw new WhooshError(
        'AUTH_EXPIRED',
        'Session expired. Run whoosh-uploader auth login again.'
      );
    }
    return data.userId;
  } catch (e) {
    if (e instanceof WhooshError) {
      throw e;
    }
    throw new WhooshError(
      'AUTH_INVALID',
      'Expected a MyWhoosh workout-builder session token.'
    );
  }
}
export class MyWhoosh {
  /**
   * Initialize an API client after checking the token locally.
   * @param {string} token - Session JWT; retained for authorization headers.
   * @param {Function} fetcher - Fetch implementation, injectable for offline tests.
   * @throws {WhooshError} If the token is malformed or expired.
   */
  constructor(token, fetcher = fetch) {
    this.userId = identity(token);
    this.token = token;
    this.fetcher = fetcher;
  }
  /**
   * Send one API request and decode its response without retrying writes.
   * @param {string} path - API-relative path.
   * @param {object} [body] - JSON request body.
   * @param {string} [method] - Defaults to POST with a body, otherwise GET.
   * @returns {Promise<object>} Decoded API response.
   * @throws {WhooshError} For network, authentication, rejection, or uncertain-write failures.
   */
  async request(path, body, method = body ? 'POST' : 'GET') {
    const unknownWriteCode =
      method === 'DELETE' ? 'DELETE_UNKNOWN' : 'UPLOAD_UNKNOWN';
    let response;
    try {
      response = await this.fetcher(`${API}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch {
      throw new WhooshError(
        method === 'GET' ? 'NETWORK_ERROR' : unknownWriteCode,
        method === 'GET'
          ? 'Cannot reach MyWhoosh. Check the network and retry.'
          : `${method} response was lost. No automatic retry. Run list and check MyWhoosh before trying again.`
      );
    }
    if ([401, 403].includes(response.status)) {
      throw new WhooshError(
        'AUTH_REQUIRED',
        `MyWhoosh returned HTTP ${response.status}. Sign in again or check account access.`
      );
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new WhooshError(
        method === 'GET' ? 'API_CHANGED' : unknownWriteCode,
        `MyWhoosh returned non-JSON data, HTTP ${response.status}.`
      );
    }
    if (
      method === 'DELETE' &&
      response.ok &&
      data?.error === true &&
      Array.isArray(data.data) &&
      data.data.length
    ) {
      throw new WhooshError(
        'WORKOUT_IN_USE',
        'MyWhoosh reports that this workout is used in training plans. No further deletion or upload attempted.'
      );
    }
    if (!data || typeof data !== 'object') {
      throw new WhooshError(
        method === 'GET' ? 'API_CHANGED' : unknownWriteCode,
        'Unexpected MyWhoosh response.'
      );
    }
    if (!response.ok || data.status === false) {
      throw new WhooshError(
        'API_REJECTED',
        `MyWhoosh rejected the request, HTTP ${response.status}. ${typeof data.message === 'string' ? data.message.slice(0, 300).replaceAll(this.token, '[redacted]') : 'Check your account and slot credits.'}`
      );
    }
    return data;
  }
  /**
   * Fetch the account workout list.
   * @returns {Promise<object[]>} Remote workout records.
   * @throws {WhooshError} If the request fails or the response shape changes.
   */
  async list() {
    const data = await this.request('/workout-builder/my-workouts');
    if (!Array.isArray(data.data)) {
      throw new WhooshError(
        'API_CHANGED',
        'Unexpected My Workouts response. No upload attempted.'
      );
    }
    return data.data;
  }
  /**
   * Fetch the available workout-slot count.
   * @returns {Promise<number>} Remaining credits.
   * @throws {WhooshError} If the request fails or credits are not a finite number.
   */
  async credits() {
    const data = await this.request('/client/my-credits');
    const remainingCredits = data.data?.CurrentCredits;
    if (
      typeof remainingCredits !== 'number' ||
      !Number.isFinite(remainingCredits)
    ) {
      throw new WhooshError(
        'API_CHANGED',
        'Unexpected slot-credit response. No upload attempted.'
      );
    }
    return remainingCredits;
  }
  /**
   * Delete one cycling workout and confirm its absence with up to three reads.
   * @param {object} workout - Remote record with WorkoutId and SportsModeType.
   * @returns {Promise<object>} ID, name, and creation time of the deleted workout.
   * @throws {WhooshError} On failure; deletion_attempt identifies an attempted deletion.
   * The DELETE itself is never retried.
   */
  async deleteWorkout(workout) {
    if (
      !/^\d+$/.test(String(workout.WorkoutId)) ||
      workout.SportsModeType !== 0
    ) {
      throw new WhooshError(
        'API_CHANGED',
        'Expected a cycling workout with a numeric WorkoutId. No deletion attempted.'
      );
    }
    const deleted = {
      id: workout.WorkoutId,
      name: workout.Name,
      created_at: workout.createdAt
    };
    try {
      const result = await this.request(
        `/client/custom-workout-upload/0/${workout.WorkoutId}`,
        undefined,
        'DELETE'
      );
      if (
        result.error === true ||
        (result.status !== true &&
          result.status !== 1 &&
          result.error !== false)
      ) {
        throw new WhooshError(
          'DELETE_UNKNOWN',
          'Unexpected deletion response. Check My Workouts before trying again.'
        );
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        let remaining;
        try {
          remaining = await this.list();
        } catch {
          throw new WhooshError(
            'DELETE_UNVERIFIED',
            'Deletion was accepted but readback failed. Check My Workouts before trying again.'
          );
        }
        if (
          !remaining.some(
            (candidate) =>
              String(candidate.WorkoutId) === String(workout.WorkoutId)
          )
        ) {
          return deleted;
        }
      }
      throw new WhooshError(
        'DELETE_UNVERIFIED',
        'Deletion was accepted but the workout is still listed. No upload attempted. Check My Workouts before trying again.'
      );
    } catch (error) {
      error.deletion_attempt = deleted;
      throw error;
    }
  }
  /**
   * Upload a compiled workout after checking duplicates, conflicts, and capacity.
   * @param {object} workout - Output of compile.
   * @returns {Promise<object>} Verified upload or existing-workout summary.
   * @throws {WhooshError} On failure, including uncertain or unverified writes.
   * May delete at most one oldest cycling workout to reclaim a slot.
   * Errors after confirmed deletion include deleted_workout. Writes are never retried.
   */
  async upload(workout) {
    const payload = toMyWhoosh(workout);
    const marker = `[whoosh-cli:${workout.hash}]`;
    const before = await this.list();
    const existing = before.find(
      (candidate) =>
        typeof candidate.Description === 'string' &&
        candidate.Description.includes(marker)
    );
    if (existing) {
      verify(existing, payload);
      return {
        ...summary(workout),
        status: 'already_exists',
        remote_id: existing.WorkoutId,
        verified: true
      };
    }
    // Never reuse an unrelated ID or silently overwrite an existing named session.
    if (
      before.some(
        (candidate) =>
          String(candidate.WorkoutId) === String(workout.id) ||
          candidate.Name === workout.name
      )
    ) {
      throw new WhooshError(
        'WORKOUT_CONFLICT',
        'A different workout already has this name or ID. Choose a new session name. No upload attempted.'
      );
    }
    const credits = await this.credits();
    let deleted;
    try {
      if (credits <= 0) {
        deleted = await this.deleteWorkout(oldestWorkout(before));
        let available = 0;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          available = await this.credits();
          if (available > 0) {
            break;
          }
        }
        if (available <= 0) {
          throw new WhooshError(
            'NO_CREDITS',
            'The oldest workout was deleted, but no slot credit became available. No further deletion or upload attempted.'
          );
        }
      }
      const result = await this.request('/client/custom-workout-upload', {
        UserId: this.userId,
        SportsModeType: 0,
        WorkoutsData: [payload]
      });
      if (result.status !== true && result.status !== 1) {
        throw new WhooshError(
          'UPLOAD_UNKNOWN',
          'Upload returned an unexpected status. Inspect My Workouts before trying again.'
        );
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        let after;
        try {
          after = await this.list();
        } catch {
          throw new WhooshError(
            'UPLOAD_UNVERIFIED',
            'MyWhoosh accepted the upload, but the follow-up list failed. Check My Workouts before retrying.'
          );
        }
        const saved =
          after.find((candidate) => candidate.Description?.includes(marker)) ??
          after.find(
            (candidate) =>
              candidate.Name === workout.name &&
              !before.some(
                (previous) => previous.WorkoutId === candidate.WorkoutId
              )
          );
        if (saved) {
          verify(saved, payload);
          return {
            ...summary(workout),
            status: 'uploaded',
            remote_id: saved.WorkoutId,
            verified: true,
            credits_before: credits,
            ...(deleted ? { deleted_workout: deleted } : {})
          };
        }
      }
      throw new WhooshError(
        'UPLOAD_UNVERIFIED',
        'MyWhoosh accepted the upload, but it is not visible in My Workouts yet. Run list before retrying.'
      );
    } catch (error) {
      if (deleted) {
        error.deleted_workout = deleted;
      }
      throw error;
    }
  }
}
/**
 * Select the oldest cycling workout by creation time, then ID for ties.
 * @param {object[]} workouts - Remote records; the array is not mutated.
 * @returns {object} Record eligible for slot recovery.
 * @throws {WhooshError} If no candidate exists or its metadata is invalid.
 */
export function oldestWorkout(workouts) {
  const candidates = workouts.filter(
    (candidate) => candidate.SportsModeType === 0
  );
  if (!candidates.length) {
    throw new WhooshError(
      'NO_CREDITS',
      'No slot credits remain and no custom cycling workout is available to delete.'
    );
  }
  if (
    candidates.some(
      (candidate) =>
        typeof candidate.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(candidate.createdAt)) ||
        !/^\d+$/.test(String(candidate.WorkoutId))
    )
  ) {
    throw new WhooshError(
      'API_CHANGED',
      'Cannot determine the oldest workout from MyWhoosh metadata. No deletion attempted.'
    );
  }
  return [...candidates].sort(
    (left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      String(left.WorkoutId).localeCompare(String(right.WorkoutId))
  )[0];
}
/**
 * Compare stored steps and metadata against the expected upload payload.
 * @param {object} actual - Remote workout returned by readback.
 * @param {object} expected - Payload produced by toMyWhoosh.
 * @returns {void}
 * @throws {WhooshError} VERIFY_FAILED at the first mismatch.
 * Power comparisons tolerate float32 rounding; messages must match exactly.
 */
export function verify(actual, expected) {
  /**
   * Throw VERIFY_FAILED identifying the supplied field.
   * @param {string} field - Name or step path that differs.
   * @returns {never}
   */
  const mismatch = (field) => {
    throw new WhooshError(
      'VERIFY_FAILED',
      `Uploaded workout differs at ${field}. Inspect My Workouts before retrying.`
    );
  };
  for (const field of ['Name', 'Time', 'StepCount']) {
    if (actual[field] !== expected[field]) {
      mismatch(field);
    }
  }
  const steps = actual.WorkoutStepsArray;
  if (
    !Array.isArray(steps) ||
    steps.length !== expected.WorkoutStepsArray.length
  ) {
    mismatch('steps');
  }
  for (let index = 0; index < steps.length; index++) {
    const actualStep = steps[index];
    const expectedStep = expected.WorkoutStepsArray[index];
    for (const field of ['StepType', 'Time', 'Rpm']) {
      if (actualStep[field] !== expectedStep[field]) {
        mismatch(`step ${index + 1}.${field}`);
      }
    }
    for (const field of ['Power', 'StartPower', 'EndPower']) {
      if (
        !Number.isFinite(actualStep[field]) ||
        Math.abs(actualStep[field] - expectedStep[field]) > 1e-6
      ) {
        mismatch(`step ${index + 1}.${field}`);
      }
    }
    if (
      JSON.stringify(actualStep.WorkoutMessage ?? []) !==
      JSON.stringify(expectedStep.WorkoutMessage)
    ) {
      mismatch(`step ${index + 1}.WorkoutMessage`);
    }
  }
}
