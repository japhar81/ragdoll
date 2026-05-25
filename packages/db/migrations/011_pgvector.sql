-- Phase 6 of the dataset/RBAC/retrieval refactor: enable the `vector`
-- extension so the platform can run on Postgres-only deployments (no
-- Qdrant). The PgVectorStore in packages/vector creates one table per
-- vector collection on demand; this migration just installs the
-- extension once at db-init time.
--
-- pgvector is bundled in the official `pgvector/pgvector:pg17` image
-- (and provided by most managed Postgres offerings). On a stock
-- postgres image the CREATE EXTENSION will fail — operators should
-- either switch the docker-compose image to pgvector/pgvector or
-- continue using Qdrant.
--
-- IF NOT EXISTS keeps this idempotent on re-runs and on installations
-- where the extension is provisioned out of band.

CREATE EXTENSION IF NOT EXISTS vector;
