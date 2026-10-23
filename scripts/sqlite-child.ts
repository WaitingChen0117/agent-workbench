import { SQLiteTaskStore } from "@/lib/agent/task/sqlite-task-store";

/**
 * 跨进程验证用的独立子进程脚本（由 task-sqlite-evaluate 通过 child_process 启动）。
 * 用法：tsx scripts/sqlite-child.ts <mode> <dbPath>
 *   create-task  —— 直接用 SQLiteTaskStore 创建一个任务，打印 {taskId}
 *   create-running —— 创建并置为 running，打印 {taskId}
 *   run-task     —— 走真实 Runtime（需 AGENT_TASK_STORE=sqlite）跑完一个任务，打印 {taskId}
 */
async function main(): Promise<void> {
  const mode = process.argv[2];
  const dbPath = process.argv[3];

  if (mode === "create-task" || mode === "create-running") {
    const store = new SQLiteTaskStore(dbPath);
    const task = await store.create({
      messages: [{ role: "user", content: "cross-process" }],
      maxSteps: 5,
    });
    if (mode === "create-running") {
      await store.transition(task.id, "running");
    }
    console.log(JSON.stringify({ taskId: task.id }));
  } else if (mode === "run-task") {
    const { createAndRunTask } = await import("@/lib/agent/task/runtime");
    const { task } = await createAndRunTask({
      messages: [{ role: "user", content: "用一句话打个招呼。" }],
    });
    console.log(JSON.stringify({ taskId: task.id }));
  } else {
    console.error("unknown mode");
    process.exit(2);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
