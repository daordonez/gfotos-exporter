import path from 'node:path';
import {exists} from './system.js';
import React, {useEffect, useState} from 'react';
import {Box, render, Text} from 'ink';
import {Alert, ConfirmInput, ProgressBar, Select, Spinner, StatusMessage, TextInput} from '@inkjs/ui';
import {exifToolAvailable} from './media.js';
import {importCandidates, initializePaths, requiredBytes, type ImportProgress} from './migration.js';
import {openPhotosLibrary} from './photos.js';
import {inventoryTakeout} from './takeout.js';
import {validateExternalApfs} from './volume.js';
import type {MediaCandidate, TakeoutInventory} from './domain.js';

type Screen = 'menu' | 'source' | 'volume' | 'library' | 'confirm' | 'running' | 'complete';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = -1;
  do { value /= 1024; index++; } while (value >= 1024 && index < units.length - 1);
  return `${value.toFixed(1)} ${units[index]}`;
}

function App(): React.JSX.Element {
  const [screen, setScreen] = useState<Screen>('menu');
  const [sourcePath, setSourcePath] = useState('');
  const [volumePath, setVolumePath] = useState('');
  const [inventory, setInventory] = useState<TakeoutInventory>();
  const [candidates, setCandidates] = useState<MediaCandidate[]>([]);
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<ImportProgress>();
  const [libraryReady, setLibraryReady] = useState(false);

  const selectMenu = (value: string): void => {
    if (value === 'start') setScreen('source');
    else if (value === 'exit') process.exit(0);
    else setError('Use the corresponding non-interactive command for this operation.');
  };

  const inspectSource = async (value: string): Promise<void> => {
    try {
      setError(undefined);
      const result = await inventoryTakeout(value.trim());
      if (result.inventory.archives === 0) throw new Error('No ZIP archives were found in the selected path.');
      if (result.media.length === 0) throw new Error('No supported photos or videos were found in the ZIP archives.');
      setSourcePath(path.resolve(value.trim()));
      setInventory(result.inventory);
      setCandidates(result.media);
      setScreen('volume');
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };

  const inspectVolume = async (value: string): Promise<void> => {
    try {
      if (!inventory) return;
      setError(undefined);
      await validateExternalApfs(value.trim(), requiredBytes(inventory));
      if (!await exifToolAvailable()) throw new Error('ExifTool is required. Install it with: brew install exiftool');
      setVolumePath(path.resolve(value.trim()));
      setScreen('library');
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };

  const startMigration = async (): Promise<void> => {
    try {
      setScreen('running');
      const paths = await initializePaths(volumePath);
      await openPhotosLibrary(paths.libraryPath);
      await importCandidates(paths, candidates, setProgress);
      setScreen('complete');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setScreen('confirm');
    }
  };

  useEffect(() => {
    if (screen !== 'library') return;
    const interval = setInterval(async () => setLibraryReady(await exists(path.join(volumePath, 'GoogleTakeoutMigration.photoslibrary'))), 1000);
    return () => clearInterval(interval);
  }, [screen, volumePath]);

  return <Box flexDirection="column" padding={1} gap={1}>
    <Text color="cyan" bold>gfotos-migrator</Text>
    {error && <Alert variant="error">{error}</Alert>}
    {screen === 'menu' && <>
      <Text>Safe Google Takeout migration to an isolated Photos library.</Text>
      <Select options={[
        {label: 'Start guided migration', value: 'start'},
        {label: 'Resume interrupted migration', value: 'resume'},
        {label: 'Check migration status', value: 'status'},
        {label: 'Prepare external storage', value: 'prepare'},
        {label: 'Validate handoff to main library', value: 'handoff'},
        {label: 'View reports', value: 'reports'},
        {label: 'Exit', value: 'exit'}
      ]} onChange={selectMenu}/>
    </>}
    {screen === 'source' && <>
      <Text>Enter the folder containing Google Takeout ZIP archives:</Text>
      <TextInput placeholder="/Volumes/External/Takeout" onSubmit={inspectSource}/>
    </>}
    {screen === 'volume' && inventory && <>
      <Text>{`${inventory.images} photos, ${inventory.videos} videos, ${inventory.archives} ZIP archives.`}</Text>
      <Text>{`Required external free space: ${formatBytes(requiredBytes(inventory))}.`}</Text>
      <Text>Enter the APFS external volume mount path:</Text>
      <TextInput placeholder="/Volumes/GoogleMigration" onSubmit={inspectVolume}/>
    </>}
    {screen === 'library' && <>
      <Text bold>Create the isolated library in Photos now.</Text>
      <Text>{`Quit Photos, hold Option while opening it, select Create New, and use:`}</Text>
      <Text color="yellow">{path.join(volumePath, 'GoogleTakeoutMigration.photoslibrary')}</Text>
      <Text>Do not make it the System Photo Library and do not enable iCloud Photos.</Text>
      {libraryReady ? <ConfirmInput onConfirm={() => setScreen('confirm')} onCancel={() => setScreen('menu')}/> : <Spinner label="Waiting for the new library to appear..."/>}
    </>}
    {screen === 'confirm' && inventory && <>
      <StatusMessage variant="info">The main Photos library and iCloud will not be modified.</StatusMessage>
      <Text>{`Import ${inventory.images} photos and ${inventory.videos} videos into the isolated library?`}</Text>
      <ConfirmInput defaultChoice="cancel" onConfirm={() => void startMigration()} onCancel={() => setScreen('menu')}/>
    </>}
    {screen === 'running' && <>
      <Spinner label="Importing into the open isolated Photos library..."/>
      <ProgressBar value={progress ? (progress.completed / Math.max(progress.total, 1)) * 100 : 0}/>
      <Text>{progress ? `${progress.completed}/${progress.total} processed · ${progress.imported} imported · ${progress.skipped} skipped · ${progress.failed} failed` : 'Preparing...'}</Text>
      {progress?.current && <Text dimColor>{progress.current.entryPath}</Text>}
    </>}
    {screen === 'complete' && <>
      <StatusMessage variant="success">Migration completed. Review the isolated library before using handoff-check.</StatusMessage>
      <Text>{`Source: ${sourcePath}`}</Text>
      <Text>{`Library: ${path.join(volumePath, 'GoogleTakeoutMigration.photoslibrary')}`}</Text>
    </>}
  </Box>;
}

export async function runTui(): Promise<void> {
  const instance = render(<App/>);
  await instance.waitUntilExit();
}
