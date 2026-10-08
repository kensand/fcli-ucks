#!/usr/bin/env node
// f creds daemon — holds the derived key in memory, serves ops over a unix socket,
// auto-exits after TTL. Zero deps (node:crypto, node:net, node:fs).

import crypto from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const args = {};
const FLAG_KEYS = ["socket", "lockfile", "ttl", "creds", "salt"];
for (let i = 0; i < argv.length; i++) {
  const k = argv[i].replace(/^--/, "");
  if (FLAG_KEYS.includes(k) && i + 1 < argv.length) {
    args[k] = argv[i + 1];
    i++;
  }
}

const SOCKET = args.socket;
const LOCKFILE = args.lockfile;
const CREDS = args.creds;
const TTL_SEC = Number(args.ttl) || 600;

// Read passkey from stdin (never argv — argv is visible in ps).
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

// Derive a 32-byte key from passkey + salt via scrypt (slow KDF).
function deriveKey(passkey, salt) {
  return crypto.scryptSync(passkey, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 1 << 29 });
}

// Creds file format: { salt: base64, entries: { name: { nonce, tag, data } } }
// We store the salt in a plaintext header (it's not secret) + the entries encrypted.
function loadCredsBox() {
  if (!fs.existsSync(CREDS)) return { salt: crypto.randomBytes(16).toString("base64"), entries: {} };
  const raw = JSON.parse(fs.readFileSync(CREDS, "utf8"));
  return { salt: raw.salt, entries: raw.entries ?? {} };
}
function saveCredsBox(box, key) {
  // Re-encrypt is per-entry at set time; here we just persist the box as-is.
  fs.writeFileSync(CREDS, JSON.stringify(box, null, 2), { mode: 0o600 });
}

// Per-value encryption: AES-256-GCM. key is 32 bytes.
function encValue(key, value) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const data = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce: nonce.toString("base64"), tag: tag.toString("base64"), data: data.toString("base64") };
}
function decValue(key, entry) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(entry.nonce, "base64")
  );
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(entry.data, "base64")), decipher.final()]);
  return plain.toString("utf8");
}

let key = null;
let box = null;

const server = net.createServer((socket) => {
  let buf = "";
  socket.on("data", (c) => {
    buf += c;
    let req;
    try {
      req = JSON.parse(buf);
    } catch {
      return; // wait for full message
    }
    buf = "";
    let resp;
    try {
      switch (req.op) {
        case "ls":
          resp = { ok: true, names: Object.keys(box.entries) };
          break;
        case "get": {
          const e = box.entries[req.name];
          if (!e) resp = { ok: false, error: `no such cred: ${req.name}` };
          else resp = { ok: true, value: decValue(key, e) };
          break;
        }
        case "set":
          box.entries[req.name] = encValue(key, req.value);
          saveCredsBox(box, key);
          resp = { ok: true };
          break;
        case "rm": {
          if (!(req.name in box.entries)) resp = { ok: false, error: `no such cred: ${req.name}` };
          else {
            delete box.entries[req.name];
            saveCredsBox(box, key);
            resp = { ok: true };
          }
          break;
        }
        default:
          resp = { ok: false, error: `unknown op: ${req.op}` };
      }
    } catch (e) {
      resp = { ok: false, error: e.message };
    }
    socket.end(JSON.stringify(resp));
  });
  socket.on("error", () => {});
});

function shutdown() {
  try {
    server.close();
    if (key) {
      key.fill(0); // zeroize
      key = null;
    }
    for (const f of [SOCKET, LOCKFILE]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const passkey = await readStdin().then((s) => s.trim());
if (!passkey) {
  process.stderr.write("daemon: no passkey\n");
  process.exit(1);
}

box = loadCredsBox();
key = deriveKey(passkey, box.salt);
// Zeroize the passkey string's backing as soon as we can (strings are immutable in JS,
// but we drop all references immediately).
// (Note: JS strings can't be truly zeroized; the daemon keeps no further refs.)

server.listen(SOCKET, () => {
  fs.writeFileSync(
    LOCKFILE,
    JSON.stringify({ pid: process.pid, start: Date.now(), ttl: TTL_SEC, socket: SOCKET }),
    { mode: 0o600 }
  );
});

// Auto-exit after TTL.
const timer = setTimeout(shutdown, TTL_SEC * 1000);
timer.unref();

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    // Another daemon already owns the socket; clean up and exit.
    try {
      fs.unlinkSync(LOCKFILE);
    } catch {}
    process.exit(0);
  }
  throw e;
});
