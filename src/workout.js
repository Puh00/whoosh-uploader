import { createHash } from 'node:crypto';

export class WhooshError extends Error {
  /**
   * Create an error with a stable CLI error code and a user-facing message.
   * @param {string} code - Machine-readable failure category.
   * @param {string} message - Safe explanation to show the user.
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
/**
 * Throw INVALID_INPUT with the supplied validation message.
 * @param {string} message - Explanation of the invalid input.
 * @returns {never}
 */
const fail = (message) => {
  throw new WhooshError('INVALID_INPUT', message);
};
/**
 * Return whether a value is a non-null, non-array object.
 * @param {*} value - Value to inspect.
 * @returns {*} Truthy for objects, falsy otherwise.
 */
const isObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);
/**
 * Check whether a value is finite and inside an inclusive numeric range.
 * @param {*} value - Value to inspect.
 * @param {number} minimum - Inclusive minimum.
 * @param {number} maximum - Inclusive maximum.
 * @returns {boolean}
 */
const isNumberInRange = (value, minimum, maximum) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= minimum &&
  value <= maximum;
/**
 * Validate an object and reject fields outside the allowed list.
 * @param {*} value - Candidate object.
 * @param {string[]} allowed - Accepted field names.
 * @param {string} path - Input path used in errors.
 * @throws {WhooshError} If the value or a field is invalid.
 */
const validateKeys = (value, allowed, path) => {
  if (!isObject(value)) {
    fail(`${path} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`${path}: unknown field ${key}`);
    }
  }
};
/**
 * Validate text length and reject unsupported control characters.
 * @param {*} value - Candidate text.
 * @param {number} maximumLength - Maximum character count.
 * @param {string} path - Input path used in errors.
 * @throws {WhooshError} If the text is invalid.
 */
const validateText = (value, maximumLength, path) => {
  if (
    typeof value !== 'string' ||
    value.length > maximumLength ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)
  ) {
    fail(`${path} must be text of at most ${maximumLength} characters`);
  }
};
/**
 * Round a numeric power ratio to eight decimal places.
 * @param {number} value - Ratio to round.
 * @returns {number}
 */
const roundPowerRatio = (value) => Number(value.toFixed(8));
/**
 * Validate workout input, expand repeats, and resolve watt ranges.
 * @param {object} input - Version 1 workout JSON, including the current FTP.
 * @returns {object} Normalized steps, duration, deterministic identity, and warnings.
 * @throws {WhooshError} If input fields or expanded workout limits are invalid.
 */
export function compile(input) {
  validateKeys(
    input,
    [
      'version',
      'name',
      'description',
      'author',
      'ftp_watts',
      'range_policy',
      'steps'
    ],
    'workout'
  );
  if (input.version !== 1) {
    fail('version must be 1');
  }
  validateText(input.name, 120, 'name');
  if (!input.name.trim()) {
    fail('name cannot be empty');
  }
  if (!isNumberInRange(input.ftp_watts, 1, 1000)) {
    fail('ftp_watts must be between 1 and 1000');
  }
  for (const key of ['description', 'author']) {
    if (input[key] !== undefined) {
      validateText(input[key], key === 'author' ? 120 : 2000, key);
    }
  }
  const policy = input.range_policy ?? 'midpoint';
  if (!['midpoint', 'lower', 'upper'].includes(policy)) {
    fail('range_policy must be midpoint, lower or upper');
  }
  const steps = [];
  const warnings = [];
  /**
   * Append validated steps and range warnings to the enclosing workout.
   * @param {object[]} items - Steps or repeat groups to expand.
   * @param {number} depth - Current repeat nesting depth.
   * @param {string} at - Input path used in validation errors.
   * @throws {WhooshError} If a step or expansion limit is invalid.
   */
  function expand(items, depth = 0, at = 'steps') {
    if (depth > 5) {
      fail('repeat nesting exceeds 5 levels');
    }
    if (!Array.isArray(items) || !items.length || items.length > 1000) {
      fail(`${at} must contain 1 to 1000 steps`);
    }
    items.forEach((step, i) => {
      const path = `${at}[${i}]`;
      if (isObject(step) && 'repeat' in step) {
        validateKeys(step, ['repeat', 'steps'], path);
        if (
          !Number.isInteger(step.repeat) ||
          !isNumberInRange(step.repeat, 1, 100)
        ) {
          fail(`${path}.repeat must be an integer from 1 to 100`);
        }
        for (let j = 0; j < step.repeat; j++) {
          expand(step.steps, depth + 1, `${path}.steps`);
        }
        return;
      }
      validateKeys(
        step,
        ['seconds', 'watts', 'ramp_watts', 'free_ride', 'cadence', 'text'],
        path
      );
      if (
        !Number.isInteger(step.seconds) ||
        !isNumberInRange(step.seconds, 1, 86400)
      ) {
        fail(`${path}.seconds must be a positive integer, at most 86400`);
      }
      if (
        ['watts', 'ramp_watts', 'free_ride'].filter((k) => k in step).length !==
        1
      ) {
        fail(`${path}: specify exactly one of watts, ramp_watts or free_ride`);
      }
      if (
        step.cadence !== undefined &&
        (!Number.isInteger(step.cadence) ||
          !isNumberInRange(step.cadence, 1, 250))
      ) {
        fail(`${path}.cadence must be an integer from 1 to 250`);
      }
      if (step.text !== undefined) {
        validateText(step.text, 500, `${path}.text`);
      }
      const normalizedStep = {
        seconds: step.seconds,
        cadence: step.cadence ?? 0,
        text: step.text ?? ''
      };
      /**
       * Return a valid watt target, or throw INVALID_INPUT for the given path.
       * @param {*} value - Candidate watt target.
       * @param {string} path - Input path used in errors.
       * @returns {number}
       */
      const watts = (value, path) => {
        if (!isNumberInRange(value, 0, 3000)) {
          fail(`${path} must be watts between 0 and 3000`);
        }
        return value;
      };
      if ('free_ride' in step) {
        if (step.free_ride !== true) {
          fail(`${path}.free_ride must be true`);
        }
        normalizedStep.kind = 'free';
      } else if ('ramp_watts' in step) {
        if (!Array.isArray(step.ramp_watts) || step.ramp_watts.length !== 2) {
          fail(`${path}.ramp_watts must be [start, end]`);
        }
        normalizedStep.kind = 'ramp';
        [normalizedStep.start_watts, normalizedStep.end_watts] =
          step.ramp_watts.map((value) => watts(value, path));
      } else {
        normalizedStep.kind = 'steady';
        if (Array.isArray(step.watts)) {
          if (step.watts.length !== 2 || step.watts[0] > step.watts[1]) {
            fail(`${path}.watts range must be [lower, upper]`);
          }
          const [low, high] = step.watts.map((value) => watts(value, path));
          if (policy === 'lower') {
            normalizedStep.watts = low;
          } else if (policy === 'upper') {
            normalizedStep.watts = high;
          } else {
            normalizedStep.watts = (low + high) / 2;
          }
          warnings.push(
            `${path}: ${low}-${high} W resolved to ${normalizedStep.watts} W using ${policy}`
          );
        } else {
          normalizedStep.watts = watts(step.watts, `${path}.watts`);
        }
      }
      steps.push(normalizedStep);
      if (steps.length > 30) {
        fail(
          'More than 30 expanded steps. This CLI follows the current MyWhoosh editor limit; split the session.'
        );
      }
    });
  }
  expand(input.steps);
  const seconds = steps.reduce((total, step) => total + step.seconds, 0);
  if (seconds > 86400) {
    fail('Workout exceeds 24 hours');
  }
  // Property order is part of the fingerprint used for duplicate detection.
  const normalized = {
    version: 1,
    name: input.name.trim(),
    description: input.description ?? '',
    author: input.author ?? 'whoosh-cli',
    ftp_watts: input.ftp_watts,
    steps
  };
  const hash = createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
  const id = 1 + Number(BigInt(`0x${hash.slice(0, 12)}`) % 9999999n);
  return { ...normalized, seconds, hash, id, warnings: [...new Set(warnings)] };
}
/**
 * Escape a value for XML text or quoted attributes.
 * @param {*} value - Value to stringify and escape.
 * @returns {string}
 */
const escapeXml = (value) =>
  String(value).replace(
    /[<>&"']/g,
    (character) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&apos;'
      })[character]
  );
/**
 * Serialize a compiled workout as ZWO XML with FTP-relative power.
 * @param {object} workout - Output of compile.
 * @returns {string} XML ending with a newline; does not write a file.
 */
export function toZwo(workout) {
  const lines = [
    '<workout_file>',
    `  <author>${escapeXml(workout.author)}</author>`,
    `  <name>${escapeXml(workout.name)}</name>`,
    `  <description>${escapeXml(workout.description)}</description>`,
    '  <sportType>bike</sportType>',
    '  <durationType>time</durationType>',
    '  <tags/>',
    '  <workout>'
  ];
  for (const step of workout.steps) {
    let tag;
    if (step.kind === 'steady') {
      tag = 'SteadyState';
    } else if (step.kind === 'free') {
      tag = 'FreeRide';
    } else if (step.start_watts > step.end_watts) {
      tag = 'Cooldown';
    } else {
      tag = 'Warmup';
    }
    let attributes = `Duration="${step.seconds}"`;
    if (step.kind === 'steady') {
      attributes += ` Power="${roundPowerRatio(step.watts / workout.ftp_watts)}"`;
    }
    if (step.kind === 'ramp') {
      attributes += ` PowerLow="${roundPowerRatio(step.start_watts / workout.ftp_watts)}" PowerHigh="${roundPowerRatio(step.end_watts / workout.ftp_watts)}"`;
    }
    if (step.kind === 'free') {
      attributes += ' FlatRoad="0"';
    }
    if (step.cadence) {
      attributes += ` Cadence="${step.cadence}"`;
    }
    lines.push(
      step.text
        ? `    <${tag} ${attributes}><textevent timeoffset="0" message="${escapeXml(step.text)}"/></${tag}>`
        : `    <${tag} ${attributes}/>`
    );
  }
  return [...lines, '  </workout>', '</workout_file>', ''].join('\n');
}
/**
 * Build the public CLI summary for a compiled workout.
 * @param {object} workout - Output of compile.
 * @returns {object} Duration, identity, FTP, step count, and range warnings.
 */
export function summary(workout) {
  return {
    name: workout.name,
    duration_seconds: workout.seconds,
    duration_minutes: workout.seconds / 60,
    step_count: workout.steps.length,
    ftp_watts: workout.ftp_watts,
    workout_id: workout.id,
    fingerprint: workout.hash,
    warnings: workout.warnings
  };
}
/**
 * Build a MyWhoosh upload payload and estimate its training statistics.
 * @param {object} workout - Output of compile.
 * @returns {object} API payload; does not perform network operations.
 */
export function toMyWhoosh(workout) {
  const workoutSteps = workout.steps.map((step, i) => ({
    IntervalId: 0,
    StepType: myWhooshStepType(step),
    Id: i + 1,
    WorkoutMessage: step.text ? [{ Id: 1, Time: 0, Message: step.text }] : [],
    Rpm: step.cadence,
    Power:
      step.kind === 'steady'
        ? roundPowerRatio(step.watts / workout.ftp_watts)
        : 0,
    Pace: 0,
    StartPower:
      step.kind === 'ramp'
        ? roundPowerRatio(step.start_watts / workout.ftp_watts)
        : 0,
    EndPower:
      step.kind === 'ramp'
        ? roundPowerRatio(step.end_watts / workout.ftp_watts)
        : 0,
    Time: step.seconds,
    IsManualGrade: false,
    ManualGradeValue: 0,
    ShowAveragePower: true,
    FlatRoad: 0
  }));
  const { intensity, kilojoules } = estimateStatistics(workout);
  return {
    Id: workout.id,
    Name: workout.name,
    Description: `${workout.description}\n[whoosh-cli:${workout.hash}]`.trim(),
    Mode: 'E_Ride',
    ERGMode: 'E_OFF',
    IsRecovery: false,
    IsIntervals: false,
    FTPMode: 'E_NoFTP',
    IsTT: false,
    IsTSS: false,
    IsIF: false,
    FTPMultiplier: 1,
    StressPoint: 0,
    Time: workout.seconds,
    CustomTagDescription: '2',
    CategoryId: 200000000,
    SubcategoryId: 1,
    Type: 'E_Normal',
    DisplayType: 'E_byWatts',
    StepCount: workoutSteps.length,
    IsFavorite: false,
    CompletedCount: 0,
    WorkoutSteps: [],
    AuthorName: workout.author,
    WokoutAssociationId: 0,
    IF: Number(intensity.toFixed(3)),
    TSS: Number(((workout.seconds / 3600) * intensity ** 2 * 100).toFixed(2)),
    KJ: Number(kilojoules.toFixed(4)),
    WorkoutStepsArray: workoutSteps
  };
}

/**
 * Map a compiled step to the API's steady, free-ride, or ramp category.
 * @param {object} step - Normalized step from compile.
 * @returns {string} MyWhoosh StepType value.
 */
function myWhooshStepType(step) {
  if (step.kind === 'steady') {
    return 'E_Normal';
  }
  if (step.kind === 'free') {
    return 'E_FreeRide';
  }
  if (step.start_watts > step.end_watts) {
    return 'E_CoolDown';
  }
  return 'E_WarmUp';
}

/**
 * Estimate intensity and energy using the editor's power conventions.
 * @param {object} workout - Compiled workout with nonempty steps and positive FTP.
 * @returns {{intensity: number, kilojoules: number}} Unrounded estimates.
 * Free ride is estimated at 70% FTP without prescribing a trainer target.
 */
function estimateStatistics(workout) {
  // Sample at 1 Hz. The final ramp sample is just before its endpoint.
  const samples = workout.steps.flatMap((step) =>
    Array.from({ length: step.seconds }, (_, second) => {
      if (step.kind === 'free') {
        return 0.7 * workout.ftp_watts;
      }
      if (step.kind === 'steady') {
        return step.watts;
      }
      return (
        step.start_watts +
        ((step.end_watts - step.start_watts) * second) / step.seconds
      );
    })
  );
  let rollingPowerSum = 0;
  let fourthPowerSum = 0;
  let windowCount = 0;
  samples.forEach((power, index) => {
    rollingPowerSum += power;
    if (index >= 30) {
      rollingPowerSum -= samples[index - 30];
    }
    if (index >= 29) {
      fourthPowerSum += (rollingPowerSum / 30) ** 4;
      windowCount++;
    }
  });
  // Short workouts have no complete 30-second window; use their mean power.
  const normalizedPower = windowCount
    ? (fourthPowerSum / windowCount) ** 0.25
    : samples.reduce((total, power) => total + power, 0) / samples.length;
  const intensity = normalizedPower / workout.ftp_watts;
  const kilojoules = workout.steps.reduce((total, step) => {
    let averagePower;
    if (step.kind === 'free') {
      averagePower = 0.7 * workout.ftp_watts;
    } else if (step.kind === 'steady') {
      averagePower = step.watts;
    } else {
      averagePower = (step.start_watts + step.end_watts) / 2;
    }
    return total + (step.seconds * averagePower) / 1000;
  }, 0);
  return { intensity, kilojoules };
}
