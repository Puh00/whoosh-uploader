import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { identity } from './api.js';
import { WhooshError } from './workout.js';

/**
 * Resolve the session-cache path from the environment and operating system.
 * @returns {string} Session filename; does not access the filesystem.
 */
export function authPath() {
  const base =
    process.env.WHOOSH_CONFIG_DIR ??
    (process.platform === 'win32'
      ? join(
          process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
          'whoosh-cli'
        )
      : join(
          process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
          'whoosh-cli'
        ));
  return join(base, 'session.auth.json');
}
/**
 * Protect or unprotect base64 data with Windows current-user DPAPI.
 * @param {string} value - Base64 input passed through a child process stdin.
 * @param {boolean} decrypt - Select unprotect instead of protect.
 * @returns {Promise<string>} Base64 output from the hidden PowerShell helper.
 * @throws {WhooshError} AUTH_STORE if the helper cannot start or complete.
 */
function dpapi(value, decrypt = false) {
  const operation = decrypt ? 'Unprotect' : 'Protect';
  // Pass session data through stdin, never through command-line arguments.
  const script = `
    Add-Type -AssemblyName System.Security
    $inputBase64 = [Console]::In.ReadToEnd()
    $inputBytes = [Convert]::FromBase64String($inputBase64)
    $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
    $outputBytes = [Security.Cryptography.ProtectedData]::${operation}($inputBytes, $null, $scope)
    [Console]::Out.Write([Convert]::ToBase64String($outputBytes))
  `;
  return new Promise((resolve, reject) => {
    const powershell = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    const child = spawn(
      powershell,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.resume();
    child.on('error', () =>
      reject(
        new WhooshError('AUTH_STORE', 'Could not start Windows DPAPI helper.')
      )
    );
    child.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(
          new WhooshError(
            'AUTH_STORE',
            'Windows could not protect or read this session. Sign in again.'
          )
        );
      }
    });
    // A failed child may close stdin early; its error/close handlers report failure.
    child.stdin.on('error', () => {});
    child.stdin.end(value);
  });
}
/**
 * Validate and persist a token, creating its cache directory if needed.
 * @param {string} token - Session JWT to store.
 * @returns {Promise<string>} Cache filename.
 * @throws {Error} On invalid tokens, protection failures, or filesystem errors.
 * Uses DPAPI on Windows and owner-only file permissions elsewhere.
 */
export async function saveToken(token) {
  identity(token);
  const file = authPath();
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
  const encoding = process.platform === 'win32' ? 'dpapi' : 'plain';
  const value =
    encoding === 'dpapi'
      ? await dpapi(Buffer.from(token).toString('base64'))
      : token;
  await writeFile(file, JSON.stringify({ encoding, value }), { mode: 0o600 });
  return file;
}
/**
 * Load a token from MYWHOOSH_TOKEN or the session cache and check its expiry.
 * @returns {Promise<string>} Session JWT; callers must not log it.
 * @throws {WhooshError} If authentication is missing, invalid, expired, or unreadable.
 */
export async function getToken() {
  if (process.env.MYWHOOSH_TOKEN) {
    identity(process.env.MYWHOOSH_TOKEN);
    return process.env.MYWHOOSH_TOKEN;
  }
  let data;
  try {
    data = JSON.parse(await readFile(authPath(), 'utf8'));
  } catch {
    throw new WhooshError(
      'AUTH_REQUIRED',
      'Run whoosh-uploader auth login, whoosh-uploader auth import, or set MYWHOOSH_TOKEN.'
    );
  }
  let token;
  if (data.encoding === 'dpapi' && process.platform === 'win32') {
    token = Buffer.from(await dpapi(data.value, true), 'base64').toString();
  } else if (data.encoding === 'plain' && process.platform !== 'win32') {
    token = data.value;
  } else {
    throw new WhooshError(
      'AUTH_STORE',
      'This session belongs to a different OS. Sign in on this OS.'
    );
  }
  identity(token);
  return token;
}
/**
 * Remove the local session cache, tolerating an already absent file.
 * @returns {Promise<void>} Does not revoke the remote session or clear environment variables.
 * @throws {Error} For filesystem errors other than ENOENT.
 */
export async function clearToken() {
  try {
    await unlink(authPath());
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }
}
/**
 * Open interactive browser sign-in and save the token once it appears.
 * @param {string} [channel] - chromium, chrome, or msedge; defaults to chromium.
 * @returns {Promise<object>} Sign-in status and session filename, never the token.
 * @throws {Error} If launch, navigation, login, or token storage fails.
 * Closes the browser on completion, cancellation, or the five-minute timeout.
 */
export async function login(channel) {
  const { chromium } = await import('playwright');
  let browser;
  const selected = channel ?? 'chromium';
  try {
    browser = await chromium.launch({
      headless: false,
      ...(selected === 'chromium' ? {} : { channel: selected })
    });
  } catch {
    throw new WhooshError(
      'BROWSER_UNAVAILABLE',
      'Run npx playwright@1.63.0 install chromium, or select an installed browser with --channel chrome or --channel msedge.'
    );
  }
  try {
    const page = await browser.newPage();
    await page.goto('https://workout.mywhoosh.com/auth');
    process.stderr.write(
      'Sign in to MyWhoosh in the opened browser. Complete any CAPTCHA yourself. The CLI will save the session token, not your password.\n'
    );
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      if (page.isClosed()) {
        throw new WhooshError('LOGIN_CANCELLED', 'Login browser closed.');
      }
      if (new URL(page.url()).origin === 'https://workout.mywhoosh.com') {
        const token = await page
          .evaluate(() => localStorage.getItem('user_auth_token'))
          .catch(() => null);
        if (token) {
          return { status: 'signed_in', session_file: await saveToken(token) };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new WhooshError(
      'LOGIN_TIMEOUT',
      'Login timed out after five minutes.'
    );
  } finally {
    await browser.close();
  }
}
