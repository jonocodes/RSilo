import { LocalDatabase } from '../services/db/local';
import { LocalStorage } from '../services/local-storage';

const STORAGE_DIR = process.env.STORAGE_DIR || 'data/storage';
const DB_PATH = process.env.DB_PATH || 'data/remotestorage.db';

console.log('Setting up local RSilo database...');
console.log(`Database: ${DB_PATH}`);
console.log(`Storage:  ${STORAGE_DIR}`);

const db = new LocalDatabase(DB_PATH);
new LocalStorage(STORAGE_DIR);

console.log('\nReady. Start the server with:');
console.log('  bun run dev:offline');
console.log('\n  Then open http://localhost:8787/account');
console.log('  (dev mode signs you in as the dev identity on localhost; the Account row is created on first use)');

db.close();
