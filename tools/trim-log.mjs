import { spawnSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const sepIdx = args.indexOf("--");
const maxLines = 45;

let raw = "";
let exitCode = 0;

if (sepIdx !== -1 && args[sepIdx + 1]) {
  const cmd = args[sepIdx + 1];
  const cmdArgs = args.slice(sepIdx + 2);
  const res = spawnSync(cmd, cmdArgs, { encoding: "utf8", shell: true });
  raw = (res.stdout || "") + "\n" + (res.stderr || "");
  exitCode = res.status ?? 1;
} else {
  raw = fs.readFileSync(0, "utf8");
}

const cleaned = raw
  .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
  .split(/\r?\n/)
  .map((l) => l.trimEnd())
  .filter((l) => l.trim().length > 0);

const deduped = [];
let repeat = 0;
for (const line of cleaned) {
  if (deduped.length > 0 && deduped[deduped.length - 1] === line) {
    repeat++;
  } else {
    if (repeat > 0) {
      deduped.push("... [repeated " + repeat + "x] ...");
      repeat = 0;
    }
    deduped.push(line);
  }
}

if (deduped.length > maxLines) {
  const head = deduped.slice(0, 12);
  const tail = deduped.slice(-(maxLines - 12));
  console.log([...head, "\n... [TRIMMED " + (deduped.length - maxLines) + " LINES TO SAVE TOKENS] ...\n", ...tail].join("\n"));
} else {
  console.log(deduped.join("\n"));
}

process.exit(exitCode);
