module.exports = [
  {
    ignores: ["eslint.config.js"],
  },
  ...require("eslint-config-next/core-web-vitals"),
  ...require("eslint-config-next/typescript"),
];
