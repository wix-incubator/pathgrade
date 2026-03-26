import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fsReal from 'fs';
import * as fsExtra from 'fs-extra';
import { LocalProvider } from '../src/providers/local';

describe('LocalProvider', () => {
  const provider = new LocalProvider();
  let tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      try { await fsExtra.remove(dir); } catch {}
    }
    tempDirs = [];
  });

  describe('setup', () => {
    it('creates a temp directory and copies task files', async () => {
      // Create a real temp task directory
      const taskDir = path.join(os.tmpdir(), `pathgrade-test-task-${Date.now()}`);
      await fsExtra.ensureDir(taskDir);
      await fsExtra.writeFile(path.join(taskDir, 'task.toml'), 'version = "1"');
      tempDirs.push(taskDir);

      const setupOpts = {
        timeoutSec: 300,
        environment: { cpus: 2, memory_mb: 2048 },
      };

      const runtime = await provider.setup(taskDir, [], setupOpts);
      tempDirs.push(runtime.handle);

      expect(runtime.handle).toContain('pathgrade-');
      expect(runtime.workspacePath).toBe(path.join(runtime.handle, 'workspace'));
      expect(runtime.paths?.home).toBe(path.join(runtime.handle, 'home'));
      expect(runtime.paths?.xdg).toBe(path.join(runtime.handle, 'xdg'));
      expect(runtime.paths?.tmp).toBe(path.join(runtime.handle, 'tmp'));
      expect(await fsExtra.pathExists(runtime.workspacePath)).toBe(true);
      expect(await fsExtra.pathExists(path.join(runtime.workspacePath, 'task.toml'))).toBe(true);
      expect(await fsExtra.pathExists(runtime.paths!.home!)).toBe(true);
      expect(await fsExtra.pathExists(runtime.paths!.xdg!)).toBe(true);
      expect(await fsExtra.pathExists(runtime.paths!.tmp)).toBe(true);
    });

    it('injects skills into discovery directories', async () => {
      const taskDir = path.join(os.tmpdir(), `pathgrade-test-task-${Date.now()}`);
      const skillDir = path.join(os.tmpdir(), `pathgrade-test-skill-${Date.now()}`);
      await fsExtra.ensureDir(taskDir);
      await fsExtra.ensureDir(skillDir);
      await fsExtra.writeFile(path.join(skillDir, 'SKILL.md'), '# Test Skill');
      tempDirs.push(taskDir, skillDir);

      const setupOpts = {
        timeoutSec: 300,
        environment: { cpus: 2, memory_mb: 2048 },
      };

      const runtime = await provider.setup(taskDir, [skillDir], setupOpts);
      tempDirs.push(runtime.handle);

      const skillName = path.basename(skillDir);
      // Check Gemini discovery path
      const geminiPath = path.join(runtime.workspacePath, '.agents', 'skills', skillName, 'SKILL.md');
      expect(await fsExtra.pathExists(geminiPath)).toBe(true);

      // Check Claude discovery path
      const claudePath = path.join(runtime.workspacePath, '.claude', 'skills', skillName, 'SKILL.md');
      expect(await fsExtra.pathExists(claudePath)).toBe(true);
    });

    it('generates CLAUDE.md with skill descriptions when skills are present', async () => {
      const taskDir = path.join(os.tmpdir(), `pathgrade-test-task-${Date.now()}`);
      const skillDir = path.join(os.tmpdir(), `pathgrade-test-skill-${Date.now()}`);
      await fsExtra.ensureDir(taskDir);
      await fsExtra.ensureDir(skillDir);
      await fsExtra.writeFile(path.join(skillDir, 'SKILL.md'), [
        '---',
        'name: my-skill',
        'description: A test skill for evaluation',
        '---',
        '# My Skill',
        'Content here.',
      ].join('\n'));
      tempDirs.push(taskDir, skillDir);

      const runtime = await provider.setup(taskDir, [skillDir], {
        timeoutSec: 300,
        environment: { cpus: 2, memory_mb: 2048 },
      });
      tempDirs.push(runtime.handle);

      const claudeMdPath = path.join(runtime.workspacePath, 'CLAUDE.md');
      expect(await fsExtra.pathExists(claudeMdPath)).toBe(true);

      const content = await fsExtra.readFile(claudeMdPath, 'utf-8');
      expect(content).toContain('my-skill');
      expect(content).toContain('A test skill for evaluation');
      expect(content).toContain('.claude/skills/');
    });

    it('does NOT generate CLAUDE.md when no skills are provided', async () => {
      const taskDir = path.join(os.tmpdir(), `pathgrade-test-task-${Date.now()}`);
      await fsExtra.ensureDir(taskDir);
      tempDirs.push(taskDir);

      const runtime = await provider.setup(taskDir, [], {
        timeoutSec: 300,
        environment: { cpus: 2, memory_mb: 2048 },
      });
      tempDirs.push(runtime.handle);

      const claudeMdPath = path.join(runtime.workspacePath, 'CLAUDE.md');
      expect(await fsExtra.pathExists(claudeMdPath)).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('removes the workspace directory', async () => {
      const tempDir = path.join(os.tmpdir(), `pathgrade-cleanup-test-${Date.now()}`);
      await fsExtra.ensureDir(tempDir);
      await fsExtra.writeFile(path.join(tempDir, 'file.txt'), 'test');

      await provider.cleanup({ handle: tempDir, workspacePath: path.join(tempDir, 'workspace'), env: {} });
      expect(await fsExtra.pathExists(tempDir)).toBe(false);
    });

    it('handles non-existent directory gracefully', async () => {
      // Should not throw
      await provider.cleanup({
        handle: '/tmp/nonexistent-dir-' + Date.now(),
        workspacePath: '/tmp/nonexistent-dir-' + Date.now() + '/workspace',
        env: {},
      });
    });
  });

  describe('runCommand', () => {
    function makeRuntime(tempDir: string) {
      return {
        handle: tempDir,
        workspacePath: tempDir,
        env: {},
      };
    }

    it('executes a command and captures stdout', async () => {
      const tempDir = path.join(os.tmpdir(), `pathgrade-cmd-test-${Date.now()}`);
      await fsExtra.ensureDir(tempDir);
      tempDirs.push(tempDir);

      const result = await provider.runCommand(makeRuntime(tempDir), 'echo "hello world"');
      expect(result.stdout.trim()).toBe('hello world');
      expect(result.exitCode).toBe(0);
    });

    it('captures stderr', async () => {
      const tempDir = path.join(os.tmpdir(), `pathgrade-cmd-test-${Date.now()}`);
      await fsExtra.ensureDir(tempDir);
      tempDirs.push(tempDir);

      const result = await provider.runCommand(makeRuntime(tempDir), 'echo "error" >&2');
      expect(result.stderr.trim()).toBe('error');
    });

    it('returns non-zero exit code', async () => {
      const tempDir = path.join(os.tmpdir(), `pathgrade-cmd-test-${Date.now()}`);
      await fsExtra.ensureDir(tempDir);
      tempDirs.push(tempDir);

      const result = await provider.runCommand(makeRuntime(tempDir), 'exit 42');
      expect(result.exitCode).toBe(42);
    });

    it('passes environment variables', async () => {
      const tempDir = path.join(os.tmpdir(), `pathgrade-cmd-test-${Date.now()}`);
      await fsExtra.ensureDir(tempDir);
      tempDirs.push(tempDir);

      const result = await provider.runCommand(makeRuntime(tempDir), 'echo $TEST_VAR', { TEST_VAR: 'test_value' });
      expect(result.stdout.trim()).toBe('test_value');
    });

    it('runs command in the correct working directory', async () => {
      const tempDir = path.join(os.tmpdir(), `pathgrade-cmd-test-${Date.now()}`);
      await fsExtra.ensureDir(tempDir);
      tempDirs.push(tempDir);

      const result = await provider.runCommand(makeRuntime(tempDir), 'pwd');
      // The path might have /private prefix on macOS
      expect(result.stdout.trim()).toContain(path.basename(tempDir));
    });

    it('applies isolated HOME, XDG, and TMPDIR paths from the trial runtime', async () => {
      const taskDir = path.join(os.tmpdir(), `pathgrade-isolation-task-${Date.now()}`);
      await fsExtra.ensureDir(taskDir);
      await fsExtra.writeFile(path.join(taskDir, 'task.toml'), 'version = "1"');
      tempDirs.push(taskDir);

      const runtime = await provider.setup(taskDir, [], {
        timeoutSec: 300,
        environment: { cpus: 2, memory_mb: 2048 },
      });
      tempDirs.push(runtime.handle);

      const result = await provider.runCommand(
        runtime,
        'printf "%s\\n%s\\n%s\\n%s\\n%s\\n" "$(basename "$PWD")" "$(basename "$HOME")" "$(basename "$XDG_CONFIG_HOME")" "$(basename "$XDG_STATE_HOME")" "$(basename "${TMPDIR%/}")"'
      );

      expect(result.stdout.trim().split('\n')).toEqual([
        'workspace',
        'home',
        'xdg',
        'state',
        'tmp',
      ]);
    });

    it('aborts long-running commands when the signal is canceled', async () => {
      const tempDir = path.join(os.tmpdir(), `pathgrade-cmd-abort-${Date.now()}`);
      await fsExtra.ensureDir(tempDir);
      tempDirs.push(tempDir);

      const controller = new AbortController();
      const startTime = Date.now();
      const resultPromise = provider.runCommand(
        makeRuntime(tempDir),
        'trap "exit 143" TERM; sleep 10',
        undefined,
        { signal: controller.signal }
      );

      setTimeout(() => controller.abort(), 50);
      const result = await resultPromise;

      expect(Date.now() - startTime).toBeLessThan(2000);
      expect(result.timedOut).toBe(true);
    });
  });
});
