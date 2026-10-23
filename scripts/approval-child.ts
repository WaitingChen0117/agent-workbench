/**
 * 跨进程验证用的独立子进程脚本（由 approval-persistence-evaluate 通过 child_process 启动）。
 * 用法：tsx scripts/approval-child.ts <mode> ...args
 *   create-approval <dbPath>
 *     —— 直接用 SQLite 创建一个 task + pending approval（不注册进程内 waiter），
 *        打印 {taskId, approvalId}
 *   setup-waiting <dbPath> <toolName> <inputB64>
 *     —— 创建 task 并置为 waiting，再创建对应 pending approval，
 *        打印 {taskId, approvalId}
 *   apply <action>
 *     —— 读 env（AGENT_TASK_STORE/AGENT_APPROVAL_STORE/AGENT_TASK_DB_PATH）后
 *        调用 Runtime.applyApprovalDecision，等待 resume 完成，打印 {ok, status}
 *
 * apply 模式故意走真实 Runtime（含 MCP 工具解析），模拟「进程重启后无 waiter 的 resume」。
 */
import { SQLiteTaskStore } from "@/lib/agent/task/sqlite-task-store";
import { SQLiteApprovalStore } from "@/lib/agent/approval/sqlite-approval-store";

async function main(): Promise<void> {
  const mode = process.argv[2];

  if (mode === "create-approval") {
    const dbPath = process.argv[3];
    const taskStore = new SQLiteTaskStore(dbPath);
    const approvalStore = new SQLiteApprovalStore(dbPath);
    const task = await taskStore.create({
      messages: [{ role: "user", content: "cross-process-approval" }],
      maxSteps: 5,
    });
    const approval = await approvalStore.create({
      taskId: task.id,
      toolName: "writeFile",
      input: { path: "tmp-approval-x.txt", content: "x" },
    });
    console.log(JSON.stringify({ taskId: task.id, approvalId: approval.id }));
  } else if (mode === "setup-waiting") {
    const dbPath = process.argv[3];
    const toolName = process.argv[4];
    const input = JSON.parse(
      Buffer.from(process.argv[5], "base64").toString("utf-8"),
    );
    const taskStore = new SQLiteTaskStore(dbPath);
    const approvalStore = new SQLiteApprovalStore(dbPath);
    const task = await taskStore.create({
      messages: [{ role: "user", content: `需要审批后执行 ${toolName}` }],
      maxSteps: 5,
    });
    // running → waiting：模拟「等待人工审批时进程被重启」
    await taskStore.transition(task.id, "running");
    await taskStore.transition(task.id, "waiting");
    const approval = await approvalStore.create({
      taskId: task.id,
      toolName,
      input,
    });
    console.log(JSON.stringify({ taskId: task.id, approvalId: approval.id }));
  } else if (mode === "apply") {
    const action = process.argv[3] as "approve" | "reject";
    const taskId = process.argv[4];
    const approvalId = process.argv[5];
    const { applyApprovalDecision } = await import("@/lib/agent/task/runtime");
    const result = await applyApprovalDecision(taskId, approvalId, action);
    console.log(JSON.stringify(result));
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
