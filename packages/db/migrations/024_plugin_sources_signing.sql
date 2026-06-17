-- 024_plugin_sources_signing.sql
--
-- PLUGIN-ARCH-1 close-out: KISS signature verification.
--
-- Per-source signing config. When `require_signature` is TRUE the
-- loader's `verify` stage runs `git -c gpg.format=ssh -c
-- gpg.ssh.allowedSignersFile=<tmp> verify-commit <sha>` against the
-- per-source `allowed_signers` content; a bad/missing/untrusted
-- signature is `failed{stage:'verify'}` and the plugin doesn't load.
--
-- Trust posture: signing is OPT-IN per source. A source that doesn't
-- set `require_signature` loads without verification — preserves
-- the legacy behaviour for sources that already work. The richer
-- trust tier (org-wide signer policy, revocation) is a future
-- ADR — this is the KISS floor under it.
--
-- Storage shape: `allowed_signers` is the verbatim content of an
-- SSH allowed-signers file. We deliberately do NOT crack it into
-- discrete columns — the format is whatever ssh-keygen +
-- gpg.ssh.allowedSignersFile expect, and treating it as opaque
-- keeps the schema stable as the format evolves.

ALTER TABLE plugin_sources
  ADD COLUMN IF NOT EXISTS require_signature boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allowed_signers   text;

COMMENT ON COLUMN plugin_sources.require_signature IS
  'PLUGIN-ARCH-1 close-out: when true, the loader refuses to load plugins from this source until git verify-commit passes against allowed_signers.';
COMMENT ON COLUMN plugin_sources.allowed_signers IS
  'SSH allowed-signers file content used by git verify-commit. Opaque text; format is whatever gpg.ssh.allowedSignersFile expects.';
