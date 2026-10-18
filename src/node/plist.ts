export const LABEL = "com.jobtracker.alerts";

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A launchd job that runs `npm run alerts` daily. It goes through a login shell
 * so node and npm are on PATH the same way they are in your Terminal.
 */
export function plistXml(projectDir: string, hour: number): string {
  const quoted = `'${projectDir.replace(/'/g, `'\\''`)}'`;
  const command = `cd ${quoted} && npm run alerts >> .data/alerts.log 2>&1`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xmlEsc(command)}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
</dict>
</plist>
`;
}
