import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import {
  canEditReview,
  createReview,
  deleteReview,
  fetchMyReview,
  fetchReviews,
  myReviewKey,
  ratingSummaryText,
  reviewErrorMessage,
  reviewsKey,
  updateReview,
  validateReviewForm,
} from '../lib/reviews.js';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, Field, Input, Pagination, PageLoading, Stars, Textarea } from './ui';
import { linkClasses } from './ui/classes.js';

const formatDate = (value) => new Date(value).toLocaleDateString('en-IN', { dateStyle: 'medium' });

/** Create or edit form. The server re-checks everything; this only catches mistakes early. */
function ReviewForm({ review, onSubmit, onCancel, pending, serverError }) {
  const [rating, setRating] = useState(review?.rating ?? 0);
  const [title, setTitle] = useState(review?.title ?? '');
  const [body, setBody] = useState(review?.body ?? '');
  const [errors, setErrors] = useState({});

  function submit(event) {
    event.preventDefault();
    const result = validateReviewForm({ rating, title, body });
    setErrors(result.errors ?? {});
    if (result.value) onSubmit(result.value);
  }

  return (
    <form className="max-w-xl space-y-4" onSubmit={submit} noValidate>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-slate-700">Your rating</legend>
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className="cursor-pointer">
              <input
                type="radio"
                name="rating"
                value={n}
                checked={rating === n}
                onChange={() => setRating(n)}
                className="peer sr-only"
              />
              <span className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition-colors peer-checked:border-brand-600 peer-checked:bg-brand-600 peer-checked:text-white peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-600 hover:border-slate-400">
                {n} {n === 1 ? 'star' : 'stars'}
              </span>
            </label>
          ))}
        </div>
        {errors.rating && (
          <p role="alert" className="mt-1.5 text-xs font-medium text-red-600">
            {errors.rating}
          </p>
        )}
      </fieldset>
      <Field label="Title (optional)" error={errors.title}>
        <Input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Your review" error={errors.body}>
        <Textarea rows={5} value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} />
      </Field>
      {serverError && <Alert tone="danger">{reviewErrorMessage(serverError)}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={pending}>
          {pending ? 'Saving…' : review ? 'Save changes' : 'Post review'}
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/** The signed-in customer's own part: write, edit or delete a review of this product. */
function MyReview({ productId, slug }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { data, error, isPending } = useQuery({
    queryKey: myReviewKey(productId),
    queryFn: () => fetchMyReview(productId),
    retry: false,
  });

  // A review changes the product's average and the list: refresh all three.
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: myReviewKey(productId) });
    queryClient.invalidateQueries({ queryKey: ['reviews', productId] });
    queryClient.invalidateQueries({ queryKey: ['product', slug] });
  };
  const save = useMutation({
    mutationFn: (value) =>
      data.review ? updateReview(data.review.id, value) : createReview(productId, value),
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteReview(data.review.id),
    onSettled: () => {
      setConfirmDelete(false);
      refresh();
    },
  });

  if (isPending) return null;
  if (error) return null; // not a customer, or the lookup failed: the public list still works
  const { eligible, review } = data;

  if (!review) {
    if (!eligible) {
      return (
        <p className="rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-600">
          Only customers who received this product can review it.
        </p>
      );
    }
    return (
      <Card as="section" aria-label="Write a review">
        <h3 className="mb-4 text-base font-semibold text-slate-900">Write a review</h3>
        <ReviewForm
          onSubmit={(value) => save.mutate(value)}
          pending={save.isPending}
          serverError={save.error}
        />
      </Card>
    );
  }

  return (
    <Card as="section" aria-label="Your review" className="border-brand-200 bg-brand-50/40">
      <h3 className="mb-3 text-base font-semibold text-slate-900">Your review</h3>
      {review.status === 'hidden' && (
        <Alert tone="warning" className="mb-3">
          This review is hidden by a moderator and is not shown to other shoppers.
        </Alert>
      )}
      {editing ? (
        <ReviewForm
          review={review}
          onSubmit={(value) => save.mutate(value)}
          onCancel={() => setEditing(false)}
          pending={save.isPending}
          serverError={save.error}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Stars rating={review.rating} />
            {review.title && <strong className="text-sm text-slate-900">{review.title}</strong>}
          </div>
          <p className="mt-2 whitespace-pre-line text-sm text-slate-700">{review.body}</p>
          {remove.error && (
            <Alert tone="danger" className="mt-3">
              {reviewErrorMessage(remove.error)}
            </Alert>
          )}
          {canEditReview(review) ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button variant="danger-outline" size="sm" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            </div>
          ) : (
            <p className="mt-3 text-xs text-slate-500">Reviews can be changed for 30 days after posting.</p>
          )}
          <ConfirmDialog
            open={confirmDelete}
            title="Delete your review?"
            message="This removes your review and updates the product's rating."
            confirmLabel="Delete review"
            pending={remove.isPending}
            onConfirm={() => remove.mutate()}
            onCancel={() => setConfirmDelete(false)}
          />
        </>
      )}
    </Card>
  );
}

/** Rating summary, the public review list, and the customer's own review form. */
export default function ReviewsSection({ product }) {
  const { status, user } = useAuth();
  const [page, setPage] = useState(1);
  const { data, error, isPending } = useQuery({
    queryKey: reviewsKey(product.id, page),
    queryFn: () => fetchReviews(product.id, { page }),
    placeholderData: (previous) => previous,
  });

  return (
    <section id="reviews" className="mt-14 max-w-3xl border-t border-slate-200 pt-10" aria-labelledby="reviews-heading">
      <h2 id="reviews-heading" className="text-xl font-semibold tracking-tight text-slate-900">
        Customer reviews
      </h2>
      <div className="mt-3 flex items-center gap-3">
        {product.ratingCount > 0 && (
          <>
            <span className="tabular text-3xl font-semibold text-slate-900">
              {product.ratingAvg.toFixed(1)}
            </span>
            <Stars rating={product.ratingAvg.toFixed(1)} className="[&_svg]:size-5" />
          </>
        )}
        <p className="text-sm text-slate-600">{ratingSummaryText(product.ratingAvg, product.ratingCount)}</p>
      </div>

      <div className="mt-6 space-y-4">
        {status === 'authenticated' && user.role === 'customer' && (
          <MyReview productId={product.id} slug={product.slug} />
        )}
        {status === 'anonymous' && (
          <p className="rounded-lg bg-slate-100 px-4 py-3 text-sm text-slate-600">
            <Link to="/login" state={{ from: `/products/${product.slug}` }} className={linkClasses}>
              Log in
            </Link>{' '}
            to review products you have received.
          </p>
        )}
      </div>

      <div className="mt-6">
        {isPending && <PageLoading label="Loading reviews…" className="py-8" />}
        {error && <Alert tone="danger">Reviews could not be loaded.</Alert>}
        {data && data.items.length === 0 && (
          <EmptyState icon="message" title="No reviews yet" description="Be the first to share what you think once you have received this product." />
        )}
        {data && data.items.length > 0 && (
          <>
            <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white shadow-card">
              {data.items.map((review) => (
                <li key={review.id} className="p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Stars rating={review.rating} />
                    {review.title && <strong className="text-sm text-slate-900">{review.title}</strong>}
                  </div>
                  <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-700">{review.body}</p>
                  <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                    <span className="font-medium text-slate-700">{review.authorName}</span>
                    <span>{formatDate(review.createdAt)}</span>
                    <Badge tone="success">Verified purchase</Badge>
                  </p>
                </li>
              ))}
            </ul>
            <Pagination meta={data.meta} onPage={setPage} label="Review pages" />
          </>
        )}
      </div>
    </section>
  );
}