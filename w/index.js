import { execSync } from "node:child_process";

export function register(_ctx) {
  return {
    name: "w",
    desc: "locate binary (alias for which)",
    run: (_argv, args) => {
      const target = Array.isArray(args._) ? args._[0] : args._;
      if (!target || typeof target !== "string") {
        console.error("f: w requires a binary name, e.g. f w node");
        process.exit(1);
      }
      try {
        const out = execSync(`which ${target}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        console.log(out.trim());
      } catch {
        console.error(`f: ${target} not found`);
        process.exit(1);
      }
    },
  };
}
export default { register };
