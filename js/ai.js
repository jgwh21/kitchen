// Reads a food label photo with Claude and returns the details to pre-fill the item form.
//
// The app calls the Claude API straight from the phone with your own API key, which is
// kept on this device only (never in shared or backup files). Plain fetch is used rather
// than the Anthropic SDK because the app has no build step to bundle it with.

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';

export const MODELS = {
  'claude-opus-5-5': 'Claude Opus 5.5 (most accurate, about 1p a photo)',
  'claude-haiku-5-5': 'Claude Haiku 5.5 (faster, a fraction of a penny)',
};
export const DEFAULT_MODEL = 'claude-opus-5-5';
// Server-side fallback (retry on another model if a request is declined) is offered on Opus only.
const FALLBACK_MODELS = new Set(['claude-opus-5-5']);

export class AiError extends Error {}

function schema(types) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['readable', 'name', 'brand', 'type', 'quantity', 'unit', 'expiry', 'expiry_kind', 'notes'],
    properties: {
      readable: { type: 'boolean', description: 'false if the photo shows no food or label you can read' },
      name: { type: 'string', description: 'Short product name a person would use, e.g. "Semi-skimmed milk"' },
      brand: { type: 'string', description: 'Brand or shop, or empty' },
      type: { type: 'string', enum: types },
      quantity: { type: 'string', description: 'Pack size number only, e.g. "2" or "500", or empty' },
      unit: { type: 'string', description: 'Unit for quantity: g, kg, ml, L, pcs, pack, or empty' },
      expiry: { type: 'string', description: 'Use-by or best-before date as YYYY-MM-DD, or empty if none is visible' },
      expiry_kind: { type: 'string', enum: ['use_by', 'best_before', ''] },
      notes: { type: 'string', description: 'Storage advice worth keeping, e.g. "Once opened use within 3 days", or empty' },
    },
  };
}

function prompt(today) {
  return `This is a photo of a food or drink item, usually its label, taken to add it to a home fridge/freezer/pantry inventory.
Read the label and fill in the fields. Today is ${today}.
- Dates on UK and European labels are day first: 03/11 is 3 November. If the year is missing, pick the next date on or after today that fits, unless the label suggests otherwise.
- If both a use-by and a best-before date are shown, use the use-by date.
- For "type", pick the closest category from the list.
- Leave a field empty rather than guess when it isn't on the label.`;
}

function explainHttp(status, body) {
  const msg = body?.error?.message || '';
  if (status === 401 || status === 403) return 'The Claude API key wasn\'t accepted. Check it in Settings.';
  if (status === 429) return 'Claude is busy or your usage limit was reached. Try again in a minute.';
  if (status === 400 && /credit|billing|balance/i.test(msg)) return 'Your Claude API account is out of credit. Top it up at console.anthropic.com.';
  if (status >= 500) return 'Claude is unavailable right now. Try again shortly.';
  return `Claude couldn't read the label (${status}${msg ? `: ${msg}` : ''}).`;
}

/**
 * @param {string} imageBase64  JPEG, base64 without the data: prefix
 * @param {{ apiKey: string, model: string, types: string[] }} opts
 */
export async function readLabel(imageBase64, { apiKey, model, types }) {
  if (!apiKey) throw new AiError('Add your Claude API key in Settings to read labels automatically.');
  const now = new Date();
  const today = new Date(now - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  const body = {
    model,
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: schema(types) } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: prompt(today) },
      ],
    }],
  };
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    // Required for calls made from a browser. The key stays on this device; it is only ever
    // sent to api.anthropic.com.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (FALLBACK_MODELS.has(model)) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }

  let res;
  try {
    res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new AiError('No connection to Claude. Fill in the details yourself, or try again when online.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new AiError(explainHttp(res.status, data));

  if (data.stop_reason === 'refusal') throw new AiError('Claude declined to read this photo. Fill in the details yourself.');
  if (data.stop_reason === 'max_tokens') throw new AiError('Claude\'s answer was cut short. Try again.');
  const text = data.content?.find((b) => b.type === 'text')?.text;
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    throw new AiError('Claude\'s answer couldn\'t be understood. Try again.');
  }
  if (!out.readable) throw new AiError('Claude couldn\'t find a readable label in that photo. Try again closer, or fill it in yourself.');
  if (out.expiry && !/^\d{4}-\d{2}-\d{2}$/.test(out.expiry)) out.expiry = '';
  return out;
}
