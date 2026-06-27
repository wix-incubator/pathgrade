import { afterAll, afterEach, aroundEach } from 'vitest';
import { lifecycle } from './lifecycle.js';

lifecycle.install(afterEach, afterAll, aroundEach);
