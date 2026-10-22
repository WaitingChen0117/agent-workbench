# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

### Removed

## [0.8.0] - 2026-10-22

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
