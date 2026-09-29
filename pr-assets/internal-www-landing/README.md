# Appliance landing v2 review captures

Captured 2026-09-29 in Chromium 149.0.7827.55.

- Before: origin/main (`40fe4c5`), local Next development server. No product-story section existed; the full home capture includes the whole baseline.
- After: final production pages, 1280 × 900 and 375 × 900 viewports; PNGs capture the full page. Separate story crops make the new section easier to review.
- `hero-reveal.gif`: actual Chromium screencast of a page reload with normal motion, followed by a final-frame hold. Server output is visible before enhancement.
- `reveal-samples.json`: browser opacity samples from the production reveal. Intermediate values verify interpolation after CSS minification converts the kit duration token from milliseconds to seconds.
- `smoke.json`: responsive overflow, keyboard/CLI anchor, no-JavaScript content, reduced-motion initial preference and live changes, and browser error checks.
- `lighthouse-{home,catalogue}.{json,html}`: Lighthouse 13.5.0, accessibility category only, default mobile configuration, local production HTTP server. Both routes score 100/100. Automated scores are supplemented by the browser checks above.

Brand source: public main `6dcd274b12aa0c6613d43310a5f9e03a54e3b491`. No deployment was performed.
