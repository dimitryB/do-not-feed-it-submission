import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// The rules must compute the same bits in every engine (docs/CHAIN.md §3):
// ECMAScript leaves these Math functions and the ** operator
// implementation-approximated, so lib/game uses lib/game/detmath.ts instead.
const APPROXIMATED = ["sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
  "exp", "expm1", "log", "log1p", "log2", "log10", "cbrt", "hypot", "pow"];
const deterministicRules = {
  files: ["lib/game/**/*.ts"],
  ignores: ["lib/game/detmath.ts"],
  rules: {
    "no-restricted-properties": ["error", ...APPROXIMATED.map((property) => ({
      object: "Math", property, message: "Engines may differ in the last bit; use lib/game/detmath.ts so a replay matches in every browser.",
    }))],
    "no-restricted-syntax": ["error",
      { selector: "BinaryExpression[operator='**']", message: "`**` is implementation-approximated; use pow() from lib/game/detmath.ts." },
      { selector: "AssignmentExpression[operator='**=']", message: "`**=` is implementation-approximated; use pow() from lib/game/detmath.ts." },
    ],
  },
};

export default defineConfig([...nextVitals, ...nextTs, deterministicRules, globalIgnores([".next/**", "dist/**", "build/**", "node_modules/**", "artifacts/**", "cache/**", "next-env.d.ts"])]);
