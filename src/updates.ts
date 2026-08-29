import {mkdtemp, rm, writeFile} from 'node:fs/promises';
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

export async function installUpdate(update: AvailableUpdate): Promise<void> {
  const response = await fetch(`${ASSETS_URL}/${update.assetId}`, {
    headers: requestHeaders('application/octet-stream'),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`GitHub package download failed with HTTP ${response.status}.`);

  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-migrator-update-'));
  const packagePath = path.join(directory, update.packageName);
  try {
    await writeFile(packagePath, Buffer.from(await response.arrayBuffer()), {mode: 0o600});
    await run('npm', ['install', '--global', packagePath]);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}
