// Publishes the canonical covenant bytecode in the one form a recognizer can
// actually use: hex.
//
// The committed artifacts cannot serve this purpose. Their `bytecode` field holds
// the *disassembled* CashScript mnemonics ("OP_2 OP_PICK OP_HASH160 OP_OVER..."),
// which is readable but not hashable and not comparable to anything on chain.
// `check-artifacts.mjs` says so in a comment and works around it. Only `cashc
// --hex` produces the bytes a P2SH script hash is actually computed over, so
// that is what this tool records.
//
// Why a recognizer needs it at all: a P2SH locking script carries only
// hash160(redeemScript), so a shape-based recognizer cannot tell the canonical
// covenant from an impostor that mints the same output shape. Comparing the
// deployed script against this file is what closes that gap, and it is a byte
// comparison that does not run the VM.
//
// The constructor arguments are part of the deployed script, appended to the
// bytecode by the compiler. Both covenants take pkh parameters, so every
// instance has a different script hash: `IdentityVault(bytes20 ownerPkh)` and
// `ReceiptGenesisValidator(bytes20 partyAPkh, bytes20 partyBPkh)`. The
// recognizer therefore cannot compare against a single fixed hash, it has to
// rebuild the expected script from the parties it already derived from the
// outputs. Recording `constructorInputs` here is what makes that possible.
//
// If cashc is unavailable the tool reports SKIPPED, never PASS, and writes
// nothing. A missing toolchain is not evidence of a correct bytecode.
//
// Usage:
//   node tools/build-covenant-bytecode.mjs            write protocol/covenant-bytecode.json
//   node tools/build-covenant-bytecode.mjs --check    fail if the file is stale

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(root, 'protocol', 'covenant-bytecode.json');
const checkOnly = process.argv.includes('--check');
const constants = JSON.parse(readFileSync(join(root, 'protocol', 'constants.json'), 'utf8'));

// On Windows the npm shims are .cmd files, which cannot be spawned directly.
function spawnable(cmd, args) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)) {
    return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', cmd, ...args] };
  }
  return { cmd, args: [...args] };
}

function run(cmd, args) {
  const { cmd: c, args: a } = spawnable(cmd, args);
  return execFileSync(c, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function findCashc() {
  if (process.env.CASHC) return process.env.CASHC;
  const local = join(root, 'node_modules', '.bin', 'cashc');
  if (existsSync(local)) return process.platform === 'win32' ? `${local}.cmd` : local;
  for (const name of ['cashc', 'cashc.cmd']) {
    try {
      run(name, ['--version']);
      return name;
    } catch { /* keep looking */ }
  }
  return null;
}

const hash160 = (bytes) =>
  createHash('ripemd160')
    .update(createHash('sha256').update(bytes).digest())
    .digest('hex');

const cashc = findCashc();
if (!cashc) {
  console.log('SKIPPED: cashc not found. The canonical bytecode was NOT published in this run.');
  console.log('  Set CASHC, or install cashscript, then run this tool.');
  process.exit(2);
}

const expectedVersion = constants.contracts.compiler.version;
let compilerVersion;
try {
  compilerVersion = run(cashc, ['--version']).trim();
} catch (error) {
  console.log(`SKIPPED: could not run cashc (${error.message}).`);
  process.exit(2);
}
if (!compilerVersion.includes(expectedVersion)) {
  console.log('FAILED: compiler version drift.');
  console.log(`  recorded in constants.json : cashc ${expectedVersion}`);
  console.log(`  found in this environment  : ${compilerVersion}`);
  console.log('  Different compilers emit different bytecode. Re-verify before recording.');
  process.exit(1);
}

const contracts = {};
let failures = 0;

for (const [name, contract] of Object.entries(constants.contracts)) {
  if (name === 'compiler' || name.startsWith('$')) continue;

  const sourcePath = join(root, contract.source);
  if (!existsSync(sourcePath)) {
    console.log(`FAILED  ${name}: missing source ${contract.source}`);
    failures += 1;
    continue;
  }

  let bytecode;
  try {
    bytecode = run(cashc, ['--hex', sourcePath]).trim();
  } catch (error) {
    console.log(`FAILED  ${name}: compilation failed`);
    console.log(`        ${(error.stdout || '').toString().trim() || error.message}`);
    failures += 1;
    continue;
  }

  if (!/^[0-9a-f]+$/.test(bytecode) || bytecode.length % 2 !== 0) {
    console.log(`FAILED  ${name}: --hex did not return even-length lowercase hex`);
    console.log(`        got ${bytecode.length} chars starting "${bytecode.slice(0, 40)}"`);
    failures += 1;
    continue;
  }

  const bytes = Buffer.from(bytecode, 'hex');
  const artifact = JSON.parse(readFileSync(join(root, contract.artifact), 'utf8'));

  // Cross-check against the fingerprint the artifact already reports. The
  // fingerprint is not derived from the `bytecode` field (it is not hex), so
  // this cannot be verified from the committed artifact alone; it is recorded
  // here so a change in either is visible side by side.
  contracts[name] = {
    source: contract.source,
    artifact: contract.artifact,
    compiler: { name: 'cashc', version: expectedVersion },
    fingerprint: contract.fingerprint,
    artifactFingerprint: artifact.fingerprint,
    constructorInputs: artifact.constructorInputs,
    bytecodeHex: bytecode,
    bytecodeBytes: bytes.length,
    hash160BytecodeOnly: hash160(bytes),
    note:
      'The deployed script is bytecodeHex followed by the serialized constructor ' +
      'arguments, in the order declared by constructorInputs. Because both ' +
      'covenants take pkh parameters, every instance has a different script hash.',
  };

  console.log(
    `ok      ${name.padEnd(16)} ${String(bytes.length).padStart(4)} bytes  ` +
      `hash160(bytecode)=${contracts[name].hash160BytecodeOnly.slice(0, 16)}...`,
  );
}

if (failures > 0) {
  console.log(`\n${failures} contract(s) could not be published.`);
  process.exit(1);
}

const document = {
  $comment:
    'Canonical covenant bytecode in hex, generated by tools/build-covenant-bytecode.mjs from the ' +
    'sources named here with the compiler named here. Consumed by a recognizer that wants to ' +
    'verify a fact came from a covenant rather than only matching its output shape. Do not edit ' +
    'by hand: `npm run bytecode:check` fails when this file is stale.',
  generatedFrom: 'contracts/*.cash',
  contracts,
};

const serialized = `${JSON.stringify(document, null, 2)}\n`;

if (checkOnly) {
  if (!existsSync(outPath)) {
    console.log('FAILED: protocol/covenant-bytecode.json does not exist. Run the builder.');
    process.exit(1);
  }
  if (readFileSync(outPath, 'utf8') !== serialized) {
    console.log('FAILED: protocol/covenant-bytecode.json is stale.');
    console.log('  Run `npm run bytecode:build` and commit the result in the same change as whatever');
    console.log('  altered a covenant source or the compiler version.');
    process.exit(1);
  }
  console.log('OK: covenant-bytecode.json matches the current sources.');
  process.exit(0);
}

writeFileSync(outPath, serialized, 'utf8');
console.log(`\nWrote protocol/covenant-bytecode.json (${Object.keys(contracts).length} contracts).`);
