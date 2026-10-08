export default {
  extends: ["stylelint-config-standard"],
  reportNeedlessDisables: true,
  rules: {
    "media-feature-range-notation": "prefix",
    // Shared state and component rules intentionally rely on specificity, not source order.
    "no-descending-specificity": null,
  },
};
