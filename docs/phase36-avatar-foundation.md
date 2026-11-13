# Phase 3.6A — Avatar model foundation

This change separates renderer body resources, base skeleton, garment geometry and initial garment fitting from the fixed V2 model. Existing callers retain V2 defaults. The renderer takes one immutable model per instance, isolating its geometry and neck-mask caches.

## Boundaries

- V2 remains the only selectable model. No database migration, upload endpoint or model switching is included.
- Compatible future models must use the 1200×1800 canvas and the existing V2 bone/anchor semantics; arbitrary skeletons are not supported.
- Body assets are cropped sprites with rest-space rectangles. Hair/head are separate appearance inputs.
- Sleeve classification still uses symmetric-body heuristics and pixel-sized tolerances. Test against proportion changes before exposing custom models.
- Next: validate/import a model package, inject selected model through room and pose controls, implement model-specific template/API persistence and immutable look snapshots. Preserve old V2 calibration and image references.
- Do not migrate existing clothing settings automatically; new models require separate initial fits or explicitly accepted transferred calibrations.
