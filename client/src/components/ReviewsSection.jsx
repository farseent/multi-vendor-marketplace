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
  stars,
  updateReview,
  validateReviewForm,
} from '../lib/reviews.js';
import './reviews.css';

const formatDate = (value) => new Date(value).toLocaleDateString('en-IN', { dateStyle: 'medium' });

function Stars({ rating }) {
  return (
    <span className="review-stars" role="img" aria-label={`${rating} out of 5 stars`}>
      {stars(rating)}
    </span>
  );
}

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
    <form className="review-form" onSubmit={submit} noValidate>
      <fieldset>
        <legend>Your rating</legend>
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className="review-star-choice">
            <input
              type="radio"
              name="rating"
              value={n}
              checked={rating === n}
              onChange={() => setRating(n)}
            />
            {n} {n === 1 ? 'star' : 'stars'}
          </label>
        ))}
        {errors.rating && <p role="alert">{errors.rating}</p>}
      </fieldset>
      <label>
        Title (optional)
        <input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
      </label>
      {errors.title && <p role="alert">{errors.title}</p>}
      <label>
        Your review
        <textarea
          rows={5}
          value={body}
          maxLength={2000}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      {errors.body && <p role="alert">{errors.body}</p>}
      {serverError && <p role="alert">{reviewErrorMessage(serverError)}</p>}
      <div className="review-actions">
        <button type="submit" disabled={pending}>
          {pending ? 'Saving…' : review ? 'Save changes' : 'Post review'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/** The signed-in customer's own part: write, edit or delete a review of this product. */
function MyReview({ productId, slug }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
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
    onSettled: refresh,
  });

  if (isPending) return null;
  if (error) return null; // not a customer, or the lookup failed: the public list still works
  const { eligible, review } = data;

  if (!review) {
    if (!eligible) {
      return <p className="review-hint">Only customers who received this product can review it.</p>;
    }
    return (
      <section aria-label="Write a review">
        <h3>Write a review</h3>
        <ReviewForm
          onSubmit={(value) => save.mutate(value)}
          pending={save.isPending}
          serverError={save.error}
        />
      </section>
    );
  }

  return (
    <section aria-label="Your review" className="review-own">
      <h3>Your review</h3>
      {review.status === 'hidden' && (
        <p role="status" className="notice">
          This review is hidden by a moderator and is not shown to other shoppers.
        </p>
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
          <p>
            <Stars rating={review.rating} /> {review.title && <strong>{review.title}</strong>}
          </p>
          <p>{review.body}</p>
          {remove.error && <p role="alert">{reviewErrorMessage(remove.error)}</p>}
          {canEditReview(review) ? (
            <div className="review-actions">
              <button type="button" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button
                type="button"
                className="danger"
                disabled={remove.isPending}
                onClick={() => {
                  if (window.confirm('Delete your review?')) remove.mutate();
                }}
              >
                {remove.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          ) : (
            <p className="review-hint">Reviews can be changed for 30 days after posting.</p>
          )}
        </>
      )}
    </section>
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
    <section className="reviews" aria-labelledby="reviews-heading">
      <h2 id="reviews-heading">Reviews</h2>
      <p>{ratingSummaryText(product.ratingAvg, product.ratingCount)}</p>

      {status === 'authenticated' && user.role === 'customer' && (
        <MyReview productId={product.id} slug={product.slug} />
      )}
      {status === 'anonymous' && (
        <p className="review-hint">
          <Link to="/login">Log in</Link> to review products you have received.
        </p>
      )}

      {isPending && <p>Loading reviews…</p>}
      {error && <p role="alert">Reviews could not be loaded.</p>}
      {data && (
        <>
          <ul className="review-list">
            {data.items.map((review) => (
              <li key={review.id}>
                <p>
                  <Stars rating={review.rating} /> {review.title && <strong>{review.title}</strong>}
                </p>
                <p>{review.body}</p>
                <small>
                  {review.authorName} · {formatDate(review.createdAt)} · Verified purchase
                </small>
              </li>
            ))}
          </ul>
          {data.meta.totalPages > 1 && (
            <nav aria-label="Review pages" className="review-actions">
              <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <span>
                Page {data.meta.page} of {data.meta.totalPages}
              </span>
              <button
                type="button"
                disabled={page >= data.meta.totalPages}
                onClick={() => setPage(page + 1)}
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
