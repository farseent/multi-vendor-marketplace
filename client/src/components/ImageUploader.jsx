import { useState } from 'react';
import { uploadImage } from '../lib/uploads.js';
import { Alert, Icon } from './ui';
import { cx } from './ui/classes.js';

const MAX_IMAGES = 6;

/** Controlled list of product images: { key, url, alt? }. Uploads happen as files are chosen. */
export default function ImageUploader({ images, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const onPick = async (event) => {
    const files = Array.from(event.target.files ?? []).slice(0, MAX_IMAGES - images.length);
    event.target.value = ''; // allow picking the same file again
    if (files.length === 0) return;
    setError(null);
    setBusy(true);
    const added = [];
    try {
      for (const file of files) added.push(await uploadImage(file)); // one at a time, in order
    } catch (err) {
      setError(err); // images that did upload before the failure are still kept below
    } finally {
      setBusy(false);
      if (added.length > 0) onChange([...images, ...added]);
    }
  };

  const remove = (key) => onChange(images.filter((img) => img.key !== key));

  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium text-slate-700">
        Images ({images.length}/{MAX_IMAGES})
      </legend>
      <p className="mb-3 text-xs text-slate-500">The first image is shown on product cards.</p>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {images.map((img, index) => (
          <li key={img.key} className="group relative">
            <div className="aspect-square overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
              {img.url ? (
                <img src={img.url} alt={img.alt ?? `Product image ${index + 1}`} className="size-full object-cover" />
              ) : (
                <span className="grid size-full place-items-center break-all p-2 text-center text-xs text-slate-500">
                  {img.key}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => remove(img.key)}
              aria-label={`Remove image ${index + 1}`}
              className="absolute right-1.5 top-1.5 grid size-8 place-items-center rounded-full bg-white/95 text-slate-600 shadow-sm ring-1 ring-slate-200 transition hover:text-red-600"
            >
              <Icon name="x" className="size-4" />
            </button>
            {index === 0 && (
              <span className="absolute bottom-1.5 left-1.5 rounded bg-slate-900/80 px-1.5 py-0.5 text-[11px] font-medium text-white">
                Main
              </span>
            )}
          </li>
        ))}
        {images.length < MAX_IMAGES && (
          <li>
            <label
              className={cx(
                'flex aspect-square cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-2 text-center text-xs text-slate-600 transition-colors hover:border-brand-400 hover:bg-brand-50/40 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-brand-600',
                busy && 'pointer-events-none opacity-60',
              )}
            >
              <Icon name="upload" className="size-6 text-slate-400" />
              <span className="font-medium text-slate-700">{busy ? 'Uploading…' : 'Add images'}</span>
              <span>JPEG, PNG or WebP, up to 5 MB each</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                disabled={busy}
                onChange={onPick}
                className="sr-only"
              />
            </label>
          </li>
        )}
      </ul>
      {busy && (
        <p role="status" className="mt-3 text-sm text-slate-600">
          Uploading…
        </p>
      )}
      {error && (
        <Alert tone="danger" className="mt-3">
          {error.message}
        </Alert>
      )}
    </fieldset>
  );
}