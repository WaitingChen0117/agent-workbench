# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

### Removed

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
