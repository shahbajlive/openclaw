import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export default createScopedVitestConfig(["ui/src/workspace/**/*.test.ts"]);
