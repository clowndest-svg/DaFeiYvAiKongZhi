import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureStorage } from '../src/storage.js';
const root = fileURLToPath(new URL('../', import.meta.url));
configureStorage(process.env.BIZHI_DATA_DIR || path.join(root, 'data'));
