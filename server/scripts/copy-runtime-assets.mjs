import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const destinationDirectory = path.join(serverRoot, 'dist', 'services');

await fs.mkdir(destinationDirectory, { recursive: true });
await fs.copyFile(
  path.join(serverRoot, 'src', 'services', 'local-cli-supervisor.mjs'),
  path.join(destinationDirectory, 'local-cli-supervisor.mjs'),
);
