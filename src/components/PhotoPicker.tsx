import { useRef, useState } from 'react';
import { storePhoto, usePhotoUrl, type PhotoQuality } from '../data/photos';
import { IconCamera, IconImage, IconX } from './icons';

/**
 * One photo slot (正面 or 背面).
 *
 * The picked file is compressed and written to IndexedDB straight away, and the
 * new id handed up — the caller is responsible for cleaning up ids it ends up
 * not saving (see `CardForm`'s staged-photo tracking).
 */
export function PhotoPicker({
  label,
  photoId,
  quality,
  onChange,
}: {
  label: string;
  photoId: string | undefined;
  quality: PhotoQuality;
  onChange: (photoId: string | undefined) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const url = usePhotoUrl(photoId, 'thumb');

  const accept = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('請選擇圖片檔');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const photo = await storePhoto(file, quality);
      onChange(photo.id);
    } catch (e) {
      console.error(e);
      setError('圖片處理失敗，請換一張試試');
    } finally {
      setBusy(false);
      // Let the same file be picked again after a removal.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div>
      <span className="label">{label}</span>
      <div
        className={`aspect-photocard relative overflow-hidden rounded-2xl border-2 border-dashed transition-colors ${
          dragging ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2'
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void accept(e.dataTransfer.files[0]);
        }}
      >
        {url ? (
          <img src={url} alt={label} className="h-full w-full object-cover" />
        ) : (
          <button
            type="button"
            className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            <IconImage className="h-7 w-7" />
            <span className="text-xs">{busy ? '處理中…' : '點選或拖曳照片'}</span>
          </button>
        )}

        {busy && url && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-xs text-white">
            處理中…
          </div>
        )}

        {url && !busy && (
          <div className="absolute inset-x-2 bottom-2 flex gap-1.5">
            <button
              type="button"
              className="btn btn-sm flex-1 bg-black/55 text-white backdrop-blur hover:bg-black/70"
              onClick={() => inputRef.current?.click()}
            >
              <IconCamera className="h-3.5 w-3.5" />
              更換
            </button>
            <button
              type="button"
              aria-label={`移除${label}`}
              className="btn btn-sm bg-black/55 text-white backdrop-blur hover:bg-black/70"
              onClick={() => onChange(undefined)}
            >
              <IconX className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => void accept(e.target.files?.[0])}
      />

      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
