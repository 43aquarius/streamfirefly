import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Explicit write-mode check: restore exact source bytes even when a mutant survives.
// Run sequentially after verify:features; do not edit the checkout concurrently.
const root = fileURLToPath(new URL('../', import.meta.url));
function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length - 1, 1, `Expected one source match: ${before}`);
  return text.replace(before, after);
}
assert.equal(replaceOnce('abc', 'b', 'B'), 'aBc');
assert.throws(() => replaceOnce('abc', 'missing', ''), /one source match/);
assert.throws(() => replaceOnce('bb', 'b', ''), /one source match/);
if (process.argv.length !== 3 || process.argv[2] !== '--mutate') throw Error('Use --mutate explicitly; this check temporarily edits and restores source');
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.signal) throw result.error || Error(`Interrupted check: ${command}`);
  return { code: result.status, output: result.stdout + result.stderr };
};
const cargo = ['cargo', ['test', '--manifest-path', 'native-host/Cargo.toml']];
const sourceOpen = '    let mut source = fs::File::open(temporary).map_err(|_| "output_write_failed")?;';
const mutants = [
  { name: 'shutdown spawn gate', file: 'native-host/src/processes.rs', mutate: text => replaceOnce(text, 'if host_exiting(store) {', 'if false {'), command: [cargo[0], [...cargo[1], 'shutdown_reaps_children_and_rejects_late_spawn']], failure: /spawn was accepted after shutdown/ },
  { name: 'latest network policy', file: 'extension/src/background.js', mutate: text => replaceOnce(text, 'if (latest.proxyMode !== wanted.mode || latest.proxyUrl !== wanted.proxyUrl) continue;', 'if (false) continue;'), command: ['node', ['tools/test-extension-logic.mjs']], failure: /stale policy while initialization was pending/ },
  { name: 'source before destination', file: 'native-host/src/task_input.rs', mutate: text => replaceOnce(replaceOnce(text, sourceOpen, ''), '    if write_output(&mut source, &mut created).is_err() {', `${sourceOpen}\n    if write_output(&mut source, &mut created).is_err() {`), command: [cargo[0], [...cargo[1], 'publish_missing_source_does_not_reserve_the_destination']], failure: /failed source open left an empty final output/ }
];
for (const mutant of mutants) {
  const file = path.join(root, mutant.file);
  const original = fs.readFileSync(file);
  const source = original.toString('utf8');
  const mutated = mutant.mutate(source);
  assert.notEqual(mutated, source, `Unapplied mutation: ${mutant.name}`);
  try {
    fs.writeFileSync(file, mutated);
    assert.equal(fs.readFileSync(file, 'utf8'), mutated);
    const result = run(...mutant.command);
    assert.notEqual(result.code, 0, `Surviving mutant: ${mutant.name}`);
    assert.match(result.output, mutant.failure, `Mutant failed for the wrong reason: ${mutant.name}\n${result.output}`);
    console.log(`Detected mutation: ${mutant.name}`);
  } finally {
    fs.writeFileSync(file, original);
    assert.ok(fs.readFileSync(file).equals(original), `Source restoration failed: ${mutant.file}`);
  }
}
for (const command of [cargo, ['node', ['tools/test-extension-logic.mjs']], ['cargo', ['build', '--manifest-path', 'native-host/Cargo.toml']]]) {
  const result = run(...command);
  assert.equal(result.code, 0, result.output);
}
console.log('Three deliberate regressions detected; original source and clean checks restored');
