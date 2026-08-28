import path from 'node:path';
import {run} from './system.js';

export interface VolumeInfo {
  mountPoint: string;
  filesystem: string;
  availableBytes: number;
  capacityBytes: number;
  isExternal: boolean;
  deviceIdentifier?: string;
}

function xmlValue(xml: string, key: string): string | undefined {
  const match = xml.match(new RegExp(`<key>${key}</key>\\s*<(?:string|integer)>([^<]+)</(?:string|integer)>`, 'i'));
  return match?.[1];
}

function xmlBoolean(xml: string, key: string): boolean | undefined {
  const match = xml.match(new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`, 'i'));
  return match ? match[1].toLowerCase() === 'true' : undefined;
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
  const internal = xmlBoolean(diskInfo, 'Internal');
  return {
    mountPoint,
    filesystem: (xmlValue(diskInfo, 'FilesystemType') ?? '').toLowerCase(),
    availableBytes,
    capacityBytes,
    isExternal: internal === false,
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
  if (xmlBoolean(stdout, 'Internal') !== false || xmlBoolean(stdout, 'WholeDisk') !== true) {
    throw new Error('Only a whole external physical disk can be erased.');
  }
  await run('/usr/sbin/diskutil', ['eraseDisk', 'APFS', volumeName, deviceIdentifier]);
}
