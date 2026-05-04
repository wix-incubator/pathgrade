import { execSync } from 'child_process';

export interface ProtocolFixtureRunInputs {
    env: Record<string, string | undefined>;
    codexOnPath: boolean;
}

export interface ProtocolFixtureRunDecision {
    shouldRun: boolean;
    skipReason?: string;
}

/**
 * Decide whether the protocol fixture suite should run given the environment.
 * Pure function for easy unit testing; probes live in
 * {@link probeProtocolFixturePreconditions}. The driver only uses the
 * PATH-installed `codex` binary, so the gate no longer checks for the npm
 * package (it is not a dependency post-v0.124 hardening).
 */
export function decideProtocolFixtureRun(
    inputs: ProtocolFixtureRunInputs,
): ProtocolFixtureRunDecision {
    if (inputs.env.PATHGRADE_RUN_PROTOCOL_FIXTURES !== '1') {
        return {
            shouldRun: false,
            skipReason:
                'PATHGRADE_RUN_PROTOCOL_FIXTURES is not set to "1"; local `npm test` stays fast',
        };
    }
    if (!inputs.codexOnPath) {
        return {
            shouldRun: false,
            skipReason: 'codex binary not found on PATH',
        };
    }
    return { shouldRun: true };
}

/**
 * Wrap a skip reason in a human-readable message that vitest will print when
 * the suite is skipped. Callers pass this to `describe.skip()` or equivalent.
 */
export function protocolFixtureSkipMessage(reason: string): string {
    return `codex app-server protocol fixture suite skipped: ${reason}`;
}

/**
 * Live prerequisite probes. Result is consumed by `decideProtocolFixtureRun`.
 */
export function probeProtocolFixturePreconditions(): ProtocolFixtureRunInputs {
    const codexOnPath = (() => {
        try {
            execSync('command -v codex', { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    })();

    return {
        env: process.env,
        codexOnPath,
    };
}
