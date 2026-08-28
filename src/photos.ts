import {run} from './system.js';

const IMPORT_SCRIPT = `on run argv
  tell application "Photos"
    activate
    import (POSIX file (item 1 of argv))
  end tell
end run`;

export async function importIntoOpenPhotosLibrary(filePath: string): Promise<void> {
  await run('/usr/bin/osascript', ['-e', IMPORT_SCRIPT, filePath]);
}

export async function isPhotosRunning(): Promise<boolean> {
  const {stdout} = await run('/usr/bin/osascript', ['-e', 'application "Photos" is running']);
  return stdout.trim() === 'true';
}

export async function openPhotosLibrary(libraryPath: string): Promise<void> {
  await run('/usr/bin/open', ['-a', 'Photos', libraryPath]);
}
