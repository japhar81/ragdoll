/**
 * Redis-leased leader election for the worker's cron scheduler.
 *
 * Earlier, the helm chart split workers into a "leader" deployment
 * (replicas: 1, scheduler on) + "followers" (replicas: N, scheduler
 * off) so the in-process croner only ticked from one pod. Workable,
 * but if the leader pod dies the scheduler pauses until k8s
 * reschedules it — scheduled runs miss their tick during that window.
 *
 * This module replaces that split with cooperative leader election
 * over Redis: every worker tries to acquire a short-lived lease;
 * whoever holds it runs the scheduler. When the holder pauses (GC,
 * crash, network blip) the lease expires and another worker claims
 * it on its next attempt. Failover latency ≈ leaseTtl, typically
 * 10 s — strictly better than waiting for a k8s pod restart.
 *
 * Design choices, in order of importance:
 *
 *  1. `SET <key> <token> NX PX <ttlMs>` is the acquire primitive.
 *     `NX` is the atomic test-and-set; `PX` sets the millisecond TTL.
 *  2. Renewal is gated on token ownership via a Lua script (or a
 *     compare-and-swap pattern). Without the check, a slow renewal
 *     could overwrite a successor's lease.
 *  3. Release is also fenced — same Lua check — so a lost-then-
 *     reacquired-by-someone-else lease isn't accidentally deleted
 *     by the old holder's shutdown handler.
 *  4. Split-brain window: between "old holder pauses" and "old holder
 *     notices its lease expired", both pods may briefly believe they
 *     are leader. BullMQ deduplicates job ids, and the scheduler
 *     enqueues with deterministic ids (`schedule:<id>:<tickAt>`), so a
 *     duplicate enqueue drops cleanly. Document this caveat below
 *     instead of plumbing fencing tokens through the queue.
 *  5. Pure of `ioredis` at the top level — dynamic import + a small
 *     `RedisLikeClient` slice so unit tests stay offline.
 */

import { randomUUID } from "node:crypto";
import type { StructuredLogger } from "../../../packages/observability/src/index.ts";

/**
 * Cooperative-leadership primitive consumed by the scheduler. Every
 * worker holds a reference; only the one whose `isLeader()` returns
 * true should fire the cron tick. Implementations:
 *
 *   - `AlwaysLeader` for single-node / tests / no-Redis paths.
 *   - `RedisLeaderElection` for distributed multi-worker setups.
 */
export interface LeaderElection {
  /** True iff this instance currently holds the lease. Non-blocking. */
  isLeader(): boolean;
  /** Spin up the acquire/renew loop. Returns a stop function. */
  start(): () => Promise<void>;
}

/**
 * Always-leader. Used by the in-memory-queue test path and by any
 * deployment that doesn't set REDIS_URL — there's only one process,
 * so there's no contention to resolve.
 */
export class AlwaysLeader implements LeaderElection {
  isLeader(): boolean {
    return true;
  }
  start(): () => Promise<void> {
    return async () => undefined;
  }
}

// ---------------------------------------------------------------------------
// Redis-backed lease
// ---------------------------------------------------------------------------

/** Minimal slice of ioredis we use. Mirrors the auth/sso-state pattern. */
export interface RedisLikeClient {
  set(
    key: string,
    value: string,
    mode: "NX" | "XX",
    expiryMode: "PX",
    ms: number
  ): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  quit(): Promise<unknown>;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export interface RedisLeaderElectionOptions {
  redisUrl?: string;
  /** Optional pre-built client. When omitted, one is created lazily
   *  from redisUrl. */
  client?: RedisLikeClient;
  /** Per-pod identity stamped onto the lease. Defaults to `WORKER_ID`
   *  env if set, otherwise a random UUID. */
  podId?: string;
  /** Redis key holding the lease. Defaults `ragdoll:scheduler:leader`. */
  key?: string;
  /** Lease TTL in ms. Must be at least 2x renewIntervalMs.
   *  Default 10_000ms. */
  leaseTtlMs?: number;
  /** Renewal cadence in ms. Default leaseTtlMs / 3 (so we tolerate two
   *  missed renewals before a successor can claim). */
  renewIntervalMs?: number;
  /** Initial-attempt poll interval when we DON'T hold the lease.
   *  Defaults to leaseTtlMs / 2 — half-TTL keeps takeover snappy
   *  without flooding Redis on a steady-state follower. */
  pollIntervalMs?: number;
  logger?: StructuredLogger;
  /** Test seam — pinned to deterministic ids in tests. */
  now?: () => number;
}

/** Lua script: only delete the key if it still holds OUR token. */
const RELEASE_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

/** Lua script: only refresh the TTL if WE still hold the key. Returns 1
 *  on success, 0 if the lease has been lost. */
const RENEW_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`;

export class RedisLeaderElection implements LeaderElection {
  private client?: RedisLikeClient;
  private ownedClient = false;
  private clientFactory: () => Promise<RedisLikeClient>;
  private podId: string;
  private key: string;
  private leaseTtlMs: number;
  private renewIntervalMs: number;
  private pollIntervalMs: number;
  private logger?: StructuredLogger;
  private now: () => number;

  private leader = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(options: RedisLeaderElectionOptions) {
    this.podId = options.podId ?? process.env.WORKER_ID ?? `worker-${randomUUID().slice(0, 8)}`;
    this.key = options.key ?? "ragdoll:scheduler:leader";
    this.leaseTtlMs = options.leaseTtlMs ?? 10_000;
    this.renewIntervalMs = options.renewIntervalMs ?? Math.max(1_000, Math.floor(this.leaseTtlMs / 3));
    this.pollIntervalMs = options.pollIntervalMs ?? Math.max(1_000, Math.floor(this.leaseTtlMs / 2));
    if (this.leaseTtlMs < this.renewIntervalMs * 2) {
      throw new Error(
        `RedisLeaderElection: leaseTtlMs (${this.leaseTtlMs}) must be at least 2x renewIntervalMs (${this.renewIntervalMs}) to tolerate a missed renewal`
      );
    }
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());

    if (options.client) {
      this.client = options.client;
      this.clientFactory = async () => options.client!;
    } else {
      const redisUrl = options.redisUrl;
      if (!redisUrl) {
        throw new Error(
          "RedisLeaderElection: either `client` or `redisUrl` must be provided"
        );
      }
      this.ownedClient = true;
      this.clientFactory = async () => {
        // Lazy ioredis import keeps this module install-free for the
        // offline test path. Mirrors createRedisChangeBus.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ioredis: any = await import("ioredis");
        const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
        const c = new Redis(redisUrl, { lazyConnect: true });
        c.on("error", (e: Error) =>
          this.logger?.warn?.("leader_election_redis_error", { message: e.message })
        );
        await c.connect();
        return c as RedisLikeClient;
      };
    }
  }

  isLeader(): boolean {
    return this.leader && !this.stopped;
  }

  start(): () => Promise<void> {
    void this.loop();
    return () => this.stop();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        if (!this.client) this.client = await this.clientFactory();
        if (this.leader) {
          // Renew. If the lease is gone (we paused too long), drop
          // leadership and fall back to the poll cadence.
          const renewed = await this.renew();
          if (!renewed) {
            this.logger?.warn?.("leader_election_lease_lost", { podId: this.podId, key: this.key });
            this.leader = false;
            await this.sleep(this.pollIntervalMs);
            continue;
          }
          await this.sleep(this.renewIntervalMs);
        } else {
          // Try to acquire.
          const acquired = await this.acquire();
          if (acquired) {
            this.leader = true;
            this.logger?.info?.("leader_election_acquired", { podId: this.podId, key: this.key });
            // Don't sleep the renew interval immediately — fall through
            // to the top of the loop so the next iteration enters the
            // renewal branch promptly.
            continue;
          }
          await this.sleep(this.pollIntervalMs);
        }
      } catch (err) {
        // Transient redis failure: lose leadership, back off, retry.
        // Better to give up the lease than to fly blind thinking we
        // still hold it.
        this.leader = false;
        this.logger?.warn?.("leader_election_tick_failed", {
          podId: this.podId,
          error: err instanceof Error ? err.message : String(err)
        });
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  private async acquire(): Promise<boolean> {
    const reply = await this.client!.set(this.key, this.podId, "NX", "PX", this.leaseTtlMs);
    // ioredis returns the string "OK" on success, null on no-op.
    return reply === "OK";
  }

  private async renew(): Promise<boolean> {
    const reply = await this.client!.eval(
      RENEW_LUA,
      1,
      this.key,
      this.podId,
      String(this.leaseTtlMs)
    );
    return Number(reply) === 1;
  }

  private async release(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.eval(RELEASE_LUA, 1, this.key, this.podId);
    } catch {
      // Best-effort: process is exiting either way.
    }
  }

  private async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.release();
    this.leader = false;
    if (this.ownedClient && this.client) {
      try {
        await this.client.quit();
      } catch {
        /* ignore */
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = setTimeout(resolve, ms);
    });
  }
}
