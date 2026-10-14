import { randomUUID } from "node:crypto";

/**
 * Stable per-process id for this API instance.
 *
 * Used by the plugin-refresh broadcast: the replica that serves
 * `POST /api/plugins/refresh` rebuilds its own registry in the handler, so when
 * its own broadcast comes back around the ChangeBus it skips it (origin ===
 * API_INSTANCE_ID) and only OTHER replicas reload.
 */
export const API_INSTANCE_ID = randomUUID();
