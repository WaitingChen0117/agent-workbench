import fs from "node:fs/promises";
import path from "node:path";

/**
 * 最小 Skill 能力（Discovery + Loading）
 *
 * Skill 描述「Agent 应该如何完成某类任务」（workflow / 约束），
 * 与 Tool（「Agent 能做什么」）互补。Skill 可以编排一个或多个 Tool。
 *
 * 约定：每个 Skill 是 .agent/skills/<name>/SKILL.md，
 * 其中目录名即 skill name。内容从文件系统读取，不在 TS 中硬编码。
 */

const SKILLS_DIR = path.join(process.cwd(), ".agent", "skills");

export interface SkillMeta {
  name: string;
  description: string;
}

// 从 SKILL.md 中提取「## Description」段落的首行作为简介
function extractDescription(markdown: string): string {
  const lines = markdown.split("\n");
  const headingIndex = lines.findIndex((line) =>
    /^#{1,6}\s+description/i.test(line.trim()),
  );

  if (headingIndex >= 0) {
    for (let i = headingIndex + 1; i < lines.length; i += 1) {
      const text = lines[i].trim();
      if (text && !text.startsWith("#")) {
        return text;
      }
    }
  }

  // 回退：第一行非标题文本
  const firstText = lines
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));

  return firstText ?? "";
}

/**
 * Skill Discovery：列出当前所有可用 Skill 及其简介。
 */
export async function discoverSkills(): Promise<SkillMeta[]> {
  let dirents;
  try {
    dirents = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return []; // .agent/skills 不存在时返回空
  }

  const skills: SkillMeta[] = [];

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const markdown = await loadSkill(dirent.name);
    if (markdown === null) {
      continue;
    }

    skills.push({
      name: dirent.name,
      description: extractDescription(markdown),
    });
  }

  return skills;
}

/**
 * Skill Loading：读取指定 Skill 的 SKILL.md 全文。
 */
export async function loadSkill(name: string): Promise<string | null> {
  // 防止路径穿越：name 只允许简单目录名
  if (!/^[a-z0-9._-]+$/i.test(name)) {
    return null;
  }

  const file = path.join(SKILLS_DIR, name, "SKILL.md");

  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
}

/**
 * 把所有已发现 Skill 的内容拼成一段可注入 system 的指令。
 * Agent 启动时加载，使 Skill 成为上下文的一部分。
 */
export async function loadSkillInstructions(): Promise<string> {
  const skills = await discoverSkills();

  if (skills.length === 0) {
    return "";
  }

  const sections: string[] = ["以下是当前可用的 Skill（任务执行指南）："];

  for (const skill of skills) {
    const content = await loadSkill(skill.name);
    if (content) {
      sections.push(`\n--- SKILL: ${skill.name} ---\n${content.trim()}`);
    }
  }

  return sections.join("\n");
}
