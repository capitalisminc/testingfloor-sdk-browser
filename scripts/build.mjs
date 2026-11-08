import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

rmSync('dist', { recursive: true, force: true })
const tsc = new URL('../node_modules/typescript/bin/tsc', import.meta.url)
for (const flags of [[], ['--module', 'CommonJS', '--moduleResolution', 'Node10', '--verbatimModuleSyntax', 'false', '--outDir', 'dist/cjs']]) {
  const result = spawnSync(process.execPath, [fileURLToPath(tsc), '-p', 'tsconfig.build.json', ...flags], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
mkdirSync('dist/cjs', { recursive: true })
writeFileSync('dist/cjs/package.json', JSON.stringify({ type: 'commonjs' }) + '\n')
