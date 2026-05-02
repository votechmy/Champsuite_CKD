/**
 * Scryfall image URL helpers.
 *
 * Scryfall hosts card images at a predictable path:
 *   https://cards.scryfall.io/{size}/front/{c1}/{c2}/{uuid}.jpg
 * where c1, c2 are the first two chars of the UUID.
 *
 * Sizes (per Scryfall docs):
 *   small   146x204 — list thumbnails
 *   normal  488x680 — modal preview
 *   large   672x936 — full-screen
 *   art_crop / border_crop / png — not used here
 */

export type ScryfallSize = 'small' | 'normal' | 'large' | 'png';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidScryfallId(v: string | null | undefined): v is string {
  if (!v) return false;
  return UUID_RE.test(v);
}

export function scryfallImageUrl(
  scryfallId: string | null | undefined,
  size: ScryfallSize = 'small',
): string | null {
  if (!isValidScryfallId(scryfallId)) return null;
  const c1 = scryfallId[0];
  const c2 = scryfallId[1];
  const ext = size === 'png' ? 'png' : 'jpg';
  return `https://cards.scryfall.io/${size}/front/${c1}/${c2}/${scryfallId}.${ext}`;
}
