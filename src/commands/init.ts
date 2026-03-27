/**
 * `pathgrade init` command.
 *
 * Detects skills in the current directory and generates an eval.ts config.
 * With an API key, uses an LLM to generate intelligent eval tasks.
 * Without an API key, generates a well-commented template.
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import { detectSkills } from '../core/skills';
import { parseEnvFile } from '../utils/env';
import { isClaudeCliAvailable } from '../utils/cli-llm';
import { callLLM } from '../utils/llm';

export async function runInit(dir: string, opts: { force?: boolean } = {}) {
  const evalPath = path.join(dir, 'eval.ts');

  if (await fs.pathExists(evalPath)) {
    if (opts.force) {
      await fs.remove(evalPath);
    } else {
      console.error('  eval.ts already exists. Use --force to overwrite.');
      throw new Error('eval.ts already exists');
    }
  }

  console.log('\npathgrade init\n');

  // Detect skills
  const skills = await detectSkills(dir);

  if (skills.length === 0) {
    console.log('  No SKILL.md found. Creating a generic template.');
    console.log('     Place a SKILL.md in this directory for better scaffolding.\n');
    await writeTemplate(evalPath, 'my-skill', 'Describe what the agent should do with this skill.');
    return;
  }

  console.log(`  Found ${skills.length} skill(s): ${skills.map(s => s.name).join(', ')}\n`);

  // Load .env file if present
  const envPath = path.join(dir, '.env');
  if (await fs.pathExists(envPath)) {
    const envVars = parseEnvFile(await fs.readFile(envPath, 'utf-8'));
    for (const [key, value] of Object.entries(envVars)) {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }

  // Try LLM-powered scaffold — auto-detect from available API key or CLI
  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const hasApiKey = !!(geminiKey || anthropicKey || openaiKey);
  const cliAvailable = await isClaudeCliAvailable();

  if (hasApiKey || cliAvailable) {
    const { Spinner, fmt } = await import('../utils/cli');
    const label = 'generating eval with available LLM backend';
    const spinner = new Spinner('init', label);
    try {
      const config = await generateWithLLM(skills);
      await fs.writeFile(evalPath, config, 'utf-8');
      spinner.stop(fmt.green('created eval.ts'));
      console.log(`     Review and edit the file, then run: pathgrade\n`);
      return;
    } catch (err: unknown) {
      spinner.stop(fmt.red(`AI generation failed: ${(err as Error).message}`));
      console.log('     Falling back to template.\n');
    }
  } else {
    console.log('  Install Claude CLI or set an API key for AI-powered eval generation.\n');
  }

  // Fallback: template-based scaffold
  const skill = skills[0];
  const taskName = `test-${skill.name}`;
  const instruction = extractInstructionHint(skill.skillMd);
  await writeTemplate(evalPath, taskName, instruction);
}

async function writeTemplate(evalPath: string, taskName: string, instruction: string) {
  const templatePath = path.join(__dirname, '..', '..', 'templates', 'eval.ts.template');
  let template: string;

  if (await fs.pathExists(templatePath)) {
    template = await fs.readFile(templatePath, 'utf-8');
  } else {
    // Inline fallback if template file not found (e.g., if installed globally)
    template = getInlineTemplate();
  }

  const result = template
    .replace(/\{\{TASK_NAME\}\}/g, taskName)
    .replace(/\{\{INSTRUCTION\}\}/g, instruction);

  await fs.writeFile(evalPath, result, 'utf-8');
  console.log(`  Created eval.ts.`);
  console.log(`     Edit the file to define your eval tasks, then run: pathgrade\n`);
}

/**
 * Extract a reasonable instruction hint from SKILL.md content.
 */
function extractInstructionHint(skillMd: string): string {
  // Try to get the first paragraph after the main heading
  const lines = skillMd.split('\n');
  let foundHeading = false;
  const paragraphLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('# ') && !foundHeading) {
      foundHeading = true;
      continue;
    }
    if (foundHeading) {
      if (line.trim() === '' && paragraphLines.length > 0) break;
      if (line.startsWith('#')) break;
      if (line.trim()) paragraphLines.push(line.trim());
    }
  }

  if (paragraphLines.length > 0) {
    return `TODO: Write an instruction based on this skill.\n      Skill description: ${paragraphLines.join(' ')}`;
  }

  return 'TODO: Write an instruction for the agent.';
}

/**
 * Build the init prompt for eval.ts generation.
 */
function buildInitPrompt(skills: Array<{ name: string; skillMd: string }>): string {
  const skillSummaries = skills.map(s =>
    `## Skill: ${s.name}\n\n${s.skillMd}`
  ).join('\n\n---\n\n');

  return `You are an expert at creating evaluation tasks for AI agent skills.

Given the following skill definition(s), generate an eval.ts file that defines 1-2 evaluation tasks to test whether an AI agent correctly discovers and uses the skill.

For each task:
- Write a realistic instruction (what a user would ask the agent to do)
- Define workspace files if needed (fixture files the agent works on)
- Write a deterministic grader (shell script that outputs JSON to stdout)
- Write an LLM rubric (criteria for the LLM judge)

IMPORTANT GRADING RULES:
- Deterministic graders MUST output JSON to stdout: {"score": 0.0-1.0, "details": "...", "checks": [{name, passed, message}]}
- Do NOT use exit codes for scoring. Exit code is ignored — only stdout JSON matters.
- Use awk for floating point arithmetic (bc is not available in node:20-slim).
- The "checks" array is optional but recommended for per-check breakdown.
- For workspace files, only reference files that exist in the skill directory or that the agent will create.

CRITICAL — FILENAME CONSISTENCY:
- The instruction MUST tell the agent exactly what filenames to create (e.g., "Save the result as output.txt").
- The deterministic grader MUST only check for filenames that are explicitly mentioned in the instruction.
- NEVER check for a hardcoded filename that the instruction does not mention — the agent will choose its own names and the grader will fail.
- Example: if the grader checks for "output.html", the instruction must say "Save the HTML file as output.html".

${skillSummaries}

Respond with ONLY the eval.ts file content. Start with the import statement. Use this format:

import { defineEval } from '@wix/pathgrade';

export default defineEval({
  defaults: { agent: 'gemini', trials: 5, timeout: 300, threshold: 0.8 },
  tasks: [
    {
      name: '<descriptive-task-name>',
      instruction: \`<realistic user instruction>
Save <expected output> as <exact-filename>.\`,
      workspace: [
        // Files to copy into the agent's workspace (optional).
        // { src: 'fixtures/app.js', dest: 'app.js' },
      ],
      graders: [
        {
          type: 'deterministic',
          run: \`# Check conditions and output JSON
...
echo '{"score": ..., "details": "...", "checks": [...]}'\`,
          weight: 0.7,
        },
        {
          type: 'llm_rubric',
          rubric: \`<evaluation criteria>\`,
          weight: 0.3,
        },
      ],
    },
  ],
});`;
}

/**
 * Generate eval.ts content using the shared LLM boundary.
 * This keeps init aligned with the CLI-first provider selection used
 * elsewhere in the runtime.
 */
async function generateWithLLM(
  skills: Array<{ name: string; skillMd: string }>
): Promise<string> {
  const prompt = buildInitPrompt(skills);
  const result = await callLLM(prompt);

  // Extract TypeScript from response (strip markdown code fences if present)
  const tsContent = result.text.replace(/```(?:typescript|ts)?\n?/g, '').replace(/```\n?/g, '').trim();
  return tsContent + '\n';
}

function getInlineTemplate(): string {
  return `import { defineEval } from '@wix/pathgrade';

export default defineEval({
  defaults: {
    agent: 'gemini',
    trials: 5,
    timeout: 300,
    threshold: 0.8,
  },

  tasks: [
    {
      name: '{{TASK_NAME}}',
      instruction: \`{{INSTRUCTION}}\`,

      // workspace: [
      //   { src: 'fixtures/broken-file.js', dest: 'app.js' },
      //   { src: 'bin/my-tool', dest: '/usr/local/bin/my-tool', chmod: '+x' },
      // ],

      graders: [
        {
          type: 'deterministic',
          // Grader must output JSON to stdout. See: docs/grader-authoring.md
          // Contract: { "score": 0.0-1.0, "details": "...", "checks": [{name, passed, message}] }
          run: \`echo '{"score": 0.0, "details": "TODO: implement grader"}'\`,
          weight: 0.7,
        },
        {
          type: 'llm_rubric',
          rubric: \`TODO: Write evaluation criteria.\`,
          weight: 0.3,
        },
      ],

      // Optional: reference solution for --validate
      // solution: 'solutions/solve.sh',
    },
  ],
});
`;
}
