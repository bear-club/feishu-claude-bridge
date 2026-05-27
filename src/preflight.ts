import { execFile } from "child_process";

export function checkClaudeCli(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("claude", ["--version"], { timeout: 10000 }, (err, stdout) => {
      if (err) {
        reject(new Error(`Claude CLI 不可用: ${err.message}\n请确认已安装并登录 Claude Code`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}
