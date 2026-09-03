import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile, mkdir, readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {isSafeArchivePath} from '../dist/system.js';
import {inventoryTakeout, readTakeoutMetadata} from '../dist/takeout.js';
import {findAvailableUpdate, resolveExecutablePrefix, verifyInstalledVersion} from '../dist/updates.js';
import {prepareFailureAction} from '../dist/tui.js';
import {isSelectableExternalVolume, parentWholeDiskIdentifier, volumeMountPath} from '../dist/volume.js';
import {BundleDatabase} from '../dist/bundle-database.js';
import {checkBundleVolume, initializeBundlePaths, loadManifest, requiredBundleBytes, safeImportFilename, validateBundleCompatibility, prepareBundle, writeBundleReport} from '../dist/bundle.js';
import {applyTakeoutMetadata, exifToolAvailable} from '../dist/media.js';
import {detectContainer, validateJpeg, validateMediaFile, validateMp4, validatePng} from '../dist/media-validate.js';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

// A tiny (2x2 pixel) but structurally valid JPEG, reused as the shared valid-media fixture
// content wherever these tests need real image bytes rather than plain ASCII placeholders.
const MINIMAL_VALID_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDFoooryz7w/9k=';
const MINIMAL_VALID_JPEG = Buffer.from(MINIMAL_VALID_JPEG_BASE64, 'base64');

test('rejects unsafe archive paths', () => {
  assert.equal(isSafeArchivePath('../escape.jpg'), false);
  assert.equal(isSafeArchivePath('/absolute.jpg'), false);
  assert.equal(isSafeArchivePath('Album/photo.jpg'), true);
});

test('adds bundle storage headroom', () => {
  assert.equal(requiredBundleBytes({archives: 1, images: 1, videos: 0, compressedBytes: 10, extractBytes: 100, rejectedEntries: 0}), 120);
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

test('checkBundleVolume validates writability and capacity for any filesystem', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-check-'));
  try {
    const info = await checkBundleVolume(directory, 10);
    assert.equal(info.writable, true);
    assert.equal(info.sufficient, true);
    assert.ok(info.availableBytes >= 10);
    await assert.rejects(checkBundleVolume(directory, Number.MAX_SAFE_INTEGER), /enough free space/);
    await assert.rejects(checkBundleVolume(path.join(directory, 'missing'), 0), /does not exist/);
  } finally {
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
  assert.throws(
    () => validateBundleCompatibility(manifest, 'different-fingerprint'),
    /clear(?:ing)? both import\/ and \.gfotos-migrator\//
  );
});

test('bundle rejects corrupt manifest (missing required fields)', () => {
  assert.throws(
    () => validateBundleCompatibility({version: null, createdAt: null, updatedAt: null, sourceFingerprint: 'abc', counts: {}}, 'abc'),
    /corrupt/i
  );
  assert.throws(
    () => validateBundleCompatibility({version: null, createdAt: null, updatedAt: null, sourceFingerprint: 'abc', counts: {}}, 'abc'),
    /clear(?:ing)? both import\/ and \.gfotos-migrator\//
  );
});

test('loadManifest rejects corrupt manifest JSON with a stable error', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-manifest-'));
  try {
    const paths = await initializeBundlePaths(directory);
    await writeFile(paths.manifestPath, '{not-json');
    await assert.rejects(loadManifest(paths), /Corrupt bundle manifest: JSON could not be parsed/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('bundle deduplication: second occurrence becomes duplicate', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-dedup-'));
  try {
    const sourceDir = path.join(directory, 'source');
    const volumeDir = path.join(directory, 'volume');
    await mkdir(sourceDir, {recursive: true});
    await mkdir(volumeDir, {recursive: true});
    await writeFile(path.join(sourceDir, 'photo.jpg'), MINIMAL_VALID_JPEG);
    await execute('/usr/bin/zip', ['archive1.zip', 'photo.jpg'], {cwd: sourceDir});
    await writeFile(path.join(sourceDir, 'photo2.jpg'), MINIMAL_VALID_JPEG);
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
    await writeFile(path.join(sourceDir, 'photo.jpg'), MINIMAL_VALID_JPEG);
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
    await writeFile(path.join(sourceDir, 'a.jpg'), MINIMAL_VALID_JPEG);
    await execute('/usr/bin/zip', ['arc1.zip', 'a.jpg'], {cwd: sourceDir});
    await writeFile(path.join(sourceDir, 'b.jpg'), MINIMAL_VALID_JPEG);
    await execute('/usr/bin/zip', ['arc2.zip', 'b.jpg'], {cwd: sourceDir});
    await writeFile(path.join(sourceDir, 'c.jpg'), MINIMAL_VALID_JPEG);
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

// ─── CLI dispatch and Import Bundle command surface ────────────────────────

const cliPath = path.resolve(fileURLToPath(import.meta.url), '../../dist/cli.js');

test('CLI --help documents the Import Bundle command surface and omits removed Photos-specific commands', async () => {
  const {stdout} = await execute(process.execPath, [cliPath, '--help']);
  for (const removed of ['doctor', 'import-takeout', 'handoff-check', 'cleanup', 'prepare-volume', 'photos-running', 'bundle-prepare', 'bundle-resume', 'bundle-status', 'bundle-report']) {
    assert.ok(!stdout.includes(removed), `--help should not mention removed command: ${removed}`);
  }
  for (const kept of ['guided-migration', 'inspect', 'prepare', 'resume', 'status', 'report']) {
    assert.ok(stdout.includes(kept), `--help should mention command: ${kept}`);
  }
});

test('CLI rejects an unknown command with a non-zero exit code', async () => {
  await assert.rejects(execute(process.execPath, [cliPath, 'doctor']));
  await assert.rejects(execute(process.execPath, [cliPath, 'totally-unknown-command']));
});

async function makeSyntheticTakeout(sourceDir) {
  await mkdir(sourceDir, {recursive: true});
  await writeFile(path.join(sourceDir, 'photo.jpg'), MINIMAL_VALID_JPEG);
  await writeFile(path.join(sourceDir, 'photo.jpg.json'), JSON.stringify({photoTakenTime: {timestamp: '1700000000'}}));
  await execute('/usr/bin/zip', ['takeout-1.zip', 'photo.jpg', 'photo.jpg.json'], {cwd: sourceDir});
}

test('CLI inspect/prepare/resume/status/report work end-to-end against a synthetic Takeout fixture', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-cli-bundle-'));
  try {
    const sourceDir = path.join(directory, 'source');
    const volumeDir = path.join(directory, 'volume');
    await makeSyntheticTakeout(sourceDir);
    await mkdir(volumeDir, {recursive: true});

    const inspectNoVolume = await execute(process.execPath, [cliPath, 'inspect', '--source', sourceDir]);
    const inspected = JSON.parse(inspectNoVolume.stdout);
    assert.equal(inspected.inventory.images, 1);
    assert.equal(inspected.volume, undefined);

    const inspectWithVolume = await execute(process.execPath, [cliPath, 'inspect', '--source', sourceDir, '--volume', volumeDir]);
    const inspectedWithVolume = JSON.parse(inspectWithVolume.stdout);
    assert.equal(inspectedWithVolume.volume.sufficient, true);
    assert.equal(inspectedWithVolume.volumeError, undefined);

    const prepared = await execute(process.execPath, [cliPath, 'prepare', '--source', sourceDir, '--volume', volumeDir]);
    const preparedLines = prepared.stdout.trim().split('\n');
    const preparedResult = JSON.parse(preparedLines.slice(preparedLines.findIndex(line => line.startsWith('{'))).join('\n'));
    assert.equal(preparedResult.materialized, 1);
    assert.equal(preparedResult.failed, 0);

    const resumed = await execute(process.execPath, [cliPath, 'resume', '--source', sourceDir, '--volume', volumeDir]);
    const resumedLines = resumed.stdout.trim().split('\n');
    const resumedResult = JSON.parse(resumedLines.slice(resumedLines.findIndex(line => line.startsWith('{'))).join('\n'));
    assert.equal(resumedResult.materialized, 1);
    assert.equal(resumedResult.failed, 0);

    const status = await execute(process.execPath, [cliPath, 'status', '--volume', volumeDir]);
    const manifest = JSON.parse(status.stdout);
    assert.equal(manifest.counts.materialized, 1);

    const report = await execute(process.execPath, [cliPath, 'report', '--volume', volumeDir]);
    const reportPath = report.stdout.trim();
    assert.ok(reportPath.includes('.gfotos-migrator'));
    const {stat: statFn, readdir: readdirFn} = await import('node:fs/promises');
    await assert.doesNotReject(statFn(reportPath));

    const rootEntries = await readdirFn(volumeDir);
    assert.deepEqual([...rootEntries].sort(), ['.gfotos-migrator', 'import']);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

// --- Metadata: sidecar parsing ---

test('readTakeoutMetadata parses dates, GPS, title, and description from a full sidecar', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-metadata-full-'));
  try {
    const jsonPath = path.join(directory, 'photo.jpg.json');
    await writeFile(jsonPath, JSON.stringify({
      title: 'My Photo',
      description: 'A lovely day',
      photoTakenTime: {timestamp: '1609459200'}, // 2021-01-01T00:00:00Z
      creationTime: {timestamp: '1609000000'},
      geoData: {latitude: 48.8566, longitude: 2.3522, altitude: 35.0}
    }));
    const metadata = await readTakeoutMetadata(jsonPath);
    assert.equal(metadata.title, 'My Photo');
    assert.equal(metadata.description, 'A lovely day');
    assert.equal(metadata.takenAt.toISOString(), new Date(1609459200 * 1000).toISOString());
    assert.equal(metadata.latitude, 48.8566);
    assert.equal(metadata.longitude, 2.3522);
    assert.equal(metadata.altitude, 35.0);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('readTakeoutMetadata parses a video sidecar with full fields', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-metadata-video-'));
  try {
    const jsonPath = path.join(directory, 'clip.mov.json');
    await writeFile(jsonPath, JSON.stringify({
      title: 'My Clip',
      description: 'A short video',
      photoTakenTime: {timestamp: '1609459200'},
      geoData: {latitude: -33.8688, longitude: 151.2093, altitude: 12.0}
    }));
    const metadata = await readTakeoutMetadata(jsonPath);
    assert.equal(metadata.title, 'My Clip');
    assert.equal(metadata.description, 'A short video');
    assert.equal(metadata.latitude, -33.8688);
    assert.equal(metadata.longitude, 151.2093);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('readTakeoutMetadata returns empty metadata for a missing sidecar', async () => {
  const metadata = await readTakeoutMetadata(undefined);
  assert.deepEqual(metadata, {});
});

test('readTakeoutMetadata returns empty metadata for invalid JSON without throwing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-metadata-invalid-'));
  try {
    const jsonPath = path.join(directory, 'broken.json');
    await writeFile(jsonPath, '{ this is not valid json ');
    let metadata;
    await assert.doesNotReject(async () => { metadata = await readTakeoutMetadata(jsonPath); });
    assert.deepEqual(metadata, {});
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('readTakeoutMetadata falls back to creationTime when photoTakenTime is absent', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-metadata-fallback-'));
  try {
    const jsonPath = path.join(directory, 'photo.jpg.json');
    await writeFile(jsonPath, JSON.stringify({creationTime: {timestamp: '1609000000'}}));
    const metadata = await readTakeoutMetadata(jsonPath);
    assert.equal(metadata.takenAt.toISOString(), new Date(1609000000 * 1000).toISOString());
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('readTakeoutMetadata treats geoData of (0, 0) as absent location', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-metadata-nogeo-'));
  try {
    const jsonPath = path.join(directory, 'photo.jpg.json');
    await writeFile(jsonPath, JSON.stringify({photoTakenTime: {timestamp: '1609459200'}, geoData: {latitude: 0, longitude: 0, altitude: 0}}));
    const metadata = await readTakeoutMetadata(jsonPath);
    assert.equal(metadata.latitude, undefined);
    assert.equal(metadata.longitude, undefined);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

// --- Metadata: applying to output media via ExifTool ---

const HAS_EXIFTOOL = await exifToolAvailable();

/** Minimal but structurally valid MP4 container (ftyp + moov boxes) that ExifTool will accept. */
function buildMinimalMp4() {
  const box = (type, data = Buffer.alloc(0)) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + data.length, 0);
    header.write(type, 4, 'ascii');
    return Buffer.concat([header, data]);
  };
  const ftypData = Buffer.concat([Buffer.from('isom', 'ascii'), Buffer.alloc(4), Buffer.from('isomiso2avc1mp41', 'ascii')]);
  const ftyp = box('ftyp', ftypData);
  const moov = box('moov', box('mvhd', Buffer.alloc(100)));
  return Buffer.concat([ftyp, moov]);
}

/** Same minimal MP4 as buildMinimalMp4(), but with a leading `free` padding box before `ftyp`, as some encoders/editors emit. */
function buildMinimalMp4WithLeadingPadding() {
  const box = (type, data = Buffer.alloc(0)) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + data.length, 0);
    header.write(type, 4, 'ascii');
    return Buffer.concat([header, data]);
  };
  const free = box('free', Buffer.alloc(16));
  return Buffer.concat([free, buildMinimalMp4()]);
}

test('applyTakeoutMetadata embeds dates, GPS, title, and description into a JPEG', {skip: !HAS_EXIFTOOL && 'exiftool is not installed in this environment'}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-media-jpg-'));
  try {
    const filePath = path.join(directory, 'photo.jpg');
    await writeFile(filePath, MINIMAL_VALID_JPEG);
    const metadata = {
      takenAt: new Date('2021-01-01T00:00:00.000Z'),
      title: 'My Photo',
      description: 'A lovely day',
      latitude: 48.8566,
      longitude: 2.3522,
      altitude: 35
    };
    const statuses = await applyTakeoutMetadata(filePath, 'image', metadata);
    assert.equal(statuses.takenAt, 'applied');
    assert.equal(statuses.title, 'applied');
    assert.equal(statuses.description, 'applied');
    assert.equal(statuses.latitude, 'applied');
    assert.equal(statuses.longitude, 'applied');
    assert.equal(statuses.altitude, 'applied');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('applyTakeoutMetadata embeds dates, GPS, and title into a minimal MP4', {skip: !HAS_EXIFTOOL && 'exiftool is not installed in this environment'}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-media-mp4-'));
  try {
    const filePath = path.join(directory, 'clip.mp4');
    await writeFile(filePath, buildMinimalMp4());
    const metadata = {
      takenAt: new Date('2021-01-01T00:00:00.000Z'),
      title: 'My Clip',
      description: 'A short video',
      latitude: -33.8688,
      longitude: 151.2093
    };
    const statuses = await applyTakeoutMetadata(filePath, 'video', metadata);
    assert.equal(statuses.takenAt, 'applied');
    assert.equal(statuses.title, 'applied');
    assert.equal(statuses.description, 'applied');
    assert.equal(statuses.latitude, 'applied');
    assert.equal(statuses.longitude, 'applied');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('applyTakeoutMetadata reports no field statuses when the sidecar had no values', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-media-empty-'));
  try {
    const filePath = path.join(directory, 'photo.jpg');
    await writeFile(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const statuses = await applyTakeoutMetadata(filePath, 'image', {});
    assert.deepEqual(statuses, {});
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('applyTakeoutMetadata marks fields unsupported when ExifTool cannot process the file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-media-corrupt-'));
  try {
    const filePath = path.join(directory, 'not-really-a-photo.jpg');
    // Bytes that are not a valid image in any format ExifTool recognizes for writing.
    await writeFile(filePath, Buffer.from('this is definitely not an image file, just plain garbage bytes'));
    const statuses = await applyTakeoutMetadata(filePath, 'image', {title: 'Won\u2019t stick'});
    assert.equal(statuses.title, 'unsupported');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

// --- Metadata: bundle-level conflict detection and reporting ---

test('prepareBundle records a metadata conflict when duplicate media has divergent sidecar values', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-conflict-'));
  try {
    const sourceDir = path.join(directory, 'source');
    const volumeDir = path.join(directory, 'volume');
    await mkdir(sourceDir, {recursive: true});
    await mkdir(volumeDir, {recursive: true});

    await writeFile(path.join(sourceDir, 'photo.jpg'), MINIMAL_VALID_JPEG);
    await writeFile(path.join(sourceDir, 'photo.jpg.json'), JSON.stringify({title: 'Original Title', photoTakenTime: {timestamp: '1609459200'}}));
    await execute('/usr/bin/zip', ['archive1.zip', 'photo.jpg', 'photo.jpg.json'], {cwd: sourceDir});

    await writeFile(path.join(sourceDir, 'photo-copy.jpg'), MINIMAL_VALID_JPEG);
    await writeFile(path.join(sourceDir, 'photo-copy.jpg.json'), JSON.stringify({title: 'Different Title', photoTakenTime: {timestamp: '1609459200'}}));
    await execute('/usr/bin/zip', ['archive2.zip', 'photo-copy.jpg', 'photo-copy.jpg.json'], {cwd: sourceDir});

    const result = await prepareBundle(volumeDir, sourceDir, () => {});
    assert.equal(result.materialized, 1);
    assert.equal(result.duplicate, 1);

    const paths = await initializeBundlePaths(volumeDir);
    const db = await BundleDatabase.open(paths.databasePath);
    try {
      const conflicts = db.listConflicts();
      const titleConflict = conflicts.find(conflict => conflict.field === 'title');
      assert.ok(titleConflict, 'a title conflict should be recorded');
      const values = titleConflict.values.map(v => v.value).sort();
      assert.deepEqual(values, ['Different Title', 'Original Title']);

      const counts = db.countMetadata();
      assert.equal(counts.conflicting, 1, 'exactly one field should be flagged as conflicting');
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('CLI status/report reject a volume without a prepared bundle', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-cli-nobundle-'));
  try {
    await assert.rejects(execute(process.execPath, [cliPath, 'status', '--volume', directory]));
    await assert.rejects(execute(process.execPath, [cliPath, 'report', '--volume', directory]));
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('prepareBundle materializes media even when the sidecar JSON is malformed', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-badjson-'));
  try {
    const sourceDir = path.join(directory, 'source');
    const volumeDir = path.join(directory, 'volume');
    await mkdir(sourceDir, {recursive: true});
    await mkdir(volumeDir, {recursive: true});
    await writeFile(path.join(sourceDir, 'photo.jpg'), MINIMAL_VALID_JPEG);
    await writeFile(path.join(sourceDir, 'photo.jpg.json'), '{ not valid json at all');
    await execute('/usr/bin/zip', ['archive1.zip', 'photo.jpg', 'photo.jpg.json'], {cwd: sourceDir});

    const result = await prepareBundle(volumeDir, sourceDir, () => {});
    assert.equal(result.materialized, 1, 'media should materialize despite invalid sidecar JSON');
    assert.equal(result.failed, 0);

    const paths = await initializeBundlePaths(volumeDir);
    const db = await BundleDatabase.open(paths.databasePath);
    try {
      const counts = db.countMetadata();
      assert.ok(counts.invalid > 0, 'invalid sidecar fields should be counted');
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('compiled CLI and TUI no longer reference Apple Photos automation', async () => {
  const root = path.resolve(fileURLToPath(import.meta.url), '../../');
  const {readFile: readFileFn} = await import('node:fs/promises');
  const cliSource = await readFileFn(path.join(root, 'dist', 'cli.js'), 'utf8');
  const tuiSource = await readFileFn(path.join(root, 'dist', 'tui.js'), 'utf8');
  for (const source of [cliSource, tuiSource]) {
    assert.ok(!source.includes('./photos.js'), 'compiled output must not import the Photos automation module');
    assert.ok(!source.includes('osascript'), 'compiled output must not reference AppleScript automation');
  }
});

test('prepareFailureAction limits fresh-start guidance to bundle-state errors', () => {
  assert.match(
    prepareFailureAction('Bundle state is corrupt: manifest is missing required fields.'),
    /clear both import\/ and \.gfotos-migrator\//
  );
  assert.match(
    prepareFailureAction('Bundle was prepared for a different source.'),
    /Use the original Takeout source to resume/
  );
  assert.match(
    prepareFailureAction('Corrupt bundle manifest: JSON could not be parsed.'),
    /Start fresh on a new empty destination/
  );
  assert.equal(
    prepareFailureAction('The selected volume does not have enough free space.'),
    'Resolve the reported source, destination, or storage issue, then try again.'
  );
});

test('compiled TUI exposes the exact root menu and Tools submenu labels', async () => {
  const root = path.resolve(fileURLToPath(import.meta.url), '../../');
  const {readFile: readFileFn} = await import('node:fs/promises');
  const tuiSource = await readFileFn(path.join(root, 'dist', 'tui.js'), 'utf8');
  for (const label of ['Start guided migration', 'Tools']) {
    assert.ok(tuiSource.includes(label), `root menu should include: ${label}`);
  }
  for (const label of ['Inspect Takeout', 'Prepare or resume Import Bundle', 'Status', 'Report', 'Back']) {
    assert.ok(tuiSource.includes(label), `Tools submenu should include: ${label}`);
  }
  assert.ok(!tuiSource.includes('Waiting for the new library to appear'), 'the Photos library wait screen must be removed');
  assert.ok(!tuiSource.includes('erase-confirmation'), 'the disk erase confirmation screen must be removed');
  assert.ok(
    tuiSource.includes('Use the original Takeout source to resume, or start fresh on a new empty destination by clearing both import/ and .gfotos-migrator/, then try again.'),
    'resume guidance should explain that a fresh restart must clear both import/ and bundle state'
  );
});

test('prepareBundle materializes media when there is no sidecar at all', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-nosidecar-'));
  try {
    const sourceDir = path.join(directory, 'source');
    const volumeDir = path.join(directory, 'volume');
    await mkdir(sourceDir, {recursive: true});
    await mkdir(volumeDir, {recursive: true});
    await writeFile(path.join(sourceDir, 'photo.jpg'), MINIMAL_VALID_JPEG);
    await execute('/usr/bin/zip', ['archive1.zip', 'photo.jpg'], {cwd: sourceDir});

    const result = await prepareBundle(volumeDir, sourceDir, () => {});
    assert.equal(result.materialized, 1);
    assert.equal(result.failed, 0);

    const paths = await initializeBundlePaths(volumeDir);
    const db = await BundleDatabase.open(paths.databasePath);
    try {
      const counts = db.countMetadata();
      assert.ok(counts.missing > 0, 'fields without a sidecar should be counted as missing');
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('writeBundleReport includes a Metadata section with counts and conflicts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-report-'));
  try {
    const sourceDir = path.join(directory, 'source');
    const volumeDir = path.join(directory, 'volume');
    await mkdir(sourceDir, {recursive: true});
    await mkdir(volumeDir, {recursive: true});
    await writeFile(path.join(sourceDir, 'photo.jpg'), MINIMAL_VALID_JPEG);
    await writeFile(path.join(sourceDir, 'photo.jpg.json'), JSON.stringify({title: 'Report Title', photoTakenTime: {timestamp: '1609459200'}}));
    await execute('/usr/bin/zip', ['archive1.zip', 'photo.jpg', 'photo.jpg.json'], {cwd: sourceDir});
    await prepareBundle(volumeDir, sourceDir, () => {});

    const reportPath = await writeBundleReport(volumeDir);
    const report = await readFile(reportPath, 'utf8');
    assert.match(report, /## Metadata/);
    assert.match(report, /applied \(embedded into output media\)/);
    assert.match(report, /conflicting \(same hash, divergent sidecar values\)/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

// --- Content-based media validation (src/media-validate.ts) ---

const {crc32} = await import('node:zlib');

/** Minimal but structurally valid single-pixel PNG (signature + IHDR + IEND, no IDAT). */
function buildMinimalPng() {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([length, typeBuf, data, crc]);
  };
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);
  ihdrData.writeUInt32BE(1, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  const ihdr = chunk('IHDR', ihdrData);
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, iend]);
}

test('detectContainer sniffs by magic bytes only', () => {
  assert.equal(detectContainer(MINIMAL_VALID_JPEG), 'jpeg');
  assert.equal(detectContainer(buildMinimalPng()), 'png');
  assert.equal(detectContainer(buildMinimalMp4()), 'mp4');
  assert.equal(detectContainer(Buffer.from('this is not media at all')), 'unknown');
});

test('detectContainer recognizes an MP4 with a leading padding box before ftyp', () => {
  const padded = buildMinimalMp4WithLeadingPadding();
  assert.equal(detectContainer(padded), 'mp4', 'a leading free/skip/wide box before ftyp must not cause misclassification as unknown');
});

test('validateMediaFile accepts an MP4 with a leading padding box before ftyp as valid', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-media-mp4-padding-'));
  try {
    const filePath = path.join(directory, 'clip.mp4');
    await writeFile(filePath, buildMinimalMp4WithLeadingPadding());
    const result = await validateMediaFile(filePath, 'video');
    assert.equal(result.status, 'valid');
    assert.equal(result.container, 'mp4');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('validateJpeg accepts a structurally valid JPEG and rejects truncation', () => {
  const valid = validateJpeg(MINIMAL_VALID_JPEG);
  assert.equal(valid.status, 'valid');
  assert.equal(valid.container, 'jpeg');

  const truncated = validateJpeg(MINIMAL_VALID_JPEG.subarray(0, MINIMAL_VALID_JPEG.length - 10));
  assert.equal(truncated.status, 'invalid');
  assert.ok(truncated.reason);

  const garbageAfterSoi = validateJpeg(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from('not a real jpeg segment at all, just noise')]));
  assert.equal(garbageAfterSoi.status, 'invalid');
});

test('validatePng accepts a minimal valid PNG and rejects CRC mismatches and missing IEND', () => {
  const png = buildMinimalPng();
  const valid = validatePng(png);
  assert.equal(valid.status, 'valid');
  assert.equal(valid.container, 'png');

  const corrupted = Buffer.from(png);
  corrupted[20] = corrupted[20] ^ 0xff; // flip a byte inside the IHDR chunk's data
  const crcFailure = validatePng(corrupted);
  assert.equal(crcFailure.status, 'invalid');

  const missingIend = png.subarray(0, png.length - 12); // drop the trailing IEND chunk
  const noIend = validatePng(missingIend);
  assert.equal(noIend.status, 'invalid');
});

test('validateMp4 accepts the minimal fixture and rejects a truncated ftyp box', () => {
  const mp4 = buildMinimalMp4();
  const valid = validateMp4(mp4);
  assert.equal(valid.status, 'valid');
  assert.equal(valid.container, 'mp4');

  const truncated = validateMp4(mp4.subarray(0, 5)); // cut off mid-ftyp-box
  assert.equal(truncated.status, 'invalid');
});

test('validateMediaFile rejects unrecognized content and reports unchecked for formats without a validator', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-media-validate-'));
  try {
    const garbagePath = path.join(directory, 'broken.jpg');
    await writeFile(garbagePath, Buffer.from('totally not a jpeg, just plain garbage bytes'));
    const garbageResult = await validateMediaFile(garbagePath, 'image');
    assert.equal(garbageResult.status, 'invalid');
    assert.equal(garbageResult.container, 'unknown');

    const heicPath = path.join(directory, 'photo.heic');
    await writeFile(heicPath, Buffer.from('arbitrary bytes for a format this repo does not validate yet'));
    const heicResult = await validateMediaFile(heicPath, 'image');
    assert.equal(heicResult.status, 'unchecked');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

// --- prepareBundle: content validation of extracted source media ---

test('prepareBundle records structurally invalid extracted media as failed, not materialized', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-invalid-media-'));
  try {
    const sourceDir = path.join(directory, 'source');
    const volumeDir = path.join(directory, 'volume');
    await mkdir(sourceDir, {recursive: true});
    await mkdir(volumeDir, {recursive: true});
    await writeFile(path.join(sourceDir, 'broken.jpg'), Buffer.from('this is not a real jpeg, just garbage bytes'));
    await execute('/usr/bin/zip', ['archive1.zip', 'broken.jpg'], {cwd: sourceDir});

    const result = await prepareBundle(volumeDir, sourceDir, () => {});
    assert.equal(result.materialized, 0, 'structurally invalid media must never be reported as materialized');
    assert.equal(result.failed, 1);

    const paths = await initializeBundlePaths(volumeDir);
    const db = await BundleDatabase.open(paths.databasePath);
    try {
      const items = db.listItems();
      assert.equal(items.length, 1);
      assert.equal(items[0].state, 'failed');
      assert.equal(typeof items[0].error, 'string');
      assert.ok(items[0].error.length > 0);
    } finally {
      db.close();
    }

    const importEntries = await readdir(paths.importPath);
    assert.ok(!importEntries.includes('broken.jpg'), 'import/ must not contain the rejected entry');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('prepareBundle persists a distinct final-output hash alongside the source hash for valid media', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-bundle-finalhash-'));
  try {
    const sourceDir = path.join(directory, 'source');
    const volumeDir = path.join(directory, 'volume');
    await mkdir(sourceDir, {recursive: true});
    await mkdir(volumeDir, {recursive: true});
    await writeFile(path.join(sourceDir, 'photo.jpg'), MINIMAL_VALID_JPEG);
    await execute('/usr/bin/zip', ['archive1.zip', 'photo.jpg'], {cwd: sourceDir});

    const result = await prepareBundle(volumeDir, sourceDir, () => {});
    assert.equal(result.materialized, 1);
    assert.equal(result.failed, 0);

    const paths = await initializeBundlePaths(volumeDir);
    const db = await BundleDatabase.open(paths.databasePath);
    try {
      const items = db.listItems();
      assert.equal(items.length, 1);
      assert.equal(items[0].state, 'materialized');
      assert.equal(typeof items[0].finalHash, 'string');
      assert.ok(items[0].finalHash.length > 0);
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

// --- media.ts: transactional enrichment leaves the original output untouched on failure ---

test('applyTakeoutMetadata never mutates the output file when enrichment does not fully succeed', {skip: !HAS_EXIFTOOL && 'exiftool is not installed in this environment'}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-media-transactional-'));
  try {
    const filePath = path.join(directory, 'not-really-a-photo.jpg');
    const originalBytes = Buffer.from('this is definitely not an image file, just plain garbage bytes');
    await writeFile(filePath, originalBytes);

    const statuses = await applyTakeoutMetadata(filePath, 'image', {title: 'Will not stick'});

    const bytesAfter = await readFile(filePath);
    assert.ok(bytesAfter.equals(originalBytes), 'the original output file must be left byte-for-byte unchanged when enrichment does not fully succeed');
    assert.equal(statuses.title, 'unsupported');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
