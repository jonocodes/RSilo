import { LocalDatabase } from '../services/db/local';
import { LocalStorage } from '../services/local-storage';

const STORAGE_DIR = process.env.STORAGE_DIR || 'data/storage';
const DB_PATH = process.env.DB_PATH || 'data/remotestorage.db';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin';

console.log('Setting up local RSilo database...');
console.log(`Database: ${DB_PATH}`);
console.log(`Storage:  ${STORAGE_DIR}`);

const db = new LocalDatabase(DB_PATH);
new LocalStorage(STORAGE_DIR);

console.log('\nReady. Start the server with:');
console.log('  bun run dev:offline');
console.log('\n  Admin panel:  http://localhost:8787/admin/');
console.log(`  Admin secret: ${ADMIN_SECRET}`);
console.log('\n  Create users via the admin panel or:');
console.log('  curl -X POST http://localhost:8787/admin/users \\');
console.log(`    -H "Authorization: Bearer ${ADMIN_SECRET}" \\`);
console.log('    -H "Content-Type: application/json" \\');
console.log('    -d \'{"username":"alice","password":"yourpass"}\'');
console.log('\n  Then sign in at: http://localhost:8787/account');

db.close();
