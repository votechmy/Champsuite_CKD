'use client';

/**
 * Mounted once at the root layout. Listens for clicks on any element with
 * data-card-thumb="1" and shows a native <dialog> with the large image +
 * card metadata. Closing on Esc / backdrop / explicit close.
 *
 * Why event delegation instead of a per-thumbnail client component:
 *   - 50+ thumbnails per list page would otherwise mean 50+ React boundaries
 *   - one global listener, one dialog DOM node — much cheaper
 *   - server-rendered thumbnails stay 100% static
 */

import { useEffect, useRef, useState } from 'react';

type ImageState = {
  src: string;
  name: string;
  meta: string;
};

export function ImageEnlargeProvider() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [img, setImg] = useState<ImageState | null>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-card-thumb="1"]');
      if (!target) return;
      const src = target.getAttribute('data-card-img-large') ?? '';
      const name = target.getAttribute('data-card-name') ?? '';
      const meta = target.getAttribute('data-card-meta') ?? '';
      if (!src) return;
      e.preventDefault();
      setImg({ src, name, meta });
      dialogRef.current?.showModal();
    }
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  function close() {
    dialogRef.current?.close();
    setImg(null);
  }

  return (
    <dialog
      ref={dialogRef}
      className="img-dialog"
      onClick={(e) => {
        // Backdrop click: target is the dialog itself, not its content.
        if (e.target === dialogRef.current) close();
      }}
      onClose={() => setImg(null)}
    >
      {img ? (
        <div className="img-dialog-inner">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={img.src} alt={img.name} width={488} height={680} />
          <div className="img-dialog-meta">
            <div className="img-dialog-name">{img.name}</div>
            {img.meta ? <div className="img-dialog-sub">{img.meta}</div> : null}
            <button type="button" className="img-dialog-close" onClick={close}>
              Close
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
