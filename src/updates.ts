import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {run} from './system.js';

const REPOSITORY = 'daordonez/gfotos-exporter';
const API_VERSION = '2022-11-28';
const RELEASES_URL = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=10`;
const ASSETS_URL = `https://api.github.com/repos/${REPOSITORY}/releases/assets`;
const REQUEST_TIMEOUT_MS = 5_000;

interface ReleaseAsset {
  id: number;
  name: string;
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export interface AvailableUpdate {
  version: string;
  assetId: number;
  packageName: string;
}

interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(value: string): SemanticVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return undefined;
  return {major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3])};
}

function isNewer(candidate: SemanticVersion, current: SemanticVersion): boolean {
  if (candidate.major !== current.major) return candidate.major > current.major;
  if (candidate.minor !== current.minor) return candidate.minor > current.minor;
  return candidate.patch > current.patch;
}

export function findAvailableUpdate(releases: GitHubRelease[], currentVersion: string): AvailableUpdate | undefined {
  const current = parseVersion(currentVersion);
  if (!current) return undefined;

  let newest: AvailableUpdate | undefined;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const version = parseVersion(release.tag_name);
    if (!version || !isNewer(version, current)) continue;
    const versionText = `${version.major}.${version.minor}.${version.patch}`;
    const packageName = `gfotos-migrator-${versionText}.tgz`;
    const asset = release.assets.find(candidate => candidate.name === packageName);
    if (!asset) continue;
    if (!newest || isNewer(version, parseVersion(newest.version)!)) {
      newest = {version: versionText, assetId: asset.id, packageName};
    }
  }

  return newest;
}

function requestHeaders(accept: string): Record<string, string> {
  return {
    Accept: accept,
    'X-GitHub-Api-Version': API_VERSION
  };
}

async function fetchReleases(): Promise<GitHubRelease[]> {
  const response = await fetch(RELEASES_URL, {
    headers: requestHeaders('application/vnd.github+json'),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`GitHub release check failed with HTTP ${response.status}.`);
  return await response.json() as GitHubRelease[];
}

export async function checkForUpdate(currentVersion: string): Promise<AvailableUpdate | undefined> {
  return findAvailableUpdate(await fetchReleases(), currentVersion);
}

export function resolveExecutablePrefix(executablePath: string): string {
  const normalized = path.resolve(executablePath);
  const binDirectory = path.dirname(normalized);
  if (path.basename(binDirectory) !== 'bin') {
    throw new Error(`Cannot determine npm prefix: expected executable in a 'bin' directory but found: ${binDirectory}`);
  }
  return path.dirname(binDirectory);
}

async function findActiveExecutable(): Promise<string> {
  try {
    const {stdout} = await run('which', ['gfotos-migrator']);
    const exe = stdout.trim();
    if (!exe) throw new Error('empty');
    return exe;
  } catch {
    throw new Error('Cannot locate the active gfotos-migrator executable on PATH.');
  }
}

export async function verifyInstalledVersion(prefix: string, expectedVersion: string, executablePath: string): Promise<void> {
  const manifestPath = path.join(prefix, 'lib', 'node_modules', 'gfotos-migrator', 'package.json');
  let manifestVersion: string;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {version: string};
    manifestVersion = manifest.version;
  } catch {
    throw new Error(`Cannot read installed package manifest at ${manifestPath}.`);
  }
  if (manifestVersion !== expectedVersion) {
    throw new Error(`Version mismatch after update: expected ${expectedVersion} but package manifest at ${manifestPath} reports '${manifestVersion}'.`);
  }
  let activeVersion: string;
  try {
    const {stdout} = await run(executablePath, ['--version']);
    activeVersion = stdout.trim();
  } catch {
    throw new Error(`Cannot run the updated executable at ${executablePath}.`);
  }
  if (activeVersion !== expectedVersion) {
    throw new Error(`Version mismatch after update: expected ${expectedVersion} but '${executablePath} --version' reports '${activeVersion}'. A stale executable may be shadowing the new installation. Repair with: npm uninstall --prefix ${prefix} -g gfotos-migrator`);
  }
}

export async function installUpdate(update: AvailableUpdate): Promise<void> {
  const activeExe = await findActiveExecutable();
  const prefix = resolveExecutablePrefix(activeExe);

  const response = await fetch(`${ASSETS_URL}/${update.assetId}`, {
    headers: requestHeaders('application/octet-stream'),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`GitHub package download failed with HTTP ${response.status}.`);

  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-migrator-update-'));
  const packagePath = path.join(directory, update.packageName);
  try {
    await writeFile(packagePath, Buffer.from(await response.arrayBuffer()), {mode: 0o600});
    try {
      await run('npm', ['uninstall', '--global', 'gfotos-migrator', '--prefix', prefix]);
    } catch {
      // Not installed in this prefix; proceed to install.
    }
    await run('npm', ['install', '--global', '--prefix', prefix, packagePath]);
    await verifyInstalledVersion(prefix, update.version, activeExe);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}
