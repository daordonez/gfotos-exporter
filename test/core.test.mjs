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
import {initializeBundlePaths, safeImportFilename, validateBundleCompatibility, prepareBundle, writeBundleReport} from '../dist/bundle.js';
import {parseTakeoutSidecar, readTakeoutMetadata} from '../dist/takeout.js';
import {applyTakeoutMetadata, exifToolAvailable} from '../dist/media.js';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

// A minimal, valid 2x2 baseline JPEG used to exercise real ExifTool writes without adding
// a binary fixture file or a new project dependency.
const MINIMAL_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD50ooor8MP9Uz/2Q==';

async function writeMinimalJpeg(destination) {
  await writeFile(destination, Buffer.from(MINIMAL_JPEG_BASE64, 'base64'));
}

const exiftoolReady = await exifToolAvailable();
if (!exiftoolReady) {
  console.warn('exiftool is not installed in this environment; skipping ExifTool-dependent metadata tests.');
}

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


// ─── Takeout metadata parsing (sidecar) ────────────────────────────────────

test('parses a full sidecar: date, title, description, and geoData GPS', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-sidecar-full-'));
  try {
    const jsonPath = path.join(directory, 'photo.jpg.json');
    await writeFile(jsonPath, JSON.stringify({
      title: 'Sunset',
      description: 'A nice sunset over the bay',
      photoTakenTime: {timestamp: '1700000000'},
      geoData: {latitude: 37.4219999, longitude: -122.0862515, altitude: 5.5},
      geoDataExif: {latitude: 0, longitude: 0, altitude: 0}
    }));
    const result = await parseTakeoutSidecar(jsonPath);
    assert.equal(result.status, 'present');
    assert.equal(result.metadata.title, 'Sunset');
    assert.equal(result.metadata.description, 'A nice sunset over the bay');
    assert.equal(result.metadata.takenAt.getTime(), 1700000000 * 1000);
    assert.equal(result.metadata.latitude, 37.4219999);
    assert.equal(result.metadata.longitude, -122.0862515);
    assert.equal(result.metadata.altitude, 5.5);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('falls back to creationTime when photoTakenTime is absent', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-sidecar-fallback-'));
  try {
    const jsonPath = path.join(directory, 'photo.jpg.json');
    await writeFile(jsonPath, JSON.stringify({creationTime: {timestamp: '1600000000'}}));
    const result = await parseTakeoutSidecar(jsonPath);
    assert.equal(result.status, 'present');
    assert.equal(result.metadata.takenAt.getTime(), 1600000000 * 1000);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('falls back to geoDataExif when geoData is zero', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-sidecar-geo-fallback-'));
  try {
    const jsonPath = path.join(directory, 'photo.jpg.json');
    await writeFile(jsonPath, JSON.stringify({
      geoData: {latitude: 0, longitude: 0},
      geoDataExif: {latitude: 51.5, longitude: -0.1}
    }));
    const result = await parseTakeoutSidecar(jsonPath);
    assert.equal(result.status, 'present');
    assert.equal(result.metadata.latitude, 51.5);
    assert.equal(result.metadata.longitude, -0.1);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('sidecar status is missing when no path is given or file does not exist', async () => {
  const noPath = await parseTakeoutSidecar(undefined);
  assert.equal(noPath.status, 'missing');
  assert.deepEqual(noPath.metadata, {});

  const missingFile = await parseTakeoutSidecar('/nonexistent/path/does-not-exist.json');
  assert.equal(missingFile.status, 'missing');
});

test('sidecar status is invalid for malformed JSON, and readTakeoutMetadata never throws', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-sidecar-invalid-'));
  try {
    const jsonPath = path.join(directory, 'photo.jpg.json');
    await writeFile(jsonPath, '{not valid json');
    const result = await parseTakeoutSidecar(jsonPath);
    assert.equal(result.status, 'invalid');
    assert.deepEqual(result.metadata, {});

    // Back-compat: readTakeoutMetadata callers (e.g. the legacy migration path) must never throw
    // or discard valid media just because the sidecar is malformed.
    const legacy = await readTakeoutMetadata(jsonPath);
    assert.deepEqual(legacy, {});
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('sidecar with a non-object JSON shape is treated as invalid, not present', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-sidecar-shape-'));
  try {
    const jsonPath = path.join(directory, 'photo.jpg.json');
    await writeFile(jsonPath, '"just a string"');
    const result = await parseTakeoutSidecar(jsonPath);
    assert.equal(result.status, 'invalid');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

// ─── ExifTool metadata application (src/media.ts) ──────────────────────────

test('marks GPS as unsupported for GIF files without invoking ExifTool', async () => {
  // This test needs no ExifTool binary: applyTakeoutMetadata should recognize the
  // format cannot carry embedded GPS and skip invoking ExifTool entirely when GPS
  // is the only field present.
  const result = await applyTakeoutMetadata('/tmp/whatever-nonexistent.gif', 'image', {latitude: 1, longitude: 2});
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.unsupported, ['gps']);
});

test('returns empty applied/unsupported and skips ExifTool when there is no metadata to write', async () => {
  const result = await applyTakeoutMetadata('/tmp/whatever-nonexistent.jpg', 'image', {});
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.unsupported, []);
});

test('applies date, title, description, and GPS into a real JPEG via ExifTool', {skip: !exiftoolReady}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-exif-apply-'));
  try {
    const imagePath = path.join(directory, 'photo.jpg');
    await writeMinimalJpeg(imagePath);
    const metadata = {
      takenAt: new Date('2023-06-15T12:00:00.000Z'),
      title: 'Vacation',
      description: 'At the beach',
      latitude: 40.7128,
      longitude: -74.006,
      altitude: 10
    };
    const result = await applyTakeoutMetadata(imagePath, 'image', metadata);
    assert.deepEqual(result.applied.slice().sort(), ['date', 'description', 'gps', 'title'].sort());
    assert.deepEqual(result.unsupported, []);

    const {stdout} = await execute('/usr/bin/env', ['exiftool', '-json', '-DateTimeOriginal', '-Title', '-Description', '-GPSLatitude', '-GPSLongitude', imagePath]);
    const [tags] = JSON.parse(stdout);
    assert.equal(tags.DateTimeOriginal, '2023:06:15 12:00:00');
    assert.equal(tags.Title, 'Vacation');
    assert.equal(tags.Description, 'At the beach');
    assert.ok(tags.GPSLatitude.startsWith('40'), `expected latitude near 40, got ${tags.GPSLatitude}`);
    assert.ok(tags.GPSLongitude.includes('74'), `expected longitude near 74, got ${tags.GPSLongitude}`);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('applyTakeoutMetadata rejects (non-fatally, for the caller to catch) on an invalid video container', {skip: !exiftoolReady}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-exif-video-'));
  try {
    // No real video container is required here: ExifTool will reject the invalid MP4 content.
    // This asserts the video-specific argument branch is exercised and that ExifTool failures
    // surface as a rejected promise (callers, e.g. prepareBundle, must treat this as non-fatal).
    const videoPath = path.join(directory, 'clip.mp4');
    await writeFile(videoPath, 'not-a-real-video');
    await assert.rejects(applyTakeoutMetadata(videoPath, 'video', {takenAt: new Date('2023-01-01T00:00:00.000Z')}));
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

// ─── Bundle metadata enrichment (src/bundle.ts) ────────────────────────────

test('bundle: materializes an image and enriches it with full sidecar metadata', {skip: !exiftoolReady}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-meta-full-'));
  try {
    const sourceDir = path.join(directory, 'source');
    const volumeDir = path.join(directory, 'volume');
    await mkdir(sourceDir, {recursive: true});
    await mkdir(volumeDir, {recursive: true});
    await writeMinimalJpeg(path.join(sourceDir, 'photo.jpg'));
    await writeFile(path.join(sourceDir, 'photo.jpg.json'), JSON.stringify({
      title: 'Trip',
      description: 'Mountains',
      photoTakenTime: {timestamp: '1690000000'},
      geoData: {latitude: 46.5, longitude: 8.5, altitude: 1200}
    }));
    await execute('/usr/bin/zip', ['archive1.zip', 'photo.jpg', 'photo.jpg.json'], {cwd: sourceDir});

    const result = await prepareBundle(volumeDir, sourceDir, () => {});
    assert.equal(result.materialized, 1);
    assert.equal(result.failed, 0);

    const paths = await initializeBundlePaths(volumeDir);
    const database = await BundleDatabase.open(paths.databasePath);
    try {
      const items = database.listItems();
      assert.equal(items.length, 1);
      const [item] = items;
      assert.equal(item.state, 'materialized');
      assert.equal(item.sidecarStatus, 'present');
      assert.equal(item.metadataApplied, true);
      assert.ok(item.appliedFields.includes('date'));
      assert.ok(item.appliedFields.includes('title'));
      assert.ok(item.appliedFields.includes('description'));
      assert.ok(item.appliedFields.includes('gps'));
      assert.equal(item.metadataConflict, false);
    } finally {
      database.close();
    }

    const manifest = await loadManifestForTest(paths);
    assert.equal(manifest.counts.metadataApplied, 1);
    assert.equal(manifest.counts.metadataPresent, 1);
    assert.equal(manifest.counts.metadataConflicting, 0);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('bundle: missing sidecar never discards valid media', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-meta-missing-'));
  try {
    const sourceDir = path.join(directory, 'source');
    const volumeDir = path.join(directory, 'volume');
    await mkdir(sourceDir, {recursive: true});
    await mkdir(volumeDir, {recursive: true});
    await writeFile(path.join(sourceDir, 'photo.jpg'), 'photo-bytes-no-sidecar');
    await execute('/usr/bin/zip', ['archive1.zip', 'photo.jpg'], {cwd: sourceDir});

    const result = await prepareBundle(volumeDir, sourceDir, () => {});
    assert.equal(result.materialized, 1, 'media without any sidecar is still materialized');
    assert.equal(result.failed, 0);

    const paths = await initializeBundlePaths(volumeDir);
    const database = await BundleDatabase.open(paths.databasePath);
    try {
      const [item] = database.listItems();
      assert.equal(item.state, 'materialized');
      assert.equal(item.hasSidecar, false);
      assert.equal(item.sidecarStatus, 'missing');
      assert.equal(item.metadataApplied, false);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('bundle: invalid sidecar JSON never discards valid media', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-meta-invalid-'));
  try {
    const sourceDir = path.join(directory, 'source');
    const volumeDir = path.join(directory, 'volume');
    await mkdir(sourceDir, {recursive: true});
    await mkdir(volumeDir, {recursive: true});
    await writeFile(path.join(sourceDir, 'photo.jpg'), 'photo-bytes-with-bad-sidecar');
    await writeFile(path.join(sourceDir, 'photo.jpg.json'), '{this is not json');
    await execute('/usr/bin/zip', ['archive1.zip', 'photo.jpg', 'photo.jpg.json'], {cwd: sourceDir});

    const result = await prepareBundle(volumeDir, sourceDir, () => {});
    assert.equal(result.materialized, 1, 'media with a malformed sidecar is still materialized');
    assert.equal(result.failed, 0);

    const paths = await initializeBundlePaths(volumeDir);
    const database = await BundleDatabase.open(paths.databasePath);
    try {
      const [item] = database.listItems();
      assert.equal(item.state, 'materialized');
      assert.equal(item.hasSidecar, true, 'a sidecar file was present, even though unparsable');
      assert.equal(item.sidecarStatus, 'invalid');
      assert.equal(item.metadataApplied, false);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('bundle: detects and records metadata conflicts across duplicate sidecars', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-meta-conflict-'));
  try {
    const sourceDir = path.join(directory, 'source');
    const volumeDir = path.join(directory, 'volume');
    await mkdir(sourceDir, {recursive: true});
    await mkdir(volumeDir, {recursive: true});

    await writeFile(path.join(sourceDir, 'a.jpg'), 'identical-bytes-for-conflict-test');
    await writeFile(path.join(sourceDir, 'a.jpg.json'), JSON.stringify({title: 'Original title', photoTakenTime: {timestamp: '1000000000'}}));
    await execute('/usr/bin/zip', ['arc1.zip', 'a.jpg', 'a.jpg.json'], {cwd: sourceDir});

    await writeFile(path.join(sourceDir, 'b.jpg'), 'identical-bytes-for-conflict-test');
    await writeFile(path.join(sourceDir, 'b.jpg.json'), JSON.stringify({title: 'Different title', photoTakenTime: {timestamp: '1000000000'}}));
    await execute('/usr/bin/zip', ['arc2.zip', 'b.jpg', 'b.jpg.json'], {cwd: sourceDir});

    const result = await prepareBundle(volumeDir, sourceDir, () => {});
    assert.equal(result.materialized, 1);
    assert.equal(result.duplicate, 1);

    const paths = await initializeBundlePaths(volumeDir);
    const database = await BundleDatabase.open(paths.databasePath);
    try {
      const items = database.listItems();
      // Both the canonical (materialized) and the duplicate record should reflect the conflict.
      assert.ok(items.every(item => item.metadataConflict === true), 'both records should be flagged as conflicting');
      const conflicts = database.listMetadataConflicts();
      assert.ok(conflicts.length >= 1, 'at least one conflict entry should be recorded');
      const titleConflict = conflicts.find(c => c.field === 'title');
      assert.ok(titleConflict, 'a title conflict should be recorded');
      assert.equal(titleConflict.canonicalValue, 'Original title');
      assert.equal(titleConflict.conflictingValue, 'Different title');
    } finally {
      database.close();
    }

    const manifest = await loadManifestForTest(paths);
    assert.equal(manifest.counts.metadataConflicting, 1, 'exactly one distinct hash should be flagged conflicting');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('bundle report distinguishes metadata preserved (raw JSON kept) from metadata applied (written via ExifTool)', {skip: !exiftoolReady}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-report-meta-'));
  try {
    const sourceDir = path.join(directory, 'source');
    const volumeDir = path.join(directory, 'volume');
    await mkdir(sourceDir, {recursive: true});
    await mkdir(volumeDir, {recursive: true});
    await writeMinimalJpeg(path.join(sourceDir, 'photo.jpg'));
    await writeFile(path.join(sourceDir, 'photo.jpg.json'), JSON.stringify({title: 'Report Test', photoTakenTime: {timestamp: '1690000000'}}));
    await execute('/usr/bin/zip', ['archive1.zip', 'photo.jpg', 'photo.jpg.json'], {cwd: sourceDir});

    await prepareBundle(volumeDir, sourceDir, () => {});
    const reportPath = await writeBundleReport(volumeDir);
    const report = await readFileForTest(reportPath);
    assert.match(report, /metadataApplied/);
    assert.match(report, /metadataPresent/);
    assert.match(report, /written into the materialized media file via ExifTool/i);
    assert.match(report, /sidecar JSON was found and parsed/i);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

async function loadManifestForTest(paths) {
  const text = await readFileForTest(paths.manifestPath);
  return JSON.parse(text);
}

async function readFileForTest(target) {
  const {readFile} = await import('node:fs/promises');
  return readFile(target, 'utf8');
}
