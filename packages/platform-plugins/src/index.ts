/**
 * @ragdoll/platform-plugins — global, engine-style plugins that run arbitrary
 * code on platform lifecycle events (the 72 audited mutations + the pipeline
 * run lifecycle + usage), in `pre` (interceptable — veto/mutate) and `post`
 * (durable, observational) phases.
 *
 * This package is the dependency-free CORE: the event envelope, the catalog,
 * the plugin SPI + registry, the boot loader, and the pure dispatch engine.
 * Transport (NATS durable fan-out) and the emission wiring live in the host
 * (worker/api); the webhook sink is layered on top. See ADR 0036.
 */
export * from "./events.ts";
export * from "./catalog.ts";
export * from "./plugin.ts";
export * from "./dispatcher.ts";
export * from "./loader.ts";
