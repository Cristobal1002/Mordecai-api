/**
 * Format PMS-style address objects (line1, line2, city, state, postalCode) for letters.
 */

export function formatSingleLineMailingAddress(addr) {
  if (!addr || typeof addr !== 'object') return '';
  const line1 = String(addr.line1 ?? addr.line_1 ?? '').trim();
  const line2 = String(addr.line2 ?? addr.line_2 ?? '').trim();
  const street = [line1, line2].filter(Boolean).join(', ');
  const city = String(addr.city ?? '').trim();
  const state = String(addr.state ?? addr.stateID ?? addr.stateId ?? '').trim();
  const zip = String(addr.postalCode ?? addr.postal_code ?? addr.zip ?? '').trim();
  const cityPart = [city, state].filter(Boolean).join(', ');
  const cityStateZip = [cityPart, zip].filter(Boolean).join(' ').trim();
  const parts = [street, cityStateZip].filter(Boolean);
  return parts.join(', ').trim();
}
