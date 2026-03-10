import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const HUB_ROOT = path.resolve(__dirname, "../..");

export function nowIso() {
  return new Date().toISOString();
}

export function makeRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readJsonFile(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }

    throw new Error(`invalid json at ${filePath}: ${error.message}`);
  }
}

export async function writeJsonFile(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fs.rename(tmpPath, filePath);
}

export function mergeUnique(a = [], b = []) {
  return [...new Set([...(a || []), ...(b || [])])];
}

export function pickFirstNonEmpty(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) {
      return value;
    }

    if (typeof value === "string" && value.trim()) {
      return value;
    }

    if (value && typeof value === "object" && Object.keys(value).length > 0) {
      return value;
    }
  }

  return null;
}
