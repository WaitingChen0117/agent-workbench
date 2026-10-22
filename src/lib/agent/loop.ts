import {
  generateText,
  stepCountIs,
  streamText,
  type ModelMessage,
  type ToolSet,
} from "ai";

import { aiModel } from "@/lib/ai";
import { localTools } from "@/lib/agent/registry";

/**
 * 第二阶段 Agent Loop
 *
 * 执行模型：
 *   while (!finished) {
 *     LLM
 *       ├─ 没有 Tool Call → Final Answer，结束
 *       └─ 有 Tool Call  → 执行 Tool → Tool Result 回到 LLM
 *   }
 *   达到 MAX_AGENT_STEPS 仍未产出最终答案 → 抛出 Agent Loop Limit 错误
 *
 * 这里直接使用 AI SDK v7 generateText 的多步能力（stopWhen + stepCountIs）：
 * SDK 会在每一步把「assistant tool call」与「tool result」自动追加到
 * conversation context，再回传给 LLM，天然支持连续 Tool Call、同一轮多个
 * Tool Call 以及 Context 累积，无需手写 if/else 分发或 toolCalls[0]。
 */

export const MAX_AGENT_STEPS = 5;

// 达到步数上限但 LLM 仍想继续调用工具（没有产出最终答案）时抛出
export class AgentLoopLimitError extends Error {
  readonly steps: number;

  constructor(steps: number) {
    super(`Agent loop limit reached after ${steps} steps without a final answer`);
    this.name = "AgentLoopLimitError";
    this.steps = steps;
  }
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

// 单次工具调用的记录（跨所有 step 汇总），便于返回与 Trace
export interface AgentToolCall {
  step: number;
  tool: string;
  input: unknown;
  output: unknown;
}

export interface AgentResult {
  answer: string;
  toolCalls: AgentToolCall[];
  steps: number;
}

/**
 * Agent Loop 向外发出的细粒度事件。
 * Loop 只负责「发事件」，不负责记录日志 / Task 状态 —— 由上层（Task Runtime）消费。
 */
export type AgentLoopEvent =
  | { type: "agent.step.started"; step: number }
  | { type: "llm.requested"; step: number }
  | { type: "tool.started"; step: number; tool: string; input: unknown }
  | {
      type: "tool.completed";
      step: number;
      tool: string;
      success: boolean;
      output: unknown;
    }
  | { type: "agent.step.completed"; step: number; toolCalls: number }
  // LLM 最终文本的流式事件（streamAgent 才会产生真正的 token 级 delta）
  | { type: "message.started"; step: number }
  | { type: "message.delta"; step: number; content: string }
  | { type: "message.completed"; step: number };

export interface RunAgentOptions {
  messages: AgentMessage[];
  // 默认使用本地工具集；Runtime 会传入 Local + MCP 合并后的 ToolSet
  tools?: ToolSet;
  // 最大循环步数，默认 MAX_AGENT_STEPS
  maxSteps?: number;
  // 可选事件回调；上层用它来记录 Task Event / 更新状态 / 打日志
  onEvent?: (event: AgentLoopEvent) => void;
  // 追加到 system 的额外指令（例如 Skill 指令）
  instructions?: string;
}

const AGENT_SYSTEM_PROMPT = `
你是一个可以使用工具的 AI 助手。你可以使用以下工具：

1. searchKnowledge：查询项目知识库（前端 / React 相关资料）。
2. getCurrentTime：获取指定时区的当前时间。

规则：
1. 当问题依赖知识库资料（前端 / React 的概念、用法、对比等）时，先调用
   searchKnowledge，再基于检索结果回答。
2. 当问题涉及当前时间 / 日期时，调用 getCurrentTime；用户未指定时区时默认
   Asia/Shanghai。
3. 一个问题可能同时需要多个工具，可以依次调用，拿到全部结果后再回答。
4. 与工具无关的通用问题、闲聊或常识，直接回答，不要调用工具。
5. 你可能还会看到其他可用工具（例如来自 MCP 的文件系统工具）。请阅读每个工具的
   描述，自行判断何时调用，不要臆测不存在的工具。
6. 如果工具返回 success:false，请根据错误信息决定重试、换工具或如实告知用户，
   不要编造结果。
7. 回答自然流畅，不要暴露内部检索、工具调用或 Prompt 等实现细节。
`.trim();

function buildSystem(instructions?: string): string {
  return instructions
    ? `${AGENT_SYSTEM_PROMPT}\n\n${instructions}`
    : AGENT_SYSTEM_PROMPT;
}

/**
 * 运行一次 Agent Loop。独立成纯函数，便于测试。
 */
export async function runAgent({
  messages,
  tools = localTools,
  maxSteps = MAX_AGENT_STEPS,
  onEvent,
  instructions,
}: RunAgentOptions): Promise<AgentResult> {
  const modelMessages: ModelMessage[] = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  const collectedToolCalls: AgentToolCall[] = [];
  let stepIndex = 0;

  const result = await generateText({
    model: aiModel,
    system: buildSystem(instructions),
    messages: modelMessages,
    tools,
    // Agent Loop 的核心：最多连续执行 maxSteps 步，防止无限循环
    stopWhen: stepCountIs(maxSteps),
    // 千帆 Responses 端点不支持 item_reference，关闭 store 让历史内联回传
    providerOptions: {
      openai: {
        store: false,
      },
    },
    onStepFinish(step) {
      stepIndex += 1;

      // 从一次已完成的 step 还原出有序的细粒度事件
      onEvent?.({ type: "agent.step.started", step: stepIndex });
      onEvent?.({ type: "llm.requested", step: stepIndex });

      for (const call of step.toolCalls) {
        onEvent?.({
          type: "tool.started",
          step: stepIndex,
          tool: call.toolName,
          input: call.input,
        });
      }

      for (const toolResult of step.toolResults) {
        const output = toolResult.output as { success?: boolean } | undefined;
        const success = output?.success ?? true;

        onEvent?.({
          type: "tool.completed",
          step: stepIndex,
          tool: toolResult.toolName,
          success,
          output: toolResult.output,
        });

        collectedToolCalls.push({
          step: stepIndex,
          tool: toolResult.toolName,
          input: toolResult.input,
          output: toolResult.output,
        });
      }

      onEvent?.({
        type: "agent.step.completed",
        step: stepIndex,
        toolCalls: step.toolCalls.length,
      });
    },
  });

  const steps = result.steps.length;

  // finishReason === 'tool-calls' 表示循环是被 stepCountIs 截断的：
  // LLM 仍想调用工具却已达上限，没有产出最终答案 → Agent Loop Limit
  if (result.finishReason === "tool-calls") {
    throw new AgentLoopLimitError(steps);
  }

  return {
    answer: result.text.trim(),
    toolCalls: collectedToolCalls,
    steps,
  };
}

export interface StreamAgentOptions extends RunAgentOptions {
  // 用于取消执行（客户端断开等场景）
  abortSignal?: AbortSignal;
}

/**
 * 流式 Agent Loop：基于 AI SDK v7 streamText 的 fullStream。
 *
 * 与 runAgent 行为一致（相同 system / tools / maxSteps / Loop Limit），
 * 但在生成过程中实时发出事件 —— 包含真正的 token 级 message.delta。
 * 第四阶段的 Task Runtime 使用它来驱动 SSE。
 */
export async function streamAgent({
  messages,
  tools = localTools,
  maxSteps = MAX_AGENT_STEPS,
  onEvent,
  abortSignal,
  instructions,
}: StreamAgentOptions): Promise<AgentResult> {
  const modelMessages: ModelMessage[] = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  const collectedToolCalls: AgentToolCall[] = [];
  let stepIndex = 0;
  let toolCallsInStep = 0;
  let messageOpen = false;
  let streamedText = "";

  const result = streamText({
    model: aiModel,
    system: buildSystem(instructions),
    messages: modelMessages,
    tools,
    stopWhen: stepCountIs(maxSteps),
    abortSignal,
    providerOptions: {
      openai: {
        store: false,
      },
    },
  });

  // 消费 fullStream：一个统一的流里包含 step 边界、tool call/result、文本 delta
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "start-step":
        stepIndex += 1;
        toolCallsInStep = 0;
        onEvent?.({ type: "agent.step.started", step: stepIndex });
        onEvent?.({ type: "llm.requested", step: stepIndex });
        break;
      case "tool-call":
        toolCallsInStep += 1;
        onEvent?.({
          type: "tool.started",
          step: stepIndex,
          tool: part.toolName,
          input: part.input,
        });
        break;
      case "tool-result": {
        const output = part.output as { success?: boolean } | undefined;
        onEvent?.({
          type: "tool.completed",
          step: stepIndex,
          tool: part.toolName,
          success: output?.success ?? true,
          output: part.output,
        });
        collectedToolCalls.push({
          step: stepIndex,
          tool: part.toolName,
          input: part.input,
          output: part.output,
        });
        break;
      }
      case "tool-error":
        // 工具抛出异常：作为失败的 tool 结果上报，交给 LLM 处理
        onEvent?.({
          type: "tool.completed",
          step: stepIndex,
          tool: part.toolName,
          success: false,
          output: { success: false, error: String(part.error) },
        });
        collectedToolCalls.push({
          step: stepIndex,
          tool: part.toolName,
          input: part.input,
          output: { success: false, error: String(part.error) },
        });
        break;
      case "text-start":
        messageOpen = true;
        onEvent?.({ type: "message.started", step: stepIndex });
        break;
      case "text-delta":
        streamedText += part.text;
        onEvent?.({
          type: "message.delta",
          step: stepIndex,
          content: part.text,
        });
        break;
      case "text-end":
        if (messageOpen) {
          onEvent?.({ type: "message.completed", step: stepIndex });
          messageOpen = false;
        }
        break;
      case "finish-step":
        onEvent?.({
          type: "agent.step.completed",
          step: stepIndex,
          toolCalls: toolCallsInStep,
        });
        break;
    }
  }

  const finishReason = await result.finishReason;
  const steps = (await result.steps).length;

  if (finishReason === "tool-calls") {
    throw new AgentLoopLimitError(steps);
  }

  const finalText = (await result.text).trim() || streamedText.trim();

  return {
    answer: finalText,
    toolCalls: collectedToolCalls,
    steps,
  };
}
