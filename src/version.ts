import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const packageInfo = require('../package.json') as {name: string; version: string};

export const PACKAGE_NAME = packageInfo.name;
export const VERSION = packageInfo.version;
