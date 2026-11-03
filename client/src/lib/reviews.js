import { apiFetch } from './api.js';

// Product reviews (Phase 7). The API enforces who may review and the 30-day edit window; these
// helpers only fetch, validate the form early and decide what to SHOW.

export const REVIEW_LIMITS = { titleMax: 100, bodyMin: 10, bodyMax: 2000 };

export const reviewsKey = (productId, page = 1) => ['reviews', productId, page];
export const myReviewKey = (productId) => ['my-review', productId];

export const fetchReviews = async (productId, { page = 1, limit = 10 } = {}) => {
  const { data, meta } = await apiFetch(
    `/products/${productId}/reviews?page=${page}&limit=${limit}`,
  );
  return { items: data, meta };
};

/** { eligible, review } for the signed-in customer (customer accounts only). */
export const fetchMyReview = async (productId) =>
  (await apiFetch(`/products/${productId}/reviews/mine`)).data;

export const createReview = (productId, body) =>
  apiFetch(`/products/${productId}/reviews`, { method: 'POST', body });

export const updateReview = (reviewId, body) =>
  apiFetch(`/reviews/${reviewId}`, { method: 'PATCH', body });

export const deleteReview = (reviewId) => apiFetch(`/reviews/${reviewId}`, { method: 'DELETE' });

/** "★★★★☆" for a whole rating; the visible text is for sighted users, the label for screen readers. */
export const stars = (rating) => '★'.repeat(rating) + '☆'.repeat(5 - rating);

/** "4.6 out of 5 (12 reviews)" or "No reviews yet". */
export function ratingSummaryText(ratingAvg, ratingCount) {
  if (!ratingCount) return 'No reviews yet';
  return `${ratingAvg.toFixed(1)} out of 5 (${ratingCount} ${ratingCount === 1 ? 'review' : 'reviews'})`;
}

/**
 * Checks the form the way the API will, so mistakes show before the request.
 * Returns { value } (ready to send) or { errors: { rating?, title?, body? } }.
 */
export function validateReviewForm({ rating, title, body }) {
  const errors = {};
  const ratingNumber = Number(rating);
  if (!Number.isInteger(ratingNumber) || ratingNumber < 1 || ratingNumber > 5) {
    errors.rating = 'Choose 1 to 5 stars.';
  }
  const cleanTitle = String(title ?? '').trim();
  if (cleanTitle.length > REVIEW_LIMITS.titleMax) {
    errors.title = `Keep the title under ${REVIEW_LIMITS.titleMax} characters.`;
  }
  const cleanBody = String(body ?? '').trim();
  if (cleanBody.length < REVIEW_LIMITS.bodyMin) {
    errors.body = `Write at least ${REVIEW_LIMITS.bodyMin} characters.`;
  } else if (cleanBody.length > REVIEW_LIMITS.bodyMax) {
    errors.body = `Keep the review under ${REVIEW_LIMITS.bodyMax} characters.`;
  }
  if (Object.keys(errors).length) return { errors };
  return {
    value: { rating: ratingNumber, ...(cleanTitle && { title: cleanTitle }), body: cleanBody },
  };
}

/** The owner can change a review until `editableUntil` (the API returns it). */
export const canEditReview = (review, now = Date.now()) =>
  Boolean(review) && new Date(review.editableUntil).getTime() > now;

export function reviewErrorMessage(error) {
  if (error?.code === 'REVIEW_EXISTS') return 'You have already reviewed this product.';
  if (error?.status === 403)
    return 'Only customers with a delivered order can review this product.';
  if (error?.details?.reason === 'edit_window_closed') {
    return 'This review can no longer be changed (30 days have passed).';
  }
  if (error?.status === 404) return 'This review no longer exists.';
  return error?.message ?? 'Something went wrong. Please try again.';
}
