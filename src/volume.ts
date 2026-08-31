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

export interface ExternalDisk {
  deviceIdentifier: string;
  name: string;
  capacityBytes: number;
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

function xmlArrayValues(xml: string, key: string): string[] {
  const array = xml.match(new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`, 'i'))?.[1] ?? '';
  return [...array.matchAll(/<string>([^<]+)<\/string>/gi)].map(match => match[1]);
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

export async function externalWholeDiskForVolume(target: string): Promise<ExternalDisk> {
  const {stdout} = await run('/usr/sbin/diskutil', ['info', '-plist', target]);
  const deviceIdentifier = parentWholeDiskIdentifier(xmlValue(stdout, 'DeviceIdentifier'), xmlValue(stdout, 'ParentWholeDisk'));
  const {stdout: diskInfo} = await run('/usr/sbin/diskutil', ['info', '-plist', `/dev/${deviceIdentifier}`]);
  if (xmlBoolean(diskInfo, 'RemovableMediaOrExternalDevice') !== true || xmlBoolean(diskInfo, 'WholeDisk') !== true || xmlValue(diskInfo, 'VirtualOrPhysical') !== 'Physical') {
    throw new Error('Only a whole external physical disk can be formatted.');
  }
  return {
    deviceIdentifier,
    name: xmlValue(diskInfo, 'MediaName') ?? xmlValue(diskInfo, 'IORegistryEntryName') ?? 'External disk',
    capacityBytes: Number(xmlValue(diskInfo, 'TotalSize') ?? 0)
  };
}

export async function listExternalWholeDisks(): Promise<ExternalDisk[]> {
  const {stdout} = await run('/usr/sbin/diskutil', ['list', '-plist']);
  const identifiers = xmlArrayValues(stdout, 'AllDisks').filter(identifier => /^disk\d+$/.test(identifier));
  const results = await Promise.allSettled(identifiers.map(async deviceIdentifier => {
    const {stdout: info} = await run('/usr/sbin/diskutil', ['info', '-plist', `/dev/${deviceIdentifier}`]);
    if (xmlBoolean(info, 'RemovableMediaOrExternalDevice') !== true || xmlBoolean(info, 'WholeDisk') !== true || xmlValue(info, 'VirtualOrPhysical') !== 'Physical') return undefined;
    return {
      deviceIdentifier,
      name: xmlValue(info, 'MediaName') ?? xmlValue(info, 'IORegistryEntryName') ?? 'External disk',
      capacityBytes: Number(xmlValue(info, 'TotalSize') ?? 0)
    };
  }));
  return results
    .filter((result): result is PromiseFulfilledResult<ExternalDisk | undefined> => result.status === 'fulfilled')
    .map(result => result.value)
    .filter((disk): disk is ExternalDisk => disk !== undefined)
    .sort((left, right) => left.deviceIdentifier.localeCompare(right.deviceIdentifier, undefined, {numeric: true}));
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

export async function validateExternalApfs(target: string, minimumBytes = 0): Promise<VolumeInfo> {
  const volume = await inspectVolume(path.resolve(target));
  if (!volume.isExternal) throw new Error('The selected path is not on an external storage device.');
  if (volume.filesystem !== 'apfs') throw new Error('The selected external storage must use APFS.');
  if (volume.availableBytes < minimumBytes) throw new Error('The selected external storage does not have enough free space.');
  return volume;
}

export async function eraseExternalDisk(deviceIdentifier: string, volumeName: string): Promise<void> {
  if (!/^disk\d+$/.test(deviceIdentifier)) throw new Error('A whole disk identifier such as disk4 is required.');
  const {stdout} = await run('/usr/sbin/diskutil', ['info', '-plist', `/dev/${deviceIdentifier}`]);
  if (xmlBoolean(stdout, 'RemovableMediaOrExternalDevice') !== true || xmlBoolean(stdout, 'WholeDisk') !== true || xmlValue(stdout, 'VirtualOrPhysical') !== 'Physical') {
    throw new Error('Only a whole external physical disk can be erased.');
  }
  await run('/usr/sbin/diskutil', ['eraseDisk', 'APFS', volumeName, deviceIdentifier]);
}
