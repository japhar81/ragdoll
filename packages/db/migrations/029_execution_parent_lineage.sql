-- Pipelines-as-modules: record the call edge when one pipeline invokes another
-- as a step (pipeline_call). `parent_execution_id` points at the invoking run's
-- execution_id so a run's full call tree is reconstructable, and usage / audit
-- can be attributed across the tree.
--
-- Nullable (top-level runs have no parent). Plain text referencing the parent's
-- execution_id (which is `text UNIQUE`); no FK because a parent may be pruned
-- independently and we don't want child inserts to fail on a missing ancestor.
-- Indexed for the "children of X" call-tree query.

ALTER TABLE executions
  ADD COLUMN IF NOT EXISTS parent_execution_id text;

CREATE INDEX IF NOT EXISTS executions_parent_execution_id_idx
  ON executions (parent_execution_id)
  WHERE parent_execution_id IS NOT NULL;
