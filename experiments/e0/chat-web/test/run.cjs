const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-e0-b1-run-'));
const profile = path.join(tempRoot, 'electron-profile');
fs.mkdirSync(profile);
const executable = require('electron');
const interactive = process.argv.includes('--interactive');
const args = [root, ...(interactive ? [] : ['--self-test'])];
let stdout = '';
let stderr = '';

function removeTemporaryProfile(attempt = 0) {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (attempt >= 24) {
      console.error(`Could not remove spike-only temporary profile: ${tempRoot}: ${error.message}`);
      return false;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    return removeTemporaryProfile(attempt + 1);
  }
}

const child = spawn(executable, args, {
  cwd: root,
  env: { ...process.env, A3_E0_B1_PROFILE: profile },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: false,
});
child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('close', (code, signal) => {
  const report = stdout.match(/E0_B1_RESULT=(\{[^\r\n]+\})/);
  let reportOK = interactive;
  if (!interactive && report) {
    try { reportOK = JSON.parse(report[1]).pass === true; } catch { reportOK = false; }
  }
  const cleanupOK = removeTemporaryProfile();
  if (code !== 0 || signal || !reportOK || !cleanupOK) process.exitCode = 1;
  else if (!interactive) console.log('E0_B1_PROFILE_CLEANUP=passed');
});
