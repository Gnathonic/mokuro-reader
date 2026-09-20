# Novels and text-first books: what it needs

**Date:** 2026-09-19
**Status:** reviewed design, nothing implemented. Produced by six parallel reviews (two of ttu-ttu/ebook-reader,
an audit of this reader, format/OCR research, a model+renderer memo), one architect pass and one critic pass
that re-checked the load-bearing claims in code. Full reports: `~/Projects/mokuro-ocr-research-2026-09-19/novel-support/`.
Tags: **[V]** verified in code or a primary source · **[L]** likely · **[S]** speculative.

## Owner's brief

Better OCR exists to support **novels**: EPUB/PDF import, embedded-text support, dense-page OCR (manga-ocr is
poor on text-heavy pages), EPUB export, and a text renderer that needs no backing image, with paging and
progress by **characters** rather than pages. Inputs form a spectrum: image manga · manga packaged as EPUB/PDF ·
scanned books with no OCR · PDFs with a text layer · reflowable EPUB novels. Most imported novels will be
**light novels**: reflowable text plus illustrations, some with baked-in text — so even an EPUB novel needs its
images run through OCR. Reference reader: ttu-ttu/ebook-reader (BSD-3).

## The shape of the work

Three pieces, not one "novel mode":

1. **A document import front end.** Image EPUBs and PDFs become today's paged volume (`.cbz` + `.mokuro`);
   everything downstream — reader, editor, layers, stats, sync, bunko — is unchanged.
2. **A second volume kind, `flow`.** Reflowable EPUB/TXT stored as sanitised per-chapter HTML, read in a new
   image-free `FlowReader`. Illustrations inside a flow volume are pages of their own kind: each image gets the
   normal OCR treatment (line quads + text, rendered with the existing overlay) so baked-in text is
   look-up-able in place.
3. **A projection** of any paged volume into the same `FlowReader` — how a scanned book or a text-layer PDF is
   read as text. One stored copy, one character count, one OCR editor.

`VolumeMetadata.kind?: 'paged' | 'flow'` (absent = paged).

## Position and progress: the one model

- **Position = a volume-level character offset.** `VolumeData.chars` already exists, already syncs, and already
  survives old clients' closed constructor allowlist (`settings/volume-data.ts:136-184`) **[V]**.
- **`chars` means "end of what has been read"** — what the paged reader writes today (`Reader.svelte:253`).
  ttu's rule is start-of-screen; adopting it would make a hybrid volume resume a page late and inject ~900
  characters into reading speed on every view toggle **[V]**.
- Flow volumes get layout-independent **locator pages**: `page = floor(chars / 600) + 1`,
  `page_count = max(1, ceil(character_count / 600))`. Deterministic on every device; needs no stored array.
  The constant is fixed forever — changing it renumbers everyone's progress.
- **Things the naive version breaks [V]:**
  - _Two counting rules are live today._ Import counts every UTF-16 unit (`import/processing.ts:428-433`) and
    trusts mokuro's own `chars` (`:531`); the reader counts kana/kanji only (`util/count-chars.ts:12-16`).
    "Mark as read" writes the import-rule total into history (`VolumeItem.svelte:238-247`). Unify on the
    Japanese-only rule (ruby `rt` excluded, a gaiji image = 1), and clamp legacy `chars > character_count`.
  - _Reading speed._ Time and speed come from gaps between turns, and gaps over the 5-minute idle timeout are
    discarded (`util/reading-speed.ts:54,114`). At 100 chars/min a 600-character locator page takes 6 minutes:
    every gap is dropped and speed reads 0. Log a turn on a ≤60 s cadence while reading, then compact.
  - _Completion._ `isVolumeComplete` fires at `pageCount - 1` (`util/volume-helpers.ts:45-48`): a novel would
    show finished up to 1,200 characters early. Flow completion = `chars === character_count`.
  - _Non-Japanese text_ counts ≈ 0 under the Japanese-only rule → `page_count` 0 = the placeholder state.
    Needs a fallback count.
  - `recentPageTurns` is unbounded and the whole store is one localStorage key; page turns re-walk all pages
    (use `page_char_counts[page-1]`); `pagesRead` (29 call sites) would mix manga pages with pseudo-pages —
    flow volumes should display a percentage or characters.

## What to take from ttu-ttu/ebook-reader

- **Take:** the EPUB loader (OPF/spine/nav parsing, href rewriting, gaiji, cover; ~1,175 lines, lift nearly
  verbatim); the position mapper — cumulative character counts per text node, ONE rect read per node, binary
  search both ways, scoped to the **mounted chapter** so cost follows chapter size, not book size; the
  "character count is the truth, pixel offset is a cache revalidated by recomputing" restore after a font or
  viewport change; idle handling incl. pausing when a dictionary popup is detected.
- **Do not take:** continuous mode mounting the whole book (O(book) rect reads); Svelte 4 + rxjs plumbing;
  its sync format (a processed `bookdata_*.zip`, original EPUB discarded); and above all its **lack of any
  sanitiser** **[V]**.
- foliate-js (MIT) is a reference for fixed-layout detection and font de-obfuscation only: its paginator is an
  iframe with `allow-same-origin allow-scripts` **[V]**, which would put text outside our input stack,
  night-mode layers and the Yomitan rules.

## Security floor — before ANY HTML import

An EPUB is untrusted HTML rendered in an origin whose `localStorage` holds `mega_password`, `webdav_password`,
Drive tokens and OCR/LLM API keys (`provider-detection.ts:60-70`), and the app has **no CSP** **[V]**. Required:
a hash-based `script-src` CSP; DOMPurify with an EXPLICIT tag/attribute allowlist (the defaults admit `style`,
`<form>`/`<input>`, remote `<img>`); sanitise the final string in HTML mode (the XML-fallback → serialise →
`innerHTML` path is a mutation-XSS vector); block every remote URL; no publisher CSS in v1; no generic "HTML
file" import; zip-bomb limits in the shared extractor (there are none today); refuse DRM (`encryption.xml`).

## PDFs

pdf.js (Apache-2.0). Real cost ≈ 5.2 MB (main 459 KB, worker 1.27 MB, cmaps 1.17 MB, wasm decoders 1.55 MB —
mandatory for JPX/JBIG2 scans, fonts 0.8 MB), and `service-worker.js` precaches the whole build: it must be
excluded from the precache. A text-layer item is a positioned line — better data than OCR — but for vertical
fonts pdf.js puts the run extent in `item.height`, and its vertical-glyph issue is closed "not planned":
gate that path on a spike over real vertical-Japanese PDFs. Scanned PDFs are 50–500 MB; bilevel pages inflate
5–10× as JPEG; iOS caps canvas size; a pre-import quota check and a reused canvas are needed. MuPDF.js (AGPL)
is legally combinable under GPLv3 §13 — the cost is the AGPL source offer on every deployment and 14 MB, not
relicensing; hold it as a fallback.

## OCR for books

Line-level detector + CTC recognizer is the right family (see
`2026-09-19-ocr-engine-options-findings.md`); `ppocr-manga` is being built and evaluated on a real scanned
light novel now. Candidates for dense pages beyond it: NDLOCR-Lite (National Diet Library, CC BY 4.0 —
attribution required; reading order + ruby aware) pending a spike; YomiToku is CC BY-NC-SA (unusable);
Surya's weights carry a revenue-capped licence. Book pages additionally need block ROLES (body, page number,
running title, caption), ruby association, paragraph reconstruction, two-tier layouts — and excluded roles
must be uncounted in BOTH views, so role detection has to land together with the hybrid projection or history
gets recounted twice.

## Renderer

A sibling `FlowReader` mounted from `ReaderView` by kind or a per-volume toggle, under the same
`#/reader/<uuid>` route — not a growth of the 1,886-line `Reader.svelte`. Paginated mode = CSS multi-column with
ONE chapter mounted, pages turned by `transform` inside `overflow: clip`; normal-flow text for Yomitan; DOM
keyed per chapter/page for Migaku; position restore waits on `document.fonts.ready`. **Unproven and able to
invalidate the approach:** vertical-rl multi-column differs across Chromium / iOS WebKit / Firefox, and
Yomitan's `caretRangeFromPoint` scanning under transformed columns has not been tested — the first spike must
assert real scan results with the extension loaded, not just layout. Browser floor: current Chromium,
Safari 18, Firefox 140.

## Phases (each ships something usable; no big-bang migration)

| Phase | Content                                                                                                                                           | Ships                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| P0a   | Count unification + clamp, O(1) page lookup, turn compaction + time-cadence logging, kind-aware completion, CSP                                   | consistent stats; safe ground for HTML     |
| P0b   | Spikes: vertical multi-column with real Yomitan scanning · dense-page OCR (also sets the PDF raster cap) · pdf.js text on five real vertical PDFs | go/no-go on three risks                    |
| P1a   | `FlowReader` paginated over TXT + a fixture EPUB (clean text isolates renderer defects)                                                           | image-free reading with character progress |
| P1b   | Local EPUB import: sanitiser, images + gaiji, **illustrations OCR'd as image pages**, TOC, DRM refusal, original kept in `volume_files`           | **read an EPUB light novel**               |
| P2    | Image EPUB + PDF rasterising; text-layer PDF gated on its spike                                                                                   | manga/scans from EPUB and PDF              |
| P3    | Sync + bunko for flow volumes (original `.epub` in the cloud folder; old clients simply do not list it)                                           | novels back up                             |
| P4    | Hybrid projection + book OCR together (roles, ruby, paragraphs defined once)                                                                      | **read a scanned book as text**            |
| P5    | EPUB export (reflowable text; fixed-layout image+text; re-emit original)                                                                          | export                                     |
| P6    | Continuous mode virtualised by chapter, footnotes, search, idle page maps                                                                         | depth                                      |

## Decisions that are the owner's

1. **Counting rule:** Japanese-only everywhere + fallback for non-Japanese books; locator constant 600 forever.
   (Row totals shrink by the punctuation share; read history is clamped, not rewritten.)
2. **Meaning of `chars`:** end of what has been read (today's paged meaning), not ttu's start-of-screen.
3. **Originals:** keep the `.epub` (locally from P1b, in the cloud from P3); for PDFs discard the original only
   once the raster cap and bilevel encoding are settled — until then keep it, with an opt-out.
4. **PDF library:** pdf.js, excluded from the service-worker precache; MuPDF.js held as a fallback.
5. **Security floor first:** CSP + explicit allowlist + no remote URLs + no publisher CSS + no generic HTML
   import, before the first EPUB is rendered.
6. **Order:** EPUB novels first; hybrid text view ships together with server-side book OCR, not before it.

## Not in a first version

DRM · MOBI/AZW/FB2 · media overlays · publisher CSS and embedded fonts · mixed writing modes and `vertical-lr`
· editing flow text · annotations/highlights · ttu backup interop · true reflow of born-digital PDFs.
