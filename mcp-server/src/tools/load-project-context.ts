import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LoadProjectContextParams {
  folder_path: string;
}

interface FileEntry {
  name: string;
  lastModified: string; // ISO date string
}

interface ScheduleHint {
  date: string;       // ISO date string (YYYY-MM-DD)
  description: string;
  source: 'readme_heading' | 'readme_date_line' | 'readme_table' | 'file_metadata';
}

interface ProjectContextResult {
  folderPath: string;
  readmeContent: string | null;
  subfolders: string[];
  files: FileEntry[];
  scheduleHints: ScheduleHint[];
}

// ---------------------------------------------------------------------------
// README detection
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Schedule hint extraction from README
// ---------------------------------------------------------------------------

/**
 * Parse a date string in YYYY-MM-DD or YYYY/MM/DD format.
 * Returns the ISO date key (YYYY-MM-DD) or null if parsing fails.
 */
function parseFlexibleDate(dateStr: string): string | null {
  const normalized = dateStr.replace(/\//g, '-');
  const parsed = new Date(normalized + 'T00:00:00');
  if (isNaN(parsed.getTime())) return null;
  return normalized;
}

/**
 * Extract schedule hints from README content.
 * Looks for:
 *   - Headings containing date patterns (e.g. "## 2024-05-01 Kick-off meeting")
 *   - Date lines: "YYYY-MM-DD: description" or "YYYY/MM/DD - description"
 *   - Markdown table rows with date-like first columns
 */
function extractScheduleHintsFromReadme(content: string): ScheduleHint[] {
  const hints: ScheduleHint[] = [];
  const lines = content.split('\n');

  // Pattern: Markdown heading with date
  const headingDatePattern =
    /^#+\s+.*?(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*(.*)/;

  // Pattern: YYYY-MM-DD or YYYY/MM/DD followed by separator and description
  const dateLinePattern =
    /(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*[:\-|]\s*(.+)/;

  // Pattern: Markdown table row with date
  const tableRowPattern =
    /\|\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*\|\s*([^|]+)\|/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try heading pattern first
    const headingMatch = trimmed.match(headingDatePattern);
    if (headingMatch) {
      const date = parseFlexibleDate(headingMatch[1]);
      if (date) {
        const desc = headingMatch[2].trim() || trimmed.replace(/^#+\s+/, '').trim();
        hints.push({ date, description: desc, source: 'readme_heading' });
        continue;
      }
    }

    // Try table row pattern (more specific than date line)
    const tableMatch = trimmed.match(tableRowPattern);
    if (tableMatch) {
      const date = parseFlexibleDate(tableMatch[1]);
      if (date) {
        hints.push({ date, description: tableMatch[2].trim(), source: 'readme_table' });
        continue;
      }
    }

    // Try date-line pattern
    const lineMatch = trimmed.match(dateLinePattern);
    if (lineMatch) {
      const date = parseFlexibleDate(lineMatch[1]);
      if (date) {
        hints.push({ date, description: lineMatch[2].trim(), source: 'readme_date_line' });
      }
    }
  }

  // Sort by date ascending
  hints.sort((a, b) => a.date.localeCompare(b.date));
  return hints;
}

// ---------------------------------------------------------------------------
// Schedule hints from file metadata
// ---------------------------------------------------------------------------

/**
 * Reconstruct schedule hints from file modification times in the folder.
 * Groups files by modification date and creates schedule hints.
 */
function extractScheduleHintsFromFiles(folderPath: string): ScheduleHint[] {
  const hints: ScheduleHint[] = [];
  const filesByDate = new Map<string, string[]>();

  try {
    const items = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
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
      hints.push({
        date: dateKey,
        description: files.join(', '),
        source: 'file_metadata',
      });
    }
  } catch {
    // Folder might not be accessible
  }

  hints.sort((a, b) => a.date.localeCompare(b.date));
  return hints;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function loadProjectContext(params: LoadProjectContextParams): ProjectContextResult {
  const folderPath = params.folder_path;

  if (!fs.existsSync(folderPath)) {
    throw new Error(`Folder does not exist: ${folderPath}`);
  }

  const stat = fs.statSync(folderPath);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${folderPath}`);
  }

  // Read README if present
  let readmeContent: string | null = null;
  const readmePath = findReadme(folderPath);
  if (readmePath) {
    try {
      readmeContent = fs.readFileSync(readmePath, 'utf-8');
    } catch {
      // README exists but can't be read — proceed without it
    }
  }

  // List directory entries
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  const subfolders: string[] = [];
  const files: FileEntry[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(folderPath, entry.name);

    if (entry.isDirectory()) {
      subfolders.push(entry.name);
    } else if (entry.isFile()) {
      try {
        const fileStat = fs.statSync(fullPath);
        files.push({
          name: entry.name,
          lastModified: fileStat.mtime.toISOString(),
        });
      } catch {
        // Skip files that can't be stat'd
        files.push({
          name: entry.name,
          lastModified: new Date(0).toISOString(),
        });
      }
    }
  }

  subfolders.sort();
  files.sort((a, b) => a.name.localeCompare(b.name));

  // Extract schedule hints: prefer README-based, supplement with file metadata
  let scheduleHints: ScheduleHint[] = [];
  if (readmeContent) {
    scheduleHints = extractScheduleHintsFromReadme(readmeContent);
  }
  if (scheduleHints.length === 0) {
    scheduleHints = extractScheduleHintsFromFiles(folderPath);
  }

  return {
    folderPath,
    readmeContent,
    subfolders,
    files,
    scheduleHints,
  };
}
