/**
 * `pathgrade init` command.
 *
 * Detects skills in the current directory and generates a *.eval.ts config.
 * With an API key, uses an LLM to generate intelligent eval tasks.
 * Without an API key, generates a well-commented template.
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import { detectSkills } from '../core/skills';
import { parseEnvFile } from '../utils/env';
import { isClaudeCliAvailable } from '../utils/cli-llm';
import { callLLM } from '../utils/llm';

/** Find any existing eval config file in a directory. */
async function findExistingEvalFile(dir: string): Promise<string | null> {
  const files = await fs.readdir(dir);
  const evalFile = files.find(f => f.endsWith('.eval.ts'));
  if (evalFile) return path.join(dir, evalFile);
  const legacy = path.join(dir, 'eval.ts');
  if (await fs.pathExists(legacy)) return legacy;
  return null;
}

export async function runInit(dir: string, opts: { force?: boolean } = {}) {
  const existing = await findExistingEvalFile(dir);

  if (existing) {
    if (opts.force) {
      await fs.remove(existing);
    } else {
      const name = path.basename(existing);
      console.error(`  ${name} already exists. Use --force to overwrite.`);
      throw new Error(`${name} already exists`);
    }
  }

  console.log('\npathgrade init\n');

  // Detect skills
  const skills = await detectSkills(dir);

  // Derive eval filename: <skill-name>.eval.ts or <dirname>.eval.ts
  const dirName = path.basename(dir);

  if (skills.length === 0) {
    console.log('  No SKILL.md found. Creating a generic template.');
    console.log('     Place a SKILL.md in this directory for better scaffolding.\n');
    const evalPath = path.join(dir, `${dirName}.eval.ts`);
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
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const hasApiKey = !!(anthropicKey || openaiKey);
  const cliAvailable = await isClaudeCliAvailable();

  const evalName = skills.length === 1 ? skills[0].name : dirName;
  const evalPath = path.join(dir, `${evalName}.eval.ts`);

  if (hasApiKey || cliAvailable) {
    const { Spinner, fmt } = await import('../utils/cli');
    const label = 'generating eval with available LLM backend';
    const spinner = new Spinner('init', label);
    try {
      const config = await generateWithLLM(skills);
      await fs.writeFile(evalPath, config, 'utf-8');
      spinner.stop(fmt.green(`created ${path.basename(evalPath)}`));
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
  console.log(`  Created ${path.basename(evalPath)}.`);
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
- Write a deterministic grader using deterministicGrader({ execute: ... }) that returns { score, details, checks }
- Write an LLM rubric (criteria for the LLM judge)

IMPORTANT GRADING RULES:
- Deterministic graders use deterministicGrader({ execute: async (ctx) => { ... } })
- The execute function receives ctx with: workspacePath, runCommand, sessionLog, env
- It must return: { score: 0.0-1.0, details: "...", checks: [{name, passed, message}] }
- LLM rubric graders use llmRubricGrader({ rubric: '...', weight: N })
- For workspace files, only reference files that exist in the skill directory or that the agent will create.

CRITICAL — FILENAME CONSISTENCY:
- The instruction MUST tell the agent exactly what filenames to create (e.g., "Save the result as output.txt").
- The deterministic grader MUST only check for filenames that are explicitly mentioned in the instruction.
- NEVER check for a hardcoded filename that the instruction does not mention — the agent will choose its own names and the grader will fail.
- Example: if the grader checks for "output.html", the instruction must say "Save the HTML file as output.html".

${skillSummaries}

Respond with ONLY the eval.ts file content. Start with the import statement. Use this format:

import { defineEval, deterministicGrader, llmRubricGrader } from 'pathgrade';

export default defineEval({
  defaults: { agent: 'claude', trials: 5, timeout: 300, threshold: 0.8 },
  tasks: [
    {
      name: '<descriptive-task-name>',
      type: 'instruction',
      instruction: \`<realistic user instruction>
Save <expected output> as <exact-filename>.\`,
      workspace: [],
      graders: [
        deterministicGrader({
          weight: 0.7,
          execute: async ({ workspacePath }) => {
            // Check conditions and return result
            return { score: 0.0, details: '...', checks: [] };
          },
        }),
        llmRubricGrader({
          rubric: \`<evaluation criteria>\`,
          weight: 0.3,
        }),
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
  return `import { defineEval, deterministicGrader, llmRubricGrader } from 'pathgrade';

export default defineEval({
  defaults: {
    agent: 'claude',
    trials: 5,
    timeout: 300,
    threshold: 0.8,
  },

  tasks: [
    {
      name: '{{TASK_NAME}}',
      type: 'instruction',
      instruction: \`{{INSTRUCTION}}\`,

      // workspace: [
      //   { src: 'fixtures/broken-file.js', dest: 'app.js' },
      // ],

      graders: [
        deterministicGrader({
          weight: 0.7,
          // Grader execute function receives { workspacePath, runCommand, sessionLog, env }
          // Must return: { score: 0.0-1.0, details: "...", checks: [{name, passed, message}] }
          execute: async ({ workspacePath }) => {
            return { score: 0.0, details: 'TODO: implement grader', checks: [] };
          },
        }),
        llmRubricGrader({
          rubric: \`TODO: Write evaluation criteria.\`,
          weight: 0.3,
        }),
      ],

      // Optional: validation script for --validate
      // validation_script: 'solutions/solve.sh',
    },
  ],
});
`;
}
