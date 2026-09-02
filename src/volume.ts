import path from 'node:path';
import {readdir} from 'node:fs/promises';
import {run} from './system.js';

export interface VolumeInfo {
  mountPoint: string;
  filesystem: string;
  availableBytes: number;
  capacityBytes: number;
  isExternal: boolean;
  isReadOnly: boolean;
  deviceIdentifier?: string;
}

export interface ExternalVolume extends VolumeInfo {
  name: string;
}

function xmlValue(xml: string, key: string): string | undefined {
  const match = xml.match(new RegExp(`<key>${key}</key>\\s*<(?:string|integer)>([^<]+)</(?:string|integer)>`, 'i'));
  return match?.[1];
}

function xmlBoolean(xml: string, key: string): boolean | undefined {
  const match = xml.match(new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`, 'i'));
  return match ? match[1].toLowerCase() === 'true' : undefined;
}

function normalizedMountPoint(value: string): string {
  return path.resolve(value);
}

export function isSelectableExternalVolume(volume: VolumeInfo, timeMachineMountPoints: string[] = []): boolean {
  return volume.isExternal
    && !volume.isReadOnly
    && volume.mountPoint.startsWith('/Volumes/')
    && !timeMachineMountPoints.map(normalizedMountPoint).includes(normalizedMountPoint(volume.mountPoint));
}

async function listTimeMachineMountPoints(): Promise<string[]> {
  try {
    const {stdout} = await run('/usr/bin/tmutil', ['destinationinfo']);
    return [...stdout.matchAll(/^\s*Mount Point\s*:\s*(.+)$/gim)].map(match => match[1].trim());
  } catch {
    return [];
  }
}

export async function listSelectableExternalVolumes(): Promise<ExternalVolume[]> {
  const [entries, timeMachineMountPoints] = await Promise.all([
    readdir('/Volumes', {withFileTypes: true}),
    listTimeMachineMountPoints()
  ]);
  const results = await Promise.allSettled(entries
    .filter(entry => entry.isDirectory())
    .map(async entry => {
      const mountPoint = path.join('/Volumes', entry.name);
      const volume = await inspectVolume(mountPoint);
      if (!isSelectableExternalVolume(volume, timeMachineMountPoints)) return undefined;
      return {...volume, name: entry.name};
    }));
  return results
    .filter((result): result is PromiseFulfilledResult<ExternalVolume | undefined> => result.status === 'fulfilled')
    .map(result => result.value)
    .filter((volume): volume is ExternalVolume => volume !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function parentWholeDiskIdentifier(deviceIdentifier: string | undefined, parentWholeDisk: string | undefined): string {
  const candidate = parentWholeDisk ?? deviceIdentifier?.match(/^(disk\d+)s\d+$/)?.[1];
  if (!candidate || !/^disk\d+$/.test(candidate)) throw new Error('Unable to determine the external physical disk for the selected volume.');
  return candidate;
}

export function volumeMountPath(volumeName: string): string {
  const normalized = volumeName.trim();
  if (!normalized || normalized.includes('/') || normalized === '.' || normalized === '..') {
    throw new Error('The APFS volume name must be a non-empty name without slashes.');
  }
  return path.join('/Volumes', normalized);
}

export async function inspectVolume(target: string): Promise<VolumeInfo> {
  const [{stdout: diskInfo}, {stdout: dfOutput}] = await Promise.all([
    run('/usr/sbin/diskutil', ['info', '-plist', target]),
    run('/bin/df', ['-kP', target])
  ]);
  const rows = dfOutput.trim().split('\n');
  const fields = rows.at(-1)?.trim().split(/\s+/) ?? [];
  if (fields.length < 6) throw new Error(`Unable to determine free space for ${target}.`);
  const availableBytes = Number(fields[3]) * 1024;
  const capacityBytes = Number(fields[1]) * 1024;
  const mountPoint = fields.slice(5).join(' ');
  return {
    mountPoint,
    filesystem: (xmlValue(diskInfo, 'FilesystemType') ?? '').toLowerCase(),
    availableBytes,
    capacityBytes,
    isExternal: xmlBoolean(diskInfo, 'RemovableMediaOrExternalDevice') === true,
    isReadOnly: xmlBoolean(diskInfo, 'ReadOnlyVolume') === true,
    deviceIdentifier: xmlValue(diskInfo, 'DeviceIdentifier')
  };
}
