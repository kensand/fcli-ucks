// f skills — manage skill entries in f.config.json's `skills` array.
//
// A skill is a named pointer to a local markdown file:
//   { "name": "git-flow", "path": "~/.f/skills/git-flow.md" }
//
// Skills are config entries (like ucks), but the content stays a plain .md
// on disk. `f skills show <name>` prints that file so an LLM can read it on
// demand without loading it into context up front.
//
// A default skill (default.md, shipped in this uck) is registered into the
// global config on first install — just like every other skill, but seeded
// automatically. `f skills` (no op) shows it.
//
// `f skills search <query>` ranks your configured skills by relevance to the
// query (name + file content). Local and offline.
//
// Targeting matches the config uck: project f.config.json by default, `-g`
// for global ~/.f/f.config.json.
//
// Zero deps (node:fs, node:path, node:url).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute dir of this uck (where default.md lives in the store). */
const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MD = join(here, "default.md");

/** Expand a leading ~ to $HOME. */
function resolve(p) {
  if (typeof p === "string" && (p === "~" || p.startsWith("~/"))) {
    return join(process.env.HOME ?? "", p.slice(1));
  }
  return p;
}

/** Resolve the config file for a target: "project" | "global". */
function resolveTarget(target) {
  if (target === "global") return join(process.env.HOME ?? "", ".f", "f.config.json");
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const p = join(dir, "f.config.json");
    if (existsSync(p)) return p;
    dir = join(dir, "..");
  }
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

/** Get the skills array from a doc (creating it if absent). */
function skillsOf(doc) {
  if (!Array.isArray(doc.skills)) doc.skills = [];
  return doc.skills;
}
function findSkill(doc, name) {
  return skillsOf(doc).find((s) => s.name === name) ?? null;
}

/**
 * First install: if the global config has no 'default' skill, seed one
 * pointing at this uck's default.md. Idempotent — never clobbers existing
 * skills. Runs at register() (store is already populated by then).
 */
function ensureDefaultSkill() {
  if (!existsSync(DEFAULT_MD)) return;
  try {
    const file = join(process.env.HOME ?? "", ".f", "f.config.json");
    const doc = readDoc(file);
    const arr = skillsOf(doc);
    if (!arr.some((s) => s.name === "default")) {
      arr.push({ name: "default", path: DEFAULT_MD });
      writeDoc(file, doc);
    }
  } catch {}
}

/** Read a skill's content string, or null if absent/missing. */
function readSkillContent(s) {
  const p = resolve(s.path);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Rank skills (name + content) by relevance to a query. Returns scored list. */
function searchSkills(query) {
  const q = String(query).toLowerCase().trim();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  // Search both global and project skills (de-dup by name, project wins).
  const doc = { skills: [] };
  for (const target of ["global", "project"]) {
    const d = readDoc(resolveTarget(target));
    for (const s of skillsOf(d)) {
      const i = doc.skills.findIndex((x) => x.name === s.name);
      if (i >= 0) doc.skills[i] = s;
      else doc.skills.push(s);
    }
  }
  const scored = [];
  for (const s of doc.skills) {
    const name = String(s.name ?? "").toLowerCase();
    const content = (readSkillContent(s) ?? "").toLowerCase();
    let score = 0;
    for (const t of terms) {
      // Name matches weigh more than content.
      if (name === t) score += 5;
      else if (name.includes(t)) score += 3;
      if (content.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ name: s.name, path: s.path, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored;
}

/** Core ops. */
const skillsApi = {
  add(target, name, path) {
    const file = resolveTarget(target);
    const doc = readDoc(file);
    const arr = skillsOf(doc);
    const entry = { name, path: String(path) };
    const i = arr.findIndex((s) => s.name === name);
    if (i >= 0) arr[i] = entry;
    else arr.push(entry);
    writeDoc(file, doc);
    return entry;
  },
  rm(target, name) {
    const file = resolveTarget(target);
    const doc = readDoc(file);
    const arr = skillsOf(doc);
    const i = arr.findIndex((s) => s.name === name);
    if (i < 0) return false;
    arr.splice(i, 1);
    writeDoc(file, doc);
    return true;
  },
  ls(target) {
    // Project skills, then global skills not already listed — so the
    // auto-seeded 'default' (a global skill) shows up even from a project.
    const out = [];
    const seen = new Set();
    const targets = target === "global" ? ["global"] : ["project", "global"];
    for (const t of targets) {
      for (const s of skillsOf(readDoc(resolveTarget(t)))) {
        if (seen.has(s.name)) continue;
        seen.add(s.name);
        out.push(s);
      }
    }
    return out;
  },
  /** Resolve a skill's content, or a status object. Project first, then global. */
  show(target, name) {
    for (const t of [target, "global"]) {
      const s = findSkill(readDoc(resolveTarget(t)), name);
      if (s) {
        const content = readSkillContent(s);
        if (content == null) return { name, path: s.path, missing: true };
        return { name, path: s.path, content };
      }
    }
    return null;
  },
  search(query) {
    return searchSkills(query);
  },
};

function print(v) {
  process.stdout.write(typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n");
}
function usage(msg) {
  const line = msg ? `f: ${msg}\n` : "";
  process.stderr.write(
    line +
      "usage: f skills [-g] <op> [args]\n" +
      "  ops:\n" +
      "    (none)              show the default skill\n" +
      "    search <query>      find relevant skills (name + content)\n" +
      "    ls                  list skills (name + path)\n" +
      "    show <name>         print a skill's markdown content\n" +
      "    add <name> <path>   add/update a skill (path to a local .md)\n" +
      "    rm  <name>          remove a skill\n" +
      "  -g  target global ~/.f/f.config.json (default: project f.config.json)\n" +
      "  e.g. f skills search git\n" +
      "       f skills show default\n"
  );
  process.exit(1);
}

export function register(ctx) {
  ensureDefaultSkill();
  return {
    name: "skills",
    desc: "manage local skill entries (search/ls/show/add/rm) in f.config.json",
    skillsApi,
    run: (argv, args) => {
      const flags = [];
      const pos = [];
      for (const a of args._ ?? []) (a === "-g" ? flags : pos).push(a);
      const target = flags.includes("-g") ? "global" : "project";
      const [op, a, b] = pos;

      // Bare `f skills` → show the default skill.
      if (!op) {
        const r = skillsApi.show("global", "default");
        if (r && !r.missing) return process.stdout.write(r.content);
        return usage();
      }

      switch (op) {
        case "search": {
          if (!a) return usage("search requires <query>");
          const results = skillsApi.search(a);
          if (results.length === 0) return process.stdout.write("");
          for (const r of results)
            process.stdout.write(`${r.score}\t${r.name}\t${r.path}\n`);
          break;
        }
        case "ls": {
          const list = skillsApi.ls(target);
          if (list.length === 0) return process.stdout.write("");
          for (const s of list) process.stdout.write(`${s.name}\t${s.path}\n`);
          break;
        }
        case "show": {
          if (!a) return usage("show requires <name>");
          const r = skillsApi.show(target, a);
          if (r == null) {
            process.stderr.write(`f: no skill '${a}'\n`);
            process.exit(1);
          }
          if (r.missing) {
            process.stderr.write(`f: skill '${a}' path not found: ${r.path}\n`);
            process.exit(1);
          }
          process.stdout.write(r.content);
          break;
        }
        case "add":
          if (!a || !b) return usage("add requires <name> <path>");
          skillsApi.add(target, a, b);
          break;
        case "rm":
          if (!a) return usage("rm requires <name>");
          if (!skillsApi.rm(target, a)) {
            process.stderr.write(`f: no skill '${a}'\n`);
            process.exit(1);
          }
          break;
        default:
          usage();
      }
    },
  };
}

export default { register, skillsApi };
