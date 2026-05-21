# Code Chunker

Symbol-aware chunker for polyglot codebases. Detects language by file
extension and splits content at top-level construct boundaries
(functions, classes, structs, interfaces, …) so retrieval lands hits on
semantic units instead of mid-statement.

## Supported languages

| Extension(s)             | Language id  | Anchored constructs                              |
|--------------------------|--------------|--------------------------------------------------|
| `.ts .tsx .mts .cts`     | typescript   | function, class, interface, type, enum, const-fn, namespace |
| `.js .jsx .mjs .cjs`     | javascript   | function, class, const-fn                        |
| `.py`                    | python       | def, class                                       |
| `.go`                    | go           | func, type (struct/interface), var/const blocks  |
| `.rs`                    | rust         | fn, struct, enum, trait, impl, mod               |
| `.java`                  | java         | class, interface, enum                           |
| `.kt .kts`               | kotlin       | fun, class, object, interface                    |
| `.c .h`                  | c            | function, struct, typedef                        |
| `.cpp .cc .cxx .hpp .hh` | cpp          | function, class, struct, namespace               |
| `.cs`                    | csharp       | class, interface, struct, namespace              |
| `.rb`                    | ruby         | class, module, def                               |
| `.php`                   | php          | function, class, interface, trait                |
| `.sh .bash .zsh`         | shell        | function                                         |
| Anything else            | (fallback)   | blank-line / line-based                          |

## Inputs

- `documents` (required) — source documents with `path` and `content`.

## Outputs

- `chunks` — array of `{ text, path, language, symbolKind?, symbolName?,
  startLine, endLine, index, docId }`. `symbolKind` is one of
  `function`, `class`, `interface`, `struct`, …; `symbolName` is the
  matched identifier (when the anchor pattern captured one).

## Config

- `maxChars` (default `4000`) — upper bound on chunk size. Oversize chunks
  split on blank lines.
- `minChars` (default `400`) — adjacent chunks below this merge (when the
  merged total stays under `maxChars`). Avoids 3-line dribbles for tiny
  helpers.

## Algorithm

1. **Detect language** from `path` extension.
2. **Find anchors** — scan lines for per-language top-level patterns;
   record each as a chunk boundary with kind + symbol name.
3. **Split** — content from line 0 to the first anchor is a "preamble"
   chunk (imports / pragmas / license headers); each subsequent anchor
   spans up to the next anchor (or EOF).
4. **Cap** — any chunk exceeding `maxChars` is re-split on blank lines.
5. **Merge** — adjacent chunks below `minChars` combine (the merged chunk
   drops its symbol metadata since it no longer represents one symbol).
6. **Fallback** — for unrecognised extensions, the whole file becomes one
   chunk subject to the cap/merge pipeline.

## Typical position

```
filesystem_source → path_classifier(code) → delta_filter
  → code_chunker → provider_embeddings → qdrant_vector_store
```

## Gotchas

- Regex-based, not AST-based. Pathological code that confuses the regex
  (multi-line function signatures with embedded blank lines, macros that
  define functions, generated code with non-standard layouts) won't always
  chunk perfectly. Retrieval still works because the cap/merge logic
  recovers — symbols just get less precise labels.
- C/C++ function detection prefers definitions with `{` on the signature
  line. Prototypes in headers are mostly invisible to it (which is fine —
  prototypes don't carry useful embedding signal).
- Markdown is NOT in the table on purpose. Use `basic_text_chunker` for
  docs / markdown; it preserves paragraphs better for narrative text.
