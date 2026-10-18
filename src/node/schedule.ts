// Runs job alerts every day on your Mac, using launchd (macOS's built-in scheduler).
//   npm run alerts:install     run daily at ALERT_HOUR (default 19:00, 7 pm)
//   npm run alerts:uninstall   stop
// If the Mac is asleep at that time, launchd runs it when the Mac wakes up.
// Output goes to .data/alerts.log.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LABEL, plistXml } from "./plist.ts";

const projectDir = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const hour = Number(process.env.ALERT_HOUR ?? 19);

if (process.platform !== "darwin") {
  console.error("This scheduler is for macOS. On other systems, run `npm run alerts` from cron.");
  process.exit(1);
}

const unload = () => {
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
  } catch {
    /* not loaded */
  }
};

const cmd = process.argv[2];
if (cmd === "install") {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    console.error("ALERT_HOUR must be a whole number from 0 to 23.");
    process.exit(1);
  }
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(projectDir, ".data"), { recursive: true });
  writeFileSync(plistPath, plistXml(projectDir, hour));
  unload();
  execSync(`launchctl load -w "${plistPath}"`);
  console.log(`Job alerts will run every day at ${hour}:00. Log: ${join(projectDir, ".data", "alerts.log")}`);
} else if (cmd === "uninstall") {
  unload();
  if (existsSync(plistPath)) unlinkSync(plistPath);
  console.log("Daily job alerts stopped.");
} else {
  console.error("Usage: npm run alerts:install | npm run alerts:uninstall");
  process.exit(1);
}
