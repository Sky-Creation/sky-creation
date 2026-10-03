/* Facebook posts shown on the site.
 *
 * This is the only file you need to edit to add posts. Add one object to the
 * relevant list, newest first, then deploy manually:
 *   netlify deploy --dir=site --prod
 * Pushing to GitHub does not publish anything.
 *
 *   date    the post date, e.g. "2026-04-18" (used for sorting and display)
 *   text    the post itself, plain text. Line breaks are preserved.
 *   url     link to the post on Facebook (optional but preferred)
 *
 * A post with no `url` renders as plain text, which is fine for announcements.
 * Anything not listed here simply does not appear - the section hides itself
 * when a list is empty, so the page never shows an empty heading.
 *
 * Example:
 *   company: [
 *     {
 *       date: '2026-04-18',
 *       text: 'We just shipped version 2 of SCI Exchange.',
 *       url: 'https://www.facebook.com/skycreationinnovations/posts/123456'
 *     }
 *   ]
 */
window.SKY_POSTS = {
  // Sky Creation Innovations - rendered on the Work page.
  company: [],

  // A Noob Mathematician - rendered on the Maths page.
  math: []
};
