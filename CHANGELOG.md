# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

### Removed

## [1.12.0] - 2026-10-27 — Persistence Reliability + Incremental Trace + Cleanup

### Added

- Incremental Trace persistence: `TraceStore` gains `createTrace` / `appendStep` (per-event, SQLite-assigned sequence via `BEGIN IMMEDIATE` + `MAX(sequence)+1`, idempotent by `stepId`) / `updateSummary`; `putTrace` kept as a compatibility layer. Collector now appends per open/close span instead of rewriting the whole trace each event.
- Persistence cleanup trigger: `getPersistenceCleanupConfig()` (`AGENT_PERSISTENCE_CLEANUP_ENABLED`, default **false**); startup trigger in `initializeAgentRuntime` (globalThis-guarded, failure-safe, logs `[agent-cleanup] scanned/deleted/skipped`); lightweight SQLite lock (`agent_persistence_locks`) so concurrent processes don't double-clean (`cleanupExpiredData({ lock: true })`).
- Pagination: shared `ListOptions`/`PageResult` + cursor helpers (`clampLimit` max 100 / default 20, base64url cursor, `InvalidCursorError`). `TaskStore.listPage`, `WorkflowExecutionStore.listPage`, `TraceStore.listPage`, `SessionStore.getMessagesPage` — all real SQLite `LIMIT` with stable `ORDER BY … DESC, id DESC` (messages by sequence ASC). Existing `list()`/`getMessages()` full-read kept (Resume uses full-read).
- SQLite reliability: `withBusyRetry` (max 3, short backoff) + `tx()` (BEGIN IMMEDIATE → COMMIT / ROLLBACK) in `persistence/sqlite-util.ts`, applied to trace writes.
- Persistence health: `getPersistenceHealth()` + `GET /api/agent/persistence/health` (read-only; backend/available/schemaReady/databaseFile basename + cleanup config; no secrets).
- Evaluation: `persistence:reliability:evaluate` (18 cases) + `data/persistence-reliability-evaluation.json`.

### Changed

- Trace collector routes through the incremental `TraceStore` API; `resumeTrace` continues appending to the same `traceId` (no second trace) with sequence continuing from the persisted max.
- `cleanupExpiredData` accepts `{ lock }`; returns `locked: true` when another process holds the cleanup lock.

### Security

- Cleanup still deletes only terminal (completed/failed/cancelled) data older than the TTL cutoff; never running/waiting tasks, pending approvals, active workflows, or waiting/active sessions. Default-off prevents accidental deletion on upgrade.
- Trace persistence re-applies `redactSecrets` before writing (no token/authorization/api_key/password/secret persisted); health diagnostics expose no secrets and only a path basename.
- Persistence errors surface distinctly from business rejections (Guard-denied is never masked as a SQLite error); transactions roll back on failure (no half-writes); busy retry is bounded (never infinite/long-blocking).
- No new infrastructure: Node built-in `node:sqlite` + existing Event Bus only; git push stays mocked in evaluation.

## [1.11.0] - 2026-10-26 — Workflow Agent Node Resume + Trace Persistence + Persistence Cleanup

### Added

- Workflow **Agent Node** cross-process Full Resume: a workflow Agent Node now reuses the Phase 10.4 AgentSession (the workflow task gets a 1:1 Session) and the injectable Agent Loop runner — no second Agent Loop. After a restart, approving re-enters the SAME loop (`executeApprovedToolToSession` → `continueAgentNode`), which may raise further approvals and only completes the node when the agent returns a final answer, then continues the DAG.
- Exported reusable resume primitive `executeApprovedToolToSession` (re-guard → resolveTools → execute once → append sanitized result to Session); shared by Agent Session resume and Workflow Agent Node resume.
- Trace persistence: `TraceStore` abstraction + `MemoryTraceStore` + `SQLiteTraceStore` + `getTraceStore()` (`AGENT_TRACE_STORE=memory|sqlite`, default memory, reuses `AGENT_TASK_DB_PATH`). Tables `agent_traces` + `agent_trace_steps` (ORDER BY sequence). `resumeTrace()` re-attaches the collector in a new process so resume events join the same trace.
- Persistence cleanup/TTL: `cleanupExpiredData()` + `getTtlDays()` (`AGENT_PERSISTENCE_TTL_DAYS`, default 7); deletes only terminal data older than the cutoff across Trace/Session/Approval/WorkflowExecution(+nodes)/Task(+events); idempotent.
- Evaluations: `workflow:agent-resume:evaluate` (12), `trace:persistence:evaluate` (10), `persistence:cleanup:evaluate` (10), with `scripts/workflow-agent-child.ts` and `scripts/trace-child.ts` (real cross-process, deterministic stub runner).

### Changed

- `createAndStartWorkflowTask` creates a Session for the workflow task; `runAgentNode` runs the agent loop over that Session via `getAgentLoopRunner()` (gated tools) instead of calling `streamAgent` directly.
- `resumeWorkflowExecution` handles `agent` nodes (previously `RESUME_UNSUPPORTED`) by delegating to the Agent Session resume path and continuing the DAG on completion.
- Trace collector routes through `TraceStore` and re-persists the whole trace after each event (SQLite snapshot stays current for cross-process reads); trace API reads from the store.
- Crash recovery already covers workflow agent nodes (running → failed `workflow_running_recovery`; waiting + pending approval → kept `workflow_approval_waiting`; waiting + no approval → failed `workflow_missing_approval`).

### Security

- Resume still re-runs `preApprovalGuard` and `resolveTools`; Guard-denied → `RESUME_GUARD_DENIED`, no tool execution. Agent Node never bypasses Permission Gate / ApprovalStore / Tool Resolver.
- Execute-once preserved via atomic `ApprovalStore.resolve`: duplicate/concurrent approve never re-executes a tool (no duplicate file write / git add / push).
- Trace persistence re-applies `redactSecrets` before writing to SQLite (token/authorization/api_key/password/secret never persisted); SQLite is treated as a sensitive boundary, not just the UI.
- Cleanup never deletes running/waiting tasks, pending approvals, active workflow executions, or waiting/active sessions.
- No new infrastructure: Node built-in `node:sqlite` + existing Event Bus only; git push stays mocked in evaluation.

## [1.10.0] - 2026-10-26 — Workflow Execution Persistence + Full Workflow Resume

### Added

- `WorkflowExecutionStore` abstraction + `MemoryWorkflowExecutionStore` + `getWorkflowExecutionStore()` (backend via `AGENT_WORKFLOW_EXECUTION_STORE`, default `memory`; independent of `AGENT_TASK_STORE`).
- `SQLiteWorkflowExecutionStore` reusing the Task DB (`AGENT_TASK_DB_PATH`): tables `agent_workflow_executions` (+ task_id/workflow_id/status indexes) and `agent_workflow_node_executions` (PRIMARY KEY(execution_id, node_id)); JSON fields (error/context/result/definition) stored as TEXT. WAL mode.
- Per-node execution persistence (`WorkflowNodeExecution`: pending/running/waiting/completed/failed, result, approvalId link, condition branch, attempt) and Workflow context persisted after every node.
- `resumeWorkflowExecution(executionId)` + `rejectWorkflowExecution(executionId)`: cross-process Full Workflow Resume — re-run Guard, execute the approved tool exactly once, restore context, continue the DAG from the next node; completed nodes and already-computed conditions are never re-run.
- Engine resume support (`runWorkflow(..., { resumeFromNodeId })`) and persistence hooks (`persistNodeRunning/Completed/Failed`, `persistExecution`).
- `GET /api/agent/workflows/:executionId/nodes` (per-node execution state). Workflow evaluation: `data/workflow-persistence-evaluation.json`, `scripts/workflow-persistence-evaluate.ts`, `scripts/workflow-child.ts`, and `workflow:persistence:evaluate` (14 cases, real cross-process).

### Changed

- Workflow Engine now persists execution/node/context through `WorkflowExecutionStore` as it runs; same-process blocking-approval behavior is unchanged.
- `GET /api/agent/workflows/:executionId` and the workflow eval scripts read from the persistent store (async) instead of the in-memory map.
- `applyApprovalDecision` routes workflow tasks to `resumeWorkflowExecution`/`rejectWorkflowExecution`; non-workflow tasks still use Agent Session resume.
- Crash recovery (`recovery.ts`) also scans workflow executions: running → failed (`workflow_running_recovery`); waiting + pending approval → kept waiting (`workflow_approval_waiting`); waiting + no approval → failed (`workflow_missing_approval`); idempotent. Workflow tasks are handled by the workflow pass (not double-processed by the task pass).

### Security

- Persistence is a sensitive boundary: node results and context pass through `sanitizeToolOutput`; approval input is read from the ApprovalStore (not re-stored in the workflow); no token/secret/authorization persisted.
- Resume never bypasses the permission system: it re-runs `preApprovalGuard` and `resolveTools`, and only executes an already-atomically-approved tool once (execute-once preserved; Guard-denied → `RESUME_GUARD_DENIED`, no execution).
- Workflow recovery never auto-reruns a `running` execution (unknown side-effect state). Agent nodes inside a workflow are not cross-process resumable and fail cleanly as `RESUME_UNSUPPORTED` (no `tool.started`, no side effect).
- No new infrastructure: Node built-in `node:sqlite` + existing Event Bus only.

## [1.9.0] - 2026-10-23 — Agent Session Persistence + Full Resume

### Added

- `AgentSession` data model (`src/lib/agent/session/types.ts`): reuses `AgentMessage`; adds `AgentSessionMessage` and `AgentSessionPendingAction` (the tool call awaiting approval), plus `sanitizePendingInput` / `sanitizeMessageContent`.
- `SessionStore` abstraction + `MemorySessionStore` + `getSessionStore()` (backend chosen only here via `AGENT_SESSION_STORE`, same style as Task/Approval stores).
- `SQLiteSessionStore`: reuses the Task DB (`AGENT_TASK_DB_PATH`); tables `agent_sessions` (task_id UNIQUE → 1:1), `agent_session_messages` (PRIMARY KEY(session_id, sequence), sequence taken in a transaction), `agent_session_pending_actions` (approval_id UNIQUE → one pending action per approval).
- Injectable Agent Loop runner seam (`setAgentLoopRunner` / `getAgentLoopRunner`); production default stays `streamAgent` (real LLM). First run and resume share the same runner — no second Agent Loop.
- Full cross-process resume (`resumeAgentSession` + `reenterAgentLoop`): approve → execute the approved tool once → append the tool result to the Session → **re-enter the same Agent Loop** (LLM re-inference, may request further tools → new approval → waiting again) until a final answer.
- Session API: `GET /api/agent/tasks/:taskId/session` (sanitized full history) and `/session/summary` (counts + pendingTool/pendingApprovalId).
- Session evaluation: `data/session-persistence-evaluation.json`, `scripts/session-persistence-evaluate.ts`, `scripts/session-child.ts` (deterministic injectable stub runner, real cross-process). New `session:persistence:evaluate` CLI (14 cases).

### Changed

- Task creation now creates a 1:1 Session and persists the initial user message(s). The Permission Gate persists a sanitized pending action and syncs the Session to `waiting`; approve/reject/complete/fail/cancel all sync Session status.
- Approval resume now re-enters the Agent Loop instead of only executing one tool and finishing (Phase 10.3 → 10.4). `applyApprovalDecision` approve path calls `resumeAgentSession`; `resumeApprovedTool` was replaced.
- Crash recovery (`recovery.ts`) syncs Session status alongside Task status; `waiting` + pending approval stays resumable, idempotent `task.recovered` unchanged.
- Resume guard-denied code renamed to `RESUME_GUARD_DENIED` (was `RESUME_DENIED`).

### Security

- Session is treated as a sensitive boundary: messages are sanitized before persistence (`sanitizeMessageContent`); pending-action input is sanitized (`sanitizePendingInput`) — **writeFile content is never stored in the Session** (resume reads the real input from the already-persisted ApprovalStore record).
- Resume always re-runs `preApprovalGuard` and `resolveTools`; a denied guard ends the task as `failed` (`RESUME_GUARD_DENIED`), never executing the tool.
- Execute-once preserved: the atomic `ApprovalStore.resolve` guarantees a tool runs at most once across duplicate/concurrent approvals (no duplicate file write / git add / push).
- Non-resumable approvals (e.g. Workflow in-memory executions) fail cleanly as `RESUME_UNSUPPORTED` before any transition or `tool.started`.
- No new infrastructure: SQLite + existing Event Bus only.

## [1.8.0] - 2026-10-23 — Persistent Approval + Task Resume

### Added

- `ApprovalStore` abstraction (`src/lib/agent/approval/approval-store.ts`): persist Approval **state** (`pending`/`approved`/`rejected`) separately from the non-persistable in-process waiting Promise.
- `SQLiteApprovalStore` (`node:sqlite`, reuses the same DB file as tasks): table `agent_approvals` + `idx_approvals_task`; `resolve()` is atomic (`BEGIN IMMEDIATE`) so a given approval can only be resolved once (execute-once guarantee).
- `MemoryApprovalStore` + `getApprovalStore()` factory selecting the backend via `AGENT_APPROVAL_STORE` (+ `AGENT_TASK_DB_PATH`).
- `ApprovalWaiter` registry (`src/lib/agent/approval/waiter.ts`): in-process `register/has/resolveWaiter` for same-process approval wake-up.
- Real cross-process **Task Resume**: `applyApprovalDecision()` + `resumeApprovedTool()` in Runtime — after a restart (no waiter), approving a `waiting` task re-runs the pre-approval Guard and executes the single approved tool exactly once, then completes the task; rejecting cancels it.
- Approval persistence evaluation (`data/approval-persistence-evaluation.json`, `scripts/approval-persistence-evaluate.ts`, `scripts/approval-child.ts`) with 12 cases incl. real cross-process verification, plus the `approval:persistence:evaluate` CLI.

### Changed

- `src/lib/agent/approvals.ts` is now a thin facade over `ApprovalStore` + `ApprovalWaiter`: `createApproval`/`getApproval`/`listApprovals` are **async**; the atomic `resolveApprovalState` replaces the old sync `resolveApproval`.
- Approval API routes and all evaluation scripts migrated to `await getApproval`/`listApprovals` and the unified `applyApprovalDecision(taskId, approvalId, action)` entry point.
- `approval.approved`/`approval.rejected` events are now emitted solely by `applyApprovalDecision` (removed from the Permission Gate) to avoid double emission.
- Recovery semantics: `waiting` + pending approval → **kept waiting** (truly resumable, emits `task.recovered` with reason `approval_waiting`); `waiting` without a pending approval → safely `failed`. `RecoveryResult` gains a `keptWaiting` counter.

### Security

- Permission Approval is still not a security bypass: resume re-runs `preApprovalGuard` before executing the approved tool; a denied guard ends the task as `failed` (`RESUME_DENIED`).
- Execute-once is enforced at the store layer (atomic `resolve`), so duplicate/concurrent approvals never produce duplicate side effects.
- Non-resumable approvals (e.g. Workflow in-memory executions) fail cleanly as `RESUME_UNSUPPORTED` **before** any state transition or `tool.started`, so no partial side effect is attempted.
- Approval `input` persisted to SQLite is the Guard-validated tool input; sanitize rules are unchanged for API responses.

## [1.7.0] - 2026-10-23 — SQLite Task Persistence + Crash Recovery

### Added

- `SQLiteTaskStore` (based on Node built-in `node:sqlite`, no extra dependency).
- SQLite schema: `agent_tasks` + `agent_task_events` (PRIMARY KEY(task_id, sequence) for strictly increasing event order).
- Task/Event persistence across process restarts.
- Memory/SQLite store selection via `AGENT_TASK_STORE` (+ `AGENT_TASK_DB_PATH`), resolved inside `getTaskStore()`.
- Task Resume / Crash Recovery (`recoverTasks` / `initializeAgentRuntime`) + Next instrumentation hook.
- `task.recovered` event.
- SQLite persistence & recovery evaluation (`data/task-sqlite-evaluation.json`) and the `task:sqlite:evaluate` CLI (with real cross-process verification).

### Changed

- `TaskStore` now has a real persistent backend; Runtime uses SQLite only via `getTaskStore()` (no memory/sqlite branching in Runtime).
- SSE replay reads events from the persistent Event Store, still ordered by sequence.
- Task lifecycle remains managed solely through the Store; `transition` stays atomic (SQLite transaction) and goes through the existing state machine.

### Security

- Recovery never re-executes a `running` task (no duplicate side effects) — it is safely ended as `failed`.
- `waiting`/approval tasks are never auto-approved after restart; they are safely ended as `failed` ("Approval state lost after process restart").
- Persisted data follows existing sanitize rules (events are sanitized upstream before storage); no tokens/credentials written to SQLite.

## [1.6.0] - 2026-10-23 — Task Persistence

### Added

- `TaskStore` abstraction (async create/get/update/transition/delete/list + event storage).
- `MemoryTaskStore` (globalThis-backed Map, async API simulating future persistence).
- Task Persistence Evaluation (`data/task-persistence-evaluation.json`) and the `task:persistence:evaluate` CLI.

### Changed

- Task Runtime no longer touches `globalThis`/`Map` directly; it depends on `TaskStore`.
- Task lifecycle state changes (created/running/waiting/completed/failed/cancelled) all go through the Store.
- Task APIs (`GET /api/agent/tasks/:taskId`, stream, approvals, trace) read task state from the Store.
- `createAndStartTask` / `createAndStartWorkflowTask` are now async (await the store).
- `transition` is idempotent for same-state (repeated cancel no longer errors).

## [1.5.0] - 2026-10-23 — Git Push + Human Approval

### Added

- `gitPush` MCP tool (`git push origin <branch>` only).
- Git Push Evaluation (`data/git-push-evaluation.json`) and the `git:push:evaluate` CLI.
- Coding Agent Git Push workflow (push behind approval).

### Changed

- Git push integrated with the Permission Gate + Human Approval.
- Workflow Tool Node supports `gitPush` (still approval-gated).
- Coding Skill documents the controlled Git Push rules.

### Security

- `gitPush` requires Human Approval.
- Only the `origin` remote is allowed.
- No force push, no branch deletion, no `-u`/upstream, no arbitrary git arguments.
- Invalid remote / branch (bad chars, `-` prefix, non-existent) rejected before approval.
- No shell execution (structured `execFile` args); push output truncated; token never exposed.

## [1.4.0] - 2026-10-23 — GitHub Read-only MCP

### Added

- `github-mcp` Server (stdio, remote GitHub REST API client).
- `githubRepo`, `githubIssues`, `githubIssue`, `githubPullRequests`, `githubPullRequest` (all read-only).
- GitHub MCP Evaluation (`data/github-evaluation.json`) and the `github:evaluate` CLI.
- GitHub read-only Agent integration (Coding Skill updated).

### Changed

- MCP Client now supports filesystem + git + github servers (independent lazy singletons).
- Tool Resolver automatically exposes GitHub tools alongside local/filesystem/git tools.
- Coding Skill documents GitHub read-only capabilities.

### Security

- GitHub MCP is read-only (no create/merge/comment/review/push).
- GitHub API access restricted to api.github.com; no arbitrary HTTP / fetchUrl.
- Tool input is structured (owner/repo from env, number validated); no user-supplied URLs.
- `GITHUB_TOKEN` is used only in the Authorization header and never enters tool input/output, trace, events, approvals, prompts, or logs.
- Issue/PR body length limits; missing token fails gracefully (success:false) without crashing /api/agent.

## [1.3.0] - 2026-10-23 — Git Write MCP

### Added

- `gitAdd` and `gitCommit` on the Git MCP (fixed `git add -- <paths>` / `git commit -m`, no shell).
- Pre-approval Guard: sensitive paths, traversal, bulk add, and invalid commit messages are denied before an approval is created.
- Git Write Evaluation (`data/git-write-evaluation.json`) and the `git:write:evaluate` CLI.
- Coding skill rules for staging and committing only through `gitAdd` / `gitCommit`.

### Changed

- `gitAdd` and `gitCommit` require human approval; commit does not auto-stage.
- A rejected tool approval keeps the workflow `cancelled` instead of overwriting it as `failed`.

### Security

- `gitAdd` rejects bulk paths (`.`, `*`, `-A`), option-like paths, path traversal, and sensitive files.
- Commit messages must be a single non-empty line of at most 200 characters.
- Approval cannot bypass the pre-approval guard.

## [1.2.0] - 2026-10-23 — Git Read-only MCP

### Added

- Git MCP Server (`git-mcp`, stdio).
- `gitStatus`, `gitDiff`, `gitLog`, `gitBranch`, `gitShow` (all read-only).
- Git MCP tool integration (multi-server MCP client).
- Git Evaluation (`data/git-evaluation.json`) and the `git:evaluate` CLI.

### Changed

- Tool Resolver now merges Local + Filesystem MCP + Git MCP tools.
- Coding Agent can inspect repository state through Git MCP (no approval needed).

### Security

- Git operations restricted to the workspace (repository must live inside it).
- Read-only Git tool allowlist; no generic runGitCommand.
- No arbitrary git command execution (add/commit/push/reset/checkout/... not exposed).
- No shell execution (execFile with shell:false, structured args).
- Diff/log/show output size limits (maxBytes / maxLines / file counts).
- Git ref validation blocks option injection; sensitive keys sanitized in traces.

## [1.1.0] - 2026-10-23 — Agent Workflow / DAG Runtime

### Added

- Workflow Definition (nodes + edges + version).
- Workflow Validator (DAG, unique start, reachability, maxSteps).
- Workflow Engine (node orchestration + context).
- Agent Node, Tool Node, Approval Node, Condition Node, End Node.
- Workflow Execution + Workflow Context.
- Workflow Events (workflow.started / node.started / node.completed / node.failed / completed / failed).
- Workflow API (`POST /api/agent/workflows/run`, `GET /api/agent/workflows/:executionId`).
- Workflow Evaluation with 10 cases and the `workflow:evaluate` CLI.
- Trace steps can now carry workflowId / executionId / nodeId.

### Changed

- Agent Runtime can execute structured workflows inside a Task.
- Workflow Nodes reuse existing Agent / Tool / Permission / Approval / Trace infrastructure.

### Security

- Workflow cannot bypass the Permission Gate (writeFile / runCommand still require approval).
- No arbitrary JavaScript execution (no eval / Function; conditions are declarative field/operator/value).
- No arbitrary shell execution (commands still go through the allowlist).
- Workflow DAG validation (cycles, missing nodes, unreachable nodes rejected).
- maxSteps execution limit prevents runaway workflows.

## [1.0.0] - 2026-10-23 — Agent Trace + Observability + Evaluation

### Added

- Added Agent Trace (a persisted, aggregated view of a task's execution).
- Added a Trace Collector that builds traces by subscribing to the Event Bus.
- Added an in-memory Trace Store that survives task completion.
- Added the Trace API (`GET /api/agent/tasks/:taskId/trace`).
- Added the Trace Summary API (`GET /api/agent/tasks/:taskId/trace/summary`).
- Added tool execution tracing (duration, status, sanitized input/output).
- Added approval tracing (wait duration, approved/rejected).
- Added LLM step tracing (latency; token usage only when the provider reports it).
- Added derived Agent Metrics (task/agent/tool/approval/llm).
- Added Agent Evaluation with 5 cases (`data/agent-evaluation.json`).
- Added the `agent:evaluate` CLI.

### Changed

- Agent Event now feeds the Trace Collector.
- Agent execution can be inspected after completion via the Trace API.

### Security

- Added Trace data sanitization.
- Avoid persisting file contents (writeFile keeps only path + bytesWritten).
- Avoid persisting sensitive command output (truncated previews, redacted secret keys).

## [0.9.0] - 2026-10-22 — Coding Agent MVP

### Added

- Added a Coding Agent MVP (Read → Analyze → Edit → Test → Fix loop).
- Added the `writeFile` MCP tool.
- Added controlled command execution (`runCommand`) with a structured program/args interface.
- Added an Agent Permission Policy (allow vs approval_required per tool).
- Added human-in-the-loop approval with a lifecycle-aware `AgentApproval`.
- Added the Approval API (`GET /approvals`, `POST /approvals/:id`).
- Added the `coding` Skill.
- Added a `/api/health` endpoint plus a basic test (first real Coding Agent task).

### Changed

- Agent Loop now supports paused execution and approval-based resumption
  (running → waiting → running/cancelled).
- Tool execution now passes through permission checks before running.

### Security

- Restricted file modification to the workspace root.
- Restricted command execution through an allowlist (structured args, no shell).
- Blocked shell-injection patterns in commands.
- Blocked sensitive file access (`.env*`, keys, `.ssh`/`.aws`/`.config`) even inside the workspace.
- Required approval before any file modification or command execution.

## [0.8.0] - 2026-10-22 — MCP + Skills

### Added

- Added a minimal `filesystem-mcp` MCP Server (stdio transport).
- Added filesystem tools: `listFiles`, `readFile`, `searchFiles`.
- Added an MCP Client that connects the Agent Runtime to the MCP Server.
- Added unified Local/MCP tool resolution via a Tool Resolver.
- Added Skill Discovery (`discoverSkills`).
- Added Skill Loading from `.agent/skills/<name>/SKILL.md`.
- Added the `knowledge-research` Skill.
- Added filesystem security validation (workspace-root sandbox).

### Changed

- Agent tool architecture now supports Local Tools and MCP Tools behind a single
  interface; the Agent Loop no longer needs to know a tool's origin.

### Security

- Restricted filesystem tools to the workspace root.
- Prevented path traversal (`../`) and absolute-path access, plus symlink escape.
