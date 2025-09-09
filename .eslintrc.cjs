module.exports = {
    "extends": "eslint:recommended",
    "parserOptions": {
        "sourceType": "module"
    },
    "env": {
        "es2017": true,
        "node": true
    },
    "rules": {
        "indent": ["error", 4],
        "linebreak-style": ["error", "unix"],
        "semi": ["error", "always"],
        "no-cond-assign": ["error", "always"]
    }
};
