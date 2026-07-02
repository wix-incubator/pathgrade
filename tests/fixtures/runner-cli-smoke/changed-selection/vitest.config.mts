import { defineConfig } from 'vitest/config';
import { pathgrade } from '@wix/pathgrade/adapters/vitest';

export default defineConfig({
    plugins: [pathgrade()],
});
