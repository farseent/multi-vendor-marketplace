import { useState } from 'react';
import { uploadImage } from '../lib/uploads.js';

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
    <fieldset className="image-uploader">
      <legend>
        Images ({images.length}/{MAX_IMAGES})
      </legend>
      <ul className="thumbs">
        {images.map((img) => (
          <li key={img.key}>
            {img.url ? (
              <img src={img.url} alt={img.alt ?? ''} width="96" height="96" />
            ) : (
              <span>{img.key}</span>
            )}
            <button type="button" onClick={() => remove(img.key)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {images.length < MAX_IMAGES && (
        <label>
          Add images (JPEG, PNG or WebP, up to 5 MB each)
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={busy}
            onChange={onPick}
          />
        </label>
      )}
      {busy && <p role="status">Uploading…</p>}
      {error && (
        <p role="alert" className="form-error">
          {error.message}
        </p>
      )}
    </fieldset>
  );
}
