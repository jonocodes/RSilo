import { LocalDatabase } from '../services/db/local';
import { LocalStorage } from '../services/local-storage';

const STORAGE_DIR = process.env.STORAGE_DIR || 'data/storage';
const DB_PATH = process.env.DB_PATH || 'data/remotestorage.db';

console.log('Setting up local RemoteStorage database...');
console.log(`Database: ${DB_PATH}`);
console.log(`Storage: ${STORAGE_DIR}`);

const db = new LocalDatabase(DB_PATH);
const storage = new LocalStorage(STORAGE_DIR);

console.log('Database initialized successfully!');
console.log('Schema created with tables: users, oauth_clients, oauth_tokens');
console.log('\nYou can now start the server with:');
console.log('  bun run dev:offline');

db.close();