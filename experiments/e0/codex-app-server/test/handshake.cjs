const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const readline = require("node:readline");

const timeoutMs = 10000;
const codex = process.env.A3_CODEX_BIN || "codex";

function waitFor(predicate, timeoutMs, child, messages) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for app-server response; received ${messages.length} JSON message(s)`));
    }, timeoutMs);

    const check = (message) => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      resolve(message);
    };

    child.on("app-server-message", check);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`app-server exited before responding (code=${code}, signal=${signal})`));
    });
  });
}

async function main() {
  const isolatedHome = await mkdtemp(join(tmpdir(), "a3-e0-b2-codex-home-"));
  const env = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "COMSPEC"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.CODEX_HOME = isolatedHome;
  env.USERPROFILE = isolatedHome;
  env.APPDATA = join(isolatedHome, "AppData", "Roaming");
  env.LOCALAPPDATA = join(isolatedHome, "AppData", "Local");

  let child;
  try {
    child = spawn(codex, ["app-server", "--listen", "stdio://"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const messages = [];
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        messages.push(message);
        child.emit("app-server-message", message);
      } catch {
        // Ignore non-protocol stdout so diagnostics cannot be mistaken for RPC messages.
      }
    });

    const stderr = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => stderr.push(chunk));

    await new Promise((resolve) => setTimeout(resolve, 200));
    const response = waitFor((message) => message.id === 1, timeoutMs, child, messages);
    child.stdin.write(`${JSON.stringify({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "a3", title: "A3", version: "0.1.0" },
        capabilities: {},
      },
    })}\n`);

    const initialized = await response;
    if (initialized.error) {
      throw new Error(`initialize returned an error: ${JSON.stringify(initialized.error)}`);
    }

    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.stdin.end();
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("app-server did not exit after stdin closed"));
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    if (exit.code !== 0) {
      throw new Error(`app-server exited unsuccessfully: ${JSON.stringify(exit)}; stderr=${stderr.join("").trim()}`);
    }

    process.stdout.write(`${JSON.stringify({
      result: "initialize succeeded without authentication or model inference",
      serverInfo: initialized.result?.serverInfo ?? null,
      initializeResultFields: Object.keys(initialized.result ?? {}),
      messagesReceived: messages.length,
      tokenVariablesPresent: false,
    }, null, 2)}\n`);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
    }
    await rm(isolatedHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
