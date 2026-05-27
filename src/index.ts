import "dotenv/config";
import { wsClient, dispatcher, setMessageHandler } from "./feishu.js";
import { checkClaudeCli } from "./preflight.js";
import { getDefaultCwd } from "./path-guard.js";
import { handleMessage, activeControllers } from "./handler.js";

async function main() {
  console.log("=== Feishu Claude Bridge ===");

  try {
    const version = await checkClaudeCli();
    console.log(`Claude CLI: ${version}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const defaultCwd = getDefaultCwd();
  console.log(`默认工作目录: ${defaultCwd}`);

  setMessageHandler(handleMessage);

  wsClient.start({ eventDispatcher: dispatcher });
  console.log("WebSocket 客户端已启动，等待消息...");
}

function shutdown() {
  console.log("\n正在关闭...");
  for (const [, controller] of activeControllers) {
    controller.abort();
  }
  activeControllers.clear();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main();
