# f — how to use it

`f` is a token-efficient CLI. Short ucks, minimal output, no boilerplate.
This is the default skill — read it to get oriented, then `f help` for the
live list of ucks.

## The basics

- `f <uck> [args]` — run a uck. `f help` lists every available uck.
- `f v` — print f's version.
- Ucks are units of functionality. Core ships a few; the rest come from
  uck sources (repos, local paths, npm packages) installed into your store.

## Skills

A **skill** is a named pointer to a local markdown file — a chunk of
instructions you can pull into context on demand. Skills live in
`f.config.json`'s `skills` array.

- `f skills` — show this default skill.
- `f skills ls` — list your skills (name + path).
- `f skills show <name>` — print a skill's markdown (read it).
- `f skills search <query>` — find skills relevant to a query (searches the
  names and contents of your configured skills).
- `f skills add <name> <path>` — register a skill (path to a local .md).
- `f skills rm <name>` — remove a skill.
- Add `-g` to any of these to target the global `~/.f/f.config.json` instead
  of the project `f.config.json`.

## Finding other skills

`f skills search <query>` ranks your configured skills by how relevant their
name and file content are to the query. It's local and offline — it searches
what you have. To get more skills:

1. A skill is just an `.md` file + a config entry. Drop a markdown file
   somewhere (e.g. `~/.f/skills/foo.md`) and `f skills -g add foo ~/.f/skills/foo.md`.
2. Shared skill sets ship in uck repos. Add a repo as a source (see `f help` /
   the ucks repo) and its skills become searchable the same way.

Keep skills terse and focused — each one is meant to be read into an LLM's
context when needed, not up front.
