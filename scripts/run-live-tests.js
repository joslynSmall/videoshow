import { spawnSync } from "node:child_process";

// `RUN_LIVE_TESTS=1 node --test` 是 POSIX 写法，cmd/PowerShell 不支持，这里用脚本跨平台设置环境变量。
const result = spawnSync(process.execPath, ["--test"], {
  stdio: "inherit",
  env: { ...process.env, RUN_LIVE_TESTS: "1" },
});
process.exit(result.status ?? 1);
