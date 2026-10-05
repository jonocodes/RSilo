const bytes = Number(process.argv[2] ?? 32);
if (!Number.isInteger(bytes) || bytes < 8 || bytes > 128) {
  console.error('Usage: bun run secret [bytes]   (8-128, default 32)');
  process.exit(1);
}
console.log(crypto.getRandomValues(new Uint8Array(bytes)).reduce((hex, b) => hex + b.toString(16).padStart(2, '0'), ''));
