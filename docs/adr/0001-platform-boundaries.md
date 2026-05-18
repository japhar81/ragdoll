# ADR 0001: Own Platform Interfaces, Adapt Frameworks Behind Plugins

## Status

Accepted

## Context

RAGdoll needs durable, GitOps-friendly pipeline definitions and the ability to swap execution frameworks, providers, vector stores, and plugin implementations.

## Decision

Persist RAGdoll-native pipeline specs and expose RAGdoll-native runtime, provider, plugin, config, and secret interfaces. LangChain, LangGraph, provider SDKs, and vector clients may be used inside plugin/provider implementations but must not leak into persisted specs or public contracts.

## Consequences

- Pipeline definitions remain portable and diffable.
- The runtime can start as a simple DAG executor and later map to LangGraph or Temporal.
- Plugin authors implement a stable SDK instead of framework-specific objects.
