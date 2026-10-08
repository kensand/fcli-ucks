import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const require = createRequire(import.meta.url);
const { JSONPath } = require("jsonpath-plus");

/** Resolve the config file for a target: "project" | "global" | explicit path. */
function resolveTarget(target) {
  if (target && target !== "project" && target !== "global") {
    return target; // explicit path
  }
  if (target === "global") {
    return join(process.env.HOME ?? "", ".f", "f.config.json");
  }
  // project: walk up from cwd
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const p = join(dir, "f.config.json");
    if (existsSync(p)) return p;
    dir = join(dir, "..");
  }
  // No project config found — default to creating in cwd.
  return join(process.cwd(), "f.config.json");
}

function readDoc(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeDoc(path, doc) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
}

/** Parse a value: try JSON first, fall back to raw string. */
function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Core ops. target: "project" | "global" | explicit path. */
const configApi = {
  /** Read the whole doc (or a path). Returns the natural value (no extra array wrap). */
  get(target, path) {
    const file = resolveTarget(target);
    const doc = readDoc(file);
    if (!path) return doc;
    const res = JSONPath({ path, json: doc, wrap: true });
    if (!Array.isArray(res) || res.length === 0) return null;
    // unwrap single match to its natural value; keep arrays for multi-match
    return res.length === 1 ? res[0] : res;
  },

  /** Set a value at a JSONPath. Creates intermediate objects as needed. */
  set(target, path, value) {
    const file = resolveTarget(target);
    const doc = readDoc(file);
    const val = parseValue(String(value));
    applySet(doc, path, val);
    writeDoc(file, doc);
    return val;
  },

  /** Append a value into an array at a JSONPath (ucks[$] style). */
  add(target, path, value) {
    const file = resolveTarget(target);
    const doc = readDoc(file);
    const val = parseValue(String(value));
    applyAdd(doc, path, val);
    writeDoc(file, doc);
    return val;
  },

  /** Remove matches at a JSONPath. */
  remove(target, path) {
    const file = resolveTarget(target);
    const doc = readDoc(file);
    const n = applyRemove(doc, path);
    writeDoc(file, doc);
    return n;
  },

  /** List the whole doc (alias for get with no path). */
  list(target) {
    return this.get(target);
  },
};

/** Set via resultType all (parent + parentProperty). */
function applySet(doc, path, value) {
  // If the path selects nothing, create it by walking segments.
  const existing = JSONPath({ path, json: doc, wrap: true });
  if (Array.isArray(existing) && existing.length > 0) {
    const all = JSONPath({ path, json: doc, resultType: "all" });
    for (const item of all) {
      if (item.parent && item.parentProperty != null) {
        item.parent[item.parentProperty] = value;
      }
    }
    return;
  }
  // Create intermediate structure then assign leaf.
  setPathCreate(doc, path, value);
}

/** Walk a simple dotted/bracketed path, creating objects/arrays, set leaf. */
function setPathCreate(doc, path, value) {
  const segments = parseSegments(path);
  let cur = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (cur[seg] == null) {
      // Infer array vs object from next segment.
      const next = segments[i + 1];
      cur[seg] = /^\d+$/.test(next) || next === "$" ? [] : {};
    }
    cur = cur[seg];
  }
  const leaf = segments[segments.length - 1];
  if (Array.isArray(cur) && (leaf === "$" || /^\d+$/.test(leaf))) {
    if (leaf === "$") cur.push(value);
    else cur[Number(leaf)] = value;
  } else {
    cur[leaf] = value;
  }
}

/** Append into an array. Path must select an array (e.g. "ucks" or "ucks[$]"). */
function applyAdd(doc, path, value) {
  // Strip trailing [$] if present.
  const clean = path.replace(/\[\$\]$/, "");
  const res = JSONPath({ path: clean, json: doc, wrap: true });
  if (Array.isArray(res) && res.length > 0) {
    for (const arr of res) {
      if (Array.isArray(arr)) arr.push(value);
    }
    return;
  }
  // Path points to a non-array or nothing — create array via create path.
  setPathCreate(doc, clean, undefined);
  const again = JSONPath({ path: clean, json: doc, wrap: true });
  if (Array.isArray(again) && again.length > 0 && Array.isArray(again[0])) {
    again[0].push(value);
  }
}

/** Remove all matches. Returns count removed. */
function applyRemove(doc, path) {
  // Collect parents+indices for array elements, or keys for object props.
  const all = JSONPath({ path, json: doc, resultType: "all" });
  let removed = 0;
  for (const item of all) {
    if (item.parent == null) continue;
    const pp = item.parentProperty;
    if (Array.isArray(item.parent)) {
      const idx = Number(pp);
      if (Number.isInteger(idx) && idx >= 0 && idx < item.parent.length) {
        item.parent.splice(idx, 1);
        removed++;
      }
    } else if (typeof item.parent === "object" && pp in item.parent) {
      delete item.parent[pp];
      removed++;
    }
  }
  return removed;
}

/** Parse a path into segments: "ucks[2].source" -> ["ucks","2","source"]; "ucks" -> ["ucks"]. */
function parseSegments(path) {
  const segs = [];
  const re = /([^.[\]]+)|\[(\d+|\$)\]/g;
  let m;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) segs.push(m[1]);
    else segs.push(m[2]);
  }
  return segs;
}

/** The uck. */
export function register(ctx) {
  return {
    name: "config",
    desc: "edit f.config.json via JSONPath (get/set/add/remove/list)",
    // Programmatic entry: other ucks can do require("@fcli/config").configApi
    configApi,
    run: (argv, args) => {
      const flags = [];
      const pos = [];
      for (const a of args._ ?? []) (a === "-g" ? flags : pos).push(a);
      const target = flags.includes("-g") ? "global" : "project";

      const [op, path, value] = pos;
      if (!op) return usage();

      switch (op) {
        case "get":
          if (!path) return usage("get requires a path (or omit for whole doc)");
          print(configApi.get(target, path));
          break;
        case "list":
          print(configApi.list(target));
          break;
        case "set":
          if (!path || value == null) return usage("set requires <path> <value>");
          configApi.set(target, path, value);
          break;
        case "add":
          if (!path || value == null) return usage("add requires <path> <value>");
          configApi.add(target, path, value);
          break;
        case "remove":
          if (!path) return usage("remove requires a path");
          configApi.remove(target, path);
          break;
        default:
          usage();
      }
    },
  };
}

function print(v) {
  process.stdout.write(typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n");
}

function usage(msg) {
  const line = msg ? `f: ${msg}\n` : "";
  process.stderr.write(
    line +
      "usage: f config [-g] <op> <path> [value]\n" +
      "  ops: get | set | add | remove | list\n" +
      "  -g  target global ~/.f/f.config.json (default: project f.config.json)\n" +
      "  e.g. f config add ucks github:user/repo\n" +
      "       f config set ucks[0] ./my-uck\n" +
      "       f config remove 'ucks[?(@.source==\"./old\")]'\n"
  );
  process.exit(1);
}

export default { register, configApi };
