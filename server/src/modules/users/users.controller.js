const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

export function createUsersController({ usersService }) {
  return {
    async getMe(req, res) {
      ok(res, { user: await usersService.getMe(req.user.id) });
    },
    async updateMe(req, res) {
      ok(res, { user: await usersService.updateMe(req.user.id, req.valid.body) });
    },
    async listAddresses(req, res) {
      ok(res, await usersService.listAddresses(req.user.id));
    },
    async addAddress(req, res) {
      ok(res, await usersService.addAddress(req.user.id, req.valid.body), 201);
    },
    async updateAddress(req, res) {
      const { addressId } = req.valid.params;
      ok(res, await usersService.updateAddress(req.user.id, addressId, req.valid.body));
    },
    async deleteAddress(req, res) {
      await usersService.deleteAddress(req.user.id, req.valid.params.addressId);
      ok(res, { deleted: true });
    },
  };
}
