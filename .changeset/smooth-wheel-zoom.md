---
'mokuro-reader': patch
---

Fix wheel zoom normalization across browsers and platforms. Normalizes scroll delta between Chrome and Firefox, adds platform-specific speed adjustment, implements edge-aware zoom to keep corners visible, and captures wheel events at window level to prevent browser zoom when hovering over UI elements.
