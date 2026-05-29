-- Phase 6 of the dataset/RBAC/retrieval refactor: enable the `vector`
-- extension so the platform can run on Postgres-only deployments (no
-- Qdrant). The PgVectorStore in packages/vector creates one table per
-- vector collection on demand; this migration just installs the
-- extension once at db-init time.
--
-- pgvector is bundled in the official `pgvector/pgvector:pg17` image
-- (and provided by most managed Postgres offerings). On a stock
-- postgres image the CREATE EXTENSION will fail because installing
-- extensions requires superuser. That's *fine* — operators who don't
-- want a pgvector-enabled Postgres just keep using Qdrant; the
-- extension is only consumed by the optional PgVectorStore backend.
--
-- The DO block below wraps the CREATE in an exception handler so a
-- missing extension OR an insufficient_privilege error is logged and
-- skipped instead of failing the whole migration. IF NOT EXISTS keeps
-- the call idempotent when the extension IS available.

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'pgvector: insufficient privilege to CREATE EXTENSION — skipping. Qdrant remains available; install pgvector out of band if you need the Postgres-only vector backend.';
  WHEN undefined_file THEN
    RAISE NOTICE 'pgvector: extension binaries not present in this Postgres image — skipping. Use pgvector/pgvector:pg17 or a managed Postgres with pgvector if you need it.';
END $$;
