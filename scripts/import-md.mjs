#!/usr/bin/env node
/**
 * Import a directory of markdown files into AstroBaaS.
 *
 *   npm run import:md -- ./content/posts
 *
 * Each .md file becomes a post. YAML frontmatter is parsed for:
 *   title (required), slug, status, excerpt, tags, category, date,
 *   featured_image. Anything else is ignored.
 *
 * If no frontmatter is present, the filename (without extension) becomes
 * the slug and the first heading becomes the title.
 *
 * Markdown body is converted to HTML by a minimal converter (paragraphs,
 * headings, code, lists, links). For complex content, paste the HTML.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { requireJsonDb } from './lib/db-target.mjs';

// Honours DB_PATH, and REFUSES when the install is on libSQL or a
// relational database — where there is no db.json and writing one would
// report success and change nothing. See scripts/lib/db-target.mjs.
const DB_PATH = requireJsonDb('import markdown');
const SEED_PATH = path.resolve(process.cwd(), 'db.seed.json');
const dir = process.argv[2];

if (!dir) {
  console.error('Usage: npm run import:md -- <directory>');
  process.exit(2);
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function slugify(s) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// Minimal YAML frontmatter parser. Supports: scalars (string/number/bool),
// inline arrays ([a, b, c]). Nothing fancier.
function parseFrontmatter(src) {
  if (!src.startsWith('---')) return { data: {}, body: src };
  const end = src.indexOf('\n---', 3);
  if (end < 0) return { data: {}, body: src };
  const fm = src.slice(3, end).trim();
  const body = src.slice(end + 4).replace(/^\s*\n/, '');
  const data = {};
  for (const line of fm.split('\n')) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else if (val.startsWith('[') && val.endsWith(']')) {
      val = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else if (val === 'true') {
      val = true;
    } else if (val === 'false') {
      val = false;
    } else if (val !== '' && !isNaN(Number(val))) {
      val = Number(val);
    }
    data[key] = val;
  }
  return { data, body };
}

// Minimal markdown → HTML converter. Enough for blog posts. For richer
// content, paste HTML; the rest of the pipeline already accepts it.
function mdToHtml(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let inCode = false;
  let inList = null; // 'ul' | 'ol' | null
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (inList) {
      out.push(`</${inList}>`);
      inList = null;
    }
  };
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/_([^_]+)_/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');

  for (const line of lines) {
    if (line.startsWith('```')) {
      flushPara();
      closeList();
      if (!inCode) {
        out.push('<pre><code>');
        inCode = true;
      } else {
        out.push('</code></pre>');
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      out.push(line.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      closeList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushPara();
      if (inList !== 'ul') {
        closeList();
        out.push('<ul>');
        inList = 'ul';
      }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      flushPara();
      if (inList !== 'ol') {
        closeList();
        out.push('<ol>');
        inList = 'ol';
      }
      out.push(`<li>${inline(line.replace(/^\d+\.\s+/, ''))}</li>`);
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      closeList();
      continue;
    }
    para.push(line);
  }
  flushPara();
  closeList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

async function loadDb() {
  try {
    return JSON.parse(await fs.readFile(DB_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      try {
        return JSON.parse(await fs.readFile(SEED_PATH, 'utf8'));
      } catch {
        return {
          posts: [],
          categories: [],
          users: [],
          media: [],
          themes: [],
          settings: [],
          themeSettings: [],
          contentChanges: [],
        };
      }
    }
    throw err;
  }
}

async function main() {
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat) {
    console.error(`Not found: ${dir}`);
    process.exit(1);
  }

  const files = (await fs.readdir(dir)).filter((f) => /\.(md|markdown)$/i.test(f));
  if (files.length === 0) {
    console.error(`No .md files found in ${dir}`);
    process.exit(1);
  }

  const db = await loadDb();
  db.posts = db.posts || [];
  db.categories = db.categories || [];
  const authorId = (db.users && db.users[0]?.id) || 'unknown';

  let categoryIndex = new Map();
  for (const c of db.categories) categoryIndex.set(c.slug, c);

  let added = 0;
  let skipped = 0;
  for (const file of files) {
    const full = path.join(dir, file);
    const raw = await fs.readFile(full, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    const fallbackTitle = file.replace(/\.(md|markdown)$/i, '').replace(/[-_]+/g, ' ');
    const title = String(data.title || fallbackTitle).trim();
    if (!title) {
      skipped += 1;
      continue;
    }
    const slug = slugify(String(data.slug || title));
    if (db.posts.some((p) => p.slug === slug)) {
      console.warn(`Skipping ${file}: slug "${slug}" already exists`);
      skipped += 1;
      continue;
    }

    let category_id;
    if (data.category) {
      const catSlug = slugify(String(data.category));
      let cat = categoryIndex.get(catSlug);
      if (!cat) {
        cat = {
          id: generateId(),
          name: String(data.category),
          slug: catSlug,
          description: '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        db.categories.push(cat);
        categoryIndex.set(catSlug, cat);
      }
      category_id = cat.id;
    }

    const html = mdToHtml(body);
    const createdAt = data.date
      ? new Date(String(data.date)).toISOString()
      : new Date().toISOString();

    db.posts.push({
      id: generateId(),
      title,
      slug,
      content: html,
      excerpt: data.excerpt ? String(data.excerpt) : '',
      featured_image: data.featured_image ? String(data.featured_image) : undefined,
      status: ['draft', 'review', 'scheduled', 'published', 'trashed'].includes(
        String(data.status),
      )
        ? String(data.status)
        : 'draft',
      author_id: authorId,
      category_id,
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      views: 0,
      created_at: createdAt,
      updated_at: createdAt,
    });
    added += 1;
  }

  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2) + '\n');
  console.log(`Imported ${added} post(s). Skipped ${skipped}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
