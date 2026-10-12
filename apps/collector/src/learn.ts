/**
 * The hook for future /learn/* articles. Nothing is published yet.
 *
 * When a `content/learn/` folder exists at the repo root, a small build step should read each
 * article's front matter (title, description, updated, status) and write it into this list.
 * The sitemap and llms.txt pick up every entry with `status: 'live'` on their own. Drafts never
 * appear anywhere public; `publicPages()` in seo.ts filters them out.
 */
import type { PublicPage } from './seo';

export interface LearnPage extends PublicPage {
  status: 'live' | 'draft';
}

export const LEARN_PAGES: LearnPage[] = [];
