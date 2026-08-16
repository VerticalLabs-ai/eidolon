const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

if (process.platform !== 'darwin') {
  process.exit(0);
}

const nodeGypScript = require.resolve('node-gyp/bin/node-gyp.js');
const nativeModules = [
  ['macos-alias', 'volume.node'],
  ['fs-xattr', 'xattr.node'],
];

for (const [packageName, bindingName] of nativeModules) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const packageDir = path.dirname(packageJsonPath);
  const bindingPath = path.join(packageDir, 'build', 'Release', bindingName);

  if (existsSync(bindingPath)) {
    continue;
  }

  const result = spawnSync(process.execPath, [nodeGypScript, 'rebuild'], {
    cwd: packageDir,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
