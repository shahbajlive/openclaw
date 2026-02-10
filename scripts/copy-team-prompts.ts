#!/usr/bin/env tsx
/**
 * Copy team prompt templates from src/agents/teams/prompts to dist/prompts
 *
 * The bundled code uses `import.meta.dirname` which resolves to `dist/`,
 * so prompts must live at `dist/prompts/` (not `dist/agents/teams/prompts/`).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const srcPrompts = path.join(projectRoot, "src", "agents", "teams", "prompts");
const distPrompts = path.join(projectRoot, "dist", "prompts");

function copyRecursive(src: string, dest: string) {
  if (!fs.existsSync(src)) {
    console.warn(`[copy-team-prompts] Source not found: ${src}`);
    return;
  }

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      fs.copyFileSync(srcPath, destPath);
      console.log(`[copy-team-prompts] Copied ${path.relative(srcPrompts, srcPath)}`);
    }
  }
}

copyRecursive(srcPrompts, distPrompts);
console.log("[copy-team-prompts] Done");
