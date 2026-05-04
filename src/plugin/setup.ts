import { afterAll, afterEach } from 'vitest';
import { lifecycle } from './lifecycle.js';

lifecycle.install(afterEach, afterAll);
