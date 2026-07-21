/**
 * Wraps an async Express route handler so a thrown/rejected error is passed
 * to next(err) instead of becoming an unhandled promise rejection.
 *
 * Node terminates the process on unhandled rejections by default (since
 * Node 15) — inside an async Express handler with no try/catch, a failed
 * DB query or API call doesn't just fail that one request, it can take the
 * whole server down, and Render's proxy reports that to the client as a
 * bare 502 with no body. Wrap every async route with this.
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
