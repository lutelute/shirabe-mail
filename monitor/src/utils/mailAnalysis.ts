// Shared mail analysis utilities used by ThreadDetailPane and batch crawl

export interface ExtractedInfo {
  deadlines: string[];
  actionItems: string[];
  urls: string[];
}

export function extractKeyInfo(text: string): ExtractedInfo {
  if (!text) return { deadlines: [], actionItems: [], urls: [] };

  const deadlines: string[] = [];
  const actionItems: string[] = [];
  const urls: string[] = [];
  const seen = new Set<string>();

  const datePatterns = [
    /(\d{1,2}月\d{1,2}日(?:\s*[\(（][月火水木金土日]\s*[\)）])?)/g,
    /(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/g,
    /((?:期限|締切|〆切|deadline|due\s*date)[:：\s]*[^\n。、]{3,40})/gi,
  ];
  for (const pat of datePatterns) {
    let m;
    while ((m = pat.exec(text)) !== null) {
      const t = m[1] ?? m[0];
      const key = t.trim().slice(0, 30);
      if (!seen.has(key)) { seen.add(key); deadlines.push(key); }
    }
  }

  const lines = text.split(/[。\n]+/);
  const actionKeywords = /お願い|ください|下さい|していただ|確認|提出|回答|返信|送付|ご連絡|ご検討|ご対応|ご確認|ご報告|至急|要対応/;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 5 && trimmed.length < 120 && actionKeywords.test(trimmed)) {
      if (!seen.has(trimmed)) { seen.add(trimmed); actionItems.push(trimmed); }
    }
  }

  const urlPat = /(https?:\/\/[^\s<>"{}|\\^`\[\]））」』】]+)/g;
  let um;
  while ((um = urlPat.exec(text)) !== null) {
    const u = um[1].replace(/[.,;:!?]+$/, '');
    if (!seen.has(u)) { seen.add(u); urls.push(u); }
  }

  return {
    deadlines: deadlines.slice(0, 5),
    actionItems: actionItems.slice(0, 5),
    urls: urls.slice(0, 5),
  };
}

/**
 * Generate a basic note content from extracted info (no AI needed).
 * Returns markdown text suitable for MailNote.content
 */
export function generateBasicNote(
  subject: string,
  sender: string,
  preview: string,
): string {
  const info = extractKeyInfo(preview);
  const parts: string[] = [];

  if (info.deadlines.length > 0) {
    parts.push('**期限**: ' + info.deadlines.join(', '));
  }
  if (info.actionItems.length > 0) {
    parts.push('**要対応**:');
    for (const a of info.actionItems) {
      parts.push(`- ${a}`);
    }
  }
  if (info.urls.length > 0) {
    parts.push('**URL**: ' + info.urls.map((u) => `[Link](${u})`).join(' '));
  }

  if (parts.length === 0) {
    // No structured info found — just summarize basics
    const previewShort = preview.slice(0, 200).replace(/\n/g, ' ').trim();
    if (previewShort) {
      parts.push(`差出人: ${sender}`, `概要: ${previewShort}...`);
    }
  }

  return parts.join('\n');
}
