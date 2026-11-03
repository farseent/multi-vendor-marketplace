export function createInvoicesController({ invoicesService }) {
  return {
    /** GET /orders/:orderId/invoice: the one non-JSON success response of the API. */
    async download(req, res) {
      const { filename, pdf } = await invoicesService.generate(
        req.user.id,
        req.valid.params.orderId,
      );
      res
        .status(200)
        .set({
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': String(pdf.length),
          // Personal data: never kept by a shared cache or the back/forward cache.
          'Cache-Control': 'private, no-store',
        })
        .end(pdf);
    },
  };
}
