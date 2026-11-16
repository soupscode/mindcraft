// Everything the dashboard reads from the environment. No address, topic or secret is
// written into the code: the defaults are the service names of genesis/compose.dashboard.yaml.

export interface Config {
    host: string;
    port: number;
    redis_url: string;
    database_url: string;
    stream: string;
    group: string;
    consumer: string;
    mindserver_url: string;
    roster: { name: string; role: string }[];
    public_dir: string;
    migrations_dir: string;
}

export const DEFAULT_AGENTS = 'Arthur:Builder,Mira:Farmer,Felix:Explorer,Nova:Merchant';

export function parseRoster(text: string): { name: string; role: string }[] {
    return text.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
        const [name, role = ''] = part.split(':').map((piece) => piece.trim());
        return { name, role };
    }).filter((agent) => /^[A-Za-z0-9_]{1,32}$/.test(agent.name));
}

export function readConfig(env: Record<string, string | undefined>, base_dir: string): Config {
    const port = Number(env.DASHBOARD_PORT ?? 8080);
    return {
        host: env.DASHBOARD_HOST ?? '0.0.0.0',
        port: Number.isInteger(port) && port > 0 ? port : 8080,
        redis_url: env.GENESIS_REDIS_URL ?? 'redis://redis:6379',
        database_url: env.GENESIS_DATABASE_URL ?? '',
        stream: env.GENESIS_EVENT_STREAM ?? 'genesis:events',
        group: env.DASHBOARD_CONSUMER_GROUP ?? 'dashboard',
        consumer: env.DASHBOARD_CONSUMER_NAME ?? 'dashboard-1',
        mindserver_url: env.GENESIS_MINDSERVER_URL ?? 'http://agents:8081',
        roster: parseRoster(env.GENESIS_AGENTS ?? DEFAULT_AGENTS),
        public_dir: env.DASHBOARD_PUBLIC_DIR ?? `${base_dir}/public`,
        migrations_dir: env.DASHBOARD_MIGRATIONS_DIR ?? `${base_dir}/../migrations`,
    };
}
