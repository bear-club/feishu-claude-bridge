import "dotenv/config";
import { wsClient, dispatcher, setMessageHandler } from "./feishu.js";
import { checkClaudeCli } from "./preflight.js";
import { getDefaultCwd } from "./path-guard.js";
import { handleMessage } from "./handler.js";

async function main() {
  console.log("=== Feishu Claude Bridge ===");

  // REVIEW #11: CLI 前置检查
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

main();
