import { execSync } from "node:child_process";

export function register(_ctx) {
  return {
    name: "ls",
    desc: "list files (terse, one per line)",
    run: (_argv, args) => {
      const target = (args._ ?? ["."])[0];
      try {
        const out = execSync(`ls -1 ${target}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        process.stdout.write(out);
      } catch (e) {
        if (e.stderr) process.stderr.write(e.stderr);
        process.exit(1);
      }
    },
  };
}
export default { register };
