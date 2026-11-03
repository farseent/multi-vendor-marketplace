import { describe, expect, it } from 'vitest';
import {
  canEditReview,
  ratingSummaryText,
  reviewErrorMessage,
  stars,
  validateReviewForm,
} from './reviews.js';

const GOOD = { rating: 4, title: ' Nice ', body: '  Comfortable and well made.  ' };

describe('validateReviewForm', () => {
  it('trims text and builds the request body (rating as a number)', () => {
    expect(validateReviewForm({ ...GOOD, rating: '4' })).toEqual({
      value: { rating: 4, title: 'Nice', body: 'Comfortable and well made.' },
    });
  });

  it('omits an empty title', () => {
    expect(validateReviewForm({ ...GOOD, title: '   ' }).value).toEqual({
      rating: 4,
      body: 'Comfortable and well made.',
    });
  });

  it.each([
    ['no rating', { ...GOOD, rating: '' }, 'rating'],
    ['rating 0', { ...GOOD, rating: 0 }, 'rating'],
    ['rating 6', { ...GOOD, rating: 6 }, 'rating'],
    ['half star', { ...GOOD, rating: 3.5 }, 'rating'],
    ['short body', { ...GOOD, body: 'too short' }, 'body'],
    ['spaces only', { ...GOOD, body: ' '.repeat(30) }, 'body'],
    ['long body', { ...GOOD, body: 'x'.repeat(2001) }, 'body'],
    ['long title', { ...GOOD, title: 'x'.repeat(101) }, 'title'],
  ])('%s -> error on %s', (_name, form, field) => {
    const result = validateReviewForm(form);
    expect(result.value).toBeUndefined();
    expect(result.errors[field]).toBeTruthy();
  });
});

describe('display helpers', () => {
  it('stars', () => {
    expect(stars(5)).toBe('★★★★★');
    expect(stars(2)).toBe('★★☆☆☆');
  });

  it('ratingSummaryText', () => {
    expect(ratingSummaryText(0, 0)).toBe('No reviews yet');
    expect(ratingSummaryText(4.6, 12)).toBe('4.6 out of 5 (12 reviews)');
    expect(ratingSummaryText(5, 1)).toBe('5.0 out of 5 (1 review)');
  });

  it('canEditReview follows editableUntil', () => {
    const now = Date.parse('2026-11-03T00:00:00Z');
    expect(canEditReview({ editableUntil: '2026-11-10T00:00:00Z' }, now)).toBe(true);
    expect(canEditReview({ editableUntil: '2026-11-02T00:00:00Z' }, now)).toBe(false);
    expect(canEditReview(null, now)).toBe(false);
  });

  it('reviewErrorMessage', () => {
    expect(reviewErrorMessage({ code: 'REVIEW_EXISTS', status: 409 })).toMatch(/already reviewed/);
    expect(reviewErrorMessage({ status: 403 })).toMatch(/delivered order/);
    expect(reviewErrorMessage({ status: 409, details: { reason: 'edit_window_closed' } })).toMatch(
      /30 days/,
    );
    expect(reviewErrorMessage({ status: 404 })).toMatch(/no longer exists/);
    expect(reviewErrorMessage({ message: 'Cannot reach the server' })).toBe(
      'Cannot reach the server',
    );
  });
});
