// Per-pipeline /invoke request bodies for the load corpus.
//
// Each pipeline's seeded input node carries a default payload (see
// `examples/load/pipelines/*.yaml`), so passing `{}` as the body would still
// produce real work. We override here so each pipeline gets a stable but
// non-degenerate input — large enough that a regression in the JSONata or
// XML codepath shows up in the latency distribution.

const XML_FEED_BODY = (() => {
  // ~40 items × ~60 chars title = roughly 3 KB of XML — small enough that
  // local-network latency dominates the per-iteration cost, large enough
  // that the parser does meaningful work.
  const items = [];
  for (let i = 0; i < 40; i++) {
    items.push(
      `<item><title>load-test-title-${i}-${"x".repeat(40)}</title></item>`
    );
  }
  return `<feed>${items.join("")}</feed>`;
})();

// Map slug -> () => body. Functions (not constants) so a generator can swap
// in a per-iteration random payload later without changing call sites.
export const PAYLOADS = {
  "load-passthrough": () => ({
    input: { payload: { ts: new Date().toISOString(), n: 1 } }
  }),
  "load-fanout-merge": () => ({
    input: { payload: { n: 100, tags: ["a", "b", "c"] } }
  }),
  "load-deep-chain": () => ({
    input: { payload: { n: 0 } }
  }),
  "load-xml-parse": () => ({
    input: { xml: XML_FEED_BODY }
  })
};

/** Returns the slug list in deterministic order so round-robin selection
 *  produces an even distribution across pipelines. */
export function loadPipelineSlugs() {
  return Object.keys(PAYLOADS);
}
