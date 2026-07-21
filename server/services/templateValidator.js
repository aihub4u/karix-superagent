/**
 * Validates a Karix-shaped template payload BEFORE it's sent to the API.
 *
 * Since this platform auto-submits on user approval (no human review step),
 * catching mistakes here is what protects the client's daily/monthly edit
 * quota and 100/hr creation cap from being burned on preventable rejections.
 *
 * Rules below are taken directly from the Karix RCM Template API docs.
 * Returns { valid: boolean, errors: string[], warnings: string[] }.
 */

const VALID_CATEGORIES = ['AUTHENTICATION', 'UTILITY', 'MARKETING'];
const VALID_HEADER_FORMATS = ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'];
const VALID_BUTTON_TYPES = [
  'QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'COPY_CODE', 'OTP', 'ORDER_DETAILS',
];
const NAME_MAX = 512;
const BODY_MAX = 1024;
const AUTOFILL_TEXT_MAX = 25;

function validateTemplate(spec) {
  const errors = [];
  const warnings = [];

  if (!spec.template_name && !spec.name) {
    errors.push('template_name (or name) is required.');
  }
  const name = spec.template_name || spec.name || '';
  if (name.length > NAME_MAX) {
    errors.push(`template_name exceeds ${NAME_MAX} characters (got ${name.length}).`);
  }
  if (name && !/^[a-z0-9_]+$/.test(name)) {
    warnings.push('template_name should typically be lowercase letters, numbers, and underscores only.');
  }

  if (!spec.language) errors.push('language is required (e.g. en, en_US, en_GB).');

  if (!spec.category) {
    errors.push('category is required.');
  } else if (!VALID_CATEGORIES.includes(spec.category)) {
    errors.push(`category must be one of ${VALID_CATEGORIES.join(', ')} (got "${spec.category}"). ` +
      'Legacy values TRANSACTIONAL/OTP/MARKETING are auto-mapped by Karix, but prefer the new enum.');
  }

  if (!Array.isArray(spec.components) || spec.components.length === 0) {
    errors.push('components array is required and must not be empty.');
    return { valid: false, errors, warnings };
  }

  let bodyCount = 0;
  let totalBodyChars = 0;

  for (const c of spec.components) {
    switch (c.type) {
      case 'HEADER': {
        if (c.format && !VALID_HEADER_FORMATS.includes(c.format)) {
          errors.push(`HEADER format "${c.format}" is invalid. Must be one of ${VALID_HEADER_FORMATS.join(', ')}.`);
        }
        if (c.format === 'TEXT' && !c.text) {
          errors.push('HEADER with format TEXT must include text.');
        }
        if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(c.format)) {
          const handle = c.example && c.example.header_handle;
          if (!handle || !handle.length) {
            errors.push(
              `HEADER format ${c.format} requires example.header_handle — ` +
              'call karixClient.uploadMedia() first and pass the returned handle here.'
            );
          }
        }
        break;
      }
      case 'BODY': {
        bodyCount += 1;
        if (!c.text) {
          errors.push('BODY component must include text.');
        } else {
          totalBodyChars += c.text.length;
          if (c.text.length > BODY_MAX) {
            errors.push(`BODY text exceeds ${BODY_MAX} characters (got ${c.text.length}).`);
          }
          const placeholders = [...c.text.matchAll(/{{\s*([\w]+)\s*}}/g)].map((m) => m[1]);
          if (placeholders.length > 0) {
            const examples = c.example && c.example.body_text;
            const namedExamples = c.example && c.example.body_text_named_params;
            if (!examples && !namedExamples) {
              errors.push(
                `BODY text has placeholders (${placeholders.join(', ')}) but no "example" block. ` +
                'Meta requires example values for every variable or the template will be rejected.'
              );
            }
          }
        }
        break;
      }
      case 'FOOTER': {
        if (!c.text) errors.push('FOOTER component must include text.');
        break;
      }
      case 'BUTTONS': {
        if (!Array.isArray(c.buttons) || c.buttons.length === 0) {
          errors.push('BUTTONS component must include a non-empty buttons array.');
          break;
        }
        for (const b of c.buttons) {
          if (!VALID_BUTTON_TYPES.includes(b.type)) {
            errors.push(`Button type "${b.type}" is invalid. Must be one of ${VALID_BUTTON_TYPES.join(', ')}.`);
          }
          if (b.type === 'URL' && !b.url) errors.push('URL button must include a url.');
          if (b.type === 'PHONE_NUMBER' && !b.phone_number) errors.push('PHONE_NUMBER button must include phone_number.');
          if (b.type === 'COPY_CODE' && (!b.example || !b.example.length)) {
            errors.push('COPY_CODE button must include an example code value.');
          }
        }
        if (c.buttons.length > 10) warnings.push('More than 10 buttons is unusual — double check WhatsApp limits for this button mix.');
        break;
      }
      case 'CAROUSEL': {
        if (!Array.isArray(c.cards) || c.cards.length === 0) {
          errors.push('CAROUSEL component must include a non-empty cards array.');
        }
        break;
      }
      case 'LIMITED_TIME_OFFER':
      case 'Limited_time_offer': {
        if (!c.limited_time_offer && !c.Limited_time_offer) {
          errors.push('LIMITED_TIME_OFFER component must include limited_time_offer.text.');
        }
        break;
      }
      default:
        warnings.push(`Component type "${c.type}" is not one of the documented types — passing through as-is.`);
    }
  }

  if (bodyCount === 0) errors.push('At least one BODY component is required.');
  if (bodyCount > 1) errors.push('Only one BODY component is allowed.');

  // Category-specific rules from the docs
  if (spec.category === 'AUTHENTICATION') {
    const hasMedia = spec.components.some((c) => c.type === 'HEADER' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(c.format));
    if (hasMedia) errors.push('AUTHENTICATION templates cannot use a media header (Image/Video/Document).');
  }

  // Autofill button text length
  for (const c of spec.components) {
    if (c.type === 'BUTTONS' && Array.isArray(c.buttons)) {
      for (const b of c.buttons) {
        if (b.autofill_text && b.autofill_text.length > AUTOFILL_TEXT_MAX) {
          errors.push(`Autofill button text exceeds ${AUTOFILL_TEXT_MAX} characters.`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Checks whether a template is currently eligible for editing, per Karix's
 * "Approved/Rejected/Paused only, 1x/day, 10x/30days" rule.
 */
function canEdit(templateRow) {
  if (!['approved', 'rejected', 'paused'].includes(templateRow.status)) {
    return { allowed: false, reason: `Template status is "${templateRow.status}" — edits only allowed when Approved, Rejected, or Paused.` };
  }
  if (templateRow.last_edited_at) {
    const hoursSince = (Date.now() - new Date(templateRow.last_edited_at).getTime()) / 3_600_000;
    if (hoursSince < 24) {
      return { allowed: false, reason: 'This template was already edited within the last 24 hours (max 1 edit/day).' };
    }
  }
  if (templateRow.status === 'approved' && templateRow.edit_count_30d >= 10) {
    return { allowed: false, reason: 'Approved templates can only be edited 10 times per 30-day window — limit reached.' };
  }
  return { allowed: true };
}

module.exports = { validateTemplate, canEdit, VALID_CATEGORIES, VALID_HEADER_FORMATS, VALID_BUTTON_TYPES };
