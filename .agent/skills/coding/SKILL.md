# Coding Skill

## Skill Name

coding

## Description

指导 Agent 在当前仓库内安全地完成编码类任务（新增/修改代码并验证），遵循 Read → Analyze → Edit → Test → Fix 闭环，且在产生副作用前必须获得人工审批。

## When to use

- 用户要求新增功能、修改代码、修复 bug、补测试等需要改动仓库文件的任务。
- 不适用于：纯知识问答（用 knowledge-research）、无需改动代码的咨询。

## Workflow

1. 理解用户请求，明确目标与范围。
2. 用 listFiles / searchFiles 勘察仓库结构，定位相关位置。
3. 用 readFile 读取相关文件，理解现有约定与风格。
4. 形成最小化实现方案（优先复用现有代码与模式）。
5. 在修改文件前，通过 writeFile 发起操作（会触发审批）。
6. 获批后应用改动。
7. 在执行命令前，通过 runCommand 发起（会触发审批）。
8. 运行验证（如 `npx tsc --noEmit`、`pnpm lint`、`npx tsx <test>`）。
9. 分析失败原因。
10. 修复问题（必要时再次 writeFile）。
11. 重新运行验证直到通过。
12. 输出修改摘要：改了哪些文件、原因、测试命令与测试结果。

## Available Tools

- 只读：listFiles、readFile、searchFiles（可直接使用）。
- 副作用：writeFile、runCommand（执行前必须审批）。
- 可选：searchKnowledge、getCurrentTime。

## Expected Output

- 清晰的修改摘要：文件列表、修改原因、验证命令与结果。
- 对未完成或失败项如实说明。

## Constraints

- 先理解、先搜索、先读取，不要凭空修改。
- 修改文件前必须获得审批；执行命令前必须获得审批。
- 改动尽量最小化，匹配现有风格，不做无关重构。
- 禁止删除文件、改动 workspace 外内容、执行任意 shell、git push、读取 .env / 密钥等敏感文件。
- 命令仅限 allowlist（如 pnpm lint / pnpm build / npx tsc --noEmit / npx tsx <file>）。
- 修改后必须运行验证；验证失败需分析并修复。
