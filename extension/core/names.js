// File and folder name helpers. Shared by the extension and the Node tools:
// no Node imports here.

// Strips characters Windows forbids in names and trims trailing dots/spaces.
export function safeName(name, maxLen = 120) {
  const cleaned = String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const out = (cleaned || 'unnamed').slice(0, maxLen).trim();
  // Windows reserves these device names, with or without an extension.
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(out) ? `_${out}` : out;
}
