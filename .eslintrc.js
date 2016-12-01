module.exports = {
  "parser": "babel-eslint",
  "root": true,
  "extends": [
    "salemove",
    "plugin:fp/recommended"
  ],
  "env": {
    "browser": true
  },
  "plugins": [
    "fp"
  ],
  "globals": {
  },
  "rules": {
    "fp/no-let": "off",
    "fp/no-mutation": "off",
    "fp/no-nil": "off",
    "fp/no-unused-expression": "off",
    "fp/no-this": "off",
    "fp/no-mutating-methods": "off",
    "fp/no-delete": "off",
    "fp/no-loops": "off",
    "fp/no-events": "off",
    "camelcase": "off",
    "no-warning-comments": "off",
    "handle-callback-err": "off",
    "no-proto": "off"
  }
};
