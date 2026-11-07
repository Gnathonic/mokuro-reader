/**
 * One seal v1 vector, copied verbatim from mokuro-bunko's
 * `interop/contract/seal/runner-output.json` (blessed by
 * `crates/bunko-layout/tests/seal_vectors.rs`): a sidecar as Bunko installs
 * it, Python separators and float spellings included. For the unit tests that
 * run without a Bunko checkout; `$lib/interop/seal-vectors.test.ts` runs every
 * vector from the checkout and checks this copy is still Bunko's.
 */
export const RUNNER_OUTPUT_DOCUMENT =
  '{"version": "0.2.5", "title": "シリーズ", "title_uuid": "0b5c1b5e-0000-5000-8000-000000000001", "volume": "シリーズ 01", "volume_uuid": "0b5c1b5e-0000-5000-8000-000000000002", "chars": 8, "ocr_engine": {"id": "hayai-nova", "detector": "ppocr-manga", "patch_budget": 512, "revision": 2, "created": "2026-10-29T00:00:00Z", "generator": "mokuro-bunko 0.8.0", "generation": "nova", "seal": "v1:8772c9b79d9d8017bf792ac96959ab1ade84f99379a6ad6a02c2b21ea24f10b5"}, "pages": [{"version": "0.2.5", "img_width": 1200, "img_height": 1700, "img_path": "001.jpg", "blocks": [{"box": [812, 104, 880, 402], "vertical": true, "font_size": 31.5, "lines_coords": [[[848.0, 104.0], [880.0, 104.0], [880.0, 402.0], [848.0, 402.0]], [[812.0, 104.5], [845.25, 104.5], [845.25, 300.0], [812.0, 300.0]]], "lines": ["橋を渡ろう", "よし！"]}]}, {"version": "0.2.5", "img_width": 1200, "img_height": 1700, "img_path": "002.jpg", "blocks": []}]}';

/** The JCS text Bunko hashed for {@link RUNNER_OUTPUT_DOCUMENT}. */
export const RUNNER_OUTPUT_SEAL_INPUT =
  '{"ocr_engine":{"created":"2026-10-29T00:00:00Z","detector":"ppocr-manga","generation":"nova","generator":"mokuro-bunko 0.8.0","id":"hayai-nova","patch_budget":512,"revision":2},"pages":[{"blocks":[{"box":[812,104,880,402],"font_size":31.5,"lines":["橋を渡ろう","よし！"],"lines_coords":[[[848,104],[880,104],[880,402],[848,402]],[[812,104.5],[845.25,104.5],[845.25,300],[812,300]]],"vertical":true}],"img_height":1700,"img_path":"001.jpg","img_width":1200,"version":"0.2.5"},{"blocks":[],"img_height":1700,"img_path":"002.jpg","img_width":1200,"version":"0.2.5"}]}';

export const RUNNER_OUTPUT_SEAL =
  'v1:8772c9b79d9d8017bf792ac96959ab1ade84f99379a6ad6a02c2b21ea24f10b5';
