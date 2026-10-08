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

export function register(ctx) {
  return {
    name: "creds",
    desc: "store credentials (scrypt+AES-GCM, daemon+socket, ttl)",
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
      const a = [...(args._ ?? [])];
      for (let i = 0; i < a.length; i++) {
        if (a[i] === "--ttl") {
          ttl = Number(a[i + 1]);
          i++;
        } else pos.push(a[i]);
      }
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
            if (r.value != null) process.stdout.write(r.value + "\n");
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
      "  get <name>                      print a cred\n" +
      "  ls                              list names\n" +
      "  rm <name>                       remove a cred\n"
  );
  process.exit(1);
}

export default { register };
