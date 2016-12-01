module.exports = {
  "env": {
    "mocha": true
  },
  plugins: [
    "mocha"
  ],
  rules: {
    "max-nested-callbacks": "off",
    "mocha/no-exclusive-tests": "error",
    "import/default": "off",
    "fp/no-this": "off"
  }
};
