/**
 * Thumbnail + click-to-enlarge trigger. Server component.
 *
 * Renders a 56x78 image (Scryfall `small`) for cards with a valid
 * scryfall_id, or a typographic fallback (first letter on a tinted card)
 * for cards without one. The button has data-* attributes that the global
 * <ImageEnlargeProvider> listens for via event delegation — no per-row
 * client component, no extra DOM, no React state in the table.
 */

import { scryfallImageUrl, isValidScryfallId } from '@/lib/scryfall';

type Props = {
  scryfallId: string | null | undefined;
  name: string;
  edition?: string | null;
  finish?: string | null;
};

export function CardThumb({ scryfallId, name, edition, finish }: Props) {
  const small = scryfallImageUrl(scryfallId, 'small');
  const normal = scryfallImageUrl(scryfallId, 'normal');
  const fallbackChar = (name?.trim()?.[0] ?? '?').toUpperCase();

  const dataAttrs = isValidScryfallId(scryfallId)
    ? {
        'data-card-thumb': '1',
        'data-card-img-large': normal ?? '',
        'data-card-name': name,
        'data-card-meta': [edition, finish].filter(Boolean).join(' · '),
      }
    : undefined;

  return (
    <button
      type="button"
      className="thumb"
      aria-label={`Enlarge ${name}`}
      {...dataAttrs}
      disabled={!small}
    >
      {small ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={small} alt={name} loading="lazy" width={56} height={78} />
      ) : (
        <span className="thumb-fallback" aria-hidden="true">
          {fallbackChar}
        </span>
      )}
    </button>
  );
}
