import * as fs from 'fs';
import * as path from 'path';
import type { ProjectContext, ScheduleEntry } from '../../src/types/index';

// --- README detection ---

const README_NAMES = [
  'README.md',
  'readme.md',
  'Readme.md',
  'README.MD',
  'README.txt',
  'README',
];

function findReadme(folderPath: string): string | null {
  for (const name of README_NAMES) {
    const filePath = path.join(folderPath, name);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return null;
}

// --- Schedule extraction from README ---

/**
 * Extract schedule entries from README content.
 * Looks for common schedule/timeline patterns:
 *   - "YYYY-MM-DD: description" or "YYYY/MM/DD: description"
 *   - Markdown table rows with date-like first columns
 *   - Lines containing date patterns followed by descriptive text
 */
function extractScheduleFromReadme(content: string): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  const lines = content.split('\n');

  // Pattern: YYYY-MM-DD or YYYY/MM/DD followed by separator and description
  const dateLinePattern =
    /(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*[:\-|]\s*(.+)/;

  // Pattern: Markdown table row with date
  const tableRowPattern =
    /\|\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*\|\s*([^|]+)\|\s*([^|]*)\|?/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try table row pattern first (more specific)
    const tableMatch = trimmed.match(tableRowPattern);
    if (tableMatch) {
      const date = parseFlexibleDate(tableMatch[1]);
      if (date) {
        entries.push({
          date,
          description: tableMatch[2].trim(),
          status: tableMatch[3]?.trim() || '',
        });
        continue;
      }
    }

    // Try date-line pattern
    const lineMatch = trimmed.match(dateLinePattern);
    if (lineMatch) {
      const date = parseFlexibleDate(lineMatch[1]);
      if (date) {
        entries.push({
          date,
          description: lineMatch[2].trim(),
          status: '',
        });
      }
    }
  }

  // Sort by date ascending
  entries.sort((a, b) => a.date.getTime() - b.date.getTime());
  return entries;
}

/**
 * Parse a date string in YYYY-MM-DD or YYYY/MM/DD format.
 * Returns null if parsing fails.
 */
function parseFlexibleDate(dateStr: string): Date | null {
  const normalized = dateStr.replace(/\//g, '-');
  const parsed = new Date(normalized + 'T00:00:00');
  if (isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

// --- Schedule reconstruction from file metadata ---

/**
 * Reconstruct a rough schedule from file modification times in the folder.
 * Groups files by modification date and creates schedule entries.
 */
function reconstructScheduleFromFiles(folderPath: string): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];

  try {
    const items = fs.readdirSync(folderPath, { withFileTypes: true });
    const filesByDate = new Map<string, string[]>();

    for (const item of items) {
      const fullPath = path.join(folderPath, item.name);
      try {
        const stat = fs.statSync(fullPath);
        const dateKey = stat.mtime.toISOString().split('T')[0];
        const existing = filesByDate.get(dateKey) ?? [];
        existing.push(item.name);
        filesByDate.set(dateKey, existing);
      } catch {
        // Skip files that can't be stat'd
      }
    }

    for (const [dateKey, files] of filesByDate) {
      const date = new Date(dateKey + 'T00:00:00');
      entries.push({
        date,
        description: files.join(', '),
        status: 'file_activity',
      });
    }
  } catch {
    // Folder might not be accessible
  }

  entries.sort((a, b) => a.date.getTime() - b.date.getTime());
  return entries;
}

// --- Exports ---

/**
 * List subdirectories within a base path.
 * Returns an array of directory names (not full paths).
 * Non-directory entries are excluded.
 */
export function listProjectFolders(basePath: string): string[] {
  if (!fs.existsSync(basePath)) {
    throw new Error(`Base path does not exist: ${basePath}`);
  }

  const stat = fs.statSync(basePath);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${basePath}`);
  }

  const entries = fs.readdirSync(basePath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Read project context from a folder path.
 * Finds README.md, lists subfolders, and reconstructs schedule
 * from README sections and/or file metadata.
 */
export function readProjectContext(folderPath: string): ProjectContext {
  if (!fs.existsSync(folderPath)) {
    throw new Error(`Folder does not exist: ${folderPath}`);
  }

  const stat = fs.statSync(folderPath);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${folderPath}`);
  }

  // Read README if present
  let readmeContent = '';
  const readmePath = findReadme(folderPath);
  if (readmePath) {
    try {
      readmeContent = fs.readFileSync(readmePath, 'utf-8');
    } catch {
      // README exists but can't be read — proceed without it
    }
  }

  // List subfolders
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  const subfolders = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();

  // Reconstruct schedule: prefer README-based, fall back to file metadata
  let schedule: ScheduleEntry[] = [];
  if (readmeContent) {
    schedule = extractScheduleFromReadme(readmeContent);
  }
  if (schedule.length === 0) {
    schedule = reconstructScheduleFromFiles(folderPath);
  }

  return {
    folderPath,
    readmeContent,
    subfolders,
    schedule,
  };
}
