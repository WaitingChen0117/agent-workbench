/**
 * Next.js instrumentation hook —— 进程启动时执行一次 Agent Runtime 初始化（Task Recovery）。
 * 只在 Node.js runtime 执行；recovery 内部幂等且不会因失败拖垮应用。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const { initializeAgentRuntime } = await import(
    "@/lib/agent/task/recovery"
  );
  await initializeAgentRuntime();
}
