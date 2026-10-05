import { createTestToken } from '../services/auth';

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  console.log('Usage: bun run dev-token [username] [scopes]');
  console.log('Example: bun run dev-token alice "documents:rw pictures:rw"');
  process.exit(0);
}

const [username = 'alice', scopes = 'documents:rw pictures:rw'] = args;
console.log(createTestToken(username, scopes));
