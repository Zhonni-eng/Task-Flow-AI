// Stable color for a user-defined label, derived from its text.
const PALETTE = ['#a78bfa', '#6aa8ff', '#f59ec5', '#4fd6e6', '#2ee6b6', '#ff8a6b', '#f7b955', '#9fd36a'];

export function labelColor(label) {
  const text = label.toLocaleLowerCase();
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
