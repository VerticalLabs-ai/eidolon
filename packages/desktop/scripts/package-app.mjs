import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { packager } from '@electron/packager';

const require = createRequire(import.meta.url);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, '..');
const forgeConfig = require('../forge.config.cjs');
const electronVersion = require('electron/package.json').version;

const platformArgument = process.argv.find((argument) => argument.startsWith('--platform='));
const archArgument = process.argv.find((argument) => argument.startsWith('--arch='));
const platform = platformArgument?.split('=')[1] || process.platform;
const arch = archArgument?.split('=')[1] || process.arch;

const appPaths = await packager({
  ...forgeConfig.packagerConfig,
  dir: desktopDirectory,
  out: path.join(desktopDirectory, 'out'),
  overwrite: true,
  platform,
  arch,
  electronVersion,
});

for (const appPath of appPaths) {
  console.log(`Packaged Eidolon desktop app: ${appPath}`);
}
