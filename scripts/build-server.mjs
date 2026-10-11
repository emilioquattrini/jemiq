import { build } from 'esbuild';
await build({ entryPoints: ['server/index.ts'], outfile: 'dist-node/server/index.js', bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external' });
