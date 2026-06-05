import { dump as dumpYaml, load as loadYaml } from 'js-yaml';
import { parseKaperYaml } from './parser/recipe-parser';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const KAPER_VALUE_REGEX = /^\s*kaper\s*:\s*\S+/m;
const KAPER_BLOCK_REGEX = /```kaper\r?\n([\s\S]*?)```/;

export function hasKaperFrontmatter(content: string): boolean {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) return false;
  return KAPER_VALUE_REGEX.test(match[1]);
}

export function ensureKaperFrontmatter(content: string): string {
  const match = content.match(FRONTMATTER_REGEX);

  if (!match) {
    return `---\nkaper: true\n---\n\n${content}`;
  }

  if (KAPER_VALUE_REGEX.test(match[1])) {
    return content;
  }

  const updated = match[0].replace(/^---\r?\n/, '---\nkaper: true\n');
  return content.replace(match[0], updated);
}
export function extractTagsFromKaperBlock(content: string): string[] {
  const match = content.match(KAPER_BLOCK_REGEX);
  if (!match) return [];

  const parsed = parseKaperYaml(match[1]);
  const explicitTags = parsed.recipe?.tags || [];

  const rawBlock = match[1];
  const inlineTags = new Set<string>();
  const regex = /(?:^|[^a-zA-Z0-9_/-])#([A-Za-z_/-][A-Za-z0-9_/-]*|[A-Za-z0-9_/-]*[A-Za-z_/-][A-Za-z0-9_/-]*)/g;
  let tagMatch;
  while ((tagMatch = regex.exec(rawBlock)) !== null) {
    inlineTags.add(tagMatch[1]);
  }

  const normalizeTag = (tag: string) => tag.trim().replace(/^#+/, '');
  const allTags = [...explicitTags, ...Array.from(inlineTags)].map(normalizeTag).filter(Boolean);
  
  return Array.from(new Set(allTags));
}

export const KAPER_TAGS_REGEX = /<span class="kaper-tags"><\/span>.*/i;

export function syncHiddenTags(content: string, tags: string[]): string {
  const seen = new Set<string>();
  const normalizedTags: string[] = [];
  for (const tag of tags) {
    const clean = tag.trim().replace(/^#+/, '');
    if (!clean) continue;
    const lower = clean.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    normalizedTags.push(`#${clean}`);
  }

  const hasTags = normalizedTags.length > 0;
  const match = content.match(KAPER_TAGS_REGEX);

  if (match) {
    if (!hasTags) {
      const beforeMatch = content.slice(0, match.index);
      const afterMatch = content.slice(match.index! + match[0].length);
      const cleaned = beforeMatch + afterMatch;
      return cleaned.replace(/\n{3,}/g, '\n\n');
    }
    const newBlock = `<span class="kaper-tags"></span> ${normalizedTags.join(' ')}`;
    return content.replace(KAPER_TAGS_REGEX, newBlock);
  } else {
    if (!hasTags) {
      return content;
    }
    const newBlock = `<span class="kaper-tags"></span> ${normalizedTags.join(' ')}`;
    const separator = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
    return `${content}${separator}${newBlock}\n`;
  }
}

export function cleanFrontmatterTags(content: string, tagsToRemove: string[]): string {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match || match.index === undefined) return content;

  let frontmatter: any;
  try {
    frontmatter = loadYaml(match[1]);
  } catch (e) {
    return content;
  }

  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return content;
  }

  const normalizeTag = (tag: string) => tag.trim().toLowerCase().replace(/^#+/, '');
  const toRemoveSet = new Set(tagsToRemove.map(normalizeTag));

  const data = { ...(frontmatter as Record<string, unknown>) };
  const rawExistingTags = data.tags;
  if (!rawExistingTags) return content;

  const existingTags = Array.isArray(rawExistingTags)
    ? rawExistingTags.filter((tag): tag is string => typeof tag === 'string')
    : typeof rawExistingTags === 'string'
      ? [rawExistingTags]
      : [];

  const cleanedTags = existingTags.filter(tag => !toRemoveSet.has(normalizeTag(tag)));

  if (cleanedTags.length === existingTags.length) {
    return content;
  }

  if (cleanedTags.length > 0) {
    data.tags = cleanedTags;
  } else {
    delete data.tags;
  }

  const serialized = dumpYaml(data, { lineWidth: 100 }).trimEnd();
  const start = match.index;
  const end = start + match[0].length;
  return `${content.slice(0, start)}---\n${serialized}\n---\n${content.slice(end)}`;
}

export function syncFileTags(content: string): string {
  const kaperTags = extractTagsFromKaperBlock(content);
  let updatedContent = syncHiddenTags(content, kaperTags);
  updatedContent = cleanFrontmatterTags(updatedContent, kaperTags);
  return updatedContent;
}

