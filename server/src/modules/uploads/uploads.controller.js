export function createUploadsController({ uploadsService }) {
  return {
    async presign(req, res) {
      const data = await uploadsService.presign(req.vendor.id, req.valid.body);
      res.status(201).json({ success: true, data });
    },
  };
}
