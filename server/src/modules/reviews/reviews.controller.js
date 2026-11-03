const ok = (res, data, status = 200, meta) =>
  res.status(status).json({ success: true, data, ...(meta && { meta }) });

// Customer actions always act on req.user.id, so a customer can only reach their own reviews.
export function createReviewsController({ reviewsService }) {
  return {
    async list(req, res) {
      const { items, meta } = await reviewsService.listPublic(
        req.valid.params.productId,
        req.valid.query,
      );
      ok(res, items, 200, meta);
    },
    async mine(req, res) {
      ok(res, await reviewsService.mine(req.user.id, req.valid.params.productId));
    },
    async create(req, res) {
      const review = await reviewsService.create(
        req.user.id,
        req.valid.params.productId,
        req.valid.body,
      );
      ok(res, review, 201);
    },
    async update(req, res) {
      ok(res, await reviewsService.update(req.user.id, req.valid.params.reviewId, req.valid.body));
    },
    async remove(req, res) {
      ok(res, await reviewsService.remove(req.user.id, req.valid.params.reviewId));
    },
    async adminSetStatus(req, res) {
      ok(
        res,
        await reviewsService.setStatus(req.user, req.valid.params.reviewId, req.valid.body.status),
      );
    },
  };
}
