import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {MigrationDatabase} from '../dist/database.js';
import {requiredBytes} from '../dist/migration.js';
import {isSafeArchivePath} from '../dist/system.js';
import {inventoryTakeout} from '../dist/takeout.js';
import {findAvailableUpdate, resolveExecutablePrefix, verifyInstalledVersion} from '../dist/updates.js';
import {isSelectableExternalVolume, parentWholeDiskIdentifier, volumeMountPath} from '../dist/volume.js';
import {BundleDatabase} from '../dist/bundle-database.js';
import {initializeBundlePaths, safeImportFilename, validateBundleCompatibility, prepareBundle} from '../dist/bundle.js';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

test('rejects unsafe archive paths', () => {
  assert.equal(isSafeArchivePath('../escape.jpg'), false);
  assert.equal(isSafeArchivePath('/absolute.jpg'), false);
  assert.equal(isSafeArchivePath('Album/photo.jpg'), true);
});

test('adds migration storage headroom', () => {
  assert.equal(requiredBytes({archives: 1, images: 1, videos: 0, compressedBytes: 10, extractBytes: 100, rejectedEntries: 0}), 120);
});

test('creates safe APFS volume mount paths', () => {
  assert.equal(volumeMountPath('Google Migration'), '/Volumes/Google Migration');
  assert.throws(() => volumeMountPath('../unsafe'));
  assert.throws(() => volumeMountPath(''));
});

test('accepts external mounted volumes regardless of their filesystem but excludes critical destinations', () => {
  const selectable = {mountPoint: '/Volumes/Migration', filesystem: 'exfat', availableBytes: 100, capacityBytes: 200, isExternal: true, isReadOnly: false};
  assert.equal(isSelectableExternalVolume(selectable), true);
  // isExternal reflects RemovableMediaOrExternalDevice; SD cards via integrated readers have isExternal: true even when Internal=true
  assert.equal(isSelectableExternalVolume({...selectable, isExternal: false}), false, 'non-removable internal disk must be rejected');
  assert.equal(isSelectableExternalVolume({...selectable, isReadOnly: true}), false);
  assert.equal(isSelectableExternalVolume({...selectable, mountPoint: '/System/Volumes/Data'}), false);
  assert.equal(isSelectableExternalVolume(selectable, ['/Volumes/Migration']), false);
});

test('resolves only a whole-disk identifier for formatting', () => {
  assert.equal(parentWholeDiskIdentifier('disk4s2', 'disk4'), 'disk4');
  assert.equal(parentWholeDiskIdentifier('disk4s2', undefined), 'disk4');
  assert.throws(() => parentWholeDiskIdentifier('disk4s2', 'disk4s2'));
});

test('persists migration state by media hash', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-migrator-'));
  const database = await MigrationDatabase.open(path.join(directory, 'state.sqlite'));
  try {
    database.save({hash: 'a'.repeat(64), archivePath: '/takeout.zip', entryPath: 'photo.jpg', mediaKind: 'image', status: 'pending'});
    database.save({hash: 'a'.repeat(64), archivePath: '/takeout.zip', entryPath: 'photo.jpg', mediaKind: 'image', status: 'imported'});
    assert.equal(database.find('a'.repeat(64))?.status, 'imported');
    assert.equal(database.countByStatus().imported, 1);
  } finally {
    database.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('inventories photos and videos from a Takeout ZIP', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-migrator-'));
  try {
    await writeFile(path.join(directory, 'photo.jpg'), 'photo');
    await writeFile(path.join(directory, 'photo.jpg.json'), JSON.stringify({photoTakenTime: {timestamp: '1700000000'}}));
    await writeFile(path.join(directory, 'clip.mov'), 'video');
    await execute('/usr/bin/zip', ['takeout.zip', 'photo.jpg', 'photo.jpg.json', 'clip.mov'], {cwd: directory});
    const result = await inventoryTakeout(path.join(directory, 'takeout.zip'));
    assert.equal(result.inventory.images, 1);
    assert.equal(result.inventory.videos, 1);
    assert.equal(result.media.find(item => item.entryPath === 'photo.jpg')?.sidecarEntryPath, 'photo.jpg.json');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('selects the newest stable release with its matching package', () => {
  const update = findAvailableUpdate([
    {tag_name: 'v0.1.1', draft: false, prerelease: false, assets: [{id: 11, name: 'gfotos-migrator-0.1.1.tgz'}]},
    {tag_name: 'v0.2.0-beta.1', draft: false, prerelease: true, assets: [{id: 12, name: 'gfotos-migrator-0.2.0-beta.1.tgz'}]},
    {tag_name: 'v0.2.0', draft: false, prerelease: false, assets: [{id: 13, name: 'gfotos-migrator-0.2.0.tgz'}]},
    {tag_name: 'v0.3.0', draft: false, prerelease: false, assets: []}
  ], '0.1.0');
  assert.deepEqual(update, {version: '0.2.0', assetId: 13, packageName: 'gfotos-migrator-0.2.0.tgz'});
});

test('importing database module does not emit the node:sqlite experimental warning', async () => {
  const root = path.resolve(fileURLToPath(import.meta.url), '../../');
  const databasePath = path.join(root, 'dist', 'database.js');
  const {stderr} = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(databasePath)})`], {encoding: 'utf8'}, (err, stdout, stderr) => {
      if (err) reject(err); else resolve({stdout, stderr});
    });
  });
  assert.ok(!(stderr.includes('ExperimentalWarning') && stderr.includes('SQLite')), `Unexpected SQLite warning on stderr: ${stderr}`);
});

test('does not suggest draft, prerelease, malformed, or older releases', () => {
  const update = findAvailableUpdate([
    {tag_name: 'v0.2.0', draft: true, prerelease: false, assets: [{id: 1, name: 'gfotos-migrator-0.2.0.tgz'}]},
    {tag_name: 'v0.1.1-rc.1', draft: false, prerelease: true, assets: [{id: 2, name: 'gfotos-migrator-0.1.1-rc.1.tgz'}]},
    {tag_name: 'latest', draft: false, prerelease: false, assets: [{id: 3, name: 'gfotos-migrator-latest.tgz'}]},
    {tag_name: 'v0.1.0', draft: false, prerelease: false, assets: [{id: 4, name: 'gfotos-migrator-0.1.0.tgz'}]}
  ], '0.1.0');
  assert.equal(update, undefined);
});

test('exports version from package.json', async () => {
  const {VERSION, PACKAGE_NAME} = await import('../dist/version.js');
  const packageInfo = require('../package.json');
  assert.equal(VERSION, packageInfo.version);
  assert.equal(PACKAGE_NAME, packageInfo.name);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

// Upgrade path regression tests

test('resolves npm prefix from a standard global executable path', () => {
  assert.equal(resolveExecutablePrefix('/home/user/.local/bin/gfotos-migrator'), '/home/user/.local');
  assert.equal(resolveExecutablePrefix('/usr/local/bin/gfotos-migrator'), '/usr/local');
  assert.equal(resolveExecutablePrefix('/opt/homebrew/bin/gfotos-migrator'), '/opt/homebrew');
});

test('throws when executable is not inside a bin directory', () => {
  assert.throws(() => resolveExecutablePrefix('/home/user/.local/gfotos-migrator'), /expected executable in a 'bin' directory/);
  assert.throws(() => resolveExecutablePrefix('/home/user/.local/sbin/gfotos-migrator'), /expected executable in a 'bin' directory/);
});

test('legacy 0.0.0 is offered an update to any newer stable release', () => {
  const releases = [
    {tag_name: 'v1.3.0', draft: false, prerelease: false, assets: [{id: 100, name: 'gfotos-migrator-1.3.0.tgz'}]},
    {tag_name: 'v0.1.0', draft: false, prerelease: false, assets: [{id: 10, name: 'gfotos-migrator-0.1.0.tgz'}]}
  ];
  const update = findAvailableUpdate(releases, '0.0.0');
  assert.deepEqual(update, {version: '1.3.0', assetId: 100, packageName: 'gfotos-migrator-1.3.0.tgz'});
});

test('declined update: returns undefined when already on latest stable release', () => {
  const releases = [
    {tag_name: 'v1.3.0', draft: false, prerelease: false, assets: [{id: 100, name: 'gfotos-migrator-1.3.0.tgz'}]}
  ];
  assert.equal(findAvailableUpdate(releases, '1.3.0'), undefined);
});

test('shadowed-path scenario: malformed current version does not produce an update', () => {
  const releases = [
    {tag_name: 'v1.3.0', draft: false, prerelease: false, assets: [{id: 100, name: 'gfotos-migrator-1.3.0.tgz'}]}
  ];
  // A shadowed/corrupt install might report no version or an invalid string.
  assert.equal(findAvailableUpdate(releases, ''), undefined);
  assert.equal(findAvailableUpdate(releases, 'unknown'), undefined);
});

test('findAvailableUpdate handles component-scoped tag gfotos-migrator-v1.3.0', () => {
  const releases = [
    {tag_name: 'gfotos-migrator-v1.3.0', draft: false, prerelease: false, assets: [{id: 100, name: 'gfotos-migrator-1.3.0.tgz'}]}
  ];
  const update = findAvailableUpdate(releases, '0.1.0');
  assert.deepEqual(update, {version: '1.3.0', assetId: 100, packageName: 'gfotos-migrator-1.3.0.tgz'});
});

test('findAvailableUpdate ignores component-scoped tag when already at that version', () => {
  const releases = [
    {tag_name: 'gfotos-migrator-v1.3.0', draft: false, prerelease: false, assets: [{id: 100, name: 'gfotos-migrator-1.3.0.tgz'}]}
  ];
  assert.equal(findAvailableUpdate(releases, '1.3.0'), undefined);
});

test('findAvailableUpdate selects component-scoped tag over an older plain tag', () => {
  const releases = [
    {tag_name: 'gfotos-migrator-v1.3.0', draft: false, prerelease: false, assets: [{id: 100, name: 'gfotos-migrator-1.3.0.tgz'}]},
    {tag_name: 'v0.2.0', draft: false, prerelease: false, assets: [{id: 20, name: 'gfotos-migrator-0.2.0.tgz'}]}
  ];
  const update = findAvailableUpdate(releases, '0.1.0');
  assert.deepEqual(update, {version: '1.3.0', assetId: 100, packageName: 'gfotos-migrator-1.3.0.tgz'});
});

test('failed-update scenario: release with no matching package asset is skipped', () => {
  const releases = [
    {tag_name: 'v1.4.0', draft: false, prerelease: false, assets: []},
    {tag_name: 'v1.3.1', draft: false, prerelease: false, assets: [{id: 200, name: 'gfotos-migrator-1.3.1.tgz'}]}
  ];
  const update = findAvailableUpdate(releases, '1.3.0');
  // v1.4.0 has no asset so the next best available (1.3.1) is returned.
  assert.deepEqual(update, {version: '1.3.1', assetId: 200, packageName: 'gfotos-migrator-1.3.1.tgz'});
});

test('verifyInstalledVersion detects a manifest version mismatch', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-migrator-test-'));
  const fakeModuleDir = path.join(directory, 'lib', 'node_modules', 'gfotos-migrator');
  try {
    await execute('/bin/mkdir', ['-p', fakeModuleDir]);
    await writeFile(path.join(fakeModuleDir, 'package.json'), JSON.stringify({version: '1.2.0'}));
    // Executable check will fail too since it's the wrong version; we only care about the manifest error here.
    await assert.rejects(
      verifyInstalledVersion(directory, '1.3.0', '/usr/bin/true'),
      /manifest.*1\.2\.0|1\.2\.0.*manifest/
    );
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('verifyInstalledVersion detects a missing package manifest', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-migrator-test-'));
  try {
    await assert.rejects(
      verifyInstalledVersion(directory, '1.3.0', '/usr/bin/true'),
      /Cannot read installed package manifest/
    );
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});


// Installer version-verification tests.
// These tests exercise the shell logic that checks whether the installed
// package manifest and active executable match the selected release version.

const installerRoot = path.resolve(fileURLToPath(import.meta.url), '../../');

/**
 * Build a self-contained bash snippet that reproduces the installer's
 * post-install version verification for a given scenario.
 *
 * @param {object} opts
 * @param {string} opts.expectedVersion   - The release version selected by the installer.
 * @param {string} opts.manifestVersion   - The version stored in the fake package.json.
 * @param {string} opts.executableVersion - The version output by the fake executable.
 * @param {string} opts.prefixDir         - Path to the fake USER_PREFIX directory.
 * @param {string} opts.binDir            - Path to the fake bin directory.
 */
function buildVerifySnippet({expectedVersion, manifestVersion, executableVersion, prefixDir, binDir}) {
  return `#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\\n' "[gfotos-migrator] ERROR: $*" >&2
  exit 1
}

expected_version="${expectedVersion}"
active_exe="${binDir}/gfotos-migrator"
USER_PREFIX="${prefixDir}"

[ -n "$active_exe" ] || fail "Installation completed but gfotos-migrator is not on PATH."

manifest_version="$(node --input-type=module --eval '
  import { readFileSync } from "node:fs";
  const [prefix] = process.argv.slice(1);
  const manifest = JSON.parse(readFileSync(\`\${prefix}/lib/node_modules/gfotos-migrator/package.json\`, "utf8"));
  process.stdout.write(manifest.version);
' "$USER_PREFIX" 2>/dev/null || true)"

if [ "$manifest_version" != "$expected_version" ]; then
  fail "Version mismatch: expected \${expected_version} in \${USER_PREFIX}/lib/node_modules/gfotos-migrator/package.json but found '\${manifest_version}'. Remove stale installations with: npm uninstall --global gfotos-migrator --prefix \${USER_PREFIX}"
fi

installed_version="$("$active_exe" --version 2>/dev/null | tr -d '[:space:]' || true)"

if [ "$installed_version" != "$expected_version" ]; then
  fail "Version mismatch: expected \${expected_version} but '\${active_exe} --version' returned '\${installed_version}'. A stale or shadowing executable may be earlier on PATH. Remove it or adjust PATH order, then rerun the installer."
fi

printf '%s\\n' "OK: \${expected_version} \${active_exe}"
`;
}

async function makeInstallerEnv(tmpDir, {manifestVersion, executableVersion}) {
  const moduleDir = path.join(tmpDir, 'lib', 'node_modules', 'gfotos-migrator');
  const binDir = path.join(tmpDir, 'bin');
  const {mkdir, chmod} = await import('node:fs/promises');
  await mkdir(moduleDir, {recursive: true});
  await mkdir(binDir, {recursive: true});
  await writeFile(path.join(moduleDir, 'package.json'), JSON.stringify({name: 'gfotos-migrator', version: manifestVersion}));
  const fakeExe = path.join(binDir, 'gfotos-migrator');
  await writeFile(fakeExe, `#!/usr/bin/env bash\necho '${executableVersion}'\n`);
  await chmod(fakeExe, 0o755);
  return {moduleDir, binDir};
}

test('installer version verification passes when manifest and executable match the selected release', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gfotos-installer-ok-'));
  try {
    const {binDir} = await makeInstallerEnv(tmpDir, {manifestVersion: '1.2.0', executableVersion: '1.2.0'});
    const snippet = buildVerifySnippet({
      expectedVersion: '1.2.0',
      manifestVersion: '1.2.0',
      executableVersion: '1.2.0',
      prefixDir: tmpDir,
      binDir,
    });
    const snippetPath = path.join(tmpDir, 'verify.sh');
    await writeFile(snippetPath, snippet, {mode: 0o755});
    const {stdout} = await new Promise((resolve, reject) => {
      execFile('/usr/bin/env', ['bash', snippetPath], {encoding: 'utf8'}, (err, stdout, stderr) => {
        if (err) reject(new Error(`Script failed: ${stderr || err.message}`)); else resolve({stdout, stderr});
      });
    });
    assert.match(stdout, /OK: 1\.2\.0/);
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});

test('installer version verification detects a stale 0.0.0 manifest after upgrade attempt', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gfotos-installer-stale-'));
  try {
    // Simulate the legacy package still installed in the prefix (version 0.0.0)
    // after an attempted upgrade to 1.2.0.
    const {binDir} = await makeInstallerEnv(tmpDir, {manifestVersion: '0.0.0', executableVersion: '0.0.0'});
    const snippet = buildVerifySnippet({
      expectedVersion: '1.2.0',
      manifestVersion: '0.0.0',
      executableVersion: '0.0.0',
      prefixDir: tmpDir,
      binDir,
    });
    const snippetPath = path.join(tmpDir, 'verify.sh');
    await writeFile(snippetPath, snippet, {mode: 0o755});
    const {code, stderr} = await new Promise((resolve) => {
      execFile('/usr/bin/env', ['bash', snippetPath], {encoding: 'utf8'}, (err, stdout, stderr) => {
        resolve({code: err?.code ?? 0, stderr});
      });
    });
    assert.notEqual(code, 0, 'Expected non-zero exit code for version mismatch');
    assert.match(stderr, /Version mismatch/);
    assert.match(stderr, /npm uninstall --global gfotos-migrator/);
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});

test('installer version verification detects a shadowing executable with wrong version', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gfotos-installer-shadow-'));
  try {
    // Manifest is correct but the active executable on PATH reports the old version.
    const {binDir} = await makeInstallerEnv(tmpDir, {manifestVersion: '1.2.0', executableVersion: '0.0.0'});
    const snippet = buildVerifySnippet({
      expectedVersion: '1.2.0',
      manifestVersion: '1.2.0',
      executableVersion: '0.0.0',
      prefixDir: tmpDir,
      binDir,
    });
    const snippetPath = path.join(tmpDir, 'verify.sh');
    await writeFile(snippetPath, snippet, {mode: 0o755});
    const {code, stderr} = await new Promise((resolve) => {
      execFile('/usr/bin/env', ['bash', snippetPath], {encoding: 'utf8'}, (err, stdout, stderr) => {
        resolve({code: err?.code ?? 0, stderr});
      });
    });
    assert.notEqual(code, 0, 'Expected non-zero exit code for shadowing executable');
    assert.match(stderr, /Version mismatch/);
    assert.match(stderr, /stale or shadowing executable/);
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});

test('installer derives correct package name from component-scoped tag gfotos-migrator-v1.3.0', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gfotos-installer-scoped-'));
  try {
    const snippetPath = path.join(tmpDir, 'derive.sh');
    await writeFile(snippetPath, `#!/usr/bin/env bash
set -euo pipefail
tag="gfotos-migrator-v1.3.0"
semver="\${tag#gfotos-migrator-}"
semver="\${semver#v}"
printf '%s\\n' "gfotos-migrator-\${semver}.tgz"
`, {mode: 0o755});
    const {stdout} = await new Promise((resolve, reject) => {
      execFile('/usr/bin/env', ['bash', snippetPath], {encoding: 'utf8'}, (err, stdout, stderr) => {
        if (err) reject(new Error(`Script failed: ${stderr || err.message}`)); else resolve({stdout, stderr});
      });
    });
    assert.equal(stdout.trim(), 'gfotos-migrator-1.3.0.tgz');
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});

test('installer derives correct package name from plain v-prefixed tag v1.3.0', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'gfotos-installer-plain-'));
  try {
    const snippetPath = path.join(tmpDir, 'derive.sh');
    await writeFile(snippetPath, `#!/usr/bin/env bash
set -euo pipefail
tag="v1.3.0"
semver="\${tag#gfotos-migrator-}"
semver="\${semver#v}"
printf '%s\\n' "gfotos-migrator-\${semver}.tgz"
`, {mode: 0o755});
    const {stdout} = await new Promise((resolve, reject) => {
      execFile('/usr/bin/env', ['bash', snippetPath], {encoding: 'utf8'}, (err, stdout, stderr) => {
        if (err) reject(new Error(`Script failed: ${stderr || err.message}`)); else resolve({stdout, stderr});
      });
    });
    assert.equal(stdout.trim(), 'gfotos-migrator-1.3.0.tgz');
  } finally {
    await rm(tmpDir, {recursive: true, force: true});
  }
});

// ─── Bundle engine tests ────────────────────────────────────────────────────

test('global pairing matches sidecar from a different archive', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-pair-'));
  try {
    await writeFile(path.join(directory, 'photo.jpg'), 'photo-content');
    await writeFile(path.join(directory, 'photo.jpg.json'), JSON.stringify({photoTakenTime: {timestamp: '1700000000'}}));
    await execute('/usr/bin/zip', ['archive1.zip', 'photo.jpg'], {cwd: directory});
    await execute('/usr/bin/zip', ['archive2.zip', 'photo.jpg.json'], {cwd: directory});
    const result = await inventoryTakeout(directory);
    const media = result.media.find(item => item.entryPath === 'photo.jpg');
    assert.ok(media, 'photo.jpg should be found');
    assert.equal(media.sidecarEntryPath, 'photo.jpg.json', 'sidecar entry should be found globally');
    assert.ok(media.sidecarArchivePath, 'sidecarArchivePath should be set for cross-archive sidecar');
    assert.ok(media.sidecarArchivePath.endsWith('archive2.zip'), 'sidecar archive should be archive2.zip');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('flat-name collision avoidance produces unique filenames', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-col-'));
  try {
    const importPath = path.join(directory, 'import');
    await mkdir(importPath, {recursive: true});
    await writeFile(path.join(importPath, 'photo.jpg'), 'original');
    await writeFile(path.join(importPath, 'photo~1.jpg'), 'second');
    const name1 = await safeImportFilename(importPath, 'photo.jpg');
    assert.equal(name1, 'photo~2.jpg');
    const name2 = await safeImportFilename(importPath, 'other.jpg');
    assert.equal(name2, 'other.jpg');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('bundle-database persists and retrieves bundle items', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-db-'));
  const db = await BundleDatabase.open(path.join(directory, 'bundle.sqlite'));
  try {
    const item = {hash: 'a'.repeat(64), archiveName: 'archive1.zip', entryPath: 'photo.jpg', mediaKind: 'image', state: 'materialized', hasSidecar: true, finalPath: 'photo.jpg'};
    db.save(item);
    const found = db.find('a'.repeat(64));
    assert.ok(found, 'item should be found by hash');
    assert.equal(found.state, 'materialized');
    assert.equal(found.finalPath, 'photo.jpg');
    const byEntry = db.findByEntry('archive1.zip', 'photo.jpg');
    assert.ok(byEntry, 'item should be found by entry');
    const counts = db.countByState();
    assert.equal(counts.materialized, 1);
    assert.equal(counts.duplicate, 0);
    assert.equal(db.countMissingSidecars(), 0);
  } finally {
    db.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('bundle works on non-APFS volume (simulated with temp dir)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-vol-'));
  try {
    const paths = await initializeBundlePaths(directory);
    assert.equal(paths.volumePath, directory);
    assert.ok(paths.importPath.endsWith('/import'), 'importPath should end with /import');
    assert.ok(paths.bundlePath.endsWith('/.gfotos-migrator'), 'bundlePath should end with /.gfotos-migrator');
    const {stat: statFn} = await import('node:fs/promises');
    await assert.doesNotReject(statFn(paths.importPath));
    await assert.doesNotReject(statFn(paths.sidecarsPath));
    await assert.doesNotReject(statFn(paths.reportsPath));
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('bundle rejects incompatible source fingerprint', () => {
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    counts: {total: 0, materialized: 0, duplicate: 0, failed: 0, skipped: 0, pending: 0, missingSidecar: 0}
  };
  assert.throws(
    () => validateBundleCompatibility(manifest, 'different-fingerprint'),
    /different source/
  );
});

test('bundle rejects corrupt manifest (missing required fields)', () => {
  assert.throws(
    () => validateBundleCompatibility({version: null, createdAt: null, updatedAt: null, sourceFingerprint: 'abc', counts: {}}, 'abc'),
    /corrupt/i
  );
});

test('bundle deduplication: second occurrence becomes duplicate', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-dedup-'));
  try {
    const sourceDir = path.join(directory, 'source');
    const volumeDir = path.join(directory, 'volume');
    await mkdir(sourceDir, {recursive: true});
    await mkdir(volumeDir, {recursive: true});
    await writeFile(path.join(sourceDir, 'photo.jpg'), 'identical-content');
    await execute('/usr/bin/zip', ['archive1.zip', 'photo.jpg'], {cwd: sourceDir});
    await writeFile(path.join(sourceDir, 'photo2.jpg'), 'identical-content');
    await execute('/usr/bin/zip', ['archive2.zip', 'photo2.jpg'], {cwd: sourceDir});
    const result = await prepareBundle(volumeDir, sourceDir, () => {});
    assert.equal(result.materialized, 1, 'one unique item should be materialized');
    assert.equal(result.duplicate, 1, 'one duplicate should be detected');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('bundle resumes from existing state and skips materialized items', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-resume-'));
  try {
    const sourceDir = path.join(directory, 'source');
    const volumeDir = path.join(directory, 'volume');
    await mkdir(sourceDir, {recursive: true});
    await mkdir(volumeDir, {recursive: true});
    await writeFile(path.join(sourceDir, 'photo.jpg'), 'photo-data');
    await execute('/usr/bin/zip', ['archive1.zip', 'photo.jpg'], {cwd: sourceDir});
    const first = await prepareBundle(volumeDir, sourceDir, () => {});
    assert.equal(first.materialized, 1);
    const second = await prepareBundle(volumeDir, sourceDir, () => {});
    assert.equal(second.materialized, 1, 'should report materialized from resume');
    assert.equal(second.failed, 0, 'should not have failures on resume');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('bundle deduplication: three identical files yield one output and two duplicate records', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-dedup3-'));
  try {
    const sourceDir = path.join(directory, 'source');
    const volumeDir = path.join(directory, 'volume');
    await mkdir(sourceDir, {recursive: true});
    await mkdir(volumeDir, {recursive: true});
    await writeFile(path.join(sourceDir, 'a.jpg'), 'triple-identical');
    await execute('/usr/bin/zip', ['arc1.zip', 'a.jpg'], {cwd: sourceDir});
    await writeFile(path.join(sourceDir, 'b.jpg'), 'triple-identical');
    await execute('/usr/bin/zip', ['arc2.zip', 'b.jpg'], {cwd: sourceDir});
    await writeFile(path.join(sourceDir, 'c.jpg'), 'triple-identical');
    await execute('/usr/bin/zip', ['arc3.zip', 'c.jpg'], {cwd: sourceDir});
    const result = await prepareBundle(volumeDir, sourceDir, () => {});
    assert.equal(result.materialized, 1, 'exactly one file should be materialized');
    assert.equal(result.duplicate, 2, 'two duplicates should be detected');
    assert.equal(result.failed, 0);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('importing bundle-database module does not emit the node:sqlite experimental warning', async () => {
  const root = path.resolve(fileURLToPath(import.meta.url), '../../');
  const databasePath = path.join(root, 'dist', 'bundle-database.js');
  const {stderr} = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(databasePath)})`], {encoding: 'utf8'}, (err, stdout, stderr) => {
      if (err) reject(err); else resolve({stdout, stderr});
    });
  });
  assert.ok(!(stderr.includes('ExperimentalWarning') && stderr.includes('SQLite')), `Unexpected SQLite warning on stderr: ${stderr}`);
});
