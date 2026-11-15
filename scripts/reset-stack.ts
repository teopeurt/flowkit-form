import { loadConfig } from '@flowkitform/demo-domain';
const database = new URL(loadConfig().DATABASE_URL).pathname.slice(1);
if (!/^flowkitform(?:_test_)?/.test(database)) throw new Error(`Refusing reset for database ${database}`);
process.stdout.write('Guard passed. Run docker compose -p flowkitform down -v manually after review.\n');
