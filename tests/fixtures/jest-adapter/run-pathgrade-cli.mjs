import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const pathgradeBin = path.join(root, 'bin/pathgrade.js');

const child = spawn(process.execPath, [
    pathgradeBin,
    'run',
    '--adapter=jest',
    '--',
    '--config',
    'jest.config.mjs',
    '--runInBand',
], {
    cwd: import.meta.dirname,
    stdio: 'inherit',
    env: {
        ...process.env,
        NODE_OPTIONS: '--experimental-vm-modules',
        PATH: ['/usr/bin', '/bin'].join(path.delimiter),
    },
});

child.on('close', code => {
    process.exitCode = code ?? 1;
});

child.on('error', err => {
    console.error(err);
    process.exitCode = 1;
});
