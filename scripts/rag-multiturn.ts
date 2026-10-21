import { retrieveKnowledge, answerWithKnowledge } from "@/lib/rag/rag";
import { aiModel } from "@/lib/ai";

interface MultiTurnCase {
  id: string;
  firstQuery: string;
  // 指定第一轮回答时使用固定 history，用于确定性地验证改写逻辑；否则使用真实生成的回答
  firstAnswer?: string;
  followUpQuery: string;
  // 改写结果必须命中每一组中的至少一个关键词（组内为“或”，组间为“且”）
  rewriteKeywordGroups: string[][];
  // 改写结果中不应再出现的词（例如未消解的指代 / 序号）
  rewriteForbidden?: string[];
  shouldRetrieve: boolean;
  expectedRetrievalKeywords?: string[];
}

const cases: MultiTurnCase[] = [
  {
    id: "react-state-diff",
    firstQuery: "React 怎么管理组件状态？",
    firstAnswer: "React 可以使用 useState、useReducer 等方式管理状态。",
    followUpQuery: "那它们有什么区别？",
    rewriteKeywordGroups: [["useState"], ["useReducer"], ["区别", "不同"]],
    rewriteForbidden: ["它们"],
    shouldRetrieve: true,
    expectedRetrievalKeywords: ["useState", "useReducer"],
  },
  {
    // 真实第一轮回答：回答内容不固定，只校验指代已被消解并能召回
    id: "react-state-diff-real-answer",
    firstQuery: "React 怎么管理组件状态？",
    followUpQuery: "那它们有什么区别？",
    rewriteKeywordGroups: [["区别", "不同"]],
    rewriteForbidden: ["它们"],
    shouldRetrieve: true,
  },
  {
    id: "react-effect-deps",
    firstQuery: "React 中副作用应该怎么处理？",
    followUpQuery: "那依赖数组是什么意思？",
    rewriteKeywordGroups: [["useEffect"], ["依赖数组", "依赖项"]],
    shouldRetrieve: true,
    expectedRetrievalKeywords: ["useEffect"],
  },
  {
    // 知识库中没有 Promise 相关内容（见 evaluation.json），只校验改写，期望不召回
    id: "promise-async",
    firstQuery: "JavaScript 中 Promise 是什么？",
    followUpQuery: "它和 async/await 有什么关系？",
    rewriteKeywordGroups: [["Promise"], ["async"]],
    rewriteForbidden: ["它和"],
    shouldRetrieve: false,
  },
  {
    id: "hook-rule-second",
    firstQuery: "React Hook 使用时有哪些规则？",
    followUpQuery: "第二条具体是什么意思？",
    rewriteKeywordGroups: [["Hook", "hook"]],
    rewriteForbidden: ["第二条"],
    shouldRetrieve: true,
    expectedRetrievalKeywords: ["Hook"],
  },
  {
    // 有历史但当前问题独立：不应被历史带偏，也不应误召回
    id: "independent-question",
    firstQuery: "React 怎么管理组件状态？",
    followUpQuery: "中国四大发明分别是什么？",
    rewriteKeywordGroups: [["四大发明"]],
    rewriteForbidden: ["React", "useState"],
    shouldRetrieve: false,
  },
];

async function runCase(item: MultiTurnCase): Promise<boolean> {
  console.log("========================================");
  console.log(`Case: ${item.id}`);

  // 第一轮：优先使用固定回答，否则真实生成回答，作为第二轮的 history
  const firstAnswer =
    item.firstAnswer ?? (await answerWithKnowledge(item.firstQuery)).answer;

  const history = [
    { role: "user" as const, content: item.firstQuery },
    { role: "assistant" as const, content: firstAnswer },
  ];

  console.log(`Turn 1: ${item.firstQuery}`);
  console.log(
    `Answer 1${item.firstAnswer ? " (fixed)" : ""}: ${firstAnswer.slice(0, 200).replace(/\n/g, " ")}……`,
  );

  // 第二轮：基于 history 改写 + 检索
  const second = await retrieveKnowledge(item.followUpQuery, history, 5, aiModel);
  const rewritten = second.rewrittenQuery;

  console.log(`Turn 2: ${item.followUpQuery}`);
  console.log(`Rewritten: ${rewritten}`);

  const missingGroups = item.rewriteKeywordGroups.filter(
    (group) => !group.some((keyword) => rewritten.includes(keyword)),
  );
  const forbiddenHits = (item.rewriteForbidden ?? []).filter((word) =>
    rewritten.includes(word),
  );
  const rewriteOk = missingGroups.length === 0 && forbiddenHits.length === 0;

  const retrievedText = second.sources.map((source) => source.content).join("\n");
  const actualRetrieve = second.sources.length > 0;
  const missingRetrieval = (item.expectedRetrievalKeywords ?? []).filter(
    (keyword) => !retrievedText.includes(keyword),
  );
  const retrievalOk =
    actualRetrieve === item.shouldRetrieve && missingRetrieval.length === 0;

  console.log(`Retrieved: ${second.sources.length}`);
  console.log(`Top Score: ${(second.sources[0]?.score ?? 0).toFixed(4)}`);
  console.log(
    `Rewrite Check: ${rewriteOk ? "OK" : "FAIL"}` +
      (missingGroups.length ? ` 缺少: ${missingGroups.map((g) => g.join("|")).join(", ")}` : "") +
      (forbiddenHits.length ? ` 不应出现: ${forbiddenHits.join(", ")}` : ""),
  );
  console.log(
    `Retrieval Check: ${retrievalOk ? "OK" : "FAIL"} (expected ${item.shouldRetrieve}, actual ${actualRetrieve})` +
      (missingRetrieval.length ? ` 缺少: ${missingRetrieval.join(", ")}` : ""),
  );

  const pass = rewriteOk && retrievalOk;
  console.log(`Result: ${pass ? "✅ PASS" : "❌ FAIL"}`);

  return pass;
}

async function main() {
  console.log(`\n开始 RAG Multi-turn Test，共 ${cases.length} 条 Case\n`);

  let passed = 0;

  for (const item of cases) {
    try {
      if (await runCase(item)) {
        passed++;
      }
    } catch (error) {
      console.error(`❌ ${item.id} Error:`, error);
    }
  }

  console.log("\n========================================");
  console.log("        RAG Multi-turn Test Result");
  console.log("========================================");
  console.log(`Total Cases: ${cases.length}`);
  console.log(`Passed:      ${passed}`);
  console.log(`Failed:      ${cases.length - passed}`);
  console.log("========================================\n");

  if (passed !== cases.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
