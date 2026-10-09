// f creds — store credentials in ~/.f/f.creds.enc, protected by a passkey-derived
// key. Unlock spawns a daemon that holds the key in memory and serves ops over a
// unix socket until TTL expires. Zero deps.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import readline from "node:readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const F = path.join(process.env.HOME ?? "", ".f");
const CREDS = path.join(F, "f.creds.enc");
const SOCKET = path.join(F, ".creds.sock");
const LOCKFILE = path.join(F, ".creds-daemon");
const DAEMON = path.join(__dirname, "daemon.js");
const DEFAULT_TTL = 600; // 10 min

function ensureFDir() {
  fs.mkdirSync(F, { recursive: true });
}

function readLockfile() {
  try {
    return JSON.parse(fs.readFileSync(LOCKFILE, "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function unlockedState() {
  const lf = readLockfile();
  if (!lf || !lf.pid || !pidAlive(lf.pid)) return null;
  const now = Date.now();
  const expires = lf.start + lf.ttl * 1000;
  if (now >= expires) return null; // expired (daemon will clean itself up)
  return { remainingMs: expires - now, socket: lf.socket, pid: lf.pid };
}

/** Talk to the daemon over the socket. Returns the JSON response. */
function daemonCall(req, socketPath = SOCKET) {
  return new Promise((resolve, reject) => {
    const client = net.connect(socketPath, () => {
      client.write(JSON.stringify(req));
    });
    let buf = "";
    client.on("data", (c) => (buf += c));
    client.on("end", () => {
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(e);
      }
    });
    client.on("error", reject);
  });
}

async function promptPasskey() {
  // Read the passkey from the TTY in raw mode without echoing it.
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    const line = await new Promise((r) => rl.question("f: passkey: ", (a) => { rl.close(); r(a); }));
    return line;
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    process.stderr.write("f: passkey: ");
    let buf = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
    };
    const onData = (ch) => {
      const s = ch.toString();
      for (const c of s) {
        if (c === "\n" || c === "\r") {
          cleanup();
          process.stderr.write("\n");
          resolve(buf);
          return;
        }
        if (c === "\x7f" || c === "\x08") {
          if (buf.length) buf = buf.slice(0, -1);
        } else if (c === "\x03") {
          cleanup();
          process.stderr.write("\n");
          process.exit(1);
        } else {
          buf += c;
        }
      }
    };
    stdin.on("data", onData);
  });
}

/** Prompt for a value from the TTY (no echo). Reuses the passkey raw-mode
 *  pattern; returns the typed string, or null on Ctrl-C. */
async function promptVisible(label) {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    const line = await new Promise((r) => rl.question(label, (a) => { rl.close(); r(a); }));
    return line;
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    process.stderr.write(label);
    let buf = "";
    const cleanup = (done) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      if (done) process.stderr.write("\n");
    };
    const onData = (ch) => {
      const s = ch.toString();
      for (const c of s) {
        if (c === "\n" || c === "\r") { cleanup(true); resolve(buf); return; }
        if (c === "\x7f" || c === "\x08") { if (buf.length) buf = buf.slice(0, -1); }
        else if (c === "\x03") { cleanup(true); resolve(null); }
        else { buf += c; }
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * A prompt function for `fill`. In a TTY, prompts interactively (no echo).
 * In non-TTY (piped), reads one line per call from a SINGLE shared readline so
 * a piped multi-line input fills multiple waiters in sequence. */
function makeFillPrompt() {
  if (process.stdin.isTTY) {
    // Interactive: prompt one at a time, no echo.
    return (label) => promptVisible(label);
  }
  // Non-TTY (piped): read all of stdin up front, serve one line per prompt.
  // This makes `printf 'V1\nV2\n' | f creds fill` fill multiple waiters.
  const lines = [];
  let buf = "";
  const done = new Promise((res) => {
    if (!process.stdin.readable) return res();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    process.stdin.on("end", () => { if (buf) lines.push(buf); res(); });
  });
  let idx = 0;
  return async (label) => {
    process.stderr.write(label);
    await done;
    const v = idx < lines.length ? lines[idx++] : "";
    return v;
  };
}

async function unlock(passkeyArg, ttl) {
  ensureFDir();
  const existing = unlockedState();
  if (existing) {
    process.stderr.write(`f: already unlocked (${fmt(existing.remainingMs)} left)\n`);
    return true;
  }
  const passkey = passkeyArg ?? (await promptPasskey());
  if (!passkey) {
    process.stderr.write("f: no passkey\n");
    return false;
  }
  // Spawn daemon detached; passkey via stdin (not argv).
  const child = spawn(process.execPath, [DAEMON, "--socket", SOCKET, "--lockfile", LOCKFILE, "--ttl", String(ttl ?? DEFAULT_TTL), "--creds", CREDS], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.write(passkey);
  child.stdin.end();
  child.unref();
  // Wait briefly for the socket to come up.
  await waitForSocket(SOCKET, 2000);
  return true;
}

function lock() {
  const lf = readLockfile();
  if (!lf || !pidAlive(lf.pid)) {
    process.stderr.write("f: not unlocked\n");
    for (const f of [SOCKET, LOCKFILE]) try { fs.unlinkSync(f); } catch {}
    return;
  }
  process.kill(lf.pid, "SIGTERM");
  process.stderr.write("f: locked\n");
}

async function requireUnlocked() {
  const state = unlockedState();
  if (!state) {
    process.stderr.write("f: creds locked. Run `f creds unlock`\n");
    process.exit(1);
  }
  return state;
}

async function op(name, value) {
  const state = await requireUnlocked();
  const resp = await daemonCall({ op: name, name: value?.name, value: value?.value }, state.socket);
  if (!resp.ok) {
    process.stderr.write(`f: ${resp.error}\n`);
    process.exit(1);
  }
  return resp;
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/** Shared waiter registry (on disk, visible across processes). A uck that
 *  calls wait() records itself here; `f creds waiters`/`fill` in another
 *  terminal read it. Lives at ~/.f/.creds-waiters.json. */
const WAITERS = path.join(process.env.HOME ?? "", ".f", ".creds-waiters.json");

function readWaiters() {
  try { return JSON.parse(fs.readFileSync(WAITERS, "utf8")); } catch { return {}; }
}
function writeWaiters(obj) {
  try {
    fs.mkdirSync(path.dirname(WAITERS), { recursive: true });
    fs.writeFileSync(WAITERS, JSON.stringify(obj, null, 2));
  } catch {}
}
function addWaiter(name, by) {
  const w = readWaiters();
  w[name] = { startedAt: Date.now(), by: by ?? "unknown" };
  writeWaiters(w);
}
function clearWaiter(name) {
  const w = readWaiters();
  if (name in w) { delete w[name]; writeWaiters(w); }
}

/**
 * Wait for a cred to be available, blocking up to `timeout` ms.
 *
 * Polls every `pollMs` (default 500ms). Each tick:
 *   - if the daemon is locked (not running), keep waiting — the user needs to
 *     run `f creds unlock` in another terminal first;
 *   - if unlocked, check whether the cred is set; if so, fetch and return it.
 * Resolves to the cred's value the moment both conditions are met. Rejects with
 * a clear error if `timeout` elapses. This is the mechanism that lets an LLM
 * uck ask for a credential and block while the user supplies it elsewhere.
 * While waiting, the request is recorded in the shared waiter registry so the
 * human can `f creds waiters` / `f creds fill` in another terminal.
 */
async function wait(name, { timeout = 300000, pollMs = 500, onPoll, by } = {}) {
  const deadline = Date.now() + timeout;
  // Helper: does the cred exist right now (daemon must be up)?
  async function tryGet() {
    const state = unlockedState();
    if (!state) return null; // locked
    const r = await daemonCall({ op: "get", name }, state.socket);
    if (r && r.ok && r.value != null && r.value !== "") return r.value;
    return null;
  }
  // Immediate check first (no delay if already present).
  let v;
  try { v = await tryGet(); } catch { v = null; }
  if (v != null) return v;

  // Not yet available — register as a waiter so it shows in `f creds waiters`.
  addWaiter(name, by);
  try {
    while (Date.now() < deadline) {
      const remainMs = deadline - Date.now();
      const sleepMs = Math.min(pollMs, remainMs);
      if (onPoll) {
        try { onPoll(remainMs); } catch {}
      }
      await new Promise((r) => setTimeout(r, sleepMs));
      try { v = await tryGet(); } catch { v = null; }
      if (v != null) return v;
    }
    throw new Error(
      `timed out after ${fmt(timeout)} waiting for cred '${name}' — ` +
      `run in another terminal: f creds unlock && f creds set ${name} <value>`
    );
  } finally {
    clearWaiter(name);
  }
}

export function register(ctx) {
  return {
    name: "creds",
    desc: "store credentials (scrypt+AES-GCM, daemon+socket, ttl)",
    skills: [{ name: "f-creds", path: path.join(__dirname, "SKILL.md") }],
    // Programmatic entry for other ucks.
    credsApi: {
      async get(name, ttl) {
        const state = unlockedState();
        if (!state) throw new Error("creds locked");
        const r = await daemonCall({ op: "get", name }, state.socket);
        if (!r.ok) throw new Error(r.error);
        return r.value;
      },
      async set(name, value) {
        const state = unlockedState();
        if (!state) throw new Error("creds locked");
        await daemonCall({ op: "set", name, value }, state.socket);
      },
      async ls() {
        const state = unlockedState();
        if (!state) throw new Error("creds locked");
        const r = await daemonCall({ op: "ls" }, state.socket);
        return r.names ?? [];
      },
      /**
       * Wait for a cred, blocking up to timeout (default 5 min). Resolves to the
       * value the moment it's set (and the daemon is unlocked). Rejects on
       * timeout. opts: { timeout (ms), pollMs, onPoll(remainMs) }.
       * Usage from a uck: const token = await credsApi.wait("forgejo.kensand.net", { timeout: 300000 });
       */
      wait(name, opts) {
        return wait(name, opts);
      },
      /** List open waiting requests (name + startedAt + by). From another
       *  terminal, so the human knows what to fill in. */
      waiters() {
        const w = readWaiters();
        return Object.entries(w).map(([name, m]) => ({
          name,
          waitingMs: Date.now() - (m.startedAt ?? Date.now()),
          by: m.by ?? "unknown",
        }));
      },
      unlock,
      lock,
      status: () => {
        const s = unlockedState();
        return s ? { unlocked: true, remainingMs: s.remainingMs } : { unlocked: false };
      },
    },
    run: (argv, args) => {
      const pos = [];
      let ttl = DEFAULT_TTL;
      let timeoutSec = 300; // default wait window for `request`
      let showSecrets = false;
      const a = [...(args._ ?? [])];
      for (let i = 0; i < a.length; i++) {
        if (a[i] === "--ttl") {
          ttl = Number(a[i + 1]);
          i++;
        } else if (a[i] === "--timeout") {
          timeoutSec = Number(a[i + 1]);
          i++;
        } else if (a[i] === "--secrets") {
          showSecrets = true;
        } else pos.push(a[i]);
      }
      const redact = (value) =>
        showSecrets ? String(value) : `[redacted — pass --secrets to reveal]`;
      const [cmd, ...rest] = pos;

      (async () => {
        switch (cmd) {
          case "unlock":
            await unlock(rest[0], ttl);
            break;
          case "lock":
            lock();
            break;
          case "status": {
            const s = unlockedState();
            process.stdout.write(s ? `unlocked (${fmt(s.remainingMs)} left)\n` : "locked\n");
            break;
          }
          case "set": {
            const [name, ...valParts] = rest;
            if (!name || valParts.length === 0) return usage("set requires <name> <value>");
            await op("set", { name, value: valParts.join(" ") });
            break;
          }
          case "get": {
            const r = await op("get", { name: rest[0] });
            if (r.value != null) process.stdout.write(redact(r.value) + "\n");
            break;
          }
          case "request": {
            const name = rest[0];
            if (!name) return usage("request requires <name>");
            const timeoutMs = timeoutSec * 1000;
            process.stderr.write(`f: waiting for cred '${name}' up to ${fmt(timeoutMs)}… (set it in another terminal: f creds set ${name} <value>)\n`);
            const value = await wait(name, { timeout: timeoutMs, by: "f creds request" });
            if (showSecrets) process.stdout.write(value + "\n");
            else process.stderr.write(`f: cred '${name}' available (pass --secrets to print)\n`);
            break;
          }
          case "waiters": {
            const ws = readWaiters();
            const entries = Object.entries(ws);
            if (entries.length === 0) {
              process.stdout.write("(no open waiting requests)\n");
              break;
            }
            for (const [name, m] of entries) {
              const waited = Date.now() - (m.startedAt ?? Date.now());
              process.stdout.write(`${name}\t[${fmt(waited)}]\tby: ${m.by ?? "unknown"}\n`);
            }
            break;
          }
          case "fill": {
            // Cycle through open waiting requests (or just the named one),
            // prompting for each value and setting it. This is the human's
            // "fill in what the LLM asked for" action in the other terminal.
            const only = rest[0] ?? null;
            const ws = readWaiters();
            const names = only ? [only] : Object.keys(ws);
            if (names.length === 0) {
              process.stdout.write(only ? `f: '${only}' is not waiting (or no waiters)\n` : "(nothing waiting to fill)\n");
              break;
            }
            const ask = makeFillPrompt(); // one prompt fn for the whole session
            for (const name of names) {
              const meta = ws[name];
              process.stderr.write(`\nf: fill '${name}'${meta ? ` (waiting ${fmt(Date.now() - (meta.startedAt ?? Date.now()))}, by ${meta.by ?? "unknown"})` : ""}\n`);
              const value = await ask(`f: ${name}: `);
              if (value == null || value === "") {
                process.stderr.write(`f: (skipped '${name}')\n`);
                continue;
              }
              // Setting requires the daemon unlocked; `set` already errors if locked.
              const state = await requireUnlocked();
              await daemonCall({ op: "set", name, value }, state.socket);
              clearWaiter(name);
              process.stderr.write(`f: set '${name}'\n`);
            }
            break;
          }
          case "ls": {
            const r = await op("ls", {});
            for (const n of r.names ?? []) process.stdout.write(n + "\n");
            break;
          }
          case "rm": {
            await op("rm", { name: rest[0] });
            break;
          }
          default:
            usage();
        }
      })().catch((e) => {
        process.stderr.write(`f: ${e.message}\n`);
        process.exit(1);
      });
    },
  };
}

function waitForSocket(p, ms) {
  const start = Date.now();
  return new Promise((resolve) => {
    const try_ = () => {
      if (fs.existsSync(p)) return resolve();
      if (Date.now() - start > ms) return resolve();
      setTimeout(try_, 50);
    };
    try_();
  });
}

function usage(msg) {
  const line = msg ? `f: ${msg}\n` : "";
  process.stderr.write(
    line +
      "usage: f creds <cmd>\n" +
      "  unlock [passkey] [--ttl sec]   start daemon (default ttl 600s)\n" +
      "  lock                            stop daemon, zeroize key\n" +
      "  status                          locked / unlocked + time left\n" +
      "  set <name> <value>              store a cred\n" +
      "  get <name> [--secrets]          print a cred (redacted without --secrets)\n" +
      "  request <name> [--timeout sec]  block until the cred is set elsewhere,\n" +
      "                                    then print it (default 300s; also waits\n" +
      "                                    for unlock if the daemon is locked;\n" +
      "                                    add --secrets to print, else confirm only)\n" +
      "  waiters                         list open waiting requests (from other\n" +
      "                                    terminals' f fj / ucks that are blocked)\n" +
      "  fill [name]                     prompt + set value(s) for the open\n" +
      "                                    waiters (or just <name>); unblocks them\n" +
      "  ls                              list names\n" +
      "  rm <name>                       remove a cred\n"
  );
  process.exit(1);
}

export default { register };
