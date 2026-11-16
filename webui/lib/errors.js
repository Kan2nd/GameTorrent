'use strict';

/** An error whose message is safe to show the user, with the HTTP status to send. */
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || null;
  }
}

const badRequest = (msg) => new HttpError(400, msg);
const forbidden = (msg) => new HttpError(403, msg);
const notFound = (msg) => new HttpError(404, msg);
const conflict = (msg) => new HttpError(409, msg);

module.exports = { HttpError, badRequest, forbidden, notFound, conflict };
