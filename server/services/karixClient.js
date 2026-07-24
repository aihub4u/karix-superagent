/**
 * Karix RCM Template API adapter.
 *
 * Built directly from Karix's "Karix RCM Template API For WhatsApp" Postman docs.
 * Endpoints, headers, and payload shapes below are taken verbatim from that spec.
 *
 * IMPORTANT — things to verify against a live sandbox before going to production:
 *   1. The docs show the auth header key as literally "Authentication: Bearer {token}"
 *      in most examples, but a couple of later pages show "Authorization: Bearer {token}".
 *      Try Authentication first (per the primary spec section); fall back to Authorization
 *      if you get 401s. See AUTH_HEADER_NAME below — flip it in one place if needed.
 *   2. Success/error response BODIES are not documented beyond status codes
 *      (200/201 success; 1001/1003/1004/1005/1007/1010 = specific errors).
 *      This client does not assume a response shape — it returns the raw parsed body
 *      plus the HTTP status, so callers can inspect what actually comes back and we
 *      can tighten this up after the first real call.
 */

const fetch = require('node-fetch');
const FormData = require('form-data');

const AUTH_HEADER_NAME = 'Authentication'; // flip to 'Authorization' if Karix rejects this

const HOSTS = {
  india: 'https://rcsgui.karix.solutions',
  uae: 'https://rcsgui.karix.ae',
};

class KarixApiError extends Error {
  constructor(message, { status, body, endpoint } = {}) {
    super(message);
    this.name = 'KarixApiError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

class KarixClient {
  /**
   * @param {object} opts
   * @param {string} opts.token   Karix bearer token for this WABA (decrypted, per-tenant)
   * @param {string} opts.wabaId  WhatsApp Business Account ID
   * @param {'india'|'uae'} [opts.region]
   */
  constructor({ token, wabaId, region = 'india' }) {
    if (!token) throw new Error('KarixClient requires a token');
    if (!wabaId) throw new Error('KarixClient requires a wabaId');
    this.token = token;
    this.wabaId = wabaId;
    this.host = HOSTS[region] || HOSTS.india;
  }

  _headers(extra = {}) {
    return {
      [AUTH_HEADER_NAME]: `Bearer ${this.token}`,
      ...extra,
    };
  }

  async _request(method, path, { json, form, query } = {}) {
    let url = `${this.host}${path}`;
    if (query) {
      const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined));
      const qsStr = qs.toString();
      if (qsStr) url += `?${qsStr}`;
    }

    const init = { method, headers: this._headers() };

    if (json) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (form) {
      // form-data sets its own multipart headers (with boundary)
      init.body = form;
      Object.assign(init.headers, form.getHeaders());
    }

    const res = await fetch(url, init);
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text; // Karix may return plain text on some errors
    }

    if (!res.ok) {
      throw new KarixApiError(`Karix API ${method} ${path} failed with ${res.status}`, {
        status: res.status,
        body,
        endpoint: path,
      });
    }

    return { status: res.status, body };
  }

  // ---- Create Template -----------------------------------------------
  // POST /api/v1.0/template/{wabaId}
  // payload shape per docs:
  // {
  //   template_name, language, category,
  //   components: [ {type: HEADER|BODY|FOOTER|BUTTONS|CAROUSEL|LIMITED_TIME_OFFER, ...} ],
  //   allow_category_change?: bool,
  //   alt_temp_body?: string, enable_backup?: "true"|"false",
  //   webhook?: { url },
  //   bid_spec?: { bid_amount, bid_strategy },
  //   sub_category?: "ORDER_STATUS" (utility order templates)
  // }
  async createTemplate(payload) {
    return this._request('POST', `/api/v1.0/template/${this.wabaId}`, { json: payload });
  }

  // ---- Get Templates (list, with filters) ------------------------------
  // GET /api/v1.0/template/{wabaId}?from&to&status&page&name
  async listTemplates({ from, to, status, page, name } = {}) {
    return this._request('GET', `/api/v1.0/template/${this.wabaId}`, {
      query: { from, to, status, page, name },
    });
  }

  // ---- Get Template by ID ----------------------------------------------
  // GET /api/v1.0/template/{wabaId}/{templateId}
  async getTemplate(templateId) {
    return this._request('GET', `/api/v1.0/template/${this.wabaId}/${templateId}`);
  }

  // ---- Edit Template -----------------------------------------------------
  // POST /api/v1.0/template/{wabaId}/edit/{templateId}?allowCategoryChange=true
  // Note: edit REPLACES components entirely — include everything you want to keep.
  // Only allowed when template status is Approved / Rejected / Paused.
  async editTemplate(templateId, { components, alt_temp_body, edit_alt_body }, { allowCategoryChange = true } = {}) {
    const payload = { components };
    if (alt_temp_body !== undefined) payload.alt_temp_body = alt_temp_body;
    if (edit_alt_body !== undefined) payload.edit_alt_body = edit_alt_body;

    return this._request('POST', `/api/v1.0/template/${this.wabaId}/edit/${templateId}`, {
      json: payload,
      query: { allowCategoryChange },
    });
  }

  // ---- Delete Template ----------------------------------------------------
  // DELETE /api/v1.0/template/{wabaId}/{templateId}
  async deleteTemplate(templateId) {
    return this._request('DELETE', `/api/v1.0/template/${this.wabaId}/${templateId}`);
  }

  // ---- Create File Handle (media upload for header) -----------------------
  // POST /api/v1.0/template/{wabaId}/media   (multipart/form-data: file, file_type)
  //
  // file_type = category (image/video/document), per the doc's parameter
  // table. NOTE: an earlier version of this code sent the actual MIME type
  // instead (e.g. "image/jpeg"), based on a worked example elsewhere in the
  // doc that showed that format — that turned out to be wrong. A real call
  // with the category value successfully returned a fileHandle; switching
  // to the MIME-type value caused Karix's own layer to reject the upload
  // outright ("Not able to Process the file", before ever reaching Meta).
  // Reverted to the category form, which is confirmed working for the
  // upload step itself. The separate, still-unsolved issue is that Meta
  // rejects the resulting handle at template-creation time with "file type
  // not supported" — that's a different step and needs its own diagnosis;
  // don't conflate the two.
  //
  // Returns a header_handle string to reference in the HEADER component's
  // `example.header_handle` array when creating/editing a template.
  async uploadMedia({ buffer, filename, mimeType, category }) {
    if (!['image', 'video', 'document'].includes(category)) {
      throw new Error(`Invalid category "${category}" — must be image, video, or document`);
    }
    const form = new FormData();
    form.append('file', buffer, { filename, contentType: mimeType });
    form.append('file_type', category);

    return this._request('POST', `/api/v1.0/template/${this.wabaId}/media`, { form });
  }
}

module.exports = { KarixClient, KarixApiError };
