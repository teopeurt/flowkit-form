import { loadConfig } from '@flowkit-demo/domain';
const database = new URL(loadConfig().DATABASE_URL).pathname.slice(1);
if (!/^flowkit_demo(?:_test_)?/.test(database)) throw new Error(`Refusing reset for database ${database}`);
process.stdout.write('Guard passed. Run docker compose -p flowkit_demo down -v manually after review.\n');
