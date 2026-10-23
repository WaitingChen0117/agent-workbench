# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

### Removed

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
