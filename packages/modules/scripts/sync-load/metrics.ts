// What a load phase measured: request latencies per route, live-update delay, rate limiting, and the
// CPU the server process and the database container spent, plus the database's own view (lock waits,
// the slowest statements when pg_stat_statements is installed).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { connectRawSql, type RawSqlConnection } from '@bolusi/db-server/testing';

export type Route = 'push' | 'pull' | 'bundle' | 'connect';

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

export class Recorder {
  readonly latencies = new Map<Route, number[]>();
  readonly statuses = new Map<string, number>();
  /** Milliseconds from a change being accepted to another device in its store holding it. */
  readonly propagation: number[] = [];
  /** opId → when its push was accepted, for changes still travelling to other devices. */
  readonly accepted = new Map<string, number>();
  pokes = 0;
  opsPushed = 0;
  opsPulled = 0;

  request(route: Route, ms: number, status: number): void {
    let list = this.latencies.get(route);
    if (list === undefined) this.latencies.set(route, (list = []));
    list.push(ms);
    if (status >= 300 && status !== 304) {
      const key = `${route} ${status}`;
      this.statuses.set(key, (this.statuses.get(key) ?? 0) + 1);
    }
  }

  summary(wallSeconds: number): string[] {
    const lines: string[] = [];
    for (const [route, values] of this.latencies) {
      const sorted = [...values].sort((a, b) => a - b);
      lines.push(
        `  ${route.padEnd(7)} ${String(values.length).padStart(7)} req (${(values.length / wallSeconds).toFixed(1)}/s)` +
          `  p50 ${percentile(sorted, 50).toFixed(0)} ms  p95 ${percentile(sorted, 95).toFixed(0)} ms` +
          `  p99 ${percentile(sorted, 99).toFixed(0)} ms  max ${(sorted.at(-1) ?? 0).toFixed(0)} ms`,
      );
    }
    if (this.propagation.length > 0) {
      const sorted = [...this.propagation].sort((a, b) => a - b);
      lines.push(
        `  change reaches other store devices: p50 ${(percentile(sorted, 50) / 1000).toFixed(1)} s` +
          `  p95 ${(percentile(sorted, 95) / 1000).toFixed(1)} s  max ${((sorted.at(-1) ?? 0) / 1000).toFixed(1)} s` +
          ` (${sorted.length} deliveries)`,
      );
    }
    lines.push(
      `  changes pushed ${this.opsPushed}, pulled ${this.opsPulled}, live-update pokes ${this.pokes}`,
    );
    const failures = [...this.statuses].map(([key, n]) => `${key} ×${n}`).join(', ');
    lines.push(`  refused or failed: ${failures === '' ? 'none' : failures}`);
    return lines;
  }
}

/** CPU seconds a process has used (user + system), from /proc. */
function processCpuSeconds(pid: number): number {
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
  return (Number(fields[11]) + Number(fields[12])) / 100; // utime, stime in clock ticks (USER_HZ 100)
}

function processRssMb(pid: number): number {
  const match = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
  return match === null ? 0 : Number(match[1]) / 1024;
}

/** CPU seconds a Docker container has used, from its cgroup (v2, else v1 cpuacct). */
function containerCpuSeconds(container: string): number | null {
  const read = (file: string) =>
    execFileSync('docker', ['exec', container, 'cat', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  try {
    const match = /usage_usec (\d+)/.exec(read('/sys/fs/cgroup/cpu.stat'));
    if (match !== null) return Number(match[1]) / 1e6;
  } catch {
    // Not cgroup v2; try v1 below.
  }
  try {
    return Number(read('/sys/fs/cgroup/cpuacct/cpuacct.usage').trim()) / 1e9;
  } catch {
    return null;
  }
}

export interface ResourceProbe {
  readonly serverPid: number;
  readonly pgContainer: string | null;
  readonly ownerUrl: string;
}

/** Samples the database every second during a phase and reports the phase's resource use. */
export class PhaseResources {
  #started = 0;
  #serverCpu = 0;
  #pgCpu: number | null = null;
  #ownCpu = process.cpuUsage();
  #timer: NodeJS.Timeout | null = null;
  #samples = 0;
  #lockWaitSum = 0;
  #lockWaitMax = 0;
  #activeMax = 0;
  #client: RawSqlConnection | null = null;
  #statements = false;

  constructor(private readonly probe: ResourceProbe) {}

  async start(): Promise<void> {
    this.#client = await connectRawSql(this.probe.ownerUrl);
    try {
      await this.#client.query('SELECT pg_stat_statements_reset()');
      this.#statements = true;
    } catch {
      this.#statements = false;
    }
    this.#started = performance.now();
    this.#serverCpu = processCpuSeconds(this.probe.serverPid);
    this.#pgCpu =
      this.probe.pgContainer === null ? null : containerCpuSeconds(this.probe.pgContainer);
    this.#ownCpu = process.cpuUsage();
    this.#timer = setInterval(() => void this.#sample(), 1000);
  }

  async #sample(): Promise<void> {
    const [row] = await this.#client!.query<{ active: string; lock_waits: string }>(
      `SELECT count(*) FILTER (WHERE state = 'active') AS active,
              count(*) FILTER (WHERE wait_event_type = 'Lock') AS lock_waits
         FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    const lockWaits = Number(row!.lock_waits);
    this.#samples += 1;
    this.#lockWaitSum += lockWaits;
    this.#lockWaitMax = Math.max(this.#lockWaitMax, lockWaits);
    this.#activeMax = Math.max(this.#activeMax, Number(row!.active));
  }

  async stop(): Promise<{ wallSeconds: number; lines: string[] }> {
    if (this.#timer !== null) clearInterval(this.#timer);
    const wallSeconds = (performance.now() - this.#started) / 1000;
    const pct = (cpuSeconds: number) => `${((cpuSeconds / wallSeconds) * 100).toFixed(0)}%`;
    const serverCpu = processCpuSeconds(this.probe.serverPid) - this.#serverCpu;
    const pgNow =
      this.probe.pgContainer === null ? null : containerCpuSeconds(this.probe.pgContainer);
    const own = process.cpuUsage(this.#ownCpu);
    const lines = [
      `  server CPU ${pct(serverCpu)} of one core, RSS ${processRssMb(this.probe.serverPid).toFixed(0)} MB;` +
        ` database CPU ${pgNow === null || this.#pgCpu === null ? 'n/a' : pct(pgNow - this.#pgCpu)};` +
        ` load generator CPU ${pct((own.user + own.system) / 1e6)}`,
      `  database: up to ${this.#activeMax} busy connections, waiting on locks avg ${(this.#lockWaitSum / Math.max(1, this.#samples)).toFixed(1)} max ${this.#lockWaitMax}`,
    ];
    if (this.#statements) {
      const rows = await this.#client!.query<{
        query: string;
        calls: string;
        total: number;
        mean: number;
      }>(
        `SELECT regexp_replace(query, '\\s+', ' ', 'g') AS query, calls,
                total_exec_time AS total, mean_exec_time AS mean
           FROM pg_stat_statements
          WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
          ORDER BY total_exec_time DESC LIMIT 6`,
      );
      lines.push('  most expensive statements (total database time):');
      for (const row of rows) {
        lines.push(
          `    ${(row.total / 1000).toFixed(1)} s, ${row.calls} calls, ${row.mean.toFixed(2)} ms avg: ${row.query.slice(0, 110)}`,
        );
      }
    }
    await this.#client!.close();
    return { wallSeconds, lines };
  }
}
