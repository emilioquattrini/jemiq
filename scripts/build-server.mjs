import { build } from 'esbuild';
await build({ entryPoints: ['server/index.ts'], outfile: 'dist/server/index.js', bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' });
