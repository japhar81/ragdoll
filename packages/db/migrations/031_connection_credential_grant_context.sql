-- ADR-0040: run-context-aware credential materialisation.
--
-- A connection driver may now resolve a sidecar credential from the RUN
-- context (the node's config or an input port) rather than only from the
-- connection itself — so one connection serves many tenants / environments /
-- credentials. The refresh callback, however, runs in the API with no node
-- config and no input ports: to re-materialise the SAME credential it needs the
-- selectors the driver used on the first call.
--
-- `materialization_context` persists exactly those selectors — the driver
-- nominates an identifiers-only blob on the first materialisation, we store it
-- here, and the redeem path replays it back into the driver hook. It holds
-- identifiers ONLY (a tenant id, an environment id, a credential id); the
-- credential itself is always re-fetched and never stored. NULL for
-- connection-only (ADR-0039) drivers, so this is a purely additive, backward-
-- compatible column — existing grants keep working untouched.

ALTER TABLE connection_credential_grants
  ADD COLUMN IF NOT EXISTS materialization_context jsonb;
