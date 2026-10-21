import fs from "node:fs/promises";
import path from "node:path";

import { retrieveKnowledge } from "@/lib/rag/rag";
import { aiModel } from "@/lib/ai";

interface EvaluationCase {
  id: string;
  query: string;
  shouldRetrieve: boolean;
  expectedKeywords: string[];
}

interface EvaluationResult {
  id: string;
  query: string;
  shouldRetrieve: boolean;
  actualRetrieve: boolean;
  recall: number;
  topScore: number;
  matchedKeywords: string[];
  retrievedCount: number;
}

async function main() {
  const filePath = path.join(process.cwd(), "data/evaluation.json");

  const content = await fs.readFile(filePath, "utf-8");

  const cases = JSON.parse(content) as EvaluationCase[];

  console.log(`\n开始 RAG Evaluation，共 ${cases.length} 条 Case\n`);

  const results: EvaluationResult[] = [];

  for (const item of cases) {
    console.log("========================================");
    console.log(`Case: ${item.id}`);
    console.log(`Query: ${item.query}`);

    try {
      const result = await retrieveKnowledge(item.query, [], 5, aiModel);

      const retrievedText = result.sources
        .map((source) => source.content)
        .join("\n");

      const matchedKeywords = item.expectedKeywords.filter((keyword) =>
        retrievedText.includes(keyword),
      );

      const recall =
        item.expectedKeywords.length === 0
          ? 0
          : matchedKeywords.length / item.expectedKeywords.length;

      const actualRetrieve = result.sources.length > 0;

      const topScore = result.sources[0]?.score ?? 0;

      const retrievalCorrect = actualRetrieve === item.shouldRetrieve;

      const keywordCorrect = !item.shouldRetrieve || recall > 0;

      const pass = retrievalCorrect && keywordCorrect;

      console.log(`Rewrite: ${result.needRewrite}`);

      console.log(`Rewritten: ${result.rewrittenQuery}`);

      console.log(`Retrieved: ${result.sources.length}`);

      console.log(`Top Score: ${topScore.toFixed(4)}`);

      console.log(`Matched: ${matchedKeywords.join(", ") || "无"}`);

      console.log("\nTop 5 Sources:");

      result.sources.forEach((source, index) => {
        console.log(`\n[${index + 1}] Score: ${source.score.toFixed(4)}`);

        console.log(source.content.slice(0, 300));
      });

      console.log(`Recall: ${(recall * 100).toFixed(2)}%`);

      console.log(`Expected Retrieve: ${item.shouldRetrieve}`);

      console.log(`Actual Retrieve: ${actualRetrieve}`);

      console.log(`Result: ${pass ? "✅ PASS" : "❌ FAIL"}`);

      results.push({
        id: item.id,
        query: item.query,
        shouldRetrieve: item.shouldRetrieve,
        actualRetrieve,
        recall,
        topScore,
        matchedKeywords,
        retrievedCount: result.sources.length,
      });
    } catch (error) {
      console.error("❌ Evaluation Error:", error);

      results.push({
        id: item.id,
        query: item.query,
        shouldRetrieve: item.shouldRetrieve,
        actualRetrieve: false,
        recall: 0,
        topScore: 0,
        matchedKeywords: [],
        retrievedCount: 0,
      });
    }
  }

  printSummary(results);
}

function printSummary(results: EvaluationResult[]) {
  const total = results.length;

  const passCount = results.filter((item) =>
    item.shouldRetrieve
      ? item.actualRetrieve && item.recall > 0
      : !item.actualRetrieve,
  ).length;

  const positiveCases = results.filter((item) => item.shouldRetrieve);

  const negativeCases = results.filter((item) => !item.shouldRetrieve);

  const averageRecall =
    positiveCases.length === 0
      ? 0
      : positiveCases.reduce((sum, item) => sum + item.recall, 0) /
        positiveCases.length;

  const averageTopScore =
    positiveCases.length === 0
      ? 0
      : positiveCases.reduce((sum, item) => sum + item.topScore, 0) /
        positiveCases.length;
  const falsePositiveCount = negativeCases.filter(
    (item) => item.actualRetrieve,
  ).length;
  console.log("\n\n========================================");

  console.log("           RAG Evaluation Result");

  console.log("========================================");

  console.log(`Total Cases:       ${total}`);

  console.log(`Passed:            ${passCount}`);

  console.log(`Failed:            ${total - passCount}`);

  console.log(
    `Pass Rate:         ${
      total ? ((passCount / total) * 100).toFixed(2) : "0.00"
    }%`,
  );

  console.log(`Recall@5:          ${(averageRecall * 100).toFixed(2)}%`);

  console.log(`Avg Top1 Score:    ${averageTopScore.toFixed(4)}`);

  console.log(`False Positive:    ${falsePositiveCount}`);

  console.log("========================================\n");

  const failed = results.filter((item) =>
    item.shouldRetrieve
      ? !item.actualRetrieve || item.recall === 0
      : item.actualRetrieve,
  );

  if (failed.length > 0) {
    console.log("❌ Failed Cases:\n");
    for (const item of failed) {
      console.log(`${item.id}`);

      console.log(`  Query: ${item.query}`);

      console.log(`  Expected Retrieve: ${item.shouldRetrieve}`);

      console.log(`  Actual Retrieve: ${item.actualRetrieve}`);

      console.log(`  Recall: ${(item.recall * 100).toFixed(2)}%`);

      console.log(`  Top Score: ${item.topScore.toFixed(4)}`);

      console.log("");
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
