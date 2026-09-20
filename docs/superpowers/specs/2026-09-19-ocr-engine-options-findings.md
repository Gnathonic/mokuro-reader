# OCR engines and text placement: what Chimahon and Manatan do, and what we should take

**Date:** 2026-09-19
**Status:** findings + recommendation. Nothing here was implemented when it was written; see the update under
recommendation 5 for the reader-side part that since was. The producer-side items are for the
mokuro-bunko session (worktree `feat-ocr-engines`), which this work only READ.
**Evidence:** reports, scripts and raw results are kept outside the repo in
`~/Projects/mokuro-ocr-research-2026-09-19/` (`reports/` = the eight investigation reports and the fact-check,
`scripts/` = the ink-evaluation harness, the PP-OCR bench experiment, the critic's re-runs).
Tags: **[V]** verified in code, data or a primary source · **[L]** likely · **[S]** speculative.
Every manga quality number published by a model author is self-reported; only the numbers under
"Measured on our pages" are ours.

## The question

Placement from our custom pipeline looks worse than stock mokuro. Chimahon (Android Mihon fork) and Manatan
place text well, one of them with local OCR. The project goal is better OCR options, not any particular engine.

## What the two apps actually do

**Neither app places individual characters — from any engine. [V]** Chimahon draws, highlights and hit-tests
on one uniform grid: `step = line extent / character count`, glyph centred in its step, the whole line rotated
by the detector's angle (`OcrTextOverlayPainter.kt`, `OcrHitTester.kt:95-119`). Its Lens parser discards the
character entries the response contains. Manatan merges lines into blocks and sets one font size per block
(`TextBox.tsx` `calculateFontSize`). Their placement looks good because the LINE boxes are good.

**Chimahon's PaddleOCR engine [V]** is a closed C++ library ("ocrtest": ncnn + Vulkan + Clipper2) running
**`Kellenok/PP-OCRv6_manga` v0.1** — byte-level weight comparison confirms it. That is an Apache-2.0 fine-tune
of the official PP-OCRv6 tiny detector (DBNet, 0.96 MB fp16) and small recognizer (SVTR-LCNet with a **CTC**
head, 10.6 MB fp16, 18,708-character dictionary), trained on Manga109-s + AnimeText, published 2026-09-02 as
ONNX and Paddle weights. Recipe: longest side 960 (we measured 1280+ is better), ImageNet normalisation for
detection, `thresh 0.15 / box_thresh 0.25 / unclip 1.40`, crops taller than wide rotated 90° counter-clockwise,
height 48, `(x/255-0.5)/0.5`, greedy CTC. Furigana is detected as separate lines and filtered by geometry
(`OwOCRMerger.kt:675-771`: no kanji, thickness ≤ 0.75 of the base line, gap < 0.30 × thickness, on the right or
above). Lines → bubbles is a geometry-only merger ported from owocr, with every threshold relative to
character size.

**Both apps' best local engine is Google's. [V]** Manatan's downloadable "Good Local OCR" is Chrome's Screen AI
library (`libchromescreenai.so` + GOCR detector/recognizer tflite models), fetched by its Makefile/Dockerfile
from `KolbyML/assets`; Chimahon's "Local OCR" loads the same GOCR assets through the Google app's on-device
Lens API. The Screen AI output format includes per-symbol boxes. These are proprietary Google binaries: we
cannot ship them; a user-fetched integration is conceivable but its quality on manga is untested. **[L]**

**Manatan's transferable practice [V]:** a regression corpus — 122 categorised cases (`wrong_line`,
`touching_bubbles`, …) of cropped bubbles with the raw engine output CACHED beside a hand-verified expected
result, so merge/placement logic is tested without running OCR (`merge_regression.rs:100-129`).

## Measured on our pages

Bench: One-Punch Man Vol B (12 pages, 1705×2800) and Chained Soldier Vol 01 (8 pages), from the local bunko
demo library; ground truth for character positions = ink-run centres on clean all-wide-glyph lines
(141 of 525 lines, 134 vertical — horizontal text is effectively untested).

|                                                         | result                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kellenok det+rec, CPU, 4 threads                        | ~0.2 s per page; 11.5 MB of models                                                                                                                                                                                                             |
| Text vs manga-ocr                                       | 2.4% CER through its own boxes, 1.9% on our quads (OPM). Of 16 hand-judged disagreements more than half were manga-ocr's errors (`齟`→`組`). Small sample.                                                                                     |
| Line boxes vs comic-text-detector                       | tighter and more symmetric (start slack 0.05 vs 0.15 pitch; 10.8% vs 14.0% ink-free across the line); true min-area rectangles, tilted for slanted SFX; unclip 1.40 clips an end glyph on ~3% of lines → use 1.5–1.6 or pad the axis 0.1 pitch |
| Furigana                                                | boxed as its own lines: 137 of 170 extra boxes on OPM were ruby, read correctly                                                                                                                                                                |
| **paddle-manga layer line quads**                       | **start/end spread 2.2 / 2.8 pitch (vs 0.2–0.7 for both detectors); ~9% of blocks re-wrap the print (two independent counts); single-character errors of 1.13 and 2.27 pitch; always axis-aligned**                                            |
| Character centres, mean error in pitch                  | producer `char_offsets` 0.037–0.040 · uniform grid 0.047 · CTC single pass 0.066 · CTC 8-shift ensemble, bias-corrected, out of sample 0.026 (max 0.18 vs producer 0.41)                                                                       |
| Fixed-pitch grid with glyph-class ink insets (no model) | 95.0% clean boundaries on wide lines / 84.5% on punctuation+small-kana lines, vs charmap 95.1% / 86.9% — and zero zero-width or squeezed cells by construction                                                                                 |
| Print pitch variation                                   | ~1.5% (the lettering is monospaced); producer cells vary ~5%                                                                                                                                                                                   |

**Reading of the numbers.** Character placement methods differ by ~0.01 pitch — under a pixel on screen.
Nothing at that scale explains "much worse than stock". The large defects are all in the **paddle-manga
line geometry**: that engine (PaddleOCR-VL + manga LoRA, `OCR:` task) returns block text with no positions, so
line quads are fabricated by splitting the block box and the text is re-wrapped onto them. Stock mokuro has
real line quads from a detector. **[V] for the measurements, [L] for it being what the eye objects to — nobody
has rendered the same page from both layers side by side.**

Why the producer's cells bloat and squeeze **[L]**: the attention centroid is a full-softmax mean over all
patches, heads and layers, so diffuse attention pulls every centroid toward the crop centre while the first and
last boundary are pinned to the ink extent; a synthetic line with 27% diffuse mass reproduces the real cells
(87,42,22,20,… vs 94,45,26,25,…). A single trailing `、` within 6 px of its neighbour pushes a perfect line off
the ink-cells path onto that attention path. No fixed-pitch prior exists anywhere in `charmap.py`, and
character placement has never been benchmarked (its tests assert length, monotonicity and bounds only).

## Engine options (fact-checked against primary sources)

- **PP-OCRv6** (PaddleOCR 3.7, 2026-06-11): Apache-2.0 code and weights, tiny/small/medium (1.5M/7.7M/34.5M),
  CTC head. No manga or vertical-text benchmark from the vendor. RapidOCR ≥ 3.9 ships it and derives character
  boxes from CTC columns, with a vertical branch that rotates them back (`cal_rec_boxes`); PaddleOCR 3.x has
  `return_word_box` natively. ONNX Runtime dropped its ROCm provider, so the ONNX path is CPU on the RX 9070 XT
  (fine at these sizes); RapidOCR's PyTorch backend is the GPU route, untested.
- **Best text recognizer on published evidence:** `sorryhyun/paddleocr-vl-1.6-manga-lora` (what `paddle-manga`
  already is): speech bubbles 88.1% exact vs manga-ocr 81.0%, SFX 83.9% vs 28.9%, self-reported, two weeks old,
  documented runaway generations. **Keep it as a recognizer; fix the geometry under it.**
- **PaddleOCR-VL 1.5/1.6 has a `Spotting:` task** that returns line quads + text from the VLM itself. Untested
  on vertical manga, and the LoRA's vision-tower fine-tune may have broken it. Cheap spike.
- **Forced alignment** of a known transcript against a CTC model's output is established practice for OCR
  (kraken `align.py`), so a CTC model can serve purely as an aligner under a stronger recognizer.
- **In the browser:** the official `@paddleocr/paddleocr-js` (Apache-2.0, onnxruntime-web, polygons out) runs
  PP-OCRv6; Namida-OCR (GPL-3.0) is a working reference for DB post-processing, vertical crops and WebGPU
  failure handling. The Kellenok manga models are 11.5 MB — small enough for a keyless local engine in the
  reader. Risks: COOP/COEP for threaded WASM vs our service worker and OAuth popups; v0.4.x API.
- Dead ends: MangaLMM (block-level boxes, >10 h per 1,166 pages), Florence-2 (no CJK vocabulary),
  manga-image-translator's CTC variant (reported inaccurate), PP-DocLayout (layout blocks, not text lines).
- comic-text-detector is GPL-3.0 and unmaintained since 2023-08.

## Recommendation, in order

1. **Give every engine real line quads (producer).** Run the Kellenok PP-OCRv6 manga detector + recognizer
   (onnxruntime, CPU) as the geometry backbone. For the VLM engine: never divide a block box — read each
   detected line with the CTC model and sequence-match the VLM's block text onto those lines; the VLM supplies
   the characters, the detector supplies where they are. Side limit ≥ 1280, unclip ~1.5. Port the
   geometry-only furigana rule and the owocr-style line→bubble merger (~300 lines). **[V]**
2. **Offer `ppocr-manga` as an engine in its own right** — 0.2 s/page on CPU, ~2% CER against manga-ocr on our
   bench, native line quads. It is the first option that works for self-hosters without a GPU. **[V]** on two
   series; needs a wider evaluation set before it is called a default.
3. **Make a fixed-pitch grid the placement model, not the fallback (producer).** Two parameters per line from
   the reading-axis ink extent, glyph-class insets for punctuation/small kana/brackets, grouping kept for
   tate-chu-yoko and `…`; accept finer data (ink cells, CTC centres) only inside sanity bounds. Replaces the
   three branches of `charmap._boundaries`. The sidecar format does not change. Do NOT take the pitch from the
   quad's cross extent — tested, it makes placement worse. **[V]** on vertical print.
4. **Producer self-check + regression corpus.** Port the reader's `repairZeroCells` give-up rules to Python so
   implausible offsets are written as `null`; build a Manatan-style corpus of real line crops with cached raw
   engine output and expected placement, including the zero-width, bloated and crushed failures. **[V]**
5. **Reader:** celled lines take the block's shared font size again; rotate a line by its quad's angle (both
   apps do; continuity-safe as a CSS transform); then a keyless in-browser `ppocr-manga` engine beside GCV.
   _Update, same day (owner's decision): the viewer's auto mode drops per-character cells altogether — every
   line sits on the uniform grid of its quad (CSS letter-spacing on one text node) and tilted quads render
   rotated. `src/lib/reader/line-grid.ts`, `e2e/line-grid.spec.ts`; `char_offsets` remain original mode's
   diagnostic view. The OCR editor draws lines the same way (grid, rotation, cells only in original) and its
   line move / resize / insert keep a quad's tilt._
6. **Spikes:** PaddleOCR-VL `Spotting:` on vertical manga; CTC centres as an independent guard (≈1 s/page for
   the 8-shift ensemble, gain ~0.01 pitch — only after 1 and 3); user-fetched Chrome Screen AI as a symbol-box
   source, feeding the reader's existing `gcv-symbols` path.

**Before choosing a default engine:** build a fixed evaluation set of 100–200 lines from our own material
(vertical, furigana, bold display type, SFX, horizontal) with hand-verified text, and score manga-ocr,
PP-OCRv6 manga, PP-OCRv6 medium and both PaddleOCR-VL fine-tunes on it. No independent manga benchmark exists.
