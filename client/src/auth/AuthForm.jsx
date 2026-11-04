import { useState } from 'react';
import { Alert } from '../components/ui';

/** Shows an ApiError as one message plus any per-field problems the server returned. */
export function FormError({ error }) {
  if (!error) return null;
  const fields = Array.isArray(error.details) ? error.details : [];
  return (
    <Alert tone="danger">
      <p>{error.message}</p>
      {fields.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {fields.map((d, i) => (
            <li key={`${d.path}-${i}`}>{d.message}</li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

/** Small form wrapper: tracks "submitting" and the last error so pages stay short. */
export function useSubmit(action) {
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await action(new FormData(event.currentTarget));
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };
  return { error, submitting, onSubmit };
}
