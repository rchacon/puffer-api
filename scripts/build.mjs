// Builds deployable artifacts from TypeScript source:
//  - build/resolvers/**/*.js -- one standalone ESM bundle per AppSync
//    resolver/pipeline-function, `@aws-appsync/utils` kept external so it
//    resolves to AppSync's real runtime implementation at deploy time (the
//    npm package itself is types-only -- see docs/architecture.md).
//  - build/lambda/<name>.zip -- a single self-contained bundle (dependencies
//    included) per Lambda: the Cognito Post Confirmation trigger and the
//    progress projector (DynamoDB Streams).
//  - build/schema.graphql -- copied as-is.
//
// Terraform (puffer-infra) never runs this -- it only ever references
// already-built files. This script, and the workflow that calls it, are
// puffer-api's job alone.
//
// Usage: `node scripts/build.mjs [target]`, where target is one of
// 'resolvers', 'postConfirmation' or 'progressProjector'. With no target,
// builds everything (local dev). Each deploy workflow passes its own single
// target so a break in one component's build can't block a release of an
// unrelated one -- the three components are versioned and deployed
// independently (see docs/architecture.md), and the build should be too.
import { build } from 'esbuild';
import { existsSync, mkdirSync, readdirSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';

const VALID_TARGETS = ['resolvers', 'postConfirmation', 'progressProjector'];
const target = process.argv[2];
if (target !== undefined && !VALID_TARGETS.includes(target)) {
  console.error(`Unknown build target '${target}' -- expected one of: ${VALID_TARGETS.join(', ')}`);
  process.exit(1);
}
const wants = (name) => target === undefined || target === name;

const BUILD_DIR = 'build';

rmSync(BUILD_DIR, { recursive: true, force: true });
mkdirSync(BUILD_DIR, { recursive: true });

async function buildResolverDir(sourceDir, outDir) {
  if (!existsSync(sourceDir)) {
    return;
  }
  mkdirSync(outDir, { recursive: true });
  const files = readdirSync(sourceDir).filter((f) => f.endsWith('.ts'));
  for (const file of files) {
    const outFile = join(outDir, `${basename(file, '.ts')}.js`);
    await build({
      entryPoints: [join(sourceDir, file)],
      outfile: outFile,
      bundle: true,
      format: 'esm',
      target: 'es2020',
      platform: 'node',
      external: ['@aws-appsync/utils'],
    });
    console.log(`Built ${outFile}`);
  }
}

if (wants('resolvers')) {
  await buildResolverDir('resolvers', join(BUILD_DIR, 'resolvers'));
  await buildResolverDir('resolvers/functions', join(BUILD_DIR, 'resolvers', 'functions'));
  cpSync('schema.graphql', join(BUILD_DIR, 'schema.graphql'));
  console.log(`Copied schema.graphql`);
}

async function buildLambda(name) {
  const lambdaOutDir = join(BUILD_DIR, 'lambda', name);
  mkdirSync(lambdaOutDir, { recursive: true });
  await build({
    entryPoints: [`lambdas/${name}/index.ts`],
    // CJS, not ESM: the AWS SDK's CJS internals (@smithy/node-http-handler)
    // dynamically require() Node built-ins in a way that doesn't survive
    // esbuild's ESM output without an interop shim. CJS needs no shim, and
    // Lambda's Node runtime treats a bundle-less .js file as CJS by default
    // (no package.json in the zip to say otherwise).
    outfile: join(lambdaOutDir, 'index.js'),
    bundle: true,
    format: 'cjs',
    target: 'node20',
    platform: 'node',
  });
  // Unambiguously CJS regardless of any outer/ambient package.json (this repo's
  // own package.json says "type": "module") -- Lambda's runtime, and anything
  // else that loads this zip's index.js directly, should never have to guess.
  writeFileSync(join(lambdaOutDir, 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n');
  execSync(`zip -qr ../${name}.zip .`, { cwd: lambdaOutDir, stdio: 'inherit' });
  console.log(`Built ${join(BUILD_DIR, 'lambda', `${name}.zip`)}`);
}

if (wants('postConfirmation')) await buildLambda('postConfirmation');
if (wants('progressProjector')) await buildLambda('progressProjector');

console.log(`\nBuild complete: ${BUILD_DIR}/`);
