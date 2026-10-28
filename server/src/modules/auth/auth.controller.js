import { REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH } from '../../config/constants.js';

/** HTTP only: reads the request, calls the service, sets cookies, shapes the envelope. */
export function createAuthController({ authService, config }) {
  const cookieOptions = {
    httpOnly: true, // not readable by JavaScript, so XSS cannot steal it
    secure: config.cookie.secure,
    sameSite: config.cookie.sameSite,
    path: REFRESH_COOKIE_PATH,
  };

  const meta = (req) => ({ ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 200) });

  const sendSession = (res, status, session) => {
    res.cookie(REFRESH_COOKIE_NAME, session.refreshToken, {
      ...cookieOptions,
      expires: session.refreshExpiresAt,
    });
    res.status(status).json({
      success: true,
      data: { user: session.user, accessToken: session.accessToken },
    });
  };

  const registerAs = (role) => async (req, res) =>
    sendSession(res, 201, await authService.register(req.valid.body, role, meta(req)));

  return {
    register: registerAs('customer'),
    registerVendor: registerAs('vendor'),

    async login(req, res) {
      sendSession(res, 200, await authService.login(req.valid.body, meta(req)));
    },

    async refresh(req, res) {
      sendSession(
        res,
        200,
        await authService.refresh(req.cookies?.[REFRESH_COOKIE_NAME], meta(req)),
      );
    },

    async logout(req, res) {
      await authService.logout(req.cookies?.[REFRESH_COOKIE_NAME]);
      res.clearCookie(REFRESH_COOKIE_NAME, cookieOptions);
      res.json({ success: true, data: { loggedOut: true } });
    },

    async me(req, res) {
      res.json({ success: true, data: { user: await authService.getUser(req.user.id) } });
    },

    async changePassword(req, res) {
      await authService.changePassword(
        req.user.id,
        req.valid.body,
        req.cookies?.[REFRESH_COOKIE_NAME],
      );
      res.json({ success: true, data: { changed: true } });
    },
  };
}
