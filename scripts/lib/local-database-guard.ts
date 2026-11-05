import postgres from 'postgres';

export const DISPOSABLE_DATABASE_NAME = 'flowkit_demo';
export const DISPOSABLE_DATABASE_MARKER = 'flowkit_starter_identity';

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'postgres']);
const TLS_MODES = new Set(['require', 'verify-ca', 'verify-full', 'prefer', 'allow']);

export interface DatabaseIdentity {
  database: string;
  marker: string | null;
  tls: boolean;
}

export interface DisposableLocalDatabaseConfig {
  databaseUrl: string;
  probe?: (databaseUrl: string) => Promise<DatabaseIdentity>;
}

async function probeDatabase(databaseUrl: string): Promise<DatabaseIdentity> {
  const sql = postgres(databaseUrl, {
    connect_timeout: 5,
    max: 1,
    ssl: false,
  });

  try {
    const [identity] = await sql<DatabaseIdentity[]>`
      SELECT
        current_database() AS database,
        current_setting('cluster_name', true) AS marker,
        COALESCE(
          (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()),
          false
        ) AS tls
    `;
    if (!identity) throw new Error('Database identity query returned no rows');
    return identity;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

function parseTarget(databaseUrl: string): URL {
  let target: URL;
  try {
    target = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL.');
  }

  if (!['postgres:', 'postgresql:'].includes(target.protocol)) {
    throw new Error('DATABASE_URL must use the PostgreSQL protocol.');
  }
  if (!ALLOWED_HOSTS.has(target.hostname.toLowerCase())) {
    throw new Error('DATABASE_URL must use a local or Compose PostgreSQL host.');
  }

  let database: string;
  try {
    database = decodeURIComponent(target.pathname.slice(1));
  } catch {
    throw new Error('DATABASE_URL must name the exact flowkit_demo database.');
  }
  if (database !== DISPOSABLE_DATABASE_NAME) {
    throw new Error('DATABASE_URL must name the exact flowkit_demo database.');
  }

  const sslMode = target.searchParams.get('sslmode')?.toLowerCase();
  const ssl = target.searchParams.get('ssl')?.toLowerCase();
  if ((sslMode && TLS_MODES.has(sslMode)) || (ssl && !['false', '0', 'disable'].includes(ssl))) {
    throw new Error('The disposable local database must not require TLS.');
  }

  return target;
}

export async function assertDisposableLocalDatabase(config: DisposableLocalDatabaseConfig): Promise<void> {
  parseTarget(config.databaseUrl);

  let identity: DatabaseIdentity;
  try {
    identity = await (config.probe ?? probeDatabase)(config.databaseUrl);
  } catch {
    throw new Error('Unable to verify the disposable local database identity. Connection details were redacted.');
  }

  if (identity.database !== DISPOSABLE_DATABASE_NAME) {
    throw new Error(`Refusing database operation: server confirmed database ${identity.database || '[unknown]'}.`);
  }
  if (identity.tls) {
    throw new Error('Refusing database operation: the server reported a TLS session.');
  }
  if (identity.marker !== DISPOSABLE_DATABASE_MARKER) {
    throw new Error('Refusing database operation: the disposable database marker is missing or invalid.');
  }
}
